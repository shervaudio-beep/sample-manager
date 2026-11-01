import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import path from 'node:path'
import type { Worker } from 'node:worker_threads'
import createScanWorker from './scan/worker?nodeWorker'
import createDupeWorker from './dupes/worker?nodeWorker'
import {
  addRoot,
  addTags,
  addToCollection,
  collectionsForFiles,
  createCollection,
  deleteCollection,
  duplicatesOf,
  extraCopyIds,
  forgetFiles,
  mergeFileData,
  planTrash,
  idsForPaths,
  listCollections,
  removeFromCollection,
  renameCollection,
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
  resetAnalysis,
  saveWaveform,
  tagsForFiles,
  updateFiles,
  type Db,
  type Waveform
} from './db'
import { AudioAnalyzer } from './analysis'
import { AUDIO_SCHEME, handleAudioProtocol, registerAudioScheme, startFileDrag } from './playback'
import type { DupeEvent, FilePatch, FileQuery, FileRow, ScanEvent } from '../shared/types'

let db: Db
let win: BrowserWindow | null = null
let scanWorker: Worker | null = null
let queuedRoots = new Set<number>()
let dupeWorker: Worker | null = null
let analyzer: AudioAnalyzer
let dupeAgain = false

// One library folder whether run from source or installed: a packaged app would otherwise be
// named "Sample Manager" and look in a different folder. Test runs can point elsewhere.
app.setName('Sample Manager')
app.setPath('userData', process.env.SAMPLE_MANAGER_DATA_DIR ?? path.join(app.getPath('appData'), 'sample-manager'))

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

/** Tell the UI the index changed outside its own calls (e.g. from the file menu). */
const libraryChanged = (detail: { renameCollectionId?: number; notice?: string } = {}): void =>
  win?.webContents.send('library:changed', detail)

/** Right-click menu for files in the list. */
function showFileMenu(sender: Electron.WebContents, ids: number[], ctx: { collectionId?: number; duplicates?: boolean }): void {
  if (!ids.length) return
  const n = ids.length
  const collections = listCollections(db)
  const current = collections.find((c) => c.id === ctx.collectionId)
  const first = getFile(db, ids[0])
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Add to Collection',
      submenu: [
        ...collections.map((c) => ({
          label: c.name,
          click: () => {
            addToCollection(db, c.id, ids)
            libraryChanged()
          }
        })),
        ...(collections.length ? [{ type: 'separator' as const }] : []),
        {
          label: `New Collection with ${n === 1 ? 'This File' : `These ${n} Files`}`,
          click: () => {
            const c = createCollection(db, 'New Collection', ids)
            libraryChanged({ renameCollectionId: c.id })
          }
        }
      ]
    }
  ]
  if (current) {
    template.push({
      label: `Remove from “${current.name}”`,
      toolTip: 'Only removes it from this collection. The file stays in your library and on disk.',
      click: () => {
        removeFromCollection(db, current.id, ids)
        libraryChanged()
      }
    })
  }
  template.push({
    label: n === 1 ? 'Detect BPM and Key Again' : `Detect BPM and Key Again for ${n} Files`,
    click: () => {
      resetAnalysis(db, ids)
      void analyzer.run()
    }
  })
  if (ctx.duplicates) {
    template.push({
      label: `Move to ${binName()}…`,
      click: () => void trashAndReport(ids)
    })
  }
  template.push(
    { type: 'separator' },
    { label: process.platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder', enabled: !!first, click: () => first && shell.showItemInFolder(first.path) },
    {
      label: n === 1 ? 'Copy File Path' : `Copy ${n} File Paths`,
      click: () => {
        const paths = ids.map((id) => getFile(db, id)?.path).filter(Boolean)
        clipboard.writeText(paths.join('\n'))
      }
    }
  )
  const owner = BrowserWindow.fromWebContents(sender)
  Menu.buildFromTemplate(template).popup(owner ? { window: owner } : undefined)
}

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
    } else {
      startDupeCheck()
    }
  })
}

/** Look for duplicates among new or changed files, in the background. */
function startDupeCheck(): void {
  if (dupeWorker) {
    dupeAgain = true
    return
  }
  dupeWorker = createDupeWorker({ workerData: { dbPath: dbPath() } })
  const sendDupe = (e: DupeEvent): void => win?.webContents.send('dupes:event', e)
  let finished = false
  dupeWorker.on('message', (e: DupeEvent) => {
    if (e.type !== 'progress') finished = true
    sendDupe(e)
  })
  dupeWorker.on('error', (err: Error) => sendDupe({ type: 'error', message: err.message }))
  dupeWorker.on('exit', () => {
    dupeWorker = null
    if (!finished) sendDupe({ type: 'done', groups: -1 })
    if (dupeAgain) {
      dupeAgain = false
      startDupeCheck()
    } else {
      // Then listen for tempo and key in anything new.
      void analyzer.run()
    }
  })
}

