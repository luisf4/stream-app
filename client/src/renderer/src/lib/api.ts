import type { Attachment, Message, Session } from './types'

const SESSION_KEY = 'resenha.session'
const LAST_KEY = 'resenha.last'

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
      body: JSON.stringify({ password, nickname }),
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
    return { Authorization: `Bearer ${this.session.token}` }
  }

  async get<T>(path: string): Promise<T> {
    return parse<T>(await fetch(this.url(path), { headers: this.headers() }))
  }

  messages(channelId: string, before?: number) {
    const query = before ? `?before=${before}` : ''
    return this.get<Message[]>(`/api/channels/${channelId}/messages${query}`)
  }

  livekitToken(channelId: string) {
    return this.get<{ url: string; token: string; iceServers?: RTCIceServer[] | null }>(
      `/api/livekit-token?channel=${encodeURIComponent(channelId)}`,
    )
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
