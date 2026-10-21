import { useStore } from '../store'
import { saveSession } from './api'
import { disconnectSocket } from './socket'
import { leaveVoice } from './voice'

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
    online: [],
    typing: {},
  })
}
