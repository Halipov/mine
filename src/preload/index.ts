import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BootState,
  PackManifest,
  Progress,
  Settings,
  UpdateInfo
} from '@shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  boot: (): Promise<BootState> => ipcRenderer.invoke('boot'),
  refreshManifest: (): Promise<{ manifest: PackManifest | null; error: string | null }> =>
    ipcRenderer.invoke('manifest:refresh'),
  saveSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:save', patch),
  addProfile: (name: string): Promise<Settings> => ipcRenderer.invoke('profile:add', name),
  removeProfile: (id: string): Promise<Settings> => ipcRenderer.invoke('profile:remove', id),
  selectProfile: (id: string): Promise<Settings> => ipcRenderer.invoke('profile:select', id),
  launch: (directJoin: boolean): Promise<void> =>
    ipcRenderer.invoke('game:launch', { directJoin }),
  kill: (): Promise<void> => ipcRenderer.invoke('game:kill'),
  openFolder: (): Promise<void> => ipcRenderer.invoke('folder:open'),
  checkUpdate: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('update:check'),
  applyUpdate: (info: UpdateInfo): Promise<void> => ipcRenderer.invoke('update:apply', info),
  onProgress: (cb: (progress: Progress) => void): (() => void) => subscribe('progress', cb),
  onLog: (cb: (line: string) => void): (() => void) => subscribe('log', cb)
}

export type LauncherApi = typeof api

contextBridge.exposeInMainWorld('launcher', api)
