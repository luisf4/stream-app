// Compila native/audio-capture/AudioCapture.cs em resources/bin/resenha-audio.exe usando o
// compilador C# do .NET Framework 4, que já vem instalado em todo Windows 10/11.
// Fora do Windows não faz nada (o helper só existe lá).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const csc = join(process.env.WINDIR ?? 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(csc)) {
  console.warn(`[audio-helper] csc.exe não encontrado em ${csc}; a stream vai usar o loopback antigo`)
  process.exit(0)
}

const source = join(root, 'native', 'audio-capture', 'AudioCapture.cs')
const out = join(root, 'resources', 'bin', 'resenha-audio.exe')
// já atualizado: não recompila (e não tenta sobrescrever o exe se outra instância estiver usando)
if (existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs) process.exit(0)
mkdirSync(dirname(out), { recursive: true })
execFileSync(
  csc,
  [
    '/nologo',
    '/optimize+',
    '/platform:anycpu',
    '/target:exe',
    `/out:${out}`,
    source,
  ],
  { stdio: 'inherit' },
)
console.log(`[audio-helper] ${out}`)
