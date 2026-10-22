import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import {
  authenticate,
  checkAdminPassword,
  checkPassword,
  isDeviceId,
  issueToken,
  tooManyAttempts,
} from './auth.js'
import { config, updateDir, uploadDir } from './config.js'
import { getChannel, getMessages, insertAttachment, isBanned, isVoiceMuted } from './db.js'
import { publishSources } from './livekit.js'

const BANNED = 'Você foi banido deste servidor.'

export function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }))

  app.post('/api/login', async (req, reply) => {
    if (tooManyAttempts(req.ip)) {
      return reply.code(429).send({ error: 'Muitas tentativas, espere um minuto.' })
    }
    const body = (req.body ?? {}) as { password?: unknown; nickname?: unknown; deviceId?: unknown }
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
    if (nickname.length < 1 || nickname.length > 32) {
      return reply.code(400).send({ error: 'Apelido deve ter entre 1 e 32 caracteres.' })
    }
    if (!isDeviceId(body.deviceId)) {
      return reply.code(400).send({ error: 'Atualize o app para entrar.' })
    }
    if (typeof body.password !== 'string' || !checkPassword(body.password)) {
      return reply.code(401).send({ error: 'Senha do servidor incorreta.' })
    }
    if (isBanned(body.deviceId)) return reply.code(403).send({ error: BANNED })
    const { token, user } = issueToken(nickname, body.deviceId)
    return {
      token,
      user,
      server: { name: config.serverName, maxUploadMb: config.maxUploadMb },
    }
  })

  // Virar admin (com a senha de admin) ou deixar de ser (admin: false). Devolve um token novo
  // para o mesmo usuário.
  app.post('/api/admin', async (req, reply) => {
    const user = authenticate(req)
    const body = (req.body ?? {}) as { password?: unknown; admin?: unknown }
    if (body.admin === false) return issueToken(user.nickname, user.deviceId, false, user.id)
    if (tooManyAttempts(req.ip)) {
      return reply.code(429).send({ error: 'Muitas tentativas, espere um minuto.' })
    }
    if (!checkAdminPassword(body.password)) {
      return reply.code(401).send({ error: 'Senha de admin incorreta.' })
    }
    return issueToken(user.nickname, user.deviceId, true, user.id)
  })

  app.get('/api/channels/:id/messages', async (req, reply) => {
    authenticate(req)
    const { id } = req.params as { id: string }
    const query = req.query as { before?: string; limit?: string }
    if (!getChannel(id)) return reply.code(404).send({ error: 'Canal não encontrado' })
    const before = query.before ? Number(query.before) : undefined
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100)
    return getMessages(id, before, limit)
  })

  app.get('/api/livekit-token', async (req, reply) => {
    const user = authenticate(req)
    if (isBanned(user.deviceId)) return reply.code(403).send({ error: BANNED })
    const { channel } = req.query as { channel?: string }
    if (!channel || getChannel(channel)?.kind !== 'voice') {
      return reply.code(404).send({ error: 'Canal de voz não encontrado' })
    }
    const voiceMuted = isVoiceMuted(user.deviceId)
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: user.id,
      name: user.nickname,
      ttl: '12h',
    })
    at.addGrant({
      room: channel,
      roomJoin: true,
      canPublish: true,
      canPublishSources: publishSources(voiceMuted),
      canSubscribe: true,
      canPublishData: true,
    })
    return {
      url: config.livekit.publicUrl,
      token: await at.toJwt(),
      voiceMuted,
    }
  })

  // Atualização automática do app (electron-updater). O repositório é público e a senha vai
  // embutida no instalador, então só entrega os arquivos para quem manda a senha do servidor.
  app.get('/api/updates/:file', async (req, reply) => {
    if (!checkPassword(headerPassword(req.headers['x-resenha-password']))) {
      if (tooManyAttempts(req.ip)) {
        return reply.code(429).send({ error: 'Muitas tentativas, espere um minuto.' })
      }
      return reply.code(401).send({ error: 'Senha do servidor incorreta.' })
    }
    const { file } = req.params as { file: string }
    if (!UPDATE_FILE.test(file) || !existsSync(join(updateDir, file))) {
      return reply.code(404).send({ error: 'Arquivo não encontrado' })
    }
    // latest.yml muda a cada versão; os instaladores têm a versão no nome
    reply.header('Cache-Control', file.endsWith('.yml') ? 'no-cache' : 'private, max-age=31536000')
    return reply.sendFile(file, updateDir, { cacheControl: false })
  })

  app.post('/api/upload', async (req, reply) => {
    const user = authenticate(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: 'Nenhum arquivo enviado' })

    const id = randomBytes(12).toString('hex')
    const ext = extname(file.filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10)
    const stored = id + ext
    const dest = join(uploadDir, stored)
    try {
      await pipeline(file.file, createWriteStream(dest))
    } catch (err) {
      await unlink(dest).catch(() => {})
      if (file.file.truncated) {
        return reply
          .code(413)
          .send({ error: `Arquivo maior que o limite de ${config.maxUploadMb} MB` })
      }
      throw err
    }
    const { size } = await stat(dest)
    const name = file.filename.slice(0, 200) || 'arquivo'
    return insertAttachment({
      id,
      file: stored,
      name,
      mime: file.mimetype || 'application/octet-stream',
      size,
      userId: user.id,
    })
  })
}

const UPDATE_FILE = /^[\w.-]+\.(yml|exe|blockmap)$/

/** O app manda a senha com encodeURIComponent (cabeçalho HTTP só aceita ASCII). */
function headerPassword(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

// Só estes tipos abrem direto no app; o resto é servido como download.
const INLINE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp',
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac',
])

export function isInlineFile(path: string): boolean {
  return INLINE_EXT.has(extname(path).toLowerCase())
}
