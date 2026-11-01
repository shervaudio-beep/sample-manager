import { parseBuffer } from 'music-metadata'
import { describe, expect, it } from 'vitest'
import { aiffToWav, mimeFor, parseRange } from '../src/main/audio'
import { syncRate } from '../src/shared/sync'

describe('parseRange', () => {
  it('returns null when there is no usable header', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('items=0-5', 1000)).toBeNull()
  })

  it('parses open, closed and suffix ranges', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('flags ranges outside the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=500-100', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })
})

describe('mimeFor', () => {
  it('maps every supported format, serving AIFF as WAV', () => {
    expect(mimeFor('wav')).toBe('audio/wav')
    expect(mimeFor('MP3')).toBe('audio/mpeg')
    expect(mimeFor('aiff')).toBe('audio/wav')
    expect(mimeFor('m4a')).toBe('audio/mp4')
  })
})

/** Build an AIFF (or AIFF-C) file around big- or little-endian sample bytes. */
function makeAiff(opts: {
  channels: number
  bits: number
  sampleRate: number
  samples: Buffer
  compression?: string
}): Buffer {
  const bytes = Math.ceil(opts.bits / 8)
  const frames = opts.samples.length / (opts.channels * bytes)
  const aifc = opts.compression != null
  const commSize = aifc ? 24 : 18
  const comm = Buffer.alloc(8 + commSize)
  comm.write('COMM', 0)
  comm.writeUInt32BE(commSize, 4)
  comm.writeInt16BE(opts.channels, 8)
  comm.writeUInt32BE(frames, 10)
  comm.writeInt16BE(opts.bits, 14)
  // 80-bit extended sample rate
  const exp = Math.floor(Math.log2(opts.sampleRate))
  comm.writeUInt16BE(16383 + exp, 16)
  const mant = opts.sampleRate / 2 ** exp
  comm.writeUInt32BE(Math.floor(mant * 2 ** 31), 18)
  comm.writeUInt32BE(0, 22)
  if (aifc) {
    comm.write(opts.compression!, 26)
    comm.writeUInt8(0, 30) // empty pascal string
  }
  const ssnd = Buffer.alloc(16 + opts.samples.length)
  ssnd.write('SSND', 0)
  ssnd.writeUInt32BE(8 + opts.samples.length, 4)
  opts.samples.copy(ssnd, 16)
  const body = Buffer.concat([Buffer.from(aifc ? 'AIFC' : 'AIFF'), comm, ssnd])
  const head = Buffer.alloc(8)
  head.write('FORM', 0)
  head.writeUInt32BE(body.length, 4)
  return Buffer.concat([head, body])
}

describe('aiffToWav', () => {
  it('converts 16-bit big-endian AIFF to a playable little-endian WAV', async () => {
    const samples = Buffer.alloc(8)
    samples.writeInt16BE(1000, 0)
    samples.writeInt16BE(-2, 2)
    samples.writeInt16BE(32767, 4)
    samples.writeInt16BE(-32768, 6)
    const wav = aiffToWav(makeAiff({ channels: 2, bits: 16, sampleRate: 44100, samples }))

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readInt16LE(44)).toBe(1000)
    expect(wav.readInt16LE(46)).toBe(-2)
    expect(wav.readInt16LE(48)).toBe(32767)
    expect(wav.readInt16LE(50)).toBe(-32768)
    const { format } = await parseBuffer(wav, { mimeType: 'audio/wav' })
    expect(format).toMatchObject({ sampleRate: 44100, numberOfChannels: 2, bitsPerSample: 16 })
  })

  it('converts 24-bit at 48 kHz', () => {
    const samples = Buffer.from([0x12, 0x34, 0x56])
    const wav = aiffToWav(makeAiff({ channels: 1, bits: 24, sampleRate: 48000, samples }))
    expect(wav.readUInt32LE(24)).toBe(48000)
    expect(wav.readUInt16LE(34)).toBe(24)
    expect([...wav.subarray(44, 47)]).toEqual([0x56, 0x34, 0x12])
  })

  it('turns signed 8-bit into unsigned 8-bit', () => {
    const wav = aiffToWav(makeAiff({ channels: 1, bits: 8, sampleRate: 22050, samples: Buffer.from([0x00, 0x7f, 0x80]) }))
    expect([...wav.subarray(44)]).toEqual([0x80, 0xff, 0x00])
  })

  it('copies little-endian AIFF-C (sowt) as-is', () => {
    const samples = Buffer.from([0x01, 0x02, 0x03, 0x04])
    const wav = aiffToWav(makeAiff({ channels: 1, bits: 16, sampleRate: 44100, samples, compression: 'sowt' }))
    expect([...wav.subarray(44)]).toEqual([0x01, 0x02, 0x03, 0x04])
  })

  it('refuses compressed AIFF-C and non-AIFF data', () => {
    const samples = Buffer.alloc(4)
    expect(() => aiffToWav(makeAiff({ channels: 1, bits: 16, sampleRate: 44100, samples, compression: 'ima4' }))).toThrow(
      /Compressed AIFF/
    )
    expect(() => aiffToWav(Buffer.from('RIFF....WAVE'))).toThrow(/Not an AIFF/)
  })
})

describe('syncRate', () => {
  it('stretches a loop to the project tempo', () => {
    expect(syncRate(140, 140)).toBe(1)
    expect(syncRate(120, 140)).toBeCloseTo(1.167, 3)
    expect(syncRate(150, 140)).toBeCloseTo(0.933, 3)
  })

  it('uses half/double time instead of extreme stretching', () => {
    expect(syncRate(70, 140)).toBe(1)
    expect(syncRate(280, 140)).toBe(1)
    expect(syncRate(85, 170)).toBe(1)
    expect(syncRate(90, 140)).toBeCloseTo(0.778, 3)
  })

  it('leaves files without a BPM alone', () => {
    expect(syncRate(null, 140)).toBe(1)
  })
})
