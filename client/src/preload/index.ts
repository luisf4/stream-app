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
  flashFrame: () => ipcRenderer.send('window:flash'),
  showWindow: () => ipcRenderer.send('window:show'),
  setCloseToTray: (value: boolean) => ipcRenderer.send('settings:closeToTray', value),
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)
