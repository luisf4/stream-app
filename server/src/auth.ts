import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import jwt from 'jsonwebtoken'
import { config } from './config.js'

export interface User {
  id: string
  nickname: string
  /** gerado pelo app uma vez por instalação; é o que o ban bloqueia (nunca vai para os outros) */
  deviceId: string
  admin: boolean
}

/** O que os outros veem de um usuário. */
export const publicUser = (user: User) => ({ id: user.id, nickname: user.nickname, admin: user.admin })

const sha256 = (value: string) => createHash('sha256').update(value).digest()

// A senha do servidor faz parte da chave: trocar a senha desloga todo mundo.
const signingKey = sha256(`${config.jwtSecret}\0${config.password}`)

export function checkPassword(password: string): boolean {
  return timingSafeEqual(sha256(password), sha256(config.password))
}

export function checkAdminPassword(password: unknown): boolean {
  if (!config.adminPassword || typeof password !== 'string') return false
  return timingSafeEqual(sha256(password), sha256(config.adminPassword))
}

// Vai no token de quem virou admin: trocar ADMIN_PASSWORD tira o admin de todo mundo.
const adminMark = () =>
  config.adminPassword ? sha256(`admin\0${config.adminPassword}`).toString('hex').slice(0, 16) : null

export const isDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)

export function issueToken(
  nickname: string,
  deviceId: string,
  admin = false,
  id: string = randomUUID(),
): { token: string; user: User } {
  const user = { id, nickname, deviceId, admin: admin && !!adminMark() }
  const claims = { name: nickname, dev: deviceId, ...(user.admin ? { adm: adminMark() } : {}) }
  const token = jwt.sign(claims, signingKey, { subject: id, expiresIn: '30d' })
  return { token, user }
}

/** `fallbackDeviceId`: tokens de antes do ban não têm o aparelho; o socket manda separado. */
export function verifyToken(token: unknown, fallbackDeviceId?: unknown): User | null {
  if (typeof token !== 'string') return null
  try {
    const payload = jwt.verify(token, signingKey) as jwt.JwtPayload
    if (typeof payload.sub !== 'string' || typeof payload.name !== 'string') return null
    const deviceId = isDeviceId(payload.dev) ? payload.dev : isDeviceId(fallbackDeviceId) ? fallbackDeviceId : ''
    const admin = typeof payload.adm === 'string' && payload.adm === adminMark()
    return { id: payload.sub, nickname: payload.name, deviceId, admin }
  } catch {
    return null
  }
}

/** Lê o "Authorization: Bearer" da requisição ou responde 401. */
export function authenticate(req: FastifyRequest): User {
  const header = req.headers.authorization
  const user = header?.startsWith('Bearer ')
    ? verifyToken(header.slice(7), req.headers['x-resenha-device'])
    : null
  if (!user) throw Object.assign(new Error('Não autorizado'), { statusCode: 401 })
  return user
}

// Limite simples de tentativas de login por IP.
const attempts = new Map<string, { count: number; resetAt: number }>()

export function tooManyAttempts(ip: string): boolean {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 })
    return false
  }
  entry.count++
  return entry.count > 10
}
