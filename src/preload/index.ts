import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Collection, FilePatch, FileQuery, FileRow, LibraryCounts, Root, ScanEvent, TagInfo } from '../shared/types'
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
  listCollections: (): Promise<Collection[]> => ipcRenderer.invoke('collections:list'),
  createCollection: (name: string, ids?: number[]): Promise<Collection> => ipcRenderer.invoke('collections:create', name, ids),
  renameCollection: (id: number, name: string): Promise<void> => ipcRenderer.invoke('collections:rename', id, name),
  deleteCollection: (id: number): Promise<void> => ipcRenderer.invoke('collections:delete', id),
  addToCollection: (id: number, ids: number[]): Promise<void> => ipcRenderer.invoke('collections:add', id, ids),
  /** Files dropped from Explorer/Finder: only ones already in the library are added. Returns how many. */
  addDroppedToCollection: (id: number, files: File[]): Promise<number> =>
    ipcRenderer.invoke('collections:addPaths', id, files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  removeFromCollection: (id: number, ids: number[]): Promise<void> => ipcRenderer.invoke('collections:remove', id, ids),
  collectionsForFiles: (ids: number[]): Promise<Collection[]> => ipcRenderer.invoke('collections:forFiles', ids),
  showFileMenu: (ids: number[], ctx: { collectionId?: number }): void => ipcRenderer.send('menu:files', ids, ctx),
  onLibraryChanged: (cb: (detail: { renameCollectionId?: number }) => void): (() => void) => {
    const listener = (_: unknown, d: { renameCollectionId?: number }): void => cb(d)
    ipcRenderer.on('library:changed', listener)
    return () => ipcRenderer.removeListener('library:changed', listener)
  },
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
