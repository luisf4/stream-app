import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface ScreenSource {
  id: string
  name: string
  thumbnail: string
  icon: string | null
  isScreen: boolean
}

const api = {
  getScreenSources: (): Promise<ScreenSource[]> => ipcRenderer.invoke('screen:sources'),
  selectScreenSource: (id: string, audio: boolean): Promise<void> =>
    ipcRenderer.invoke('screen:select', { id, audio }),
  setShortcuts: (map: Record<string, string>): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke('shortcuts:set', map),
  onShortcut: (callback: (action: string) => void) => {
    const listener = (_event: IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('shortcut', listener)
    return () => {
      ipcRenderer.removeListener('shortcut', listener)
    }
  },
  /** Windows: começa a capturar o som do PC sem o do app. false = indisponível (usar o loopback). */
  startScreenAudio: (): Promise<boolean> => ipcRenderer.invoke('screenAudio:start'),
  stopScreenAudio: () => ipcRenderer.send('screenAudio:stop'),
  onScreenAudio: (callback: (pcm: Uint8Array) => void) => {
    const listener = (_event: IpcRendererEvent, pcm: Uint8Array) => callback(pcm)
    ipcRenderer.on('screenAudio:data', listener)
    return () => {
      ipcRenderer.removeListener('screenAudio:data', listener)
    }
  },
  /** Abre "Salvar como" para um anexo do chat. */
  downloadFile: (url: string, name: string) => ipcRenderer.send('file:download', { url, name }),
  onFileDownloaded: (callback: (result: { ok: boolean; path: string }) => void) => {
    const listener = (_event: IpcRendererEvent, result: { ok: boolean; path: string }) => callback(result)
    ipcRenderer.on('file:downloaded', listener)
    return () => {
      ipcRenderer.removeListener('file:downloaded', listener)
    }
  },
  flashFrame: () => ipcRenderer.send('window:flash'),
  showWindow: () => ipcRenderer.send('window:show'),
  setCloseToTray: (value: boolean) => ipcRenderer.send('settings:closeToTray', value),
  /** Avisa o processo principal se está numa call (a atualização automática espera sair). */
  setInVoice: (value: boolean) => ipcRenderer.send('voice:active', value),
  /** Versão nova baixada e pronta para instalar (só Windows). */
  onUpdateReady: (callback: (version: string) => void) => {
    const listener = (_event: IpcRendererEvent, version: string) => callback(version)
    ipcRenderer.on('update:ready', listener)
    return () => {
      ipcRenderer.removeListener('update:ready', listener)
    }
  },
  installUpdate: () => ipcRenderer.send('update:install'),
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
