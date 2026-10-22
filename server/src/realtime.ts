import type { Server, Socket } from 'socket.io'
import { publicUser, verifyToken, type User } from './auth.js'
import {
  ban,
  createChannel,
  deleteAttachments,
  deleteChannel,
  deleteMessage,
  getAttachments,
  getChannel,
  getMessage,
  insertMessage,
  isBanned,
  isVoiceMuted,
  listBans,
  listChannels,
  muteVoice,
  renameChannel,
  unban,
  unmuteVoice,
} from './db.js'
import { removeFromRoom, setVoiceMuted } from './livekit.js'
import { removeUploads } from './uploads.js'

interface VoiceState {
  userId: string
  nickname: string
  channelId: string
  muted: boolean
  deafened: boolean
  camera: boolean
  streaming: boolean
  /** mutado por um admin: não consegue ligar o microfone */
  serverMuted: boolean
}

type Ack = (res: { ok: boolean; error?: string; [k: string]: unknown }) => void

const MAX_MESSAGE = 4000

const cleanName = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) : ''

export function setupRealtime(io: Server) {
  const voice = new Map<string, VoiceState>() // socket.id -> estado de voz
  const online = new Map<string, { user: User; sockets: number }>()

  const voiceList = () => [...voice.values()]
  const onlineList = () => [...online.values()].map((o) => publicUser(o.user))

  io.use((socket, next) => {
    const user = verifyToken(socket.handshake.auth?.token, socket.handshake.auth?.deviceId)
    if (!user) return next(new Error('unauthorized'))
    if (isBanned(user.deviceId)) return next(new Error('banned'))
    socket.data.user = user
    next()
  })

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as User

    // Erros num handler não podem derrubar o servidor.
    const on = (event: string, handler: (payload: any, ack: Ack) => void) => {
      socket.on(event, (payload: unknown, ack?: unknown) => {
        const reply: Ack = typeof ack === 'function' ? (ack as Ack) : () => {}
        try {
          handler(payload ?? {}, reply)
        } catch (err) {
          console.error(`erro em ${event}:`, err)
          reply({ ok: false, error: 'Erro interno' })
        }
      })
    }

    const entry = online.get(user.id)
    if (entry) {
      entry.sockets++
      entry.user = user // pode ter virado (ou deixado de ser) admin
    } else online.set(user.id, { user, sockets: 1 })

    socket.emit('init', { channels: listChannels(), voice: voiceList(), online: onlineList() })
    io.emit('online', onlineList())

    on('message:send', (p, reply) => {
      const channelId = String(p.channelId ?? '')
      const content = typeof p.content === 'string' ? p.content.trim().slice(0, MAX_MESSAGE) : ''
      const ids = Array.isArray(p.attachmentIds)
        ? p.attachmentIds.filter((x: unknown) => typeof x === 'string').slice(0, 10)
        : []
      if (!getChannel(channelId)) return reply({ ok: false, error: 'Canal não encontrado' })
      const attachments = getAttachments(ids, user.id)
      if (!content && attachments.length === 0) return reply({ ok: false, error: 'Mensagem vazia' })
      const message = insertMessage({
        channelId,
        userId: user.id,
        nickname: user.nickname,
        content,
        attachments,
      })
      io.emit('message:new', message)
      reply({ ok: true, message })
    })

    on('message:delete', (p, reply) => {
      const message = getMessage(Number(p.id))
      if (!message || (message.userId !== user.id && !user.admin)) {
        return reply({ ok: false, error: 'Sem permissão' })
      }
      deleteMessage(message.id)
      removeUploads(deleteAttachments(message.attachments.map((a) => a.id)))
      io.emit('message:deleted', { id: message.id, channelId: message.channelId })
      reply({ ok: true })
    })

    on('typing', (p) => {
      if (typeof p.channelId !== 'string') return
      socket.broadcast.emit('typing', {
        channelId: p.channelId,
        userId: user.id,
        nickname: user.nickname,
      })
    })

    on('voice:update', (p) => {
      if (typeof p.channelId === 'string' && getChannel(p.channelId)?.kind === 'voice') {
        voice.set(socket.id, {
          userId: user.id,
          nickname: user.nickname,
          channelId: p.channelId,
          muted: !!p.muted,
          deafened: !!p.deafened,
          camera: !!p.camera,
          streaming: !!p.streaming,
          serverMuted: isVoiceMuted(user.deviceId),
        })
      } else {
        voice.delete(socket.id)
      }
      io.emit('voice:states', voiceList())
    })

    on('channel:create', (p, reply) => {
      const name = cleanName(p.name)
      if (!name) return reply({ ok: false, error: 'Nome inválido' })
      if (listChannels().length >= 50) return reply({ ok: false, error: 'Canais demais' })
      const channel = createChannel(name, p.kind === 'text' ? 'text' : 'voice')
      io.emit('channels', listChannels())
      reply({ ok: true, channel })
    })

    on('channel:rename', (p, reply) => {
      const name = cleanName(p.name)
      if (!name || !getChannel(String(p.id))) return reply({ ok: false, error: 'Nome inválido' })
      renameChannel(String(p.id), name)
      io.emit('channels', listChannels())
      reply({ ok: true })
    })

    on('channel:delete', (p, reply) => {
      const id = String(p.id)
      if (!getChannel(id)) return reply({ ok: false, error: 'Canal não encontrado' })
      if (listChannels().length <= 1) return reply({ ok: false, error: 'Precisa ter pelo menos 1 canal' })
      removeUploads(deleteChannel(id))
      for (const [socketId, state] of voice) if (state.channelId === id) voice.delete(socketId)
      io.emit('channels', listChannels())
      io.emit('voice:states', voiceList())
      reply({ ok: true })
    })

    // ---------- admin ----------

    /** Handler só para admin; `target` é o usuário online com o id pedido (nunca o próprio admin). */
    const admin = (event: string, handler: (target: User | null, payload: any, ack: Ack) => void) =>
      on(event, (p, reply) => {
        if (!user.admin) return reply({ ok: false, error: 'Só admin pode fazer isso' })
        const target = online.get(String(p.userId ?? ''))?.user ?? null
        if (target?.id === user.id) return reply({ ok: false, error: 'Não dá para fazer isso com você mesmo' })
        handler(target, p, reply)
      })

    const voiceRoomsOf = (userId: string) =>
      new Set([...voice.values()].filter((v) => v.userId === userId).map((v) => v.channelId))

    const socketsOf = (userId: string) =>
      [...io.sockets.sockets.values()].filter((s) => (s.data.user as User).id === userId)

    const livekitError = (err: unknown) => console.error('LiveKit:', err)

    admin('admin:ban', (target, _p, reply) => {
      if (!target) return reply({ ok: false, error: 'Usuário não está online' })
      if (!target.deviceId) return reply({ ok: false, error: 'Esse usuário está com o app desatualizado' })
      ban(target.deviceId, target.nickname)
      for (const room of voiceRoomsOf(target.id)) removeFromRoom(room, target.id).catch(livekitError)
      // derruba todo mundo daquele aparelho, mesmo com outro apelido
      for (const s of io.sockets.sockets.values()) {
        if ((s.data.user as User).deviceId !== target.deviceId) continue
        s.emit('banned')
        s.disconnect(true)
      }
      reply({ ok: true })
    })

    admin('admin:unban', (_target, p, reply) => {
      unban(String(p.deviceId ?? ''))
      reply({ ok: true, bans: listBans() })
    })

    admin('admin:bans', (_target, _p, reply) => reply({ ok: true, bans: listBans() }))

    admin('admin:mute', (target, p, reply) => {
      if (!target) return reply({ ok: false, error: 'Usuário não está online' })
      if (!target.deviceId) return reply({ ok: false, error: 'Esse usuário está com o app desatualizado' })
      const muted = !!p.muted
      if (muted) muteVoice(target.deviceId, target.nickname)
      else unmuteVoice(target.deviceId)
      for (const room of voiceRoomsOf(target.id)) setVoiceMuted(room, target.id, muted).catch(livekitError)
      for (const state of voice.values()) {
        if (state.userId === target.id) {
          state.serverMuted = muted
          if (muted) state.muted = true
        }
      }
      io.emit('voice:states', voiceList())
      reply({ ok: true })
    })

    admin('admin:kick', (target, _p, reply) => {
      if (!target) return reply({ ok: false, error: 'Usuário não está online' })
      for (const room of voiceRoomsOf(target.id)) removeFromRoom(room, target.id).catch(livekitError)
      for (const s of socketsOf(target.id)) s.emit('voice:kicked')
      for (const [socketId, state] of voice) if (state.userId === target.id) voice.delete(socketId)
      io.emit('voice:states', voiceList())
      reply({ ok: true })
    })

    socket.on('disconnect', () => {
      if (voice.delete(socket.id)) io.emit('voice:states', voiceList())
      const current = online.get(user.id)
      if (current && --current.sockets <= 0) online.delete(user.id)
      io.emit('online', onlineList())
    })
  })
}