function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const binName = (): string => (process.platform === 'darwin' ? 'Trash' : 'Recycle Bin')

/**
 * Send extra copies of duplicate sounds to the Recycle Bin/Trash, after the user confirms in a
 * native dialog. Never touches the last copy of a sound; the kept copy inherits tags, rating,
 * notes and collections first. Files go to the bin, so they can be restored.
 */
async function trashDuplicates(ids: number[]): Promise<{ trashed: number; failed: string[]; freed: number } | null> {
  const plan = planTrash(db, ids)
  if ('error' in plan) {
    await dialog.showMessageBox(win!, { type: 'info', message: 'Nothing was removed', detail: plan.error })
    return null
  }
  const items = plan.items
  if (!items.length) return null
  const total = items.reduce((n, i) => n + i.size, 0)
  const shown = items.slice(0, 8).map((i) => '• ' + i.path)
  if (items.length > 8) shown.push(`…and ${items.length - 8} more`)
  const n = items.length === 1 ? 'this duplicate file' : `these ${items.length} duplicate files`
  const { response } = await dialog.showMessageBox(win!, {
    type: 'warning',
    title: 'Remove duplicate copies',
    message: `Move ${n} to the ${binName()}?`,
    detail:
      shown.join('\n') +
      `\n\nThis frees ${formatBytes(total)}. One copy of each sound stays where it is and keeps these copies' ` +
      `tags, ratings, notes and collections. You can restore the files from the ${binName()}.`,
    buttons: ['Cancel', `Move to ${binName()}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (response !== 1) return null

  let trashed = 0
  let freed = 0
  const failed: string[] = []
  for (const item of items) {
    try {
      await shell.trashItem(item.path)
    } catch {
      failed.push(item.name)
      continue
    }
    mergeFileData(db, item.id, item.keeperId)
    forgetFiles(db, [item.id])
    trashed++
    freed += item.size
  }
  return { trashed, failed, freed }
}

async function trashAndReport(ids: number[]): Promise<void> {
  const r = await trashDuplicates(ids)
  if (!r) return
  const notice =
    `Moved ${r.trashed === 1 ? '1 file' : `${r.trashed} files`} to the ${binName()} (${formatBytes(r.freed)} freed)` +
    (r.failed.length ? `. Couldn't move: ${r.failed.join(', ')}` : '')
  libraryChanged({ notice })
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
  ipcMain.handle('collections:list', () => listCollections(db))
  ipcMain.handle('collections:create', (_e, name: string, ids: number[] = []) => createCollection(db, name, ids))
  ipcMain.handle('collections:rename', (_e, id: number, name: string) => renameCollection(db, id, name))
  ipcMain.handle('collections:delete', (_e, id: number) => deleteCollection(db, id))
  ipcMain.handle('collections:add', (_e, id: number, ids: number[]) => addToCollection(db, id, ids))
  ipcMain.handle('collections:addPaths', (_e, id: number, paths: string[]) => {
    const ids = idsForPaths(db, paths)
    addToCollection(db, id, ids)
    return ids.length
  })
  ipcMain.handle('collections:remove', (_e, id: number, ids: number[]) => removeFromCollection(db, id, ids))
  ipcMain.handle('collections:forFiles', (_e, ids: number[]) => collectionsForFiles(db, ids))
  ipcMain.on('menu:files', (e, ids: number[], ctx: { collectionId?: number; duplicates?: boolean }) => showFileMenu(e.sender, ids, ctx ?? {}))
  ipcMain.handle('analysis:running', () => analyzer.busy)
  ipcMain.handle('dupes:check', () => startDupeCheck())
  ipcMain.handle('dupes:running', () => dupeWorker != null)
  ipcMain.handle('dupes:extraIds', (_e, q: Partial<FileQuery>) => extraCopyIds(db, q))
  ipcMain.handle('dupes:of', (_e, id: number) => duplicatesOf(db, id))
  ipcMain.handle('dupes:trash', (_e, ids: number[]) => trashAndReport(ids))
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
  analyzer = new AudioAnalyzer(
    () => db,
    (e) => win?.webContents.send('analysis:event', e),
    (id) => `${AUDIO_SCHEME}://file/${id}`
  )
  createWindow()
  // Catch up on anything not yet checked (e.g. a library from before duplicate finding).
  win!.webContents.once('did-finish-load', () => startDupeCheck())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  scanWorker?.terminate()
  dupeWorker?.terminate()
  analyzer?.stop()
  db?.close()
})
