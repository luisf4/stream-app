import { create } from 'zustand'
import { Api, loadSession, saveSession } from './lib/api'
import { presetServer } from './lib/config'
import { loadSettings, saveSettings, type Settings } from './lib/settings'
import type { Channel, Message, Session, User, VoiceState } from './lib/types'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface State {
  session: Session | null
  api: Api | null
  socketConnected: boolean

  channels: Channel[]
  selectedChannelId: string | null
  messages: Record<string, Message[]>
  hasMore: Record<string, boolean>
  unread: Record<string, number>
  /** canais com mensagem não lida que menciona você */
  mentioned: Record<string, boolean>
  voiceStates: VoiceState[]
  online: User[]
  /** canal -> apelido -> expira em (ms) */
  typing: Record<string, Record<string, number>>

  // voz local
  voiceChannelId: string | null
  voiceStatus: VoiceStatus
  muted: boolean
  deafened: boolean
  camera: boolean
  sharing: boolean
  speaking: string[]
  /** incrementa a cada evento do LiveKit para re-renderizar o palco */
  roomVersion: number

  settings: Settings
  toast: string | null
}

// Login salvo de outro servidor (o app foi buildado com outro endereço, ex.: depois da mudança para
// a VPS): ele ficaria tentando conectar no endereço antigo para sempre. Volta para a tela de
// entrada, com o apelido já preenchido.
function currentSession() {
  const session = loadSession()
  if (session && presetServer && session.serverUrl !== presetServer.serverUrl) {
    saveSession(null)
    return null
  }
  return session
}

const initialSession = currentSession()

export const useStore = create<State>(() => ({
  session: initialSession,
  api: initialSession ? new Api(initialSession) : null,
  socketConnected: false,
  channels: [],
  selectedChannelId: null,
  messages: {},
  hasMore: {},
  unread: {},
  mentioned: {},
  voiceStates: [],
  online: [],
  typing: {},
  voiceChannelId: null,
  voiceStatus: 'idle',
  muted: false,
  deafened: false,
  camera: false,
  sharing: false,
  speaking: [],
  roomVersion: 0,
  settings: loadSettings(),
  toast: null,
}))

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...useStore.getState().settings, ...patch }
  useStore.setState({ settings })
  saveSettings(settings)
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showToast(message: string) {
  useStore.setState({ toast: message })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => useStore.setState({ toast: null }), 4000)
}

export function selectChannel(channelId: string) {
  useStore.setState((s) => ({
    selectedChannelId: channelId,
    unread: { ...s.unread, [channelId]: 0 },
    mentioned: { ...s.mentioned, [channelId]: false },
  }))
}
