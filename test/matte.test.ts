import { describe, expect, it } from 'vitest'
import { analyzeMatte, differenceMatte } from '../src/matte.ts'
import type { RawImage } from '../src/matte.ts'

function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): RawImage {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width, height }
}

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2

describe('differenceMatte', () => {
  it('solves an opaque subject exactly', () => {
    // red disc on white vs the same disc on black
    const size = 64
    const white = image(size, size, (x, y) => (inCircle(x, y, 32, 32, 12) ? [200, 30, 30, 255] : [255, 255, 255, 255]))
    const black = image(size, size, (x, y) => (inCircle(x, y, 32, 32, 12) ? [200, 30, 30, 255] : [0, 0, 0, 255]))
    const matte = differenceMatte(white, black)
    const center = (32 * size + 32) * 4
    expect(matte.data[center + 3]).toBe(255)
    expect(matte.data[center]).toBe(200)
    const corner = 3
    expect(matte.data[corner]).toBe(0)
    const stats = analyzeMatte(matte)
    expect(stats.borderAlpha).toBeLessThan(0.01)
    expect(stats.strayRatio).toBe(0)
    expect(stats.opaqueRatio).toBeGreaterThan(0.05)
    expect(stats.opaqueRatio).toBeLessThan(0.2)
  })

  it('flags the un-cut failure mode (black edit came back unchanged)', () => {
    const size = 64
    const white = image(size, size, () => [255, 255, 255, 255])
    // "black" is still the white frame: white - black = 0, alpha = 1 everywhere
    const matte = differenceMatte(white, white)
    const stats = analyzeMatte(matte)
    expect(stats.opaqueRatio).toBeGreaterThan(0.99)
    expect(stats.borderAlpha).toBeGreaterThan(0.9)
  })

  it('rejects size mismatches', () => {
    const a = image(8, 8, () => [0, 0, 0, 255])
    const b = image(9, 8, () => [0, 0, 0, 255])
    expect(() => differenceMatte(a, b)).toThrow(/Size mismatch/)
  })
})

describe('checkerRatio', () => {
  const SIZE = 256
  const DEFAULT_MAX_CHECKER = 0.03

  /** A ring frame: opaque everywhere but a square hole in the middle, which `hole` paints. */
  const frame = (hole: (x: number, y: number) => [number, number, number, number]) =>
    image(SIZE, SIZE, (x, y) => {
      const inHole = Math.abs(x - SIZE / 2) < SIZE * 0.22 && Math.abs(y - SIZE / 2) < SIZE * 0.22
      return inHole ? hole(x, y) : [180, 150, 90, 255]
    })

  const checker = (a: number, b: number, square = 16) => (x: number, y: number) =>
    ((Math.floor(x / square) + Math.floor(y / square)) % 2 === 0 ? [a, a, a, 255] : [b, b, b, 255]) as [
      number,
      number,
      number,
      number,
    ]

  it('stays near zero for a clean cutout with a real hole', () => {
    const stats = analyzeMatte(frame(() => [0, 0, 0, 0]))
    expect(stats.checkerRatio).toBeLessThan(DEFAULT_MAX_CHECKER)
  })

  // The failure the whole stat exists for, in the two palettes an image editor actually uses.
  // Both are a luminance step of exactly 0.20, so a contrast threshold at or above that misses
  // them entirely - which is what shipped until it was measured.
  it.each([
    ['#fff/#ccc, the light editor checkerboard', 255, 204],
    ['#999/#666, the dark editor checkerboard', 153, 102],
    ['black/white, maximum contrast', 255, 0],
  ])('catches a hole painted as %s', (_label, a, b) => {
    const stats = analyzeMatte(frame(checker(a, b)))
    expect(stats.checkerRatio).toBeGreaterThan(DEFAULT_MAX_CHECKER)
  })

  it('catches a checkerboard that alternates alpha rather than colour', () => {
    const stats = analyzeMatte(
      frame((x, y) => ((Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? [255, 255, 255, 255] : [255, 255, 255, 0])),
    )
    expect(stats.checkerRatio).toBeGreaterThan(DEFAULT_MAX_CHECKER)
  })

  it('tolerates engraved ornament around a real hole', () => {
    // Sparse raised lines on metal - the shape real filigree takes: thin strokes with plain
    // ground between them, not wall-to-wall texture. Measured on the generated fantasy frames
    // this lands at 0.001 - 0.024, comfortably under the threshold.
    const stats = analyzeMatte(
      image(SIZE, SIZE, (x, y) => {
        const inHole = Math.abs(x - SIZE / 2) < SIZE * 0.22 && Math.abs(y - SIZE / 2) < SIZE * 0.22
        if (inHole) return [0, 0, 0, 0]
        const d = Math.hypot(x - SIZE / 2, y - SIZE / 2)
        const onLine = Math.floor(d / 12) % 4 === 0
        const v = onLine ? 230 : 140
        return [v, Math.round(v * 0.82), Math.round(v * 0.5), 255]
      }),
    )
    expect(stats.checkerRatio).toBeLessThan(DEFAULT_MAX_CHECKER)
  })

  // Known limit, recorded so it is not rediscovered as a bug: this is a contrast-churn
  // heuristic with no notion of periodicity, so any dense high-frequency texture reads as a
  // checkerboard. Nothing in the themes generates one, and the guard's answer to a trip is
  // "re-roll and look", not "discard".
  it('is a heuristic: dense periodic texture reads as a false positive', () => {
    const stats = analyzeMatte(
      image(SIZE, SIZE, (x, y) => {
        const d = Math.hypot(x - SIZE / 2, y - SIZE / 2)
        const v = Math.floor(d / 5) % 2 === 0 ? 220 : 120
        return [v, Math.round(v * 0.8), Math.round(v * 0.5), 255]
      }),
    )
    expect(stats.checkerRatio).toBeGreaterThan(DEFAULT_MAX_CHECKER)
  })
})
