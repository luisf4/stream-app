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
import { join } from 'node:path'

// "--profile=2" permite abrir uma segunda instância (com outro login) para testar.
const profile =
  process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] ?? process.env.RESENHA_PROFILE
if (profile) app.setPath('userData', join(app.getPath('appData'), `Resenha-${profile}`))

const iconPath = join(__dirname, '../../resources/icon.png')

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
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    icon: iconPath,
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

  win.once('ready-to-show', () => win?.show())

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
    }
  })
  win.on('focus', () => win?.flashFrame(false))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
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
  app.whenReady().then(() => {
    app.setAppUserModelId('app.resenha.desktop')
    setupDisplayMedia()
    createWindow()
    createTray()
  })
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('window-all-closed', () => app.quit())
}
