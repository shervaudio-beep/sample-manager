// Rule-based guess of Beat / Demo / Music Sample / Drum Sample (+ drum sub-type)
// from folder names, the filename and the duration. Manual overrides live in the DB
// and always win; this only produces the 'auto' value.

import type { Category, DrumSubtype } from '../../shared/types'

export interface CategorizeInput {
  /** Path relative to the library root, using either separator. */
  relativePath: string
  durationSec: number | null
  hasBpm: boolean
}

export interface CategorizeResult {
  category: Category
  subtype: DrumSubtype | null
  /** 0..1, how sure the rules are. Shown in the UI so you know what to double-check. */
  confidence: number
}

/** Split "Kick01_HardHH-808Sub" into ["kick", "01", "hard", "hh", "808", "sub"]. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9#]+/)
    .filter(Boolean)
}

// Exact-token keywords. Short codes like "hh" or "bd" only count as whole tokens.
const SUBTYPE_TOKENS: Record<DrumSubtype, string[]> = {
  fill: ['fill', 'fills', 'roll', 'rolls'],
  drum_loop: ['drumloop', 'drumloops', 'break', 'breaks', 'breakbeat', 'toploop', 'groove'],
  hihat_open: ['oh', 'ohh', 'ohat', 'openhat', 'openhats', 'openhh'],
  hihat_closed: ['hh', 'hat', 'hats', 'hihat', 'hihats', 'chh', 'ch', 'closedhat', 'closedhh'],
  '808': ['808', '808s'],
  kick: ['kick', 'kicks', 'kik', 'kck', 'bd', 'bassdrum'],
  snare: ['snare', 'snares', 'snr', 'sn', 'sd', 'rimshot'],
  clap: ['clap', 'claps', 'clp', 'snap', 'snaps'],
  cymbal: ['cymbal', 'cymbals', 'crash', 'crashes', 'ride', 'rides', 'splash', 'china'],
  perc: [
    'perc', 'percs', 'percussion', 'shaker', 'shakers', 'tamb', 'tambourine', 'conga', 'congas',
    'bongo', 'bongos', 'rim', 'rims', 'tom', 'toms', 'cowbell', 'block', 'triangle', 'clave', 'guiro'
  ]
}

/** Two-word forms that get joined before matching ("open hat" -> "openhat"). */
const JOINED_PAIRS: Array<[string, string, string]> = [
  ['open', 'hat', 'openhat'],
  ['open', 'hh', 'openhh'],
  ['closed', 'hat', 'closedhat'],
  ['closed', 'hh', 'closedhh'],
  ['hi', 'hat', 'hihat'],
  ['hi', 'hats', 'hihats'],
  ['bass', 'drum', 'bassdrum'],
  ['drum', 'loop', 'drumloop'],
  ['drum', 'loops', 'drumloops'],
  ['top', 'loop', 'toploop'],
  ['one', 'shot', 'oneshot'],
  ['one', 'shots', 'oneshots'],
  ['voice', 'memo', 'voicememo'],
  ['voice', 'memos', 'voicememo'],
  ['new', 'recording', 'voicememo'],
  ['type', 'beat', 'typebeat']
]

function withJoined(tokens: string[]): Set<string> {
  const out = new Set(tokens)
  for (let i = 0; i < tokens.length - 1; i++) {
    for (const [a, b, joined] of JOINED_PAIRS) {
      if (tokens[i] === a && tokens[i + 1] === b) out.add(joined)
    }
  }
  return out
}

const DRUM_FOLDER = ['drums', 'drum', 'drumkit', 'drumkits', 'kit', 'kits', 'percussion']
const DEMO_WORDS = ['demo', 'demos', 'idea', 'ideas', 'voicememo', 'memo', 'bounce', 'bounces', 'rough', 'wip', 'draft', 'sketch', 'recorded', 'recording', 'freeze']
const BEAT_WORDS = ['beat', 'beats', 'instrumental', 'instrumentals', 'inst', 'typebeat', 'prod', 'master', 'mastered', 'mixdown', 'mixdowns', 'masters', 'exports', 'renders', 'rendered', 'final', 'beattape']
const MUSIC_WORDS = [
  'loop', 'loops', 'melody', 'melodies', 'chop', 'chops', 'vox', 'vocal', 'vocals', 'acapella', 'chord', 'chords',
  'pad', 'pads', 'synth', 'keys', 'guitar', 'piano', 'pluck', 'plucks', 'bass', 'fx', 'riser', 'sfx', 'sample', 'samples',
  'texture', 'strings', 'brass', 'flute', 'bell', 'bells', 'arp', 'lead', 'stem', 'stems', 'oneshot', 'oneshots'
]

