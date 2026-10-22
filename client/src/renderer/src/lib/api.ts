import type { Attachment, Message, Session } from './types'

const SESSION_KEY = 'resenha.session'
const LAST_KEY = 'resenha.last'
const DEVICE_KEY = 'resenha.device'

/** Guarda o apelido novo para a tela de entrada. */
export function rememberNickname(nickname: string) {
  localStorage.setItem(LAST_KEY, JSON.stringify({ ...loadLast(), nickname }))
}

/** Id fixo desta instalação; é o que um ban de admin bloqueia. */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

export function loadSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function saveSession(session: Session | null) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  else localStorage.removeItem(SESSION_KEY)
}

/** Último servidor/apelido usados, para pré-preencher a tela de conexão. */
export function loadLast(): { serverUrl: string; nickname: string } {
  try {
    return { serverUrl: '', nickname: '', ...JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') }
  } catch {
    return { serverUrl: '', nickname: '' }
  }
}

/** "1-2-3-4.sslip.io" -> "https://1-2-3-4.sslip.io"; "localhost:3000" -> "http://localhost:3000" */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
    url = `${local ? 'http' : 'https'}://${url}`
  }
  return url
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || data.message || `Erro ${res.status}`) as Error & {
      status: number
    }
    error.status = res.status
    throw error
  }
  return data as T
}

export async function login(serverUrl: string, password: string, nickname: string): Promise<Session> {
  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, nickname, deviceId: deviceId() }),
    })
  } catch {
    throw new Error('Não foi possível conectar ao servidor. Confira o endereço.')
  }
  const data = await parse<Omit<Session, 'serverUrl'>>(res)
  localStorage.setItem(LAST_KEY, JSON.stringify({ serverUrl, nickname }))
  return { ...data, serverUrl }
}

export class Api {
  constructor(private session: Session) {}

  url(path: string) {
    return /^https?:/i.test(path) ? path : `${this.session.serverUrl}${path}`
  }

  private headers() {
    return { Authorization: `Bearer ${this.session.token}`, 'X-Resenha-Device': deviceId() }
  }

  async get<T>(path: string): Promise<T> {
    return parse<T>(await fetch(this.url(path), { headers: this.headers() }))
  }

  messages(channelId: string, before?: number) {
    const query = before ? `?before=${before}` : ''
    return this.get<Message[]>(`/api/channels/${channelId}/messages${query}`)
  }

  livekitToken(channelId: string) {
    return this.get<{ url: string; token: string; voiceMuted: boolean }>(
      `/api/livekit-token?channel=${encodeURIComponent(channelId)}`,
    )
  }

  /** Vira admin com a senha de admin, ou deixa de ser (`false`). Devolve a sessão nova. */
  async setAdmin(password: string | false): Promise<Session> {
    const res = await fetch(this.url('/api/admin'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(password === false ? { admin: false } : { password }),
    })
    const data = await parse<Pick<Session, 'token' | 'user'>>(res)
    return { ...this.session, ...data }
  }

  /** Troca o apelido. Devolve a sessão nova (o apelido vai no token). */
  async updateProfile(nickname: string): Promise<Session> {
    const res = await fetch(this.url('/api/profile'), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    })
    const data = await parse<Pick<Session, 'token' | 'user'>>(res)
    return { ...this.session, ...data }
  }

  async uploadAvatar(file: File): Promise<string> {
    const form = new FormData()
    form.append('file', file, file.name || 'avatar.webp')
    const res = await fetch(this.url('/api/profile/avatar'), {
      method: 'POST',
      headers: this.headers(),
      body: form,
    })
    return (await parse<{ avatar: string }>(res)).avatar
  }

  async removeAvatar(): Promise<void> {
    await parse(await fetch(this.url('/api/profile/avatar'), { method: 'DELETE', headers: this.headers() }))
  }

  async upload(file: File): Promise<Attachment> {
    const form = new FormData()
    form.append('file', file, file.name || 'colado.png')
    const res = await fetch(this.url('/api/upload'), {
      method: 'POST',
      headers: this.headers(),
      body: form,
    })
    return parse<Attachment>(res)
  }
}
