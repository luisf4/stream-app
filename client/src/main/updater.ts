import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Atualização automática, só no Windows: no Mac a troca do app exige assinatura paga da Apple.
// Os instaladores ficam no próprio servidor (/api/updates, protegido pela senha embutida no app);
// o GitHub Actions publica uma versão nova a cada push na main que mexe em client/.
// A versão nova baixa em segundo plano e é instalada quando a pessoa sai do app, ou sozinha quando
// o app está escondido na bandeja e fora da voz (para nunca derrubar uma call).

const CHECK_EVERY_MS = 60 * 60 * 1000

let ready = false
let inVoice = false

// Atualizou sozinho com o app na bandeja: reabre lá mesmo, sem a janela pular na tela.
const hiddenMarker = () => join(app.getPath('userData'), 'update-hidden')

/** true (uma vez) se o app acabou de ser reaberto por uma atualização feita na bandeja. */
export function consumeStartHidden(): boolean {
  const marker = hiddenMarker()
  const created = statSync(marker, { throwIfNoEntry: false })?.mtimeMs
  if (created === undefined) return false
  rmSync(marker, { force: true })
  // marca velha = a instalação falhou e a pessoa abriu o app depois: mostra a janela
  return Date.now() - created < 5 * 60 * 1000
}

function feedUrl(): string | null {
  const server = import.meta.env.VITE_SERVER_URL?.trim().replace(/\/+$/, '')
  if (!server) return null
  return `${/^https?:\/\//i.test(server) ? server : `https://${server}`}/api/updates`
}

export function setupUpdater(getWindow: () => BrowserWindow | null, testProfile: boolean) {
  ipcMain.on('voice:active', (_event, value: boolean) => {
    inVoice = !!value
    installIfIdle(getWindow())
  })
  ipcMain.on('update:install', () => install())

  const url = feedUrl()
  const password = import.meta.env.VITE_SERVER_PASSWORD
  if (process.platform !== 'win32' || !app.isPackaged || testProfile || !url || !password) return

  autoUpdater.setFeedURL({ provider: 'generic', url })
  autoUpdater.requestHeaders = { 'X-Resenha-Password': encodeURIComponent(password) }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => console.warn('[updater]', err.message))
  autoUpdater.on('update-downloaded', (info) => {
    ready = true
    const win = getWindow()
    win?.webContents.send('update:ready', info.version)
    installIfIdle(win)
  })

  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, CHECK_EVERY_MS)
}

/** Chamado quando a janela some (bandeja) ou a pessoa sai da voz. */
export function installIfIdle(win: BrowserWindow | null) {
  if (ready && !inVoice && (!win || !win.isVisible())) install(true)
}

function install(hidden = false) {
  if (!ready) return
  if (hidden) writeFileSync(hiddenMarker(), '')
  // silencioso (sem a tela do instalador) e reabre o app no fim
  autoUpdater.quitAndInstall(true, true)
}
