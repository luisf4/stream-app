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
  // quem digita esta senha nas Configurações vira admin; vazia = ninguém vira
  adminPassword: env.ADMIN_PASSWORD ?? '',
  livekit: {
    apiKey: required('LIVEKIT_API_KEY', 'devkey'),
    apiSecret: required('LIVEKIT_API_SECRET', 'secret'),
    // URL que o app usa para falar com o LiveKit (ws:// local, wss://dominio em produção)
    publicUrl: env.LIVEKIT_PUBLIC_URL || 'ws://localhost:7880',
    // URL que o servidor usa para a API do LiveKit (mutar, expulsar); em produção o Caddy
    // encaminha /twirp do próprio domínio para ele
    apiUrl: (env.LIVEKIT_URL || env.LIVEKIT_PUBLIC_URL || 'ws://localhost:7880').replace(/^ws/, 'http'),
  },
  defaultChannels: (env.CHANNELS ?? 'Geral,Jogos,Filmes')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 100),
  // imagens do chat são apagadas do disco depois disto (vídeos e outros arquivos ficam)
  imageTtlDays: Number(env.IMAGE_TTL_DAYS ?? 30),
  dataDir: resolve(env.DATA_DIR ?? './data'),
}

export const uploadDir = join(config.dataDir, 'uploads')
mkdirSync(uploadDir, { recursive: true })

// Instaladores do app para a atualização automática (enviados pelo GitHub Actions)
export const updateDir = join(config.dataDir, 'updates')
mkdirSync(updateDir, { recursive: true })
