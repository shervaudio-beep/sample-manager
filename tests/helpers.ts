import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** A valid PCM WAV of the given length. `seed` changes one byte so equal-length files differ. */
export function makeWav(
  seconds: number,
  opts: { sampleRate?: number; bitDepth?: 16 | 24; channels?: number; seed?: number } = {}
): Buffer {
  const sampleRate = opts.sampleRate ?? 44100
  const bitDepth = opts.bitDepth ?? 16
  const channels = opts.channels ?? 2
  const bytesPerSample = bitDepth / 8
  const frames = Math.round(seconds * sampleRate)
  const dataSize = frames * channels * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  buf.writeUInt16LE(channels * bytesPerSample, 32)
  buf.writeUInt16LE(bitDepth, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  if (opts.seed != null && dataSize > 0) buf[44] = opts.seed & 0xff
  return buf
}

export function tempDir(prefix = 'smgr-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

export function writeTree(root: string, files: Record<string, Buffer | string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}
