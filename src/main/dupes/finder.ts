// Finds files whose audio is byte-for-byte the same, whatever their names, folders or tags.
// Staged so a big library only reads what it has to:
//   1. locate the audio inside each file (a few KB read per file, done once)
//   2. files whose audio length is unique can't have a duplicate and are skipped
//   3. same-length files get a quick hash of their first and last 64 KB
//   4. only quick-hash matches are hashed in full
// Results are cached per file and cleared when the file changes, so re-runs are cheap.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { Db } from '../db'
import { audioSpan, type AudioSpan } from './audioSpan'

const EDGE = 64 * 1024

export type DupeStage = 'locating' | 'comparing' | 'verifying'

export interface DupeSummary {
  located: number
  quickHashed: number
  fullyHashed: number
  groups: number
}

interface Options {
  onProgress?: (stage: DupeStage, done: number, total: number) => void
  concurrency?: number
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
}

/** Hash of the whole span when it's small, otherwise of its length plus first and last 64 KB. */
async function quickHash(path: string, span: AudioSpan): Promise<{ quick: string; full: string | null }> {
  const fh = await open(path, 'r')
  try {
    if (span.length <= EDGE * 2) {
      const buf = Buffer.alloc(span.length)
      await fh.read(buf, 0, span.length, span.offset)
      const full = createHash('sha256').update(buf).digest('hex')
      return { quick: full, full }
    }
    const head = Buffer.alloc(EDGE)
    const tail = Buffer.alloc(EDGE)
    await fh.read(head, 0, EDGE, span.offset)
    await fh.read(tail, 0, EDGE, span.offset + span.length - EDGE)
    const quick = 'q' + createHash('sha1').update(String(span.length)).update(head).update(tail).digest('hex')
    return { quick, full: null }
  } finally {
    await fh.close()
  }
}

function fullHash(path: string, span: AudioSpan): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path, { start: span.offset, end: span.offset + span.length - 1, highWaterMark: 1024 * 1024 })
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

/** Write in batches so the UI's reads aren't blocked behind one long transaction. */
function batcher(db: Db, size = 200): { add: (fn: () => void) => void; flush: () => void } {
  let pending: Array<() => void> = []
  const flush = (): void => {
    if (!pending.length) return
    db.exec('BEGIN')
    try {
      for (const fn of pending) fn()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    pending = []
  }
  return {
    add: (fn) => {
      pending.push(fn)
      if (pending.length >= size) flush()
    },
    flush
  }
}

export async function findDuplicates(db: Db, opts: Options = {}): Promise<DupeSummary> {
  const concurrency = opts.concurrency ?? 6
  const progress = opts.onProgress ?? (() => {})
  const summary: DupeSummary = { located: 0, quickHashed: 0, fullyHashed: 0, groups: 0 }

  // 1. Locate the audio in files we haven't looked at yet. Unreadable files get length 0 and are left out.
  const toLocate = db
    .prepare(`SELECT id, path, ext, mtime_ms FROM files WHERE status = 'ok' AND audio_len IS NULL`)
    .all() as Array<{ id: number; path: string; ext: string; mtime_ms: number }>
  const setSpan = db.prepare('UPDATE files SET audio_offset = ?, audio_len = ? WHERE id = ? AND mtime_ms = ?')
  let w = batcher(db)
  await pool(toLocate, concurrency, async (f) => {
    let span: AudioSpan = { offset: 0, length: 0 }
    try {
      span = await audioSpan(f.path, f.ext)
    } catch {
      // Missing or unreadable since the scan: skip it.
    }
    w.add(() => setSpan.run(span.offset, span.length, f.id, f.mtime_ms))
    summary.located++
    if (summary.located % 50 === 0) progress('locating', summary.located, toLocate.length)
  })
  w.flush()
  progress('locating', toLocate.length, toLocate.length)

  // 2 + 3. Quick-hash files that share an audio length with another file.
  const toQuick = db
    .prepare(
      `SELECT id, path, audio_offset, audio_len, mtime_ms FROM files
       WHERE status = 'ok' AND audio_len > 0 AND audio_qhash IS NULL AND audio_len IN (
         SELECT audio_len FROM files WHERE status = 'ok' AND audio_len > 0 GROUP BY audio_len HAVING COUNT(*) > 1)`
    )
    .all() as Array<{ id: number; path: string; audio_offset: number; audio_len: number; mtime_ms: number }>
  const setQuick = db.prepare('UPDATE files SET audio_qhash = ?, audio_hash = coalesce(?, audio_hash) WHERE id = ? AND mtime_ms = ?')
  w = batcher(db)
  await pool(toQuick, concurrency, async (f) => {
    try {
      const { quick, full } = await quickHash(f.path, { offset: f.audio_offset, length: f.audio_len })
      w.add(() => setQuick.run(quick, full, f.id, f.mtime_ms))
    } catch {
      // Gone since we located it; the next scan will mark it missing.
    }
    summary.quickHashed++
    if (summary.quickHashed % 20 === 0) progress('comparing', summary.quickHashed, toQuick.length)
  })
  w.flush()
  progress('comparing', toQuick.length, toQuick.length)

  // 4. Fully hash large files whose quick hashes match.
  const toFull = db
    .prepare(
      `SELECT id, path, audio_offset, audio_len, mtime_ms FROM files
       WHERE status = 'ok' AND audio_hash IS NULL AND audio_qhash IN (
         SELECT audio_qhash FROM files WHERE status = 'ok' AND audio_qhash IS NOT NULL GROUP BY audio_qhash HAVING COUNT(*) > 1)`
    )
    .all() as Array<{ id: number; path: string; audio_offset: number; audio_len: number; mtime_ms: number }>
  const setFull = db.prepare('UPDATE files SET audio_hash = ? WHERE id = ? AND mtime_ms = ?')
  w = batcher(db, 20)
  await pool(toFull, Math.min(concurrency, 3), async (f) => {
    try {
      const hash = await fullHash(f.path, { offset: f.audio_offset, length: f.audio_len })
      w.add(() => setFull.run(hash, f.id, f.mtime_ms))
    } catch {
      // As above.
    }
    summary.fullyHashed++
    progress('verifying', summary.fullyHashed, toFull.length)
  })
  w.flush()

  summary.groups = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT audio_hash FROM files WHERE status = 'ok' AND audio_hash IS NOT NULL
         GROUP BY audio_hash HAVING COUNT(*) > 1)`
      )
      .get() as { n: number }
  ).n
  return summary
}
