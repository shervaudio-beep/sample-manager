import { contextBridge, ipcRenderer } from 'electron'
import type { FilePatch, FileQuery, FileRow, LibraryCounts, Root, ScanEvent, TagInfo } from '../shared/types'
import type { Waveform } from '../main/db'

const api = {
  listRoots: (): Promise<Root[]> => ipcRenderer.invoke('roots:list'),
  addRoots: (): Promise<Root[]> => ipcRenderer.invoke('roots:add'),
  removeRoot: (id: number): Promise<void> => ipcRenderer.invoke('roots:remove', id),
  startScan: (rootIds?: number[]): Promise<void> => ipcRenderer.invoke('scan:start', rootIds),
  isScanning: (): Promise<boolean> => ipcRenderer.invoke('scan:running'),
  queryFiles: (q: FileQuery): Promise<FileRow[]> => ipcRenderer.invoke('files:query', q),
  countFiles: (q: Partial<FileQuery>): Promise<number> => ipcRenderer.invoke('files:count', q),
  getFile: (id: number): Promise<FileRow | null> => ipcRenderer.invoke('files:get', id),
  queryIds: (q: Omit<FileQuery, 'offset' | 'limit'> & { offset?: number; limit?: number }): Promise<number[]> =>
    ipcRenderer.invoke('files:ids', q),
  updateFiles: (ids: number[], patch: FilePatch): Promise<void> => ipcRenderer.invoke('files:update', ids, patch),
  listTags: (): Promise<TagInfo[]> => ipcRenderer.invoke('tags:list'),
  tagsForFiles: (ids: number[]): Promise<TagInfo[]> => ipcRenderer.invoke('tags:forFiles', ids),
  addTags: (ids: number[], names: string[]): Promise<void> => ipcRenderer.invoke('tags:add', ids, names),
  removeTags: (ids: number[], names: string[]): Promise<void> => ipcRenderer.invoke('tags:remove', ids, names),
  counts: (): Promise<LibraryCounts> => ipcRenderer.invoke('library:counts'),
  revealFile: (id: number): Promise<void> => ipcRenderer.invoke('files:reveal', id),
  getWaveform: (id: number): Promise<Waveform | null> => ipcRenderer.invoke('waveform:get', id),
  saveWaveform: (id: number, wf: Waveform): Promise<void> => ipcRenderer.invoke('waveform:save', id, wf),
  startDrag: (ids: number[]): void => ipcRenderer.send('drag:start', ids),
  audioUrl: (id: number): string => `sm-audio://file/${id}`,
  onScanEvent: (cb: (e: ScanEvent) => void): (() => void) => {
    const listener = (_: unknown, e: ScanEvent): void => cb(e)
    ipcRenderer.on('scan:event', listener)
    return () => ipcRenderer.removeListener('scan:event', listener)
  }
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
