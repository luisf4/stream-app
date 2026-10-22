export interface User {
  id: string
  nickname: string
  admin?: boolean
  /** foto de perfil (/files/...) */
  avatar?: string | null
}

/** Quem já entrou no servidor (um por PC). */
export interface Member extends User {
  online: boolean
  lastSeen: number
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
  /** texto: só chat, sem voz */
  kind: 'voice' | 'text'
}

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  url: string
  /** imagem antiga já apagada do servidor (as imagens duram 30 dias) */
  expired?: boolean
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
  /** mutado por um admin */
  serverMuted?: boolean
}
