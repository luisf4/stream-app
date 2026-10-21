import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { config, updateDir } from './config.js'

// Página pública de download (https://DOMINIO/): sempre o último instalador do Windows publicado
// pelo GitHub Actions (o mesmo da atualização automática).

const INSTALLER = /^Resenha-Setup-[\d.]+\.exe$/

function latest(): { version: string; file: string } | null {
  const manifest = join(updateDir, 'latest.yml')
  if (!existsSync(manifest)) return null
  const text = readFileSync(manifest, 'utf8')
  const version = text.match(/^version:\s*(\S+)/m)?.[1]
  const file = text.match(/^path:\s*(\S+)/m)?.[1]
  if (!version || !file || !INSTALLER.test(file) || !existsSync(join(updateDir, file))) return null
  return { version, file }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(release: { version: string } | null): string {
  const name = escapeHtml(config.serverName)
  const body = release
    ? `<a class="btn" href="/download">Baixar para Windows</a>
      <p class="muted">Versão ${escapeHtml(release.version)} · depois de instalado, o app se atualiza sozinho</p>`
    : `<p class="muted">Nenhuma versão publicada ainda.</p>`
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: #1e1f22; color: #dbdee1; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center;
  }
  h1 { margin: 0 0 24px; color: #f2f3f5; font-size: 32px; }
  .btn {
    display: inline-block; padding: 12px 28px; border-radius: 8px; background: #5865f2; color: #fff;
    font-weight: 600; text-decoration: none;
  }
  .btn:hover { background: #4752c4; }
  .btn:focus-visible { outline: 2px solid #f2f3f5; outline-offset: 3px; }
  .muted { color: #949ba4; font-size: 14px; margin: 16px 0 0; }
</style>
</head>
<body>
  <main>
    <h1>${name}</h1>
    ${body}
  </main>
</body>
</html>`
}

export function registerDownloadPage(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8')
    return page(latest())
  })

  // /download sempre aponta para o último; o nome do arquivo na URL vira o nome salvo no navegador
  app.get('/download', async (_req, reply) => {
    const release = latest()
    return reply.redirect(release ? `/download/${release.file}` : '/')
  })

  app.get('/download/:file', async (req, reply) => {
    const { file } = req.params as { file: string }
    if (!INSTALLER.test(file) || !existsSync(join(updateDir, file))) return reply.redirect('/')
    reply.header('Cache-Control', 'public, max-age=31536000')
    return reply.sendFile(file, updateDir, { cacheControl: false })
  })
}
