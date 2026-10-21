import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import { authenticate, checkPassword, issueToken, tooManyAttempts } from './auth.js'
import { config, uploadDir } from './config.js'
import { getChannel, getMessages, insertAttachment } from './db.js'

export function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }))

  app.post('/api/login', async (req, reply) => {
    if (tooManyAttempts(req.ip)) {
      return reply.code(429).send({ error: 'Muitas tentativas, espere um minuto.' })
    }
    const body = (req.body ?? {}) as { password?: unknown; nickname?: unknown }
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
    if (nickname.length < 1 || nickname.length > 32) {
      return reply.code(400).send({ error: 'Apelido deve ter entre 1 e 32 caracteres.' })
    }
    if (typeof body.password !== 'string' || !checkPassword(body.password)) {
      return reply.code(401).send({ error: 'Senha do servidor incorreta.' })
    }
    const { token, user } = issueToken(nickname)
    return {
      token,
      user,
      server: { name: config.serverName, maxUploadMb: config.maxUploadMb },
    }
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
    const { channel } = req.query as { channel?: string }
    if (!channel || !getChannel(channel)) {
      return reply.code(404).send({ error: 'Canal não encontrado' })
    }
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: user.id,
      name: user.nickname,
      ttl: '12h',
    })
    at.addGrant({
      room: channel,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })
    return {
      url: config.livekit.publicUrl,
      token: await at.toJwt(),
    }
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

// Só estes tipos abrem direto no app; o resto é servido como download.
const INLINE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp',
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.ogg', '.wav', '.m4a', '.opus', '.flac',
])

export function isInlineFile(path: string): boolean {
  return INLINE_EXT.has(extname(path).toLowerCase())
}
