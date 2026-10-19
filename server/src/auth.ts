import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import jwt from 'jsonwebtoken'
import { config } from './config.js'

export interface User {
  id: string
  nickname: string
}

const sha256 = (value: string) => createHash('sha256').update(value).digest()

// A senha do servidor faz parte da chave: trocar a senha desloga todo mundo.
const signingKey = sha256(`${config.jwtSecret}\0${config.password}`)

export function checkPassword(password: string): boolean {
  return timingSafeEqual(sha256(password), sha256(config.password))
}

export function issueToken(nickname: string): { token: string; user: User } {
  const user = { id: randomUUID(), nickname }
  const token = jwt.sign({ name: nickname }, signingKey, { subject: user.id, expiresIn: '30d' })
  return { token, user }
}

export function verifyToken(token: unknown): User | null {
  if (typeof token !== 'string') return null
  try {
    const payload = jwt.verify(token, signingKey) as jwt.JwtPayload
    if (typeof payload.sub !== 'string' || typeof payload.name !== 'string') return null
    return { id: payload.sub, nickname: payload.name }
  } catch {
    return null
  }
}

/** Lê o "Authorization: Bearer" da requisição ou responde 401. */
export function authenticate(req: FastifyRequest): User {
  const header = req.headers.authorization
  const user = header?.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null
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
