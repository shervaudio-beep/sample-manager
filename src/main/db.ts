// SQLite index of the library. Uses Node's built-in node:sqlite (no native modules to
// rebuild per platform). The DB only stores paths and metadata; audio files are never touched.

import { DatabaseSync } from 'node:sqlite'
import type {
  Category,
  DrumSubtype,
  FileQuery,
  FileRow,
  LibraryCounts,
  Root,
  SortField
} from '../shared/types'
import { CATEGORIES, DRUM_SUBTYPES } from '../shared/types'

export type Db = DatabaseSync

const SCHEMA_VERSION = 2

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE roots (
      id            INTEGER PRIMARY KEY,
      path          TEXT NOT NULL UNIQUE,
      status        TEXT NOT NULL DEFAULT 'ok',
      last_scan_at  INTEGER
    );

    CREATE TABLE files (
      id               INTEGER PRIMARY KEY,
      root_id          INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      path             TEXT NOT NULL UNIQUE,
      rel_path         TEXT NOT NULL,
      name             TEXT NOT NULL,
      ext              TEXT NOT NULL,
      size             INTEGER NOT NULL,
      mtime_ms         INTEGER NOT NULL,
      audio_hash       TEXT,
      status           TEXT NOT NULL DEFAULT 'ok',
      category         TEXT NOT NULL,
      category_source  TEXT NOT NULL DEFAULT 'auto',
      category_conf    REAL,
      subtype          TEXT,
      subtype_source   TEXT NOT NULL DEFAULT 'auto',
      bpm              REAL,
      bpm_source       TEXT,
      musical_key      TEXT,
      key_source       TEXT,
      duration_ms      INTEGER,
      sample_rate      INTEGER,
      bit_depth        INTEGER,
      channels         INTEGER,
      rating           INTEGER NOT NULL DEFAULT 0,
      favorite         INTEGER NOT NULL DEFAULT 0,
      notes            TEXT NOT NULL DEFAULT '',
      date_added       INTEGER NOT NULL,
      last_seen_scan   INTEGER NOT NULL,
      scan_error       TEXT
    );
    CREATE INDEX files_root      ON files(root_id);
    CREATE INDEX files_category  ON files(category, subtype);
    CREATE INDEX files_name      ON files(name COLLATE NOCASE);
    CREATE INDEX files_bpm       ON files(bpm);
    CREATE INDEX files_key       ON files(musical_key);
    CREATE INDEX files_added     ON files(date_added);
    CREATE INDEX files_size_name ON files(size, name);
    CREATE INDEX files_hash      ON files(audio_hash);

    CREATE TABLE tags (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE file_tags (
      file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (file_id, tag_id)
    );

    CREATE TABLE collections (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE collection_items (
      collection_id  INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      position       INTEGER NOT NULL,
      PRIMARY KEY (collection_id, file_id)
    );
  `,
  2: `
    -- Waveform peaks drawn by the player, cached so a file is only decoded once.
    -- Tied to the file's mtime: if the file changes, the cache entry is ignored.
    CREATE TABLE waveforms (
      file_id   INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      mtime_ms  INTEGER NOT NULL,
      duration  REAL NOT NULL,
      peaks     TEXT NOT NULL
    );
  `
}

export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

// ---------- roots ----------

export function addRoot(db: Db, path: string): Root {
  db.prepare('INSERT OR IGNORE INTO roots (path) VALUES (?)').run(path)
  return listRoots(db).find((r) => r.path === path)!
}

export function removeRoot(db: Db, id: number): void {
  // Only forgets the index entries (and their tags/notes); files on disk are untouched.
  db.prepare('DELETE FROM roots WHERE id = ?').run(id)
}

export function listRoots(db: Db): Root[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.path, r.status, r.last_scan_at,
              (SELECT COUNT(*) FROM files f WHERE f.root_id = r.id AND f.status != 'missing') AS file_count
       FROM roots r ORDER BY r.path COLLATE NOCASE`
    )
    .all() as Array<{ id: number; path: string; status: Root['status']; last_scan_at: number | null; file_count: number }>
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    status: r.status,
    lastScanAt: r.last_scan_at,
    fileCount: r.file_count
  }))
}

// ---------- files ----------

const SORT_COLUMNS: Record<SortField, string> = {
  name: 'name COLLATE NOCASE',
  category: 'category',
  subtype: 'subtype',
  bpm: 'bpm',
  key: 'musical_key',
  duration: 'duration_ms',
  size: 'size',
  dateAdded: 'date_added'
}

