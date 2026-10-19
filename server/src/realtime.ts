import type { Server, Socket } from 'socket.io'
import { verifyToken, type User } from './auth.js'
import {
  createChannel,
  deleteChannel,
  deleteMessage,
  getAttachments,
  getChannel,
  getMessage,
  insertMessage,
  listChannels,
  renameChannel,
} from './db.js'

interface VoiceState {
  userId: string
  nickname: string
  channelId: string
  muted: boolean
  deafened: boolean
  camera: boolean
  streaming: boolean
}

type Ack = (res: { ok: boolean; error?: string; [k: string]: unknown }) => void

const MAX_MESSAGE = 4000

const cleanName = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) : ''

export function setupRealtime(io: Server) {
  const voice = new Map<string, VoiceState>() // socket.id -> estado de voz
  const online = new Map<string, { user: User; sockets: number }>()

  const voiceList = () => [...voice.values()]
  const onlineList = () => [...online.values()].map((o) => o.user)

  io.use((socket, next) => {
    const user = verifyToken(socket.handshake.auth?.token)
    if (!user) return next(new Error('unauthorized'))
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
    if (entry) entry.sockets++
    else online.set(user.id, { user, sockets: 1 })

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
      if (!message || message.userId !== user.id) return reply({ ok: false, error: 'Sem permissão' })
      deleteMessage(message.id)
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
      if (typeof p.channelId === 'string' && getChannel(p.channelId)) {
        voice.set(socket.id, {
          userId: user.id,
          nickname: user.nickname,
          channelId: p.channelId,
          muted: !!p.muted,
          deafened: !!p.deafened,
          camera: !!p.camera,
          streaming: !!p.streaming,
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
      const channel = createChannel(name)
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
      deleteChannel(id)
      for (const [socketId, state] of voice) if (state.channelId === id) voice.delete(socketId)
      io.emit('channels', listChannels())
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