function hits(tokens: Set<string>, words: string[]): number {
  let n = 0
  for (const w of words) if (tokens.has(w)) n++
  return n
}

function findSubtype(tokens: Set<string>): DrumSubtype | null {
  // Order matters: a "hat fill" is a fill, an "open hat" is not a closed hat.
  for (const sub of Object.keys(SUBTYPE_TOKENS) as DrumSubtype[]) {
    if (SUBTYPE_TOKENS[sub].some((t) => tokens.has(t))) return sub
  }
  return null
}

export function categorize(input: CategorizeInput): CategorizeResult {
  const parts = input.relativePath.split(/[\\/]+/).filter(Boolean)
  const fileName = (parts.pop() ?? '').replace(/\.[^.]+$/, '')
  const nameTokens = withJoined(tokenize(fileName))
  // Only the closest few folders matter; "Music/Producer Stuff/..." near the root says little.
  const folderTokens = withJoined(parts.slice(-4).flatMap(tokenize))
  const dur = input.durationSec

  const nameSub = findSubtype(nameTokens)
  const folderSub = findSubtype(folderTokens)

  const score: Record<Category, number> = { beat: 0, demo: 0, music: 0, drum: 0 }
  score.drum += (nameSub ? 4 : 0) + (folderSub ? 2 : 0) + hits(folderTokens, DRUM_FOLDER) * 2
  score.demo += hits(nameTokens, DEMO_WORDS) * 4 + hits(folderTokens, DEMO_WORDS) * 2
  score.beat += hits(nameTokens, BEAT_WORDS) * 3 + hits(folderTokens, BEAT_WORDS) * 2
  score.music += hits(nameTokens, MUSIC_WORDS) * 3 + hits(folderTokens, MUSIC_WORDS) * 1

  if (dur != null) {
    if (dur >= 90) {
      // Long files are songs: beats or demos, not samples.
      score.beat += 5
      score.demo += 4
      score.drum -= 6
      score.music -= 3
    } else if (dur >= 45) {
      score.beat += 1
      score.demo += 1
    } else if (dur < 2) {
      // Short one-shots are much more often drums than anything else.
      score.drum += 1
      score.beat -= 4
      score.demo -= 2
    } else {
      score.beat -= 3
    }
  }

  // A loop in a drum context is a drum loop, not a music loop.
  const isLoop = nameTokens.has('loop') || nameTokens.has('loops')
  const drumContext = nameSub != null || folderSub != null || hits(folderTokens, DRUM_FOLDER) > 0
  if (isLoop && drumContext) {
    score.drum += 3
    score.music -= 3
  }

  let category: Category = 'music'
  let best = -Infinity
  // Tie-break order: demo > beat > drum > music (more specific signals first).
  for (const c of ['demo', 'beat', 'drum', 'music'] as Category[]) {
    if (score[c] > best) {
      best = score[c]
      category = c
    }
  }
  if (best <= 0) {
    // No usable signal: guess from length alone.
    category = dur == null ? 'music' : dur >= 90 ? 'beat' : dur < 2 ? 'drum' : 'music'
  }

  let subtype: DrumSubtype | null = null
  if (category === 'drum') {
    subtype = nameSub ?? folderSub
    if (subtype !== 'fill' && isLoop) subtype = 'drum_loop'
    else if (!subtype && dur != null && dur >= 2.5 && input.hasBpm) subtype = 'drum_loop'
  }

  const sorted = Object.values(score).sort((a, b) => b - a)
  const margin = sorted[0] - sorted[1]
  const confidence = best <= 0 ? 0.2 : Math.min(1, 0.4 + margin * 0.1)
  return { category, subtype, confidence: Math.round(confidence * 100) / 100 }
}
