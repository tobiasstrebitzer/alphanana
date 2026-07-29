// The generate pipeline: subject-on-white, edit-to-black, difference matte, guard,
// transparent PNG. Matte isolation is ON by default: prompts.isolation is appended to the
// white prompt unless isolate === false. References steer the subject's FORM / identity /
// composition ONLY, never the background.

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import sharp from 'sharp'
import type { AlphananaConfig } from './config.ts'
import { generateImage } from './gemini.ts'
import type { GenerationParams } from './gemini.ts'
import { analyzeMatte, differenceMatte } from './matte.ts'
import type { MatteStats, RawImage } from './matte.ts'

export interface GenerateOptions {
  prompt: string
  out: string
  apiKey: string
  config: AlphananaConfig
  /** Reference image(s) - file paths - that steer the subject's FORM/identity only (i2i). */
  reference?: string[]
  model?: string
  aspect?: string
  size?: string
  retries?: number
  /** Prepend the style preamble (default true). */
  style?: boolean
  /** Append the isolation suffix to the white prompt (default true). */
  isolate?: boolean
  /** Write intermediate white/black/matte PNGs next to the output. */
  debug?: boolean
  /** Per-run generation overrides, merged over config.generation. */
  seed?: number
  temperature?: number
  /** Progress sink (stderr by default in the CLI). */
  log?: (message: string) => void
}

export interface GenerateOutcome {
  out: string
  stats: MatteStats
  guardPassed: boolean
  attempts: number
}

