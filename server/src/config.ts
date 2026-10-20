import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Carrega ./.env se existir (útil no desenvolvimento local).
try {
  process.loadEnvFile()
} catch {
  // sem .env, tudo bem
}

const env = process.env
const production = env.NODE_ENV === 'production'

function required(name: string, devDefault: string): string {
  const value = env[name]
  if (value) return value
  if (!production) return devDefault
  throw new Error(`A variável de ambiente ${name} é obrigatória em produção`)
}

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  serverName: env.SERVER_NAME ?? 'Resenha',
  password: required('SERVER_PASSWORD', 'amigos'),
  jwtSecret: required('JWT_SECRET', 'dev-secret-troque-isto'),
  livekit: {
    apiKey: required('LIVEKIT_API_KEY', 'devkey'),
    apiSecret: required('LIVEKIT_API_SECRET', 'secret'),
    // URL que o app usa para falar com o LiveKit (ws:// local, wss://dominio em produção)
    publicUrl: env.LIVEKIT_PUBLIC_URL || 'ws://localhost:7880',
  },
  // TURN do Cloudflare (Realtime): quando configurado, toda a mídia passa por ele,
  // então o servidor não precisa de nenhuma porta aberta.
  cloudflareTurn: {
    keyId: env.CLOUDFLARE_TURN_KEY_ID ?? '',
    apiToken: env.CLOUDFLARE_TURN_API_TOKEN ?? '',
  },
  defaultChannels: (env.CHANNELS ?? 'Geral,Jogos,Filmes')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 100),
  dataDir: resolve(env.DATA_DIR ?? './data'),
}

export const uploadDir = join(config.dataDir, 'uploads')
mkdirSync(uploadDir, { recursive: true })
