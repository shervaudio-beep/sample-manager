// Walks a library root, reads audio metadata and syncs the index.
// Read-only with respect to the user's files: it only stats, opens and reads them.

import { existsSync } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import type { Db } from '../db'
import { AUDIO_EXTENSIONS, type ScanSummary } from '../../shared/types'
import { categorize } from './categorize'
import { parseBpm, parseKey } from './parseName'

export interface AudioMeta {
  durationMs: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  tagBpm: number | null
  tagKey: string | null
}

export interface ScanOptions {
  onProgress?: (found: number, processed: number, current: string) => void
  /** Swappable for tests. */
  readMetadata?: (file: string) => Promise<AudioMeta>
  concurrency?: number
  batchSize?: number
}

interface FoundFile {
  path: string
  size: number
  mtimeMs: number
}

const AUDIO_EXT = new Set<string>(AUDIO_EXTENSIONS)

/** Folders that never contain the user's audio, or that are OS/DAW internals. */
const SKIP_DIRS = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  'ableton project info'
])

export function isAudioFile(file: string): boolean {
  const base = path.basename(file)
  // macOS writes "._name.wav" resource-fork stubs on non-HFS drives; they aren't audio.
  if (base.startsWith('._')) return false
  return AUDIO_EXT.has(path.extname(base).toLowerCase())
}

export async function* walkAudio(dir: string): AsyncGenerator<FoundFile> {
  let handle
  try {
    handle = await opendir(dir)
  } catch {
    return // unreadable folder (permissions, vanished mid-scan): skip it
  }
  for await (const entry of handle) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue
      yield* walkAudio(full)
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      try {
        const s = await stat(full)
        yield { path: full, size: s.size, mtimeMs: Math.floor(s.mtimeMs) }
      } catch {
        // file disappeared between readdir and stat
      }
    }
  }
}

export async function readAudioMetadata(file: string): Promise<AudioMeta> {
  const { format, common } = await parseFile(file, { skipCovers: true, duration: false })
  // music-metadata returns an empty result rather than throwing for some garbage files.
  if (format.duration == null && format.sampleRate == null) throw new Error('Unrecognised or corrupt audio data')
  return {
    durationMs: format.duration != null ? Math.round(format.duration * 1000) : null,
    sampleRate: format.sampleRate ?? null,
    bitDepth: format.bitsPerSample ?? null,
    channels: format.numberOfChannels ?? null,
    tagBpm: typeof common.bpm === 'number' && common.bpm > 0 ? common.bpm : null,
    tagKey: common.key ?? null
  }
}

interface ExistingRow {
  id: number
  size: number
  mtime_ms: number
  category_source: string
  subtype_source: string
  bpm_source: string | null
  key_source: string | null
}

interface Derived {
  meta: AudioMeta | null
  error: string | null
  category: string
  categoryConf: number
  subtype: string | null
  bpm: number | null
  bpmSource: string | null
  key: string | null
  keySource: string | null
}

function derive(rootPath: string, file: FoundFile, meta: AudioMeta | null, error: string | null): Derived {
  const rel = path.relative(rootPath, file.path)
  const base = path.basename(file.path)
  const parent = path.basename(path.dirname(file.path))
  const durSec = meta?.durationMs != null ? meta.durationMs / 1000 : null

  // BPM: embedded tag > "140bpm" in name > bare number in name > same in parent folder name.
  let bpm: number | null = null
  let bpmSource: string | null = null
  if (meta?.tagBpm) {
    bpm = meta.tagBpm
    bpmSource = 'tag'
  } else {
    const g = parseBpm(base) ?? parseBpm(parent)
    // A bare number on a one-shot is usually a sample index ("Kick 120"), not a tempo.
    if (g && (g.confidence === 'explicit' || durSec == null || durSec >= 1.5)) {
      bpm = g.bpm
      bpmSource = 'filename'
    }
  }

  let key: string | null = null
  let keySource: string | null = null
  const tagKey = meta?.tagKey ? parseKey(meta.tagKey) ?? parseKey(`key ${meta.tagKey}`) : null
  if (tagKey) {
    key = tagKey
    keySource = 'tag'
  } else {
    const k = parseKey(base) ?? parseKey(parent)
    if (k) {
      key = k
      keySource = 'filename'
    }
  }

  const cat = categorize({ relativePath: rel, durationSec: durSec, hasBpm: bpm != null })
  return {
    meta,
    error,
    category: cat.category,
    categoryConf: cat.confidence,
    subtype: cat.subtype,
    bpm,
    bpmSource,
    key,
    keySource
  }
}

