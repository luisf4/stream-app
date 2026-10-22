import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type DesktopCapturerSource,
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { consumeStartHidden, installIfIdle, setupUpdater } from './updater'

// "--profile=2" permite abrir uma segunda instância (com outro login) para testar.
const profile =
  process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? process.env.RESENHA_PROFILE
if (profile) app.setPath('userData', join(app.getPath('appData'), `Resenha-${profile}`))

const iconPath = join(__dirname, '../../resources/icon.png')
const isMac = process.platform === 'darwin'
// Windows: a janela (barra de tarefas) usa o ícone com fundo branco e cantos arredondados
const windowIconPath =
  process.platform === 'win32' ? join(__dirname, '../../resources/icon-win.png') : iconPath

const features: string[] = []
// macOS 13+: áudio do sistema no compartilhamento de tela via ScreenCaptureKit.
if (isMac) features.push('MacLoopbackAudioForScreenShare')
// Windows: o LiveKit negocia H.264 "constrained baseline", que sem isto pode cair no OpenH264 (CPU) —
// e aí jogo e codificador disputam o processador e o FPS da transmissão despenca nas cenas de movimento.
// Com isto o H.264 vai para a placa de vídeo (Media Foundation) quando ela suporta.
if (process.platform === 'win32') features.push('MediaFoundationH264CbpEncoding')
// só um "enable-features" vale: o último sobrescreveria os anteriores
if (features.length) app.commandLine.appendSwitch('enable-features', features.join(','))

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let closeToTray = true

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    title: 'Resenha',
    backgroundColor: '#1a1b1e',
    icon: windowIconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // mantém áudio/vídeo fluindo com a janela minimizada ou na bandeja
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: true,
    },
  })

  const startHidden = consumeStartHidden()
  // Windows: sem a barra File/Edit/View (o Alt abria ela). No Mac o menu fica: é ele que dá
  // Cmd+C/Cmd+V nos campos de texto.
  if (!isMac) win.removeMenu()

  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
  })

  // Links abrem no navegador padrão, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    }
  })

  win.on('close', (event) => {
    if (!quitting && closeToTray) {
      event.preventDefault()
      win?.hide()
      installIfIdle(win)
    }
  })
  win.on('focus', () => win?.flashFrame(false))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray() {
  const size = isMac ? 18 : 16
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: size, height: size }))
  tray.setToolTip('Resenha')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Resenha', click: showWindow },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', showWindow)
}

// ---------- compartilhamento de tela ----------

let lastSources = new Map<string, DesktopCapturerSource>()
let pendingShare: { id: string; audio: boolean } | null = null

ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  })
  lastSources = new Map(sources.map((s) => [s.id, s]))
  return sources
    .filter((s) => s.name !== 'Resenha')
    .map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      isScreen: s.id.startsWith('screen:'),
    }))
})

ipcMain.handle('screen:select', (_event, selection: { id: string; audio: boolean }) => {
  pendingShare = selection
})

function setupDisplayMedia() {
  // O renderer escolhe a fonte no nosso seletor e então chama getDisplayMedia();
  // aqui respondemos com a fonte escolhida e, se pedido, o áudio do sistema (loopback).
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const selection = pendingShare
    pendingShare = null
    const source = selection && lastSources.get(selection.id)
    if (!source) {
      callback({})
      return
    }
    callback(selection.audio ? { video: source, audio: 'loopback' } : { video: source })
  })
}

// ---------- áudio da stream sem as vozes da call (Windows) ----------
// O loopback do Electron pega todo o som do PC, inclusive as vozes que o próprio app toca (e as do
// Discord, quando a galera está em call lá), e os amigos se escutavam pela stream. O helper
// (native/audio-capture) captura tudo MENOS este processo, os filhos dele e os apps de voz abaixo,
// e manda PCM float32 48 kHz estéreo pelo stdout.

const excludedVoiceApps = ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe']

