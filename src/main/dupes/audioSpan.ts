// Where the audio itself sits inside a file, skipping tags and metadata. Two files with the
// same audio but different names, ID3 tags, BWF/LIST chunks or cover art have identical spans,
// so hashing the span finds duplicates that a whole-file hash would miss. Read-only.

import { open, type FileHandle } from 'node:fs/promises'

export interface AudioSpan {
  offset: number
  length: number
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

const clamp = (offset: number, length: number, size: number): AudioSpan => {
  const start = Math.min(Math.max(0, offset), size)
  return { offset: start, length: Math.max(0, Math.min(length, size - start)) }
}

/** RIFF/WAVE: the 'data' chunk. */
async function wavSpan(fh: FileHandle, size: number): Promise<AudioSpan | null> {
  const head = await readAt(fh, 0, 12)
  if (head.length < 12 || !['RIFF', 'RF64'].includes(head.toString('ascii', 0, 4)) || head.toString('ascii', 8, 12) !== 'WAVE') return null
  let pos = 12
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 8)
    if (h.length < 8) break
    const id = h.toString('ascii', 0, 4)
    const len = h.readUInt32LE(4)
    // RF64 and broken writers put 0xFFFFFFFF here: the data runs to the end of the file.
    if (id === 'data') return clamp(pos + 8, len === 0xffffffff ? size : len, size)
    pos += 8 + len + (len & 1)
  }
  return null
}

/** AIFF/AIFF-C: the sample data inside 'SSND'. */
async function aiffSpan(fh: FileHandle, size: number): Promise<AudioSpan | null> {
  const head = await readAt(fh, 0, 12)
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'FORM' || !['AIFF', 'AIFC'].includes(head.toString('ascii', 8, 12))) return null
  let pos = 12
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 16)
    if (h.length < 8) break
    const len = h.readUInt32BE(4)
    if (h.toString('ascii', 0, 4) === 'SSND' && h.length >= 16) {
      const dataOffset = h.readUInt32BE(8)
      return clamp(pos + 16 + dataOffset, len - 8 - dataOffset, size)
    }
    pos += 8 + len + (len & 1)
  }
  return null
}

/** FLAC: everything after the last metadata block (tags and pictures live in those blocks). */
async function flacSpan(fh: FileHandle, size: number): Promise<AudioSpan | null> {
  let pos = 0
  const id3 = await skipId3v2(fh)
  pos = id3
  if ((await readAt(fh, pos, 4)).toString('ascii') !== 'fLaC') return null
  pos += 4
  for (;;) {
    const h = await readAt(fh, pos, 4)
    if (h.length < 4) return null
    const last = (h[0] & 0x80) !== 0
    pos += 4 + h.readUIntBE(1, 3)
    if (last) break
  }
  const end = size - (await id3v1Length(fh, size))
  return clamp(pos, end - pos, size)
}

/** Bytes taken by ID3v2 tags at the start (there can be more than one). */
async function skipId3v2(fh: FileHandle): Promise<number> {
  let pos = 0
  for (;;) {
    const h = await readAt(fh, pos, 10)
    if (h.length < 10 || h.toString('ascii', 0, 3) !== 'ID3') return pos
    const tagSize = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f)
    const footer = h[5] & 0x10 ? 10 : 0
    pos += 10 + tagSize + footer
  }
}

/** Bytes taken by an ID3v1 tag ("TAG", 128 bytes) at the very end, if any. */
async function id3v1Length(fh: FileHandle, size: number): Promise<number> {
  if (size < 128) return 0
  return (await readAt(fh, size - 128, 3)).toString('ascii') === 'TAG' ? 128 : 0
}

/** MP3: strip ID3v2 at the start, and ID3v1 and APEv2 tags at the end. */
async function mp3Span(fh: FileHandle, size: number): Promise<AudioSpan> {
  const start = await skipId3v2(fh)
  let end = size - (await id3v1Length(fh, size))
  // APEv2 footer: "APETAGEX", version, tag size (items + footer), item count, flags.
  if (end >= 32) {
    const f = await readAt(fh, end - 32, 32)
    if (f.toString('ascii', 0, 8) === 'APETAGEX') {
      const tagSize = f.readUInt32LE(12)
      const hasHeader = (f.readUInt32LE(20) & 0x80000000) !== 0
      end -= tagSize + (hasHeader ? 32 : 0)
    }
  }
  return clamp(start, end - start, size)
}

/** MP4/M4A: the 'mdat' box (iTunes tags and artwork live in 'moov'). */
async function mp4Span(fh: FileHandle, size: number): Promise<AudioSpan | null> {
  let pos = 0
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 16)
    if (h.length < 8) break
    let len = h.readUInt32BE(0)
    let headerLen = 8
    if (len === 1 && h.length >= 16) {
      len = Number(h.readBigUInt64BE(8))
      headerLen = 16
    } else if (len === 0) {
      len = size - pos
    }
    if (len < headerLen) break
    if (h.toString('ascii', 4, 8) === 'mdat') return clamp(pos + headerLen, len - headerLen, size)
    pos += len
  }
  return null
}

/**
 * The byte range holding the audio. Falls back to the whole file for formats it can't look
 * inside (Ogg, anything malformed), which still finds exact copies.
 */
export async function audioSpan(path: string, ext: string): Promise<AudioSpan> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    let span: AudioSpan | null = null
    switch (ext.toLowerCase().replace(/^\./, '')) {
      case 'wav':
        span = await wavSpan(fh, size)
        break
      case 'aif':
      case 'aiff':
        span = await aiffSpan(fh, size)
        break
      case 'flac':
        span = await flacSpan(fh, size)
        break
      case 'mp3':
        span = await mp3Span(fh, size)
        break
      case 'm4a':
      case 'mp4':
        span = await mp4Span(fh, size)
        break
    }
    return span && span.length > 0 ? span : { offset: 0, length: size }
  } finally {
    await fh.close()
  }
}
