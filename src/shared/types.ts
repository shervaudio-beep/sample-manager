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

export type SortField = 'name' | 'category' | 'subtype' | 'bpm' | 'key' | 'duration' | 'size' | 'rating' | 'dateAdded'

export interface FileQuery {
  category?: Category
  subtype?: DrumSubtype
  rootId?: number
  favorite?: boolean
  tagId?: number
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
  byCategory: Record<Category, number>
  bySubtype: Record<DrumSubtype, number>
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
