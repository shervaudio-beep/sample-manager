import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import createScanWorker from './scan/worker?nodeWorker'
import {
  addRoot,
  addTags,
  countFiles,
  getFile,
  getWaveform,
  libraryCounts,
  listRoots,
  listTags,
  openDb,
  queryFiles,
  queryIds,
  removeRoot,
  removeTags,
  saveWaveform,
  tagsForFiles,
  updateFiles,
  type Db,
  type Waveform
} from './db'
import { handleAudioProtocol, registerAudioScheme, startFileDrag } from './playback'
import type { FilePatch, FileQuery, FileRow, ScanEvent } from '../shared/types'

let db: Db
let win: BrowserWindow | null = null
let scanWorker: Worker | null = null
let queuedRoots = new Set<number>()

// Lets test runs use a throwaway library instead of your real one.
if (process.env.SAMPLE_MANAGER_DATA_DIR) app.setPath('userData', process.env.SAMPLE_MANAGER_DATA_DIR)

registerAudioScheme()

const dbPath = (): string => path.join(app.getPath('userData'), 'library.db')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#0e0f12',
    title: 'Sample Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('closed', () => (win = null))
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
}

const send = (e: ScanEvent): void => win?.webContents.send('scan:event', e)

function startScan(rootIds: number[]): void {
  if (scanWorker) {
    // One scan at a time; anything requested meanwhile runs right after.
    rootIds.forEach((id) => queuedRoots.add(id))
    return
  }
  scanWorker = createScanWorker({ workerData: { dbPath: dbPath(), rootIds } })
  scanWorker.on('message', (e: ScanEvent) => {
    if (e.type === 'done') return // sent once the worker has actually exited
    send(e)
  })
  scanWorker.on('error', (err: Error) => send({ type: 'error', message: err.message }))
  scanWorker.on('exit', () => {
    scanWorker = null
    send({ type: 'done' })
    if (queuedRoots.size) {
      const next = [...queuedRoots]
      queuedRoots = new Set()
      startScan(next)
    }
  })
}

function registerIpc(): void {
  ipcMain.handle('roots:list', () => listRoots(db))
  ipcMain.handle('roots:add', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Add library folders',
      properties: ['openDirectory', 'multiSelections']
    })
    if (res.canceled) return []
    const added = res.filePaths.map((p) => addRoot(db, path.resolve(p)))
    startScan(added.map((r) => r.id))
    return added
  })
  ipcMain.handle('roots:remove', (_e, id: number) => removeRoot(db, id))
  ipcMain.handle('scan:start', (_e, rootIds?: number[]) => {
    startScan(rootIds ?? listRoots(db).map((r) => r.id))
  })
  ipcMain.handle('scan:running', () => scanWorker != null)
  ipcMain.handle('files:query', (_e, q: FileQuery) => queryFiles(db, q))
  ipcMain.handle('files:count', (_e, q: Partial<FileQuery>) => countFiles(db, q))
  ipcMain.handle('files:get', (_e, id: number) => getFile(db, id))
  ipcMain.handle('files:ids', (_e, q: Parameters<typeof queryIds>[1]) => queryIds(db, q))
  ipcMain.handle('files:update', (_e, ids: number[], patch: FilePatch) => updateFiles(db, ids, patch))
  ipcMain.handle('tags:list', () => listTags(db))
  ipcMain.handle('tags:forFiles', (_e, ids: number[]) => tagsForFiles(db, ids))
  ipcMain.handle('tags:add', (_e, ids: number[], names: string[]) => addTags(db, ids, names))
  ipcMain.handle('tags:remove', (_e, ids: number[], names: string[]) => removeTags(db, ids, names))
  ipcMain.handle('library:counts', () => libraryCounts(db))
  ipcMain.handle('waveform:get', (_e, id: number) => getWaveform(db, id))
  ipcMain.handle('waveform:save', (_e, id: number, wf: Waveform) => saveWaveform(db, id, wf))
  ipcMain.on('drag:start', (e, ids: number[]) => {
    const files = ids.map((id) => getFile(db, id)).filter((f): f is FileRow => f != null)
    startFileDrag(e.sender, files)
  })
  ipcMain.handle('files:reveal', (_e, id: number) => {
    const f = getFile(db, id)
    if (f) shell.showItemInFolder(f.path)
  })
}

app.whenReady().then(() => {
  db = openDb(dbPath())
  registerIpc()
  handleAudioProtocol((id) => getFile(db, id))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  scanWorker?.terminate()
  db?.close()
})
