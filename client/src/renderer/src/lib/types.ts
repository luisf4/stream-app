export interface User {
  id: string
  nickname: string
}

export interface Session {
  serverUrl: string
  token: string
  user: User
  server: { name: string; maxUploadMb: number }
}

export interface Channel {
  id: string
  name: string
  position: number
}

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  url: string
}

export interface Message {
  id: number
  channelId: string
  userId: string
  nickname: string
  content: string
  attachments: Attachment[]
  createdAt: number
}

export interface VoiceState {
  userId: string
  nickname: string
  channelId: string
  muted: boolean
  deafened: boolean
  camera: boolean
  streaming: boolean
}