let lastScanId = 0
function nextScanId(): number {
  lastScanId = Math.max(Date.now(), lastScanId + 1)
  return lastScanId
}

export async function scanRoot(db: Db, rootId: number, opts: ScanOptions = {}): Promise<ScanSummary> {
  const readMeta = opts.readMetadata ?? readAudioMetadata
  const concurrency = opts.concurrency ?? 4
  const batchSize = opts.batchSize ?? 250
  const summary: ScanSummary = { added: 0, updated: 0, unchanged: 0, missing: 0, relinked: 0, errors: 0, offline: false }

  const root = db.prepare('SELECT id, path FROM roots WHERE id = ?').get(rootId) as { id: number; path: string } | undefined
  if (!root) throw new Error(`Unknown library folder ${rootId}`)

  if (!existsSync(root.path)) {
    // Drive unplugged or folder renamed: keep everything, just mark it offline.
    db.prepare(`UPDATE roots SET status = 'offline' WHERE id = ?`).run(rootId)
    db.prepare(`UPDATE files SET status = 'offline' WHERE root_id = ? AND status = 'ok'`).run(rootId)
    summary.offline = true
    return summary
  }
  db.prepare(`UPDATE roots SET status = 'ok' WHERE id = ?`).run(rootId)

  const scanId = nextScanId()
  const existing = new Map<string, ExistingRow>()
  for (const r of db
    .prepare(
      `SELECT id, path, size, mtime_ms, category_source, subtype_source, bpm_source, key_source
       FROM files WHERE root_id = ?`
    )
    .all(rootId) as unknown as Array<ExistingRow & { path: string }>) {
    existing.set(r.path, r)
  }

  const touch = db.prepare(`UPDATE files SET last_seen_scan = ?, status = 'ok' WHERE id = ?`)
  const insert = db.prepare(`
    INSERT INTO files (root_id, path, rel_path, name, ext, size, mtime_ms, status,
      category, category_source, category_conf, subtype, subtype_source,
      bpm, bpm_source, musical_key, key_source,
      duration_ms, sample_rate, bit_depth, channels, date_added, last_seen_scan, scan_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, 'auto', ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  // Changed file: refresh technical metadata; only overwrite auto-derived fields, never manual ones.
  const update = db.prepare(`
    UPDATE files SET size = ?, mtime_ms = ?, status = 'ok', last_seen_scan = ?, scan_error = ?,
      duration_ms = ?, sample_rate = ?, bit_depth = ?, channels = ?,
      audio_hash = NULL, audio_qhash = NULL, audio_offset = NULL, audio_len = NULL,
      category      = CASE WHEN category_source = 'manual' THEN category ELSE ? END,
      category_conf = CASE WHEN category_source = 'manual' THEN category_conf ELSE ? END,
      subtype       = CASE WHEN subtype_source = 'manual' THEN subtype ELSE ? END,
      bpm           = CASE WHEN bpm_source = 'manual' THEN bpm ELSE ? END,
      bpm_source    = CASE WHEN bpm_source = 'manual' THEN bpm_source ELSE ? END,
      musical_key   = CASE WHEN key_source = 'manual' THEN musical_key ELSE ? END,
      key_source    = CASE WHEN key_source = 'manual' THEN key_source ELSE ? END
    WHERE id = ?`)

  const newIds: number[] = []
  let pendingWrites: Array<() => void> = []
  const flush = (): void => {
    if (!pendingWrites.length) return
    db.exec('BEGIN')
    try {
      for (const w of pendingWrites) w()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    pendingWrites = []
  }
  const queueWrite = (w: () => void): void => {
    pendingWrites.push(w)
    if (pendingWrites.length >= batchSize) flush()
  }

  let found = 0
  let processed = 0
  const inFlight = new Set<Promise<void>>()

  const processFile = async (file: FoundFile, prev: ExistingRow | undefined): Promise<void> => {
    let meta: AudioMeta | null = null
    let error: string | null = null
    try {
      meta = await readMeta(file.path)
    } catch (err) {
      // Corrupt or unsupported file: still index it so it shows up, flagged with the error.
      error = err instanceof Error ? err.message : String(err)
      summary.errors++
    }
    const d = derive(root.path, file, meta, error)
    const m = d.meta
    queueWrite(() => {
      if (prev) {
        update.run(
          file.size, file.mtimeMs, scanId, d.error,
          m?.durationMs ?? null, m?.sampleRate ?? null, m?.bitDepth ?? null, m?.channels ?? null,
          d.category, d.categoryConf, d.subtype, d.bpm, d.bpmSource, d.key, d.keySource,
          prev.id
        )
        summary.updated++
      } else {
        const res = insert.run(
          rootId, file.path, path.relative(root.path, file.path), path.basename(file.path),
          path.extname(file.path).slice(1).toLowerCase(), file.size, file.mtimeMs,
          d.category, d.categoryConf, d.subtype, d.bpm, d.bpmSource, d.key, d.keySource,
          m?.durationMs ?? null, m?.sampleRate ?? null, m?.bitDepth ?? null, m?.channels ?? null,
          Date.now(), scanId, d.error
        )
        newIds.push(Number(res.lastInsertRowid))
        summary.added++
      }
    })
    processed++
    if (processed % 25 === 0) opts.onProgress?.(found, processed, file.path)
  }

  for await (const file of walkAudio(root.path)) {
    found++
    const prev = existing.get(file.path)
    if (prev && prev.size === file.size && prev.mtime_ms === file.mtimeMs) {
      queueWrite(() => touch.run(scanId, prev.id))
      summary.unchanged++
      processed++
      if (processed % 500 === 0) opts.onProgress?.(found, processed, file.path)
      continue
    }
    const p = processFile(file, prev).finally(() => inFlight.delete(p))
    inFlight.add(p)
    if (inFlight.size >= concurrency) await Promise.race(inFlight)
  }
  await Promise.all(inFlight)
  flush()

  // Anything under this root we didn't see is gone (deleted or moved). Keep the row and its
  // tags/notes so a later rescan, or a relink, can bring it back.
  const gone = db
    .prepare(`UPDATE files SET status = 'missing' WHERE root_id = ? AND last_seen_scan < ? AND status != 'missing'`)
    .run(rootId, scanId)
  summary.missing = Number(gone.changes)

  summary.relinked = relinkMoved(db, newIds)
  summary.missing -= Math.min(summary.missing, summary.relinked)
  summary.added -= summary.relinked

  db.prepare('UPDATE roots SET last_scan_at = ? WHERE id = ?').run(Date.now(), rootId)
  opts.onProgress?.(found, processed, '')
  return summary
}

/**
 * A file that vanished from one place and a "new" file with the same name and size elsewhere
 * is the same file, moved. Point the old row (with its tags, rating, notes, crates) at the new
 * location and drop the duplicate new row. Content hashes will make this stricter later.
 */
function relinkMoved(db: Db, newIds: number[]): number {
  if (!newIds.length) return 0
  const getNew = db.prepare('SELECT * FROM files WHERE id = ?')
  const findMissing = db.prepare(`
    SELECT id FROM files
    WHERE status = 'missing' AND name = ? AND size = ?
      AND (duration_ms IS NULL OR ? IS NULL OR ABS(duration_ms - ?) <= 50)
    ORDER BY id LIMIT 1`)
  const drop = db.prepare('DELETE FROM files WHERE id = ?')
  const move = db.prepare(`
    UPDATE files SET root_id = ?, path = ?, rel_path = ?, mtime_ms = ?, status = 'ok', last_seen_scan = ?,
      duration_ms = ?, sample_rate = ?, bit_depth = ?, channels = ?, scan_error = ?,
      audio_hash = NULL, audio_qhash = NULL, audio_offset = NULL, audio_len = NULL
    WHERE id = ?`)

  let relinked = 0
  db.exec('BEGIN')
  try {
    for (const id of newIds) {
      const n = getNew.get(id) as Record<string, any> | undefined
      if (!n) continue
      const old = findMissing.get(n.name, n.size, n.duration_ms, n.duration_ms) as { id: number } | undefined
      if (!old) continue
      drop.run(id) // free the UNIQUE path before reusing it
      move.run(
        n.root_id, n.path, n.rel_path, n.mtime_ms, n.last_seen_scan,
        n.duration_ms, n.sample_rate, n.bit_depth, n.channels, n.scan_error,
        old.id
      )
      relinked++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return relinked
}
