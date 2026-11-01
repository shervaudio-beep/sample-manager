// SQLite index of the library. Uses Node's built-in node:sqlite (no native modules to
// rebuild per platform). The DB only stores paths and metadata; audio files are never touched.

import { DatabaseSync } from 'node:sqlite'
import type {
  Category,
  DrumSubtype,
  FilePatch,
  FileQuery,
  FileRow,
  LibraryCounts,
  Root,
  SortField,
  TagInfo
} from '../shared/types'
import { CATEGORIES, DRUM_SUBTYPES, MUSICAL_KEYS } from '../shared/types'

export type Db = DatabaseSync

const SCHEMA_VERSION = 3

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
  `,
  3: `
    -- Search index: file name, its folders, tags and notes. The trigram tokenizer matches any
    -- part of a word ("punch" finds "KickPunchy") and ignores case and accents.
    -- Kept in step with files/file_tags by triggers, so nothing else has to remember it.
    CREATE VIRTUAL TABLE files_fts USING fts5(name, folders, tags, notes, tokenize = 'trigram remove_diacritics 1');

    CREATE TRIGGER files_fts_insert AFTER INSERT ON files BEGIN
      INSERT INTO files_fts (rowid, name, folders, tags, notes)
      VALUES (new.id, new.name, substr(new.rel_path, 1, length(new.rel_path) - length(new.name)), '', new.notes);
    END;
    CREATE TRIGGER files_fts_update AFTER UPDATE OF name, rel_path, notes ON files BEGIN
      UPDATE files_fts SET name = new.name,
        folders = substr(new.rel_path, 1, length(new.rel_path) - length(new.name)), notes = new.notes
      WHERE rowid = new.id;
    END;
    CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
      DELETE FROM files_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER file_tags_fts_insert AFTER INSERT ON file_tags BEGIN
      UPDATE files_fts SET tags = (
        SELECT coalesce(group_concat(t.name, ' '), '') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
        WHERE ft.file_id = new.file_id)
      WHERE rowid = new.file_id;
    END;
    CREATE TRIGGER file_tags_fts_delete AFTER DELETE ON file_tags BEGIN
      UPDATE files_fts SET tags = (
        SELECT coalesce(group_concat(t.name, ' '), '') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
        WHERE ft.file_id = old.file_id)
      WHERE rowid = old.file_id;
    END;

    INSERT INTO files_fts (rowid, name, folders, tags, notes)
    SELECT f.id, f.name, substr(f.rel_path, 1, length(f.rel_path) - length(f.name)),
      coalesce((SELECT group_concat(t.name, ' ') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id), ''),
      f.notes
    FROM files f;
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
  rating: 'rating',
  dateAdded: 'date_added'
}

type ListQuery = Omit<FileQuery, 'offset' | 'limit'>

function orderClause(q: ListQuery): string {
  const dir = q.desc ? 'DESC' : 'ASC'
  // Rows without a value (no BPM yet, etc.) always sink to the bottom.
  const col = SORT_COLUMNS[q.sort] ?? SORT_COLUMNS.name
  const nullsLast = col.split(' ')[0]
  return `ORDER BY ${nullsLast} IS NULL, ${col} ${dir}, id ${dir}`
}

/** Bind a list of ids as one parameter, so a 50k-file selection doesn't hit SQLite's variable limit. */
const ID_LIST = '(SELECT value FROM json_each(?))'

/** Split a search into terms; "double quotes" keep words together, a leading - excludes. */
export function parseSearch(text: string): Array<{ term: string; exclude: boolean }> {
  const out: Array<{ term: string; exclude: boolean }> = []
  for (const m of text.matchAll(/(-?)(?:"([^"]*)"?|(\S+))/g)) {
    const term = (m[2] ?? m[3] ?? '').trim()
    if (!term || term === '-') continue
    out.push({ term, exclude: m[1] === '-' })
  }
  return out
}

const likeEscape = (s: string): string => '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%'