function whereClause(q: Partial<FileQuery>): { sql: string; params: Array<string | number> } {
  const conds: string[] = []
  const params: Array<string | number> = []
  if (!q.includeMissing) conds.push(`status != 'missing'`)
  if (q.category) {
    conds.push('category = ?')
    params.push(q.category)
  }
  if (q.subtype) {
    conds.push('subtype = ?')
    params.push(q.subtype)
  }
  if (q.rootId != null) {
    conds.push('root_id = ?')
    params.push(q.rootId)
  }
  return { sql: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params }
}

interface FileDbRow {
  id: number
  root_id: number
  path: string
  name: string
  ext: string
  size: number
  status: FileRow['status']
  category: Category
  category_source: FileRow['categorySource']
  subtype: DrumSubtype | null
  bpm: number | null
  bpm_source: FileRow['bpmSource']
  musical_key: string | null
  key_source: FileRow['keySource']
  duration_ms: number | null
  sample_rate: number | null
  bit_depth: number | null
  channels: number | null
  rating: number
  favorite: number
  notes: string
  date_added: number
}

function toFileRow(r: FileDbRow): FileRow {
  return {
    id: r.id,
    rootId: r.root_id,
    path: r.path,
    name: r.name,
    ext: r.ext,
    size: r.size,
    status: r.status,
    category: r.category,
    categorySource: r.category_source,
    subtype: r.subtype,
    bpm: r.bpm,
    bpmSource: r.bpm_source,
    key: r.musical_key,
    keySource: r.key_source,
    durationMs: r.duration_ms,
    sampleRate: r.sample_rate,
    bitDepth: r.bit_depth,
    channels: r.channels,
    rating: r.rating,
    favorite: r.favorite === 1,
    notes: r.notes,
    dateAdded: r.date_added
  }
}

export function queryFiles(db: Db, q: FileQuery): FileRow[] {
  const { sql, params } = whereClause(q)
  const dir = q.desc ? 'DESC' : 'ASC'
  // Rows without a value (no BPM yet, etc.) always sink to the bottom.
  const col = SORT_COLUMNS[q.sort] ?? SORT_COLUMNS.name
  const nullsLast = col.split(' ')[0]
  const rows = db
    .prepare(
      `SELECT * FROM files ${sql}
       ORDER BY ${nullsLast} IS NULL, ${col} ${dir}, id ${dir}
       LIMIT ? OFFSET ?`
    )
    .all(...params, q.limit, q.offset) as unknown as FileDbRow[]
  return rows.map(toFileRow)
}

export function countFiles(db: Db, q: Partial<FileQuery>): number {
  const { sql, params } = whereClause(q)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM files ${sql}`).get(...params) as { n: number }
  return row.n
}

export function getFile(db: Db, id: number): FileRow | null {
  const r = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileDbRow | undefined
  return r ? toFileRow(r) : null
}

export function libraryCounts(db: Db): LibraryCounts {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>
  const bySubtype = Object.fromEntries(DRUM_SUBTYPES.map((s) => [s, 0])) as Record<DrumSubtype, number>
  let total = 0
  const rows = db
    .prepare(`SELECT category, subtype, COUNT(*) AS n FROM files WHERE status != 'missing' GROUP BY category, subtype`)
    .all() as Array<{ category: Category; subtype: DrumSubtype | null; n: number }>
  for (const r of rows) {
    total += r.n
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.n
    if (r.subtype) bySubtype[r.subtype] = (bySubtype[r.subtype] ?? 0) + r.n
  }
  const { n: missing } = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE status = 'missing'`).get() as { n: number }
  return { total, missing, byCategory, bySubtype }
}

// ---------- waveforms ----------

export interface Waveform {
  duration: number
  peaks: number[][]
}

export function getWaveform(db: Db, fileId: number): Waveform | null {
  const r = db
    .prepare(
      `SELECT w.duration, w.peaks FROM waveforms w JOIN files f ON f.id = w.file_id
       WHERE w.file_id = ? AND w.mtime_ms = f.mtime_ms`
    )
    .get(fileId) as { duration: number; peaks: string } | undefined
  return r ? { duration: r.duration, peaks: JSON.parse(r.peaks) } : null
}

export function saveWaveform(db: Db, fileId: number, wf: Waveform): void {
  db.prepare(
    `INSERT OR REPLACE INTO waveforms (file_id, mtime_ms, duration, peaks)
     SELECT id, mtime_ms, ?, ? FROM files WHERE id = ?`
  ).run(wf.duration, JSON.stringify(wf.peaks), fileId)
}
