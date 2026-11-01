// Runs the duplicate finder off the main thread, with its own DB connection (like the scan worker).

import { parentPort, workerData } from 'node:worker_threads'
import { openDb } from '../db'
import type { DupeEvent } from '../../shared/types'
import { findDuplicates } from './finder'

const { dbPath } = workerData as { dbPath: string }
const post = (e: DupeEvent): void => parentPort!.postMessage(e)

async function run(): Promise<void> {
  const db = openDb(dbPath)
  try {
    const summary = await findDuplicates(db, { onProgress: (stage, done, total) => post({ type: 'progress', stage, done, total }) })
    post({ type: 'done', groups: summary.groups })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    db.close()
  }
}

run()