/** SQL matching one search term against name, folders, tags and notes. */
function searchTerm(term: string): { sql: string; params: string[] } {
  // The trigram index needs 3+ characters; shorter terms fall back to a scan (still fast at 50k).
  if ([...term].length >= 3) {
    return { sql: 'id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)', params: ['"' + term.replace(/"/g, '""') + '"'] }
  }
  const like = likeEscape(term)
  return {
    sql: `(rel_path LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR id IN (
      SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name LIKE ? ESCAPE '\\'))`,
    params: [like, like, like]
  }
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
  if (q.favorite) conds.push('favorite = 1')
  if (q.tagId != null) {
    conds.push('id IN (SELECT file_id FROM file_tags WHERE tag_id = ?)')
    params.push(q.tagId)
  }

  for (const { term, exclude } of parseSearch(q.search ?? '')) {
    const t = searchTerm(term)
    conds.push(exclude ? `NOT ${t.sql}` : t.sql)
    params.push(...t.params)
  }

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const bpmMin = num(q.bpmMin)
  const bpmMax = num(q.bpmMax)
  if (bpmMin != null || bpmMax != null) {
    const lo = bpmMin ?? 0
    const hi = bpmMax ?? 10_000
    // Half/double time: a 70 BPM loop also fits a 140 search, and the other way round.
    conds.push(
      q.bpmHalfDouble
        ? '(bpm BETWEEN ? AND ? OR bpm * 2 BETWEEN ? AND ? OR bpm / 2 BETWEEN ? AND ?)'
        : 'bpm BETWEEN ? AND ?'
    )
    params.push(...(q.bpmHalfDouble ? [lo, hi, lo, hi, lo, hi] : [lo, hi]))
  }
  const keys = (q.keys ?? []).filter((k) => MUSICAL_KEYS.includes(k))
  if (keys.length) {
    conds.push(`musical_key IN (${keys.map(() => '?').join(', ')})`)
    params.push(...keys)
  }
  const minRating = num(q.minRating)
  if (minRating) {
    conds.push('rating >= ?')
    params.push(minRating)
  }
  const durMin = num(q.durationMin)
  const durMax = num(q.durationMax)
  if (durMin != null) {
    conds.push('duration_ms >= ?')
    params.push(durMin)
  }
  if (durMax != null) {
    conds.push('duration_ms < ?')
    params.push(durMax)
  }
  const exts = (q.exts ?? []).filter((e) => /^[a-z0-9]{1,5}$/.test(e))
  if (exts.length) {
    conds.push(`ext IN (${exts.map(() => '?').join(', ')})`)
    params.push(...exts)
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
  subtype_source: FileRow['subtypeSource']
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
  tag_list: string | null
  date_added: number
}

// Tag names joined with a unit separator, which can't appear in a tag name.
const SELECT_FILES = `SELECT files.*,
  (SELECT group_concat(t.name, char(31)) FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
   WHERE ft.file_id = files.id) AS tag_list
  FROM files`

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
    subtypeSource: r.subtype_source,
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
    tags: r.tag_list ? r.tag_list.split('\x1f').sort((a, b) => a.localeCompare(b)) : [],
    dateAdded: r.date_added
  }
}

export function queryFiles(db: Db, q: FileQuery): FileRow[] {
  const { sql, params } = whereClause(q)
  const rows = db
    .prepare(`${SELECT_FILES} ${sql} ${orderClause(q)} LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset) as unknown as FileDbRow[]
  return rows.map(toFileRow)
}

/** Ids in list order, for shift-click ranges and select-all. */
export function queryIds(db: Db, q: ListQuery & { offset?: number; limit?: number }): number[] {
  const { sql, params } = whereClause(q)
  const rows = db
    .prepare(`SELECT id FROM files ${sql} ${orderClause(q)} LIMIT ? OFFSET ?`)
    .all(...params, q.limit ?? -1, q.offset ?? 0) as Array<{ id: number }>
  return rows.map((r) => r.id)
}

export function countFiles(db: Db, q: Partial<FileQuery>): number {
  const { sql, params } = whereClause(q)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM files ${sql}`).get(...params) as { n: number }
  return row.n
}

export function getFile(db: Db, id: number): FileRow | null {
  const r = db.prepare(`${SELECT_FILES} WHERE id = ?`).get(id) as unknown as FileDbRow | undefined
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
  const { missing, favorites } = db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'missing') AS missing,
              COUNT(*) FILTER (WHERE status != 'missing' AND favorite = 1) AS favorites
       FROM files`
    )
    .get() as { missing: number; favorites: number }
  return { total, missing, favorites, byCategory, bySubtype }
}

// ---------- edits ----------
// Only the index changes here; audio files on disk are never written.

function transaction(db: Db, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Throws on anything the renderer shouldn't be able to store. */
function checkPatch(p: FilePatch): void {
  if (p.category !== undefined && !CATEGORIES.includes(p.category)) throw new Error(`Unknown category: ${p.category}`)
  if (p.subtype != null && !DRUM_SUBTYPES.includes(p.subtype)) throw new Error(`Unknown drum type: ${p.subtype}`)
  if (p.bpm != null && !(Number.isFinite(p.bpm) && p.bpm >= 20 && p.bpm <= 999)) throw new Error('BPM must be between 20 and 999')
  if (p.key != null && !MUSICAL_KEYS.includes(p.key)) throw new Error(`Unknown key: ${p.key}`)
  if (p.rating !== undefined && !(Number.isInteger(p.rating) && p.rating >= 0 && p.rating <= 5)) throw new Error('Rating must be 0-5')
  if (p.notes !== undefined && (typeof p.notes !== 'string' || p.notes.length > 20_000)) throw new Error('Notes too long')
}

export function updateFiles(db: Db, ids: number[], patch: FilePatch): void {
  checkPatch(patch)
  const sets: string[] = []
  const params: Array<string | number | null> = []
  const set = (sql: string, ...values: Array<string | number | null>): void => {
    sets.push(sql)
    params.push(...values)
  }

  // A drum type implies the Drum category; any other category has no drum type.
  let { category, subtype } = patch
  if (subtype != null) category = 'drum'
  if (category !== undefined && category !== 'drum') subtype = null

  if (category !== undefined) set(`category = ?, category_source = 'manual', category_conf = NULL`, category)
  if (subtype !== undefined) set(`subtype = ?, subtype_source = 'manual'`, subtype)
  // Clearing a value is also manual: it stops a rescan from putting the wrong guess back.
  if (patch.bpm !== undefined) set(`bpm = ?, bpm_source = 'manual'`, patch.bpm == null ? null : Math.round(patch.bpm * 100) / 100)
  if (patch.key !== undefined) set(`musical_key = ?, key_source = 'manual'`, patch.key)
  if (patch.rating !== undefined) set('rating = ?', patch.rating)
  if (patch.favorite !== undefined) set('favorite = ?', patch.favorite ? 1 : 0)
  if (patch.notes !== undefined) set('notes = ?', patch.notes)
  if (!sets.length || !ids.length) return

  db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id IN ${ID_LIST}`).run(...params, JSON.stringify(ids))
}

