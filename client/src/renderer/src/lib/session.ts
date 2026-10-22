import { useStore } from '../store'
import { Api, saveSession } from './api'
import { disconnectSocket, reconnectSocket } from './socket'
import type { Session } from './types'
import { leaveVoice } from './voice'

/** Troca o token (virou/deixou de ser admin) sem sair da voz. */
export function replaceSession(session: Session) {
  saveSession(session)
  useStore.setState({ session, api: new Api(session) })
  reconnectSocket()
}

export function logout() {
  void leaveVoice(true)
  disconnectSocket()
  saveSession(null)
  useStore.setState({
    session: null,
    api: null,
    channels: [],
    selectedChannelId: null,
    messages: {},
    hasMore: {},
    unread: {},
    mentioned: {},
    voiceStates: [],
    members: [],
    typing: {},
    serverMuted: false,
    banTarget: null,
  })
}
