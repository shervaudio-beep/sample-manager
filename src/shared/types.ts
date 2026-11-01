// Types shared by the main process, the scan worker and the renderer.

export const CATEGORIES = ['beat', 'demo', 'music', 'drum'] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  beat: 'Beats',
  demo: 'Demos',
  music: 'Music Samples',
  drum: 'Drum Samples'
}

/** Compact labels for table cells. */
export const CATEGORY_SHORT: Record<Category, string> = {
  beat: 'Beat',
  demo: 'Demo',
  music: 'Music',
  drum: 'Drum'
}

export const DRUM_SUBTYPES = [
  'kick',
  'snare',
  'clap',
  'hihat_closed',
  'hihat_open',
  '808',
  'perc',
  'cymbal',
  'drum_loop',
  'fill'
] as const
export type DrumSubtype = (typeof DRUM_SUBTYPES)[number]

export const SUBTYPE_LABELS: Record<DrumSubtype, string> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  hihat_closed: 'Hi-Hat (Closed)',
  hihat_open: 'Hi-Hat (Open)',
  '808': '808',
  perc: 'Perc',
  cymbal: 'Cymbal',
  drum_loop: 'Drum Loop',
  fill: 'Fill'
}

/** Every key the app stores, in canonical form: sharps only, "m" for minor. */
export const MUSICAL_KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].flatMap((n) => [n, n + 'm'])

export const AUDIO_EXTENSIONS =['.wav', '.mp3', '.aif', '.aiff', '.flac', '.ogg', '.m4a'] as const

/** Where a value came from. 'manual' values are never overwritten by a rescan. */
export type ValueSource = 'auto' | 'filename' | 'tag' | 'analysis' | 'manual'

export type FileStatus = 'ok' | 'missing' | 'offline'

export interface Root {
  id: number
  path: string
  status: 'ok' | 'offline'
  lastScanAt: number | null
  fileCount: number
}

export interface FileRow {
  id: number
  rootId: number
  path: string
  name: string
  ext: string
  size: number
  status: FileStatus
  category: Category
  categorySource: ValueSource
  subtype: DrumSubtype | null
  subtypeSource: ValueSource
  bpm: number | null
  bpmSource: ValueSource | null
  key: string | null
  keySource: ValueSource | null
  durationMs: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  rating: number
  favorite: boolean
  notes: string
  tags: string[]
  dateAdded: number
  /** Hash of the audio content, once duplicate checking has looked at this file. */
  audioHash: string | null
  /** How many other files (present on disk) have exactly the same audio. */
  dupCount: number
  /** What listening to the audio found, whether or not it's the value in use. */
  analysisBpm: number | null
  analysisBpmConfidence: number | null
  analysisKey: string | null
  analysisKeyConfidence: number | null
}

/** A user edit to one or more files. Category, type, BPM and key become 'manual' and survive rescans. */
export interface FilePatch {
  category?: Category
  subtype?: DrumSubtype | null
  bpm?: number | null
  key?: string | null
  rating?: number
  favorite?: boolean
  notes?: string
}

export interface TagInfo {
  id: number
  name: string
  count: number
}

export interface Collection {
  id: number
  name: string
  /** Files in the collection (or, from collectionsForFiles, how many of the asked-about files). */
  count: number
  createdAt: number
}

/** 'position' is the order files were added to a collection; only meaningful with collectionId. */
export type SortField = 'name' | 'category' | 'subtype' | 'bpm' | 'key' | 'duration' | 'size' | 'rating' | 'dateAdded' | 'position'

export interface FileQuery {
  category?: Category
  subtype?: DrumSubtype
  rootId?: number
  favorite?: boolean
  tagId?: number
  collectionId?: number
  /** Only files that have an exact audio duplicate; groups are kept together. */
  duplicates?: boolean
  /** Words to find in name, folders, tags and notes. */
  search?: string
  bpmMin?: number
  bpmMax?: number
  /** Also match files at half or double the BPM range. */
  bpmHalfDouble?: boolean
  keys?: string[]
  minRating?: number
  /** Length range in ms; max is exclusive. */
  durationMin?: number
  durationMax?: number
  exts?: string[]
  includeMissing?: boolean
  sort: SortField
  desc: boolean
  offset: number
  limit: number
}

export interface LibraryCounts {
  total: number
  missing: number
  favorites: number
  duplicates: DuplicateStats
  byCategory: Record<Category, number>
  bySubtype: Record<DrumSubtype, number>
}

export interface DuplicateStats {
  /** Sets of files with identical audio. */
  groups: number
  /** Copies beyond the first in each set: what could go. */
  extra: number
  extraBytes: number
}

export type DupeEvent =
  | { type: 'progress'; stage: 'locating' | 'comparing' | 'verifying'; done: number; total: number }
  | { type: 'done'; groups: number }
  | { type: 'error'; message: string }

export type AnalysisEvent = { type: 'progress'; done: number; total: number } | { type: 'done' }

/** A file for the hidden analyzer page to decode and analyze. */
export interface AnalyzerJob {
  id: number
  url: string
  request: import('./analysis').AnalysisRequest
}

export interface AnalyzerReply {
  id: number
  result?: import('./analysis').AnalysisResult
  error?: string
}

export type ScanEvent =
  | { type: 'start'; rootId: number; path: string }
  | { type: 'progress'; rootId: number; found: number; processed: number; current: string }
  | { type: 'rootDone'; rootId: number; summary: ScanSummary }
  | { type: 'done' }
  | { type: 'error'; rootId?: number; message: string }

export interface ScanSummary {
  added: number
  updated: number
  unchanged: number
  missing: number
  relinked: number
  errors: number
  offline: boolean
}
