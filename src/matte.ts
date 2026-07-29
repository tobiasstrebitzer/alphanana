// Difference matting (Smith & Blinn, "Blue Screen Matting", SIGGRAPH 1996).
//
// Two renders of the SAME subject on white and black backgrounds give an EXACT solve
// for alpha and un-contaminated foreground color - no thresholds, no despill, no spill.
// Channels normalized 0..1:
//
//   white = a*F + (1-a)*1     black = a*F + (1-a)*0
//   so a = 1 - (white - black) and F = black / a (un-premultiply)
//
// The only assumption is that the two renders are pixel-aligned and differ ONLY in the
// background - analyzeMatte() exists to detect when the generator broke that.

import { resolve } from 'node:path'
import sharp from 'sharp'

export interface RawImage {
  data: Buffer
  width: number
  height: number
}

export async function loadRawRGBA(path: string): Promise<RawImage> {
  const { data, info } = await sharp(resolve(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * Value step counted as a hard edge by checkerRatio.
 *
 * 0.18 rather than a rounder number because the thing being detected has a fixed contrast: an
 * image editor draws its transparency checkerboard as #fff/#ccc or #999/#666, and both of those
 * are a luminance step of exactly 0.20. At the old 0.25 the squares therefore never registered at
 * all and the guard was blind to the two palettes a model is most likely to copy - a painted
 * checkerboard scored 0.0067 against art that scored 0.0040, i.e. nothing. 0.20 itself is no good
 * either, since `> 0.20` fails on the exact step. Below 0.18 clean ornament starts counting its own
 * filigree without catching anything new. Measured on real frames: clean 0.001 - 0.024,
 * checkerboard 0.049 - 0.067.
 */
const CHECKER_CONTRAST = 0.18

/**
 * Densest share of transition coordinates checkerRegularity measures, per axis.
 *
 * An editor checkerboard of square size S puts every one of its transitions on the same
 * width/S columns, so any sampling fraction at or above 1/S captures all of them and the
 * stat saturates at 1.0. 0.125 covers squares down to 8px (below that the squares are
 * smaller than the antialiasing and the pattern stops being a checkerboard anyway), while
 * still being narrow enough that art scattering transitions evenly scores near it: a
 * uniform spread scores exactly 0.125, and measured art lands 0.21 - 0.31.
 */
const CHECKER_TOP_FRACTION = 0.125

export function differenceMatte(white: RawImage, black: RawImage, opts: { floor?: number } = {}): RawImage {
  if (white.width !== black.width || white.height !== black.height) {
    throw new Error(`Size mismatch: white ${white.width}x${white.height} vs black ${black.width}x${black.height}.`)
  }
  const floor = opts.floor ?? 0.02
  const { width, height } = white
  const n = width * height
  const out = Buffer.alloc(n * 4)

  for (let p = 0; p < n; p += 1) {
    const i = p * 4
    const diff =
      ((white.data[i]! - black.data[i]!) +
        (white.data[i + 1]! - black.data[i + 1]!) +
        (white.data[i + 2]! - black.data[i + 2]!)) /
      (3 * 255)
    const alpha = clamp01(1 - diff)
    if (alpha < floor) {
      out[i + 3] = 0
      continue
    }
    out[i] = Math.round(clamp01(black.data[i]! / 255 / alpha) * 255)
    out[i + 1] = Math.round(clamp01(black.data[i + 1]! / 255 / alpha) * 255)
    out[i + 2] = Math.round(clamp01(black.data[i + 2]! / 255 / alpha) * 255)
    out[i + 3] = Math.round(alpha * 255)
  }
  return { data: out, width, height }
}

export interface MatteStats {
  /** fraction of pixels with alpha > 0.5 */
  opaqueRatio: number
  /** fraction of opaque area NOT in the largest connected blob */
  strayRatio: number
  /** fraction of neighbor pairs with a hard (>0.5) alpha jump */
  roughness: number
  /** mean alpha over the outer frame ring */
  borderAlpha: number
  /**
   * Fraction of interior neighbour pairs that hard-switch in composited-over-black value.
   * Image models cannot draw transparency, so when a prompt asks for it they paint the
   * checkerboard that stands for it in image editors. That lands in the matte sometimes as
   * alternating alpha and sometimes as flat-alpha black/white squares, so the check has to
   * look at alpha * luminance to catch both. A clean cutout is near zero here whether it is
   * hollow or solid; a painted checkerboard is an order of magnitude up. It is a contrast
   * heuristic, not a proof: a deliberately radiant frame lands maybe half a threshold below
   * a checkerboard, so treat a trip as "re-roll and look", which is what the guard does.
   */
  checkerRatio: number
  /**
   * How much of that contrast churn sits on a regular axis-aligned lattice, 0..1.
   *
   * checkerRatio counts hard steps but knows nothing about where they are, so any dense
   * high-frequency subject trips it - a compass rose, sunburst or pinwheel alternates
   * light and dark facets exactly the way the stat looks for. What separates the real
   * failure from that art is position, not contrast: an editor checkerboard puts every
   * horizontal transition on the same handful of columns and every vertical one on the
   * same rows, because it IS a grid. Art scatters them across every coordinate.
   *
   * So this histograms the coordinate of each transition per axis and reports the share
   * landing in the densest CHECKER_TOP_FRACTION of coordinates, taking the weaker axis
   * (a lattice is regular in both; stripes are not a checkerboard). Measured: every
   * synthetic checkerboard 1.000 regardless of palette, square size or whether it
   * alternates colour or alpha; four real generated compass roses 0.211 - 0.278;
   * synthetic radial starburst and concentric rings 0.257 - 0.313. A checkerboard has to
   * be jittered by half a square before it falls to 0.562, still clear of any art.
   *
   * Known limit: this keys on axis alignment, so a *rotated* painted checkerboard reads
   * as art (5 degrees already drops it to 0.231). That is the accepted trade - the editor
   * checkerboard models copy is canonically axis-aligned, whereas flat two-tone art that
   * a rotation-tolerant test would have to accommodate is a real subject.
   */
  checkerRegularity: number
}

// Detects the difference-matting failure mode: when the generator re-rendered or
// hallucinated content between the two frames, the "empty" background resolves to opaque
// noise - disconnected blobs (strayRatio) and high-frequency speckle (roughness).
export function analyzeMatte(matte: RawImage): MatteStats {
  const { data, width, height } = matte
  const n = width * height
  const A = new Uint8Array(n)
  for (let p = 0; p < n; p += 1) A[p] = data[p * 4 + 3]!

  let opaque = 0
  for (let p = 0; p < n; p += 1) if (A[p]! > 128) opaque += 1

  // High-frequency roughness: hard alpha jumps between 4-neighbors.
  let jumps = 0
  let pairs = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = A[y * width + x]!
      if (x + 1 < width) {
        pairs += 1
        if (Math.abs(a - A[y * width + x + 1]!) > 128) jumps += 1
      }
      if (y + 1 < height) {
        pairs += 1
        if (Math.abs(a - A[(y + 1) * width + x]!) > 128) jumps += 1
      }
    }
  }

  // Largest connected component of the opaque mask (iterative flood fill).
  let largest = 0
  if (opaque > 0) {
    const seen = new Uint8Array(n)
    const stack = new Int32Array(opaque + 1)
    for (let start = 0; start < n; start += 1) {
      if (A[start]! <= 128 || seen[start]) continue
      let sp = 0
      stack[sp++] = start
      seen[start] = 1
      let size = 0
      while (sp > 0) {
        const idx = stack[--sp]!
        size += 1
        const x = idx % width
        const y = (idx - x) / width
        if (x > 0 && A[idx - 1]! > 128 && !seen[idx - 1]) {
          seen[idx - 1] = 1
          stack[sp++] = idx - 1
        }
        if (x + 1 < width && A[idx + 1]! > 128 && !seen[idx + 1]) {
          seen[idx + 1] = 1
          stack[sp++] = idx + 1
        }
        if (y > 0 && A[idx - width]! > 128 && !seen[idx - width]) {
          seen[idx - width] = 1
          stack[sp++] = idx - width
        }
        if (y + 1 < height && A[idx + width]! > 128 && !seen[idx + width]) {
          seen[idx + width] = 1
          stack[sp++] = idx + width
        }
      }
      if (size > largest) largest = size
    }
  }

  // Border ring (outer ~2%) mean alpha - a clean cutout fades to ~0 at the frame.
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.02))
  let borderSum = 0
  let borderCount = 0
  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < ring || y >= height - ring
    for (let x = 0; x < width; x += 1) {
      if (edgeRow || x < ring || x >= width - ring) {
        borderSum += A[y * width + x]!
        borderCount += 1
      }
    }
  }

  // Interior contrast churn, sampled well inside the subject so the opening's own rim does
  // not count, and measured on the pixel as it will actually be seen (alpha * luminance).
  const inset = 0.3
  const ix0 = Math.floor(width * inset)
  const ix1 = Math.ceil(width * (1 - inset))
  const iy0 = Math.floor(height * inset)
  const iy1 = Math.ceil(height * (1 - inset))
  const value = (x: number, y: number): number => {
    const i = (y * width + x) * 4
    const lum = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) / 255
    return lum * (A[y * width + x]! / 255)
  }
  // Same sweep also tallies WHERE each transition falls, per axis, for checkerRegularity:
  // a lattice stacks them onto a few coordinates, art spreads them over all of them.
  let interiorJumps = 0
  let interiorPairs = 0
  let colTotal = 0
  let rowTotal = 0
  const colHits = new Float64Array(width)
  const rowHits = new Float64Array(height)
  for (let y = iy0; y < iy1; y += 1) {
    for (let x = ix0; x < ix1; x += 1) {
      const v = value(x, y)
      if (x + 1 < ix1) {
        interiorPairs += 1
        if (Math.abs(v - value(x + 1, y)) > CHECKER_CONTRAST) {
          interiorJumps += 1
          colHits[x]! += 1
          colTotal += 1
        }
      }
      if (y + 1 < iy1) {
        interiorPairs += 1
        if (Math.abs(v - value(x, y + 1)) > CHECKER_CONTRAST) {
          interiorJumps += 1
          rowHits[y]! += 1
          rowTotal += 1
        }
      }
    }
  }

  // Share of an axis' transitions living in its densest CHECKER_TOP_FRACTION of coordinates.
  const concentration = (hits: Float64Array, lo: number, hi: number, total: number): number => {
    if (total <= 0) return 0
    const sorted = Array.from(hits.subarray(lo, hi)).sort((a, b) => b - a)
    const top = Math.max(1, Math.round(sorted.length * CHECKER_TOP_FRACTION))
    let sum = 0
    for (let i = 0; i < top; i += 1) sum += sorted[i]!
    return sum / total
  }

  return {
    opaqueRatio: opaque / n,
    strayRatio: opaque > 0 ? (opaque - largest) / opaque : 0,
    roughness: pairs > 0 ? jumps / pairs : 0,
    borderAlpha: borderCount > 0 ? borderSum / borderCount / 255 : 0,
    checkerRatio: interiorPairs > 0 ? interiorJumps / interiorPairs : 0,
    checkerRegularity: Math.min(
      concentration(colHits, ix0, ix1, colTotal),
      concentration(rowHits, iy0, iy1, rowTotal),
    ),
  }
}
