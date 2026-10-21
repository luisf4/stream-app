import { app, ipcMain, Notification, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Atualização automática, só no Windows: no Mac a troca do app exige assinatura paga da Apple.
// Os instaladores ficam no próprio servidor (/api/updates, protegido pela senha embutida no app);
// o GitHub Actions publica uma versão nova a cada push na main que mexe em client/.
// A versão nova baixa em segundo plano e é instalada (nunca no meio de uma call):
// - logo depois de abrir o app, como o Discord (a pessoa ainda nem começou a usar);
// - quando o app está escondido na bandeja;
// - quando a pessoa sai do app, ou clica em "Reiniciar e instalar".

const CHECK_EVERY_MS = 10 * 60 * 1000
/** atualização que termina de baixar até este tempo depois de abrir o app instala na hora */
const INSTALL_ON_START_MS = 2 * 60 * 1000
const startedAt = Date.now()

/** versão nova já baixada, esperando instalar */
let readyVersion: string | null = null
let inVoice = false

/** O que a tela de configurações mostra em "Atualizações". */
export type UpdateState =
  | { state: 'unsupported' }
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

let updateState: UpdateState = { state: 'idle' }
let sendState: (state: UpdateState) => void = () => {}
function setState(next: UpdateState) {
  updateState = next
  sendState(next)
}

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
  // a tela pode abrir (ou recarregar) depois do download: pergunta se já tem versão esperando
  ipcMain.handle('update:pending', () => readyVersion)
  ipcMain.handle('update:state', () => updateState)
  // botão "Procurar atualização"
  ipcMain.handle('update:check', () => {
    if (updateState.state !== 'unsupported' && updateState.state !== 'ready') check()
    return updateState
  })
  sendState = (state) => getWindow()?.webContents.send('update:state', state)

  const url = feedUrl()
  const password = import.meta.env.VITE_SERVER_PASSWORD
  if (process.platform !== 'win32' || !app.isPackaged || testProfile || !url || !password) {
    updateState = { state: 'unsupported' }
    return
  }

  // %APPDATA%\Resenha\logs\updater.log: o que o atualizador fez (o console some no app instalado)
  const logDir = app.getPath('logs')
  mkdirSync(logDir, { recursive: true })
  const write = (level: string) => (...args: unknown[]) => {
    try {
      appendFileSync(join(logDir, 'updater.log'), `${new Date().toISOString()} ${level} ${args.join(' ')}\n`)
    } catch {
      // sem disco: segue sem log
    }
  }
  autoUpdater.logger = { info: write('info'), warn: write('warn'), error: write('error'), debug: () => {} }

  // useMultipleRangeRequest: o servidor só responde uma faixa por pedido (206). Pedindo várias de
  // uma vez ele mandava o arquivo inteiro, o download só das partes que mudaram falhava e o app
  // baixava o instalador completo duas vezes.
  autoUpdater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false })
  autoUpdater.requestHeaders = { 'X-Resenha-Password': encodeURIComponent(password) }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    if (!readyVersion) setState({ state: 'checking' })
  })
  autoUpdater.on('update-not-available', () => setState({ state: 'none' }))
  autoUpdater.on('update-available', (info) => {
    if (info.version !== readyVersion) setState({ state: 'downloading', version: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (progress) => {
    if (updateState.state === 'downloading') {
      setState({ ...updateState, percent: Math.round(progress.percent) })
    }
  })
  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message)
    if (!readyVersion) setState({ state: 'error', message: err.message })
  })
  autoUpdater.on('update-downloaded', (info) => {
    // checagens seguintes acham a mesma versão já baixada: não avisa de novo
    if (info.version === readyVersion) return
    readyVersion = info.version
    setState({ state: 'ready', version: info.version })
    const win = getWindow()
    win?.webContents.send('update:ready', info.version)
    if (!inVoice && Date.now() - startedAt < INSTALL_ON_START_MS) {
      autoUpdater.logger?.info(`instalando ${info.version} logo depois de abrir o app`)
      install(!win?.isVisible())
      return
    }
    if (!installIfIdle(win)) notifyReady(info.version, getWindow)
  })

  check()
  setInterval(check, CHECK_EVERY_MS)
}

function check() {
  void autoUpdater.checkForUpdates().catch(() => {})
}

/** Notificação do Windows (canto de baixo da tela): clicar instala na hora. */
function notifyReady(version: string, getWindow: () => BrowserWindow | null) {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: 'Atualização do Resenha pronta',
    body: inVoice
      ? `Versão ${version} baixada. Clique para instalar agora (sai da call) ou ela instala depois da voz.`
      : `Versão ${version} baixada. Clique para reiniciar e instalar.`,
  })
  notification.on('click', () => {
    if (inVoice) {
      // no meio da call só abre o app; o aviso lá dentro tem o botão para instalar
      const win = getWindow()
      win?.show()
      win?.focus()
    } else {
      install()
    }
  })
  notification.show()
}

/** Chamado quando a janela some (bandeja) ou a pessoa sai da voz. true = está instalando. */
export function installIfIdle(win: BrowserWindow | null): boolean {
  if (!readyVersion || inVoice || (win && win.isVisible())) return false
  install(true)
  return true
}

function install(hidden = false) {
  if (!readyVersion) return
  if (hidden) writeFileSync(hiddenMarker(), '')
  // silencioso (sem a tela do instalador) e reabre o app no fim
  autoUpdater.quitAndInstall(true, true)
}