// ---------- tags ----------

/** Trim and collapse whitespace; null for an empty or over-long name. */
export function normalizeTagName(raw: string): string | null {
  const name = raw.replace(/[\s\x1f]+/g, ' ').trim()
  return name && name.length <= 40 ? name : null
}

export function addTags(db: Db, ids: number[], names: string[]): void {
  const clean = [...new Set(names.map(normalizeTagName).filter((n): n is string => n != null))]
  if (!clean.length || !ids.length) return
  const createTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
  const tagFiles = db.prepare(
    `INSERT OR IGNORE INTO file_tags (file_id, tag_id)
     SELECT f.id, t.id FROM files f, tags t WHERE f.id IN ${ID_LIST} AND t.name = ?`
  )
  transaction(db, () => {
    for (const name of clean) {
      createTag.run(name)
      tagFiles.run(JSON.stringify(ids), name)
    }
  })
}

export function removeTags(db: Db, ids: number[], names: string[]): void {
  if (!names.length || !ids.length) return
  const untag = db.prepare(
    `DELETE FROM file_tags WHERE file_id IN ${ID_LIST} AND tag_id = (SELECT id FROM tags WHERE name = ?)`
  )
  transaction(db, () => {
    for (const name of names) untag.run(JSON.stringify(ids), name)
    db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM file_tags)')
  })
}

/** Tags in use, with how many (present) files carry each. */
export function listTags(db: Db): TagInfo[] {
  return db
    .prepare(
      `SELECT t.id, t.name, COUNT(*) AS count FROM tags t
       JOIN file_tags ft ON ft.tag_id = t.id JOIN files f ON f.id = ft.file_id
       WHERE f.status != 'missing'
       GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
    )
    .all() as unknown as TagInfo[]
}

/** Tags across a selection, with how many of the selected files have each. */
export function tagsForFiles(db: Db, ids: number[]): TagInfo[] {
  return db
    .prepare(
      `SELECT t.id, t.name, COUNT(*) AS count FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
       WHERE ft.file_id IN ${ID_LIST} GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
    )
    .all(JSON.stringify(ids)) as unknown as TagInfo[]
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
