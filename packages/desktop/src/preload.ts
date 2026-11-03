/**
 * The only bridge between the chrome page and the main process.
 * No filesystem, no Node, no network: just browser commands and state.
 */

import { contextBridge, ipcRenderer } from 'electron'

interface TabState {
  id: number
  title: string
  display: string
  loading: boolean
}

interface BrowserState {
  tabs: TabState[]
  activeId: number | null
  address: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  status: string
  online: boolean
}

interface LauncherSite {
  address: string
  title: string
  source: 'pinned' | 'site' | 'directory'
  description?: string
}

const api = {
  ready(): void {
    ipcRenderer.send('browser:ready')
  },
  getState(): Promise<BrowserState | null> {
    return ipcRenderer.invoke('browser:state') as Promise<BrowserState | null>
  },
  getLauncher(): Promise<LauncherSite[]> {
    return ipcRenderer.invoke('browser:launcher') as Promise<LauncherSite[]>
  },
  navigate(input: string): void {
    ipcRenderer.send('browser:navigate', input)
  },
  action(action: string, argument?: number): void {
    ipcRenderer.send('browser:action', action, argument)
  },
  openLauncher(): void {
    ipcRenderer.send('browser:launcher', 'open')
  },
  closeLauncher(): void {
    ipcRenderer.send('browser:launcher', 'close')
  },
  onLauncherOpen(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('launcher:open', listener)
    return () => ipcRenderer.removeListener('launcher:open', listener)
  },
  onState(callback: (state: BrowserState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState): void => callback(state)
    ipcRenderer.on('browser:state', listener)
    return () => ipcRenderer.removeListener('browser:state', listener)
  },
  onFocusAddress(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('browser:focus-address', listener)
    return () => ipcRenderer.removeListener('browser:focus-address', listener)
  },
}

contextBridge.exposeInMainWorld('openweb', api)
