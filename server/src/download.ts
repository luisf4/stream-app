import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { config, updateDir } from './config.js'

// Página pública de download (https://DOMINIO/): sempre o último instalador do Windows publicado
// pelo GitHub Actions (o mesmo da atualização automática).

const INSTALLER = /^Resenha-Setup-[\d.]+\.exe$/
// cópia de client/resources/icon.png em 256 px (o build do servidor não enxerga a pasta do client)
const publicDir = join(import.meta.dirname, '../public')

interface Release {
  version: string
  file: string
  sizeMb: number
}

function latest(): Release | null {
  const manifest = join(updateDir, 'latest.yml')
  if (!existsSync(manifest)) return null
  const text = readFileSync(manifest, 'utf8')
  const version = text.match(/^version:\s*(\S+)/m)?.[1]
  const file = text.match(/^path:\s*(\S+)/m)?.[1]
  if (!version || !file || !INSTALLER.test(file)) return null
  const size = statSync(join(updateDir, file), { throwIfNoEntry: false })?.size
  if (size === undefined) return null
  return { version, file, sizeMb: Math.round(size / 1024 / 1024) }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const DOWNLOAD_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`

function page(release: Release | null): string {
  const name = escapeHtml(config.serverName)
  const download = release
    ? `<a class="btn" href="/download">${DOWNLOAD_ICON}Baixar para Windows</a>
      <p class="meta">Versão ${escapeHtml(release.version)} · ${release.sizeMb} MB · Windows 10 e 11</p>`
    : `<p class="meta">Nenhuma versão publicada ainda. Volte daqui a pouco.</p>`
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<meta name="description" content="Voz, vídeo, tela e chat para a galera do churras.">
<link rel="icon" href="/icon.png">
<style>
  :root {
    color-scheme: dark;
    --bg: #1e1f22; --card: #2b2d31; --line: #3f4147;
    --text: #dbdee1; --strong: #f2f3f5; --muted: #949ba4;
    --accent: #5865f2; --accent-hover: #4752c4;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
    background: radial-gradient(ellipse at top, #2a2c4a 0%, var(--bg) 60%) fixed, var(--bg);
    color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: 100%; max-width: 420px; text-align: center; }
  .logo { width: 128px; height: 128px; filter: drop-shadow(0 8px 24px rgb(0 0 0 / 0.45)); }
  h1 { margin: 8px 0 4px; color: var(--strong); font-size: 36px; letter-spacing: -0.02em; }
  .tagline { margin: 0 0 28px; color: var(--muted); }
  .btn {
    display: inline-flex; align-items: center; gap: 10px; padding: 14px 28px; border-radius: 10px;
    background: var(--accent); color: #fff; font-weight: 600; font-size: 17px; text-decoration: none;
    box-shadow: 0 6px 20px rgb(88 101 242 / 0.35); transition: background 0.15s, transform 0.15s;
  }
  .btn:hover { background: var(--accent-hover); transform: translateY(-1px); }
  .btn:focus-visible { outline: 2px solid var(--strong); outline-offset: 3px; }
  .meta { margin: 12px 0 0; color: var(--muted); font-size: 14px; }
  .hint { margin: 32px 0 0; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
  <main>
    <img class="logo" src="/icon.png" alt="" width="128" height="128">
    <h1>${name}</h1>
    <p class="tagline">Voz, vídeo, tela e chat para a galera do churras.</p>
    ${download}
    <p class="hint">Se aparecer "O Windows protegeu o computador", clique em
      <strong>Mais informações</strong> e depois em <strong>Executar assim mesmo</strong>.</p>
  </main>
</body>
</html>`
}

export function registerDownloadPage(app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8')
    return page(latest())
  })

  app.get('/icon.png', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.sendFile('icon.png', publicDir, { cacheControl: false })
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
