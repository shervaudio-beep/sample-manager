// Draws the app icon (build/icon.png, 1024x1024): the orange waveform from the drag icon on a
// dark rounded square, inset to Apple's icon grid. electron-builder turns it into .icns/.ico.
// Run: node scripts/make-icon.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const px = new Uint8Array(SIZE * SIZE * 4)

// Rounded square: 824 px wide with a 185 px corner radius, like macOS app icons.
const BOX = 824
const R = 185
const O = (SIZE - BOX) / 2
const BG = [0x15, 0x17, 0x1c]
const EDGE = [0x26, 0x2a, 0x32]
const ORANGE = [0xff, 0x8a, 0x3d]

/** Coverage (0..1) of a pixel by the rounded square, anti-aliased at the corners. */
function boxCoverage(x, y) {
  const cx = Math.min(Math.max(x, O + R), O + BOX - R)
  const cy = Math.min(Math.max(y, O + R), O + BOX - R)
  const d = Math.hypot(x - cx, y - cy)
  return Math.max(0, Math.min(1, R - d + 0.5))
}

const bars = [0.3, 0.55, 0.85, 1, 0.7, 0.92, 0.5, 0.75, 0.4]
const barW = 46
const gap = 28
const totalW = bars.length * barW + (bars.length - 1) * gap
const left = (SIZE - totalW) / 2
const maxH = 470

/** Coverage of a pixel by the bars (rounded caps). */
function barCoverage(x, y) {
  for (let i = 0; i < bars.length; i++) {
    const x0 = left + i * (barW + gap)
    if (x < x0 - 1 || x > x0 + barW + 1) continue
    const h = bars[i] * maxH
    const top = SIZE / 2 - h / 2 + barW / 2
    const bottom = SIZE / 2 + h / 2 - barW / 2
    const cx = x0 + barW / 2
    const cy = Math.min(Math.max(y, top), bottom)
    return Math.max(0, Math.min(1, barW / 2 - Math.hypot(x - cx, y - cy) + 0.5))
  }
  return 0
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const a = boxCoverage(x + 0.5, y + 0.5)
    if (!a) continue
    // A faint lighter rim and a subtle top-to-bottom shade give it some depth.
    const rim = Math.max(0, Math.min(1, 6 - (R - Math.hypot(
      x + 0.5 - Math.min(Math.max(x + 0.5, O + R), O + BOX - R),
      y + 0.5 - Math.min(Math.max(y + 0.5, O + R), O + BOX - R)
    )))) * (a > 0.99 ? 1 : 0)
    const edgeDist = Math.min(x - O, y - O, O + BOX - x, O + BOX - y)
    const rimStraight = edgeDist < 6 ? 1 : 0
    const shade = 1.12 - 0.24 * ((y - O) / BOX)
    let c = BG.map((v, i) => Math.min(255, v * shade + (EDGE[i] - BG[i]) * Math.max(rim, rimStraight)))
    const b = barCoverage(x + 0.5, y + 0.5)
    c = c.map((v, i) => v * (1 - b) + ORANGE[i] * b)
    const o = (y * SIZE + x) * 4
    px[o] = c[0]
    px[o + 1] = c[1]
    px[o + 2] = c[2]
    px[o + 3] = Math.round(a * 255)
  }
}

// ---- minimal PNG encoder (RGBA, no filtering) ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync(new URL('../build/', import.meta.url), { recursive: true })
writeFileSync(new URL('../build/icon.png', import.meta.url), png)
console.log(`build/icon.png written (${(png.length / 1024).toFixed(0)} KB)`)
