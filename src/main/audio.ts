// Serving audio to the renderer: byte ranges (so seeking works without loading whole files)
// and an in-memory AIFF -> WAV conversion, because Chromium can't play AIFF.
// Nothing here writes to disk.

export interface ByteRange {
  start: number
  end: number // inclusive
}

/** Parse an HTTP Range header for a single range. null = no/ignorable header (send everything). */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // "bytes=-500": the last 500 bytes
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aif: 'audio/wav', // served converted
  aiff: 'audio/wav'
}

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

export function needsConversion(ext: string): boolean {
  return ext === 'aif' || ext === 'aiff'
}

/** IEEE 754 80-bit extended float (AIFF sample rate field). */
function readExtended(buf: Buffer, off: number): number {
  const exp = buf.readUInt16BE(off)
  const sign = exp & 0x8000 ? -1 : 1
  const e = exp & 0x7fff
  const hi = buf.readUInt32BE(off + 2)
  const lo = buf.readUInt32BE(off + 6)
  if (e === 0 && hi === 0 && lo === 0) return 0
  return sign * (hi * 2 ** 32 + lo) * 2 ** (e - 16383 - 63)
}

function wavHeader(dataSize: number, channels: number, sampleRate: number, bits: number, float: boolean): Buffer {
  const h = Buffer.alloc(44)
  const blockAlign = channels * (bits / 8)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataSize, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(float ? 3 : 1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * blockAlign, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataSize, 40)
  return h
}

/** Convert an uncompressed AIFF / AIFF-C file to a WAV buffer. Throws on compressed formats. */
export function aiffToWav(src: Buffer): Buffer {
  if (src.toString('ascii', 0, 4) !== 'FORM') throw new Error('Not an AIFF file')
  const form = src.toString('ascii', 8, 12)
  if (form !== 'AIFF' && form !== 'AIFC') throw new Error('Not an AIFF file')

  let channels = 0
  let frames = 0
  let bits = 0
  let sampleRate = 0
  let compression = 'NONE'
  let data: Buffer | null = null

  let off = 12
  while (off + 8 <= src.length) {
    const id = src.toString('ascii', off, off + 4)
    const size = src.readUInt32BE(off + 4)
    const body = off + 8
    if (id === 'COMM') {
      channels = src.readInt16BE(body)
      frames = src.readUInt32BE(body + 2)
      bits = src.readInt16BE(body + 6)
      sampleRate = Math.round(readExtended(src, body + 8))
      if (form === 'AIFC' && size >= 22) compression = src.toString('ascii', body + 18, body + 22)
    } else if (id === 'SSND') {
      const dataOffset = src.readUInt32BE(body)
      const start = body + 8 + dataOffset
      data = src.subarray(start, Math.min(off + 8 + size, src.length))
    }
    off = body + size + (size % 2) // chunks are padded to even length
  }
  if (!channels || !bits || !sampleRate || !data) throw new Error('AIFF is missing COMM or SSND')

  const bytes = Math.ceil(bits / 8)
  let float = false
  let littleEndian = false
  switch (compression) {
    case 'NONE':
    case 'twos':
      break
    case 'sowt':
      littleEndian = true
      break
    case 'fl32':
    case 'FL32':
      float = true
      bits = 32
      break
    case 'fl64':
    case 'FL64':
      float = true
      bits = 64
      break
    default:
      throw new Error(`Compressed AIFF (${compression}) can't be previewed`)
  }
  const sampleBytes = float ? bits / 8 : bytes
  const dataSize = Math.min(data.length, frames * channels * sampleBytes)
  const out = Buffer.alloc(44 + dataSize)
  wavHeader(dataSize, channels, sampleRate, float ? bits : bytes * 8, float).copy(out, 0)
  const pcm = out.subarray(44)

  if (littleEndian) {
    data.copy(pcm, 0, 0, dataSize)
  } else if (sampleBytes === 1) {
    // AIFF 8-bit is signed, WAV 8-bit is unsigned.
    for (let i = 0; i < dataSize; i++) pcm[i] = (data[i] + 128) & 0xff
  } else {
    // Big-endian -> little-endian, one sample at a time.
    for (let i = 0; i + sampleBytes <= dataSize; i += sampleBytes) {
      for (let b = 0; b < sampleBytes; b++) pcm[i + b] = data[i + sampleBytes - 1 - b]
    }
  }
  return out
}