async function rawFromPng(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Run the full pipeline and write a transparent PNG to `out`. Returns the outcome. */
export async function runGenerate(opts: GenerateOptions): Promise<GenerateOutcome> {
  const { config } = opts
  const log = opts.log ?? (() => {})

  const model = opts.model ?? config.model.name
  const aspect = opts.aspect ?? config.model.aspectRatio
  const size = opts.size ?? config.model.imageSize
  // maxAttempts counts total tries (incl. the first); retries is one fewer.
  const retries = opts.retries ?? Math.max(0, config.guard.maxAttempts - 1)
  const useStyle = opts.style ?? true
  const useIsolate = opts.isolate ?? true
  const out = resolve(opts.out)

  const generation: GenerationParams = { ...config.generation }
  if (opts.seed !== undefined) generation.seed = opts.seed
  if (opts.temperature !== undefined) generation.temperature = opts.temperature

  const common = {
    apiKey: opts.apiKey,
    model,
    aspect,
    size,
    systemInstruction: config.prompts.systemInstruction,
    generation,
  }

  const passesGuard = (s: MatteStats) =>
    s.roughness <= config.guard.roughness &&
    s.strayRatio <= config.guard.strayRatio &&
    s.borderAlpha <= config.guard.maxBorderAlpha &&
    s.opaqueRatio <= config.guard.maxOpaqueRatio &&
    s.opaqueRatio >= config.guard.minOpaqueRatio &&
    s.checkerRatio <= config.guard.maxChecker
  // lower is better - borderAlpha weighted heavily so a real cutout always beats an un-cut
  // (opaque) frame, which otherwise scores ~0 on roughness+strayRatio and looks "best".
  const score = (s: MatteStats) => s.roughness + s.strayRatio + 2 * s.borderAlpha + 4 * s.checkerRatio

  const references = opts.reference ?? []
  const refNote = references.length
    ? `\n\nUse the provided reference image${references.length > 1 ? 's' : ''} for the subject's form, composition and identity. Re-render it in the style described above; do not reproduce any background, room or scenery from the reference.`
    : ''

  const isolationNote = useIsolate ? `\n\n${config.prompts.isolation}` : ''

  const whitePrompt = useStyle
    ? `${config.prompts.style}\n\nSubject: ${opts.prompt}${refNote}${isolationNote}\n\n${config.prompts.white}`
    : `${opts.prompt}${refNote}${isolationNote}\n\n${config.prompts.white}`

  // 1. subject on white (optionally guided by reference images)
  log(`> [1/3] generating subject on white${references.length ? ` (with ${references.length} reference image(s))` : ''}...`)
  const white = await generateImage({
    ...common,
    prompt: whitePrompt,
    images: references.length ? references : undefined,
  })
  const whiteRaw = await rawFromPng(white.png)

  // 2 + 3. edit to black, matte, guard - retry the edit until the matte is clean.
  let best: { png: Buffer; matte: RawImage; stats: MatteStats } | null = null
  let attempts = 0
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    attempts = attempt + 1
    const label = attempt === 0 ? 'edit to black' : `retry ${attempt}/${retries}`
    log(`> [2/3] ${label}...`)
    // Offset the seed per attempt, or a re-roll is not a re-roll: a theme that pins
    // `generation.seed` for reproducibility would otherwise have every retry re-issue a
    // byte-identical request, burn the full attempt budget and land on the same failure.
    const rollGeneration: GenerationParams =
      attempt === 0 || generation.seed === undefined ? generation : { ...generation, seed: generation.seed + attempt }
    const black = await generateImage({
      ...common,
      generation: rollGeneration,
      prompt: config.prompts.black,
      images: [white.png],
    })
    const blackRaw = await rawFromPng(black.png)
    const matte = differenceMatte(whiteRaw, blackRaw)
    const stats = analyzeMatte(matte)
    log(
      `        matte: roughness=${stats.roughness.toFixed(4)} stray=${stats.strayRatio.toFixed(4)} ` +
        `border=${stats.borderAlpha.toFixed(3)} opaque=${stats.opaqueRatio.toFixed(3)} ` +
        `checker=${stats.checkerRatio.toFixed(4)}`,
    )
    if (!best || score(stats) < score(best.stats)) best = { png: black.png, matte, stats }
    if (passesGuard(stats)) {
      log('        + alignment guard passed')
      break
    }
    const reason =
      stats.borderAlpha > config.guard.maxBorderAlpha || stats.opaqueRatio > config.guard.maxOpaqueRatio
        ? 'background not removed (black edit ~ white frame)'
        : stats.opaqueRatio < config.guard.minOpaqueRatio
          ? 'empty matte (no subject)'
          : stats.checkerRatio > config.guard.maxChecker
            ? 'opening painted as a transparency checkerboard'
            : 'model drifted between frames'
    log(`        x guard failed (${reason}) - re-rolling black edit`)
  }
  if (!best) throw new Error('No matte produced.')
  const guardPassed = passesGuard(best.stats)
  if (!guardPassed) {
    log(`! guard never passed after ${retries + 1} attempts - writing best matte (review it).`)
  }

  // 3. write the transparent PNG
  log('> [3/3] writing transparent PNG...')
  await mkdir(dirname(out), { recursive: true })
  await sharp(best.matte.data, { raw: { width: best.matte.width, height: best.matte.height, channels: 4 } })
    .png()
    .toFile(out)

  if (opts.debug) {
    const dir = dirname(out)
    const stem = basename(out, extname(out))
    await writeFile(join(dir, `${stem}.white.png`), white.png)
    await writeFile(join(dir, `${stem}.black.png`), best.png)
    const gray = Buffer.alloc(best.matte.width * best.matte.height)
    for (let p = 0; p < gray.length; p += 1) gray[p] = best.matte.data[p * 4 + 3]!
    await sharp(gray, { raw: { width: best.matte.width, height: best.matte.height, channels: 1 } })
      .png()
      .toFile(join(dir, `${stem}.matte.png`))
    log(`        debug: wrote ${stem}.white.png, ${stem}.black.png, ${stem}.matte.png`)
  }

  log(`+ wrote ${out}`)
  return { out, stats: best.stats, guardPassed, attempts }
}

/**
 * Generate a full-frame image (no matte, no transparency) - for backgrounds and other
 * opaque assets. The style preamble applies; isolation does not.
 */
export async function runGenerateOpaque(opts: Omit<GenerateOptions, 'isolate' | 'debug' | 'retries'>): Promise<string> {
  const { config } = opts
  const log = opts.log ?? (() => {})
  const out = resolve(opts.out)
  const generation: GenerationParams = { ...config.generation }
  if (opts.seed !== undefined) generation.seed = opts.seed
  if (opts.temperature !== undefined) generation.temperature = opts.temperature
  const useStyle = opts.style ?? true
  const prompt = useStyle ? `${config.prompts.style}\n\nSubject: ${opts.prompt}` : opts.prompt
  log('> generating opaque image...')
  const result = await generateImage({
    apiKey: opts.apiKey,
    prompt,
    model: opts.model ?? config.model.name,
    aspect: opts.aspect ?? config.model.aspectRatio,
    size: opts.size ?? config.model.imageSize,
    systemInstruction: config.prompts.systemInstruction,
    generation,
    images: opts.reference?.length ? opts.reference : undefined,
  })
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, result.png)
  log(`+ wrote ${out}`)
  return out
}
