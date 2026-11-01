// Runs scans off the main thread so the UI never blocks. Opens its own DB connection;
// WAL mode lets the main process keep reading while this one writes.

import { parentPort, workerData } from 'node:worker_threads'
import { openDb } from '../db'
import { scanRoot } from './scanner'
import type { ScanEvent } from '../../shared/types'

const { dbPath, rootIds } = workerData as { dbPath: string; rootIds: number[] }
const post = (e: ScanEvent): void => parentPort!.postMessage(e)

async function run(): Promise<void> {
  const db = openDb(dbPath)
  try {
    for (const rootId of rootIds) {
      const root = db.prepare('SELECT path FROM roots WHERE id = ?').get(rootId) as { path: string } | undefined
      if (!root) continue
      post({ type: 'start', rootId, path: root.path })
      try {
        const summary = await scanRoot(db, rootId, {
          onProgress: (found, processed, current) => post({ type: 'progress', rootId, found, processed, current })
        })
        post({ type: 'rootDone', rootId, summary })
      } catch (err) {
        post({ type: 'error', rootId, message: err instanceof Error ? err.message : String(err) })
      }
    }
  } finally {
    db.close()
    post({ type: 'done' })
  }
}

run()
