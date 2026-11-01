// Harmonic mixing helpers. Keys are in the app's canonical form: sharps only, "m" for minor.

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function parse(key: string): { note: number; minor: boolean } | null {
  const minor = key.endsWith('m')
  const note = NOTES.indexOf(minor ? key.slice(0, -1) : key)
  return note < 0 ? null : { note, minor }
}

const name = (note: number, minor: boolean): string => NOTES[(note + 12) % 12] + (minor ? 'm' : '')

/**
 * Keys that mix well with `key`: the key itself, its relative major/minor, and the keys
 * a fifth up and down in the same mode (the neighbours on the Camelot wheel).
 */
export function compatibleKeys(key: string): string[] {
  const k = parse(key)
  if (!k) return []
  const relative = k.minor ? name(k.note + 3, false) : name(k.note - 3, true)
  return [name(k.note, k.minor), relative, name(k.note + 7, k.minor), name(k.note + 5, k.minor)]
}

/** Camelot code, e.g. "8A" for A minor, "8B" for C major. */
export function camelot(key: string): string | null {
  const k = parse(key)
  if (!k) return null
  // C major is 8B and each fifth up adds one; minors share the number of their relative major.
  const major = k.minor ? (k.note + 3) % 12 : k.note
  const steps = (major * 7) % 12 // number of fifths from C
  return `${((7 + steps) % 12) + 1}${k.minor ? 'A' : 'B'}`
}
