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

  // Dense high-frequency art still trips checkerRatio on its own - that stat is contrast
  // only. checkerRegularity is what keeps it from being an accusation; see below.
  it('dense periodic texture still trips the contrast stat alone', () => {
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

describe('checkerRegularity', () => {
  const SIZE = 256
  const DEFAULT_MAX_CHECKER = 0.03
  const DEFAULT_MIN_REGULARITY = 0.45
  /** The guard's actual test: high contrast AND on a lattice. */
  const looksCheckered = (s: { checkerRatio: number; checkerRegularity: number }) =>
    s.checkerRatio > DEFAULT_MAX_CHECKER && s.checkerRegularity > DEFAULT_MIN_REGULARITY

  const checker = (a: number, b: number, square = 16) => (x: number, y: number) =>
    ((Math.floor(x / square) + Math.floor(y / square)) % 2 === 0 ? [a, a, a, 255] : [b, b, b, 255]) as [
      number,
      number,
      number,
      number,
    ]

  // A lattice saturates the stat: every transition lands on the same width/square columns,
  // whatever the palette or square size.
  it.each([
    ['#fff/#ccc square 8', 255, 204, 8],
    ['#fff/#ccc square 16', 255, 204, 16],
    ['#fff/#ccc square 32', 255, 204, 32],
    ['#fff/#ccc square 64', 255, 204, 64],
    ['#999/#666 square 16', 153, 102, 16],
    ['black/white square 16', 255, 0, 16],
  ])('scores a %s checkerboard as a lattice', (_label, a, b, square) => {
    const stats = analyzeMatte(image(SIZE, SIZE, checker(a, b, square)))
    expect(stats.checkerRegularity).toBeGreaterThan(DEFAULT_MIN_REGULARITY)
  })

  it.each([
    ['#fff/#ccc square 8', 255, 204, 8],
    ['#fff/#ccc square 16', 255, 204, 16],
    ['#999/#666 square 16', 153, 102, 16],
    ['black/white square 16', 255, 0, 16],
  ])('convicts a %s checkerboard', (_label, a, b, square) => {
    expect(looksCheckered(analyzeMatte(image(SIZE, SIZE, checker(a, b, square))))).toBe(true)
  })

  // Pre-existing gap, unchanged by checkerRegularity and recorded so it is not mistaken for
  // one: big squares mean few transitions, so checkerRatio falls under maxChecker on its own
  // (square 32 -> 0.029, square 64 -> 0.010, against a 0.03 bar) and the lattice test never
  // gets a say. Closing it would mean convicting on regularity at a lower contrast, which
  // also convicts genuinely grid-shaped subjects - a chessboard, a window grille, woven cloth.
  it.each([
    ['square 32', 32],
    ['square 64', 64],
  ])('does not reach the contrast bar for a coarse %s checkerboard', (_label, square) => {
    const stats = analyzeMatte(image(SIZE, SIZE, checker(255, 204, square)))
    expect(stats.checkerRegularity).toBeGreaterThan(DEFAULT_MIN_REGULARITY) // the lattice is seen
    expect(stats.checkerRatio).toBeLessThan(DEFAULT_MAX_CHECKER) // but contrast never accuses
    expect(looksCheckered(stats)).toBe(false)
  })

  it('still convicts a checkerboard painted into a frame opening', () => {
    const stats = analyzeMatte(
      image(SIZE, SIZE, (x, y) => {
        const inHole = Math.abs(x - SIZE / 2) < SIZE * 0.22 && Math.abs(y - SIZE / 2) < SIZE * 0.22
        return inHole ? checker(255, 204)(x, y) : [180, 150, 90, 255]
      }),
    )
    expect(looksCheckered(stats)).toBe(true)
  })

  it('survives a hand-painted checkerboard jittered by half a square', () => {
    // Deterministic per-cell offset - a model copying the pattern freehand will not be exact.
    const hash = (x: number, y: number) => {
      let h = (x * 374761393 + y * 668265263) >>> 0
      h = ((h ^ (h >>> 13)) * 1274126177) >>> 0
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296
    }
    const stats = analyzeMatte(
      image(SIZE, SIZE, (x, y) => {
        const cx = Math.floor(x / 16)
        const cy = Math.floor(y / 16)
        const ox = (hash(cx, cy) - 0.5) * 16
        const oy = (hash(cy, cx) - 0.5) * 16
        return checker(255, 204)(Math.round(x + ox), Math.round(y + oy))
      }),
    )
    expect(looksCheckered(stats)).toBe(true)
  })

  // The regression this stat exists for: radial art alternates facets exactly the way
  // checkerRatio looks for, and used to burn every retry on a clean matte.
  it.each([
    [
      'concentric rings',
      (x: number, y: number) => {
        const d = Math.hypot(x - SIZE / 2, y - SIZE / 2)
        const v = Math.floor(d / 5) % 2 === 0 ? 220 : 120
        return [v, Math.round(v * 0.8), Math.round(v * 0.5), 255] as [number, number, number, number]
      },
    ],
    [
      'a radial starburst (compass rose)',
      (x: number, y: number) => {
        const dx = x - SIZE / 2
        const dy = y - SIZE / 2
        if (Math.hypot(dx, dy) > SIZE * 0.45) return [0, 0, 0, 0] as [number, number, number, number]
        const v = Math.floor((Math.atan2(dy, dx) / Math.PI) * 16) % 2 === 0 ? 225 : 110
        return [v, Math.round(v * 0.8), Math.round(v * 0.45), 255] as [number, number, number, number]
      },
    ],
  ])('does not convict %s', (_label, fill) => {
    const stats = analyzeMatte(image(SIZE, SIZE, fill))
    expect(stats.checkerRatio).toBeGreaterThan(DEFAULT_MAX_CHECKER) // contrast alone accuses
    expect(stats.checkerRegularity).toBeLessThan(DEFAULT_MIN_REGULARITY) // the lattice test acquits
    expect(looksCheckered(stats)).toBe(false)
  })

  // Known limit, recorded so it is not rediscovered as a bug: the test keys on axis
  // alignment, so a rotated painted checkerboard reads as art. Accepted deliberately - the
  // editor checkerboard a model copies is axis-aligned, and the alternative test that would
  // catch this (two-tone-ness) convicts flat two-colour art, which is a real subject.
  it('is a heuristic: a rotated checkerboard is not caught', () => {
    const stats = analyzeMatte(
      image(SIZE, SIZE, (x, y) => {
        const r = (15 * Math.PI) / 180
        const cx = x - SIZE / 2
        const cy = y - SIZE / 2
        const u = cx * Math.cos(r) - cy * Math.sin(r)
        const v = cx * Math.sin(r) + cy * Math.cos(r)
        return checker(255, 204)(Math.round(u + SIZE / 2), Math.round(v + SIZE / 2))
      }),
    )
    expect(stats.checkerRegularity).toBeLessThan(DEFAULT_MIN_REGULARITY)
  })
})
