// The sm-audio:// protocol the player streams from, and native drag-out to a DAW.
// Files are looked up by library id, so the renderer can never ask for an arbitrary path.

import { nativeImage, protocol, type NativeImage, type WebContents } from 'electron'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { aiffToWav, mimeFor, needsConversion, parseRange } from './audio'
import type { FileRow } from '../shared/types'

export const AUDIO_SCHEME = 'sm-audio'

/** Must run before app 'ready'. */
export function registerAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: AUDIO_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

// Converted AIFFs are kept for the most recent file only: seeking re-requests ranges of it.
let converted: { path: string; mtimeMs: number; wav: Buffer } | null = null

async function convertedAiff(file: string): Promise<Buffer> {
  const { mtimeMs } = await stat(file)
  if (converted?.path === file && converted.mtimeMs === mtimeMs) return converted.wav
  const wav = aiffToWav(await readFile(file))
  converted = { path: file, mtimeMs, wav }
  return wav
}

export function handleAudioProtocol(getFile: (id: number) => FileRow | null): void {
  protocol.handle(AUDIO_SCHEME, async (req) => {
    // sm-audio://file/<id>
    const id = Number(new URL(req.url).pathname.slice(1))
    const file = Number.isInteger(id) ? getFile(id) : null
    if (!file) return new Response('Not in library', { status: 404 })

    try {
      const headers = {
        'Content-Type': mimeFor(file.ext),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        // The page is a file:// (or dev-server) origin; let its fetch() read the audio.
        'Access-Control-Allow-Origin': '*'
      }
      if (needsConversion(file.ext)) {
        const wav = await convertedAiff(file.path)
        const range = parseRange(req.headers.get('range'), wav.length)
        if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${wav.length}` } })
        if (!range) return new Response(new Uint8Array(wav), { headers: { ...headers, 'Content-Length': String(wav.length) } })
        return new Response(new Uint8Array(wav.subarray(range.start, range.end + 1)), {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(range.end - range.start + 1),
            'Content-Range': `bytes ${range.start}-${range.end}/${wav.length}`
          }
        })
      }

      const { size } = await stat(file.path)
      const range = parseRange(req.headers.get('range'), size)
      if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      const { start, end } = range ?? { start: 0, end: size - 1 }
      const body = Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          ...headers,
          'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
        }
      })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return new Response('File not found on disk', { status: 404 })
      return new Response(err instanceof Error ? err.message : 'Unreadable file', { status: 415 })
    }
  })
}

let dragIcon: NativeImage | null = null

/** A small waveform glyph shown under the cursor while dragging (required on macOS). */
function getDragIcon(): NativeImage {
  if (dragIcon) return dragIcon
  const size = 32
  const px = Buffer.alloc(size * size * 4) // BGRA
  const bars = [6, 12, 20, 26, 16, 22, 10, 18, 8]
  bars.forEach((h, i) => {
    const x0 = 2 + i * 3
    for (let y = (size - h) >> 1; y < (size + h) >> 1; y++) {
      for (let x = x0; x < x0 + 2; x++) {
        const o = (y * size + x) * 4
        px[o] = 0x3d // B
        px[o + 1] = 0x8a // G
        px[o + 2] = 0xff // R
        px[o + 3] = 0xff // A
      }
    }
  })
  dragIcon = nativeImage.createFromBitmap(px, { width: size, height: size })
  return dragIcon
}

/** Hand the original file to the OS drag system: DAWs receive the real path, nothing is copied. */
export function startFileDrag(sender: WebContents, files: FileRow[]): void {
  const paths = files.filter((f) => f.status === 'ok').map((f) => f.path)
  if (!paths.length) return
  if (paths.length === 1) sender.startDrag({ file: paths[0], icon: getDragIcon() })
  else sender.startDrag({ file: paths[0], files: paths, icon: getDragIcon() })
}
