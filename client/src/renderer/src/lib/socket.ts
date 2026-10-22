import { io, type Socket } from 'socket.io-client'
import { selectChannel, showToast, useStore } from '../store'
import { deviceId } from './api'
import { mentions } from './mentions'
import { sounds } from './sounds'
import type { Channel, Message, Session, User, VoiceState } from './types'
import { leaveVoice, setServerMuted } from './voice'

let socket: Socket | null = null

export function connectSocket(
  session: Session,
  onUnauthorized: () => void,
  onBanned: () => void,
) {
  disconnectSocket()
  const s = io(session.serverUrl, {
    // lido a cada conexão: o token muda ao virar admin (replaceSession)
    auth: (cb) => cb({ token: useStore.getState().session?.token, deviceId: deviceId() }),
    transports: ['websocket'],
  })
  socket = s
  const set = useStore.setState
  const get = useStore.getState

  s.on('connect', () => {
    set({ socketConnected: true })
    reportVoiceState()
  })
  s.on('disconnect', () => set({ socketConnected: false }))
  s.on('connect_error', (err) => {
    if (err.message === 'unauthorized') onUnauthorized()
    if (err.message === 'banned') onBanned()
  })
  s.on('banned', onBanned)
  s.on('voice:kicked', () => {
    void leaveVoice()
    showToast('Um admin tirou você da call')
  })

  const applyChannels = (channels: Channel[]) => {
    set({ channels })
    const selected = get().selectedChannelId
    if (!selected || !channels.some((c) => c.id === selected)) {
      if (channels[0]) selectChannel(channels[0].id)
    }
  }

  s.on('init', (data: { channels: Channel[]; voice: VoiceState[]; online: User[] }) => {
    // Depois de reconectar, recarrega o histórico do zero para não perder mensagens.
    set({ voiceStates: data.voice, online: data.online, messages: {}, hasMore: {} })
    applyChannels(data.channels)
  })
  s.on('channels', applyChannels)
  s.on('voice:states', (voiceStates: VoiceState[]) => {
    set({ voiceStates })
    const { session, voiceChannelId } = get()
    const mine = voiceStates.find((v) => v.userId === session?.user.id && v.channelId === voiceChannelId)
    if (mine) setServerMuted(!!mine.serverMuted)
  })
  s.on('online', (online: User[]) => set({ online }))

  s.on('message:new', (message: Message) => {
    const state = get()
    const list = state.messages[message.channelId]
    const mine = message.userId === state.session?.user.id
    const isSelected = state.selectedChannelId === message.channelId
    const me = state.session?.user.nickname ?? ''
    const pinged = !mine && !!me && mentions(message.content, me)
    const typing = { ...state.typing[message.channelId] }
    delete typing[message.nickname]

    set({
      messages: list ? { ...state.messages, [message.channelId]: [...list, message] } : state.messages,
      unread:
        !mine && !isSelected
          ? { ...state.unread, [message.channelId]: (state.unread[message.channelId] ?? 0) + 1 }
          : state.unread,
      mentioned:
        pinged && !isSelected ? { ...state.mentioned, [message.channelId]: true } : state.mentioned,
      typing: { ...state.typing, [message.channelId]: typing },
    })

    if (!mine && (!isSelected || !document.hasFocus())) notify(message, pinged)
  })

  s.on('message:deleted', ({ id, channelId }: { id: number; channelId: string }) => {
    const list = get().messages[channelId]
    if (!list) return
    set({ messages: { ...get().messages, [channelId]: list.filter((m) => m.id !== id) } })
  })

  s.on('typing', ({ channelId, nickname }: { channelId: string; nickname: string }) => {
    const typing = get().typing
    set({
      typing: { ...typing, [channelId]: { ...typing[channelId], [nickname]: Date.now() + 4000 } },
    })
  })
}

function notify(message: Message, pinged: boolean) {
  const { settings, channels } = useStore.getState()
  window.api.flashFrame()
  if (settings.sounds) sounds.message()
  if (!settings.notifications || document.hasFocus()) return
  const channel = channels.find((c) => c.id === message.channelId)
  const body = message.content || `📎 ${message.attachments.map((a) => a.name).join(', ')}`
  const title = pinged
    ? `${message.nickname} mencionou você em #${channel?.name ?? 'Resenha'}`
    : `${message.nickname} em ${channel?.name ?? 'Resenha'}`
  const n = new Notification(title, {
    body: body.slice(0, 200),
    silent: true,
  })
  n.onclick = () => {
    window.api.showWindow()
    selectChannel(message.channelId)
  }
}

/** Reconecta com o token atual (os listeners continuam). */
export function reconnectSocket() {
  socket?.disconnect().connect()
}

export function disconnectSocket() {
  socket?.removeAllListeners()
  socket?.disconnect()
  socket = null
  useStore.setState({ socketConnected: false })
}

/** Envia um evento e espera a resposta do servidor. */
export async function request<T = Record<string, unknown>>(
  event: string,
  payload: unknown,
): Promise<T & { ok: boolean; error?: string }> {
  if (!socket?.connected) return { ok: false, error: 'Sem conexão com o servidor' } as never
  try {
    return await socket.timeout(10_000).emitWithAck(event, payload)
  } catch {
    return { ok: false, error: 'O servidor não respondeu' } as never
  }
}

export function emit(event: string, payload: unknown) {
  socket?.emit(event, payload)
}

/** Conta ao servidor em qual canal de voz estamos (para a lista lateral de todo mundo). */
export function reportVoiceState() {
  const s = useStore.getState()
  const inVoice = s.voiceChannelId && (s.voiceStatus === 'connected' || s.voiceStatus === 'reconnecting')
  emit(
    'voice:update',
    inVoice
      ? {
          channelId: s.voiceChannelId,
          muted: s.muted,
          deafened: s.deafened,
          camera: s.camera,
          streaming: s.sharing,
        }
      : { channelId: null },
  )
}