const audioHelperPath = join(__dirname, '../../resources/bin/resenha-audio.exe').replace(
  'app.asar',
  'app.asar.unpacked',
)
let audioHelper: ChildProcess | null = null

function stopAudioHelper() {
  audioHelper?.stdin?.end()
  audioHelper?.kill()
  audioHelper = null
}

ipcMain.handle('screenAudio:start', (event) => {
  stopAudioHelper()
  if (process.platform !== 'win32' || !existsSync(audioHelperPath)) return false
  const sender = event.sender
  const args = ['--exclude-pid', String(process.pid)]
  for (const name of excludedVoiceApps) args.push('--exclude-name', name)
  const child = spawn(audioHelperPath, args, { windowsHide: true })
  audioHelper = child

  return new Promise<boolean>((resolve) => {
    let ready = false
    let leftover = Buffer.alloc(0)
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      if (!ok && audioHelper === child) stopAudioHelper()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 5000)

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (!ready && text.includes('READY')) {
        ready = true
        finish(true)
      } else if (text.trim()) console.warn('[resenha-audio]', text.trim())
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!ready || sender.isDestroyed()) return
      // só manda quadros inteiros (2 canais × 4 bytes); o resto fica para o próximo pedaço
      const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      const usable = data.length - (data.length % 8)
      leftover = Buffer.from(data.subarray(usable))
      if (usable) sender.send('screenAudio:data', new Uint8Array(data.subarray(0, usable)))
    })
    child.on('error', () => finish(false))
    child.on('exit', () => {
      if (audioHelper === child) audioHelper = null
      if (!ready) finish(false)
    })
  })
})

ipcMain.on('screenAudio:stop', stopAudioHelper)

// ---------- baixar anexos do chat ----------
// O <a download> não funciona aqui (o arquivo vem de outro domínio, e o app abria o navegador):
// o download passa pelo Electron, que abre "Salvar como" já com o nome original.

const downloadNames = new Map<string, string>()

ipcMain.on('file:download', (event, { url, name }: { url: string; name: string }) => {
  if (!/^https?:\/\//i.test(url)) return
  downloadNames.set(url, name)
  event.sender.downloadURL(url)
})

function setupDownloads() {
  session.defaultSession.on('will-download', (_event, item, webContents) => {
    const url = item.getURLChain()[0] ?? item.getURL()
    const name = (downloadNames.get(url) ?? item.getFilename()).replace(/[\\/:*?"<>|]/g, '_')
    downloadNames.delete(url)
    item.setSaveDialogOptions({ title: 'Salvar arquivo', defaultPath: join(app.getPath('downloads'), name) })
    item.once('done', (_e, state) => {
      if (webContents.isDestroyed() || state === 'cancelled') return
      webContents.send('file:downloaded', { ok: state === 'completed', path: item.getSavePath() })
    })
  })
}

// ---------- atalhos globais e janela ----------

ipcMain.handle('shortcuts:set', (_event, map: Record<string, string>) => {
  globalShortcut.unregisterAll()
  const result: Record<string, boolean> = {}
  for (const [action, accelerator] of Object.entries(map)) {
    if (!accelerator) continue
    try {
      result[action] = globalShortcut.register(accelerator, () =>
        win?.webContents.send('shortcut', action),
      )
    } catch {
      result[action] = false
    }
  }
  return result
})

ipcMain.on('window:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true)
})
ipcMain.on('window:show', showWindow)
ipcMain.on('settings:closeToTray', (_event, value: boolean) => {
  closeToTray = !!value
})

// ---------- ciclo de vida ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  // macOS: clicar no ícone do Dock reabre a janela escondida na bandeja.
  app.on('activate', showWindow)
  app.whenReady().then(() => {
    if (!isMac) app.setAppUserModelId('app.resenha.desktop')
    setupDisplayMedia()
    setupDownloads()
    createWindow()
    createTray()
    setupUpdater(() => win, !!profile)
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    stopAudioHelper()
  })
  app.on('window-all-closed', () => app.quit())
}
