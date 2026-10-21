import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { Server } from 'socket.io'
import { config, uploadDir } from './config.js'
import { setupRealtime } from './realtime.js'
import { isInlineFile, registerRoutes } from './routes.js'

const app = Fastify({ logger: { level: 'info' }, trustProxy: true })

await app.register(cors, { origin: true })
await app.register(multipart, {
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
})
await app.register(fastifyStatic, {
  root: uploadDir,
  prefix: '/files/',
  index: false,
  list: false,
  maxAge: '30d',
  immutable: true,
  setHeaders(res, path) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!isInlineFile(path)) res.setHeader('Content-Disposition', 'attachment')
  },
})

registerRoutes(app)

const io = new Server(app.server, { cors: { origin: true }, maxHttpBufferSize: 1e6 })
setupRealtime(io)

await app.listen({ port: config.port, host: config.host })
app.log.info(`Servidor "${config.serverName}" pronto. LiveKit: ${config.livekit.publicUrl}`)
