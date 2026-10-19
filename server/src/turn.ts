import { config } from './config.js'

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

const TTL_SECONDS = 24 * 60 * 60
let cache: { servers: IceServer[]; expiresAt: number } | null = null

export const turnEnabled = () => !!(config.cloudflareTurn.keyId && config.cloudflareTurn.apiToken)

/** Gera (e guarda por algumas horas) credenciais do TURN do Cloudflare para os apps. */
export async function getIceServers(): Promise<IceServer[] | null> {
  if (!turnEnabled()) return null
  if (cache && cache.expiresAt > Date.now()) return cache.servers

  const { keyId, apiToken } = config.cloudflareTurn
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  )
  if (!res.ok) {
    throw new Error(`Cloudflare TURN respondeu ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { iceServers: IceServer | IceServer[] }
  const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers]

  // O Cloudflare recomenda descartar as URLs na porta 53 (navegadores costumam bloquear).
  const servers = list
    .map((s) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
    }))
    .filter((s) => s.urls.length > 0)

  // renova bem antes de expirar
  cache = { servers, expiresAt: Date.now() + (TTL_SECONDS / 2) * 1000 }
  return servers
}
