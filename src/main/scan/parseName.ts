// Pull BPM and musical key out of file and folder names, e.g.
// "Dark_Loop_140bpm_F#min.wav" -> { bpm: 140, key: "F#m" }.

export interface BpmGuess {
  bpm: number
  /** 'explicit' = written next to "bpm"; 'inferred' = a bare number in a plausible range. */
  confidence: 'explicit' | 'inferred'
}

const EXPLICIT_BPM = [
  /(?<![0-9.])(\d{2,3}(?:\.\d{1,2})?)\s*-?\s*bpm(?![a-z])/i,
  /(?<![a-z])bpm\s*[-_:=]?\s*(\d{2,3}(?:\.\d{1,2})?)(?![0-9])/i
]

/** Numbers that are almost never tempos even though they fall in range. */
const BARE_NUMBER_BLOCKLIST = new Set([808, 909, 707, 606, 101, 303])

export function parseBpm(text: string): BpmGuess | null {
  for (const re of EXPLICIT_BPM) {
    const m = re.exec(text)
    if (m) {
      const bpm = Number(m[1])
      if (bpm >= 40 && bpm <= 300) return { bpm, confidence: 'explicit' }
    }
  }
  // A bare 2-3 digit number standing on its own between separators: "Loop_140_Am".
  const bare = /(?:^|[\s_\-.()[\]])(\d{2,3})(?=$|[\s_\-.()[\]])/g
  for (const m of text.matchAll(bare)) {
    const n = Number(m[1])
    if (n >= 60 && n <= 200 && !BARE_NUMBER_BLOCKLIST.has(n) && !m[1].startsWith('0')) {
      return { bpm: n, confidence: 'inferred' }
    }
  }
  return null
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const NATURAL_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** Canonical key string: sharps only, "m" suffix for minor. "Bb minor" -> "A#m". */
export function normalizeKey(letter: string, accidental: string, minor: boolean): string {
  let idx = NATURAL_INDEX[letter.toUpperCase()]
  if (/^(#|♯|sharp|s)$/i.test(accidental)) idx += 1
  else if (/^(b|♭|flat)$/i.test(accidental)) idx -= 1
  return SHARP_NAMES[(idx + 12) % 12] + (minor ? 'm' : '')
}

// Letter, optional accidental, optional separator, then a quality word.
const KEY_WITH_QUALITY =
  /(?<![A-Za-z0-9])([A-Ga-g])(#|♯|♭|b|sharp|flat)?[\s_-]?(minor|min|major|maj|m)(?![A-Za-z])/gi

// A lone note token like "C", "F#" or "Bb" between separators (major by convention).
const LONE_NOTE = /(?:^|[\s_\-.()[\]])([A-G])(#|♯|♭|b)?(?=$|[\s_\-.()[\]])/g

export function parseKey(text: string): string | null {
  for (const m of text.matchAll(KEY_WITH_QUALITY)) {
    const [, letter, accidental = '', quality] = m
    const q = quality.toLowerCase()
    // Lowercase notes ("am", "em") are usually English words unless clearly spelled out.
    if (letter === letter.toLowerCase() && !accidental && q === 'm') continue
    // An uppercase "M" alone is ambiguous (some write it for major); skip it.
    if (quality === 'M') continue
    // "b" as an accidental must be lowercase; uppercase B would be a note letter.
    if (accidental && accidental !== accidental.toLowerCase() && accidental.length === 1 && accidental !== '#') continue
    const minor = q === 'm' || q.startsWith('min')
    return normalizeKey(letter, accidental, minor)
  }

  // Lone note letters are only trusted when something else says "this name carries music info":
  // a "key" word, or a BPM written in the same name.
  const hasKeyWord = /(?<![a-z])key(?![a-z])/i.test(text)
  if (!hasKeyWord && !parseBpm(text)) return null
  for (const m of text.matchAll(LONE_NOTE)) {
    const [, letter, accidental = ''] = m
    return normalizeKey(letter, accidental, false)
  }
  return null
}
