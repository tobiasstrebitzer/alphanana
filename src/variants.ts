// Style-lock variants: generate N candidates of one representative subject (distinct seeds,
// temperature bumped for spread) and optionally composite them into a contact sheet on a flat
// brand-background fill, so a direction can be picked before batching the rest.

import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import sharp from 'sharp'
import type { OverlayOptions } from 'sharp'
import { runGenerate } from './generate.ts'
import type { GenerateOptions } from './generate.ts'

export interface VariantsOptions extends Omit<GenerateOptions, 'debug'> {
  variants: number
  contactSheet?: boolean
  /** flat hex fill for the sheet background; defaults to config.background.hex */
  backgroundHex?: string
  /** burn a small index badge into each cell */
  label?: boolean
}

export interface VariantsOutcome {
  /** the contact sheet path (when contactSheet) or the list of cutout paths */
  out: string
  variantPaths: string[]
}

export async function runVariants(opts: VariantsOptions): Promise<VariantsOutcome> {
  const log = opts.log ?? (() => {})
  const count = Math.max(2, opts.variants)
  const out = resolve(opts.out)
  const dir = dirname(out)
  await mkdir(dir, { recursive: true })

  const baseSeed = opts.seed ?? 7
  const temperature = opts.temperature ?? 1.1

  const variantPaths: string[] = []
  for (let i = 0; i < count; i += 1) {
    const variantOut = join(dir, `variant-${i + 1}.png`)
    log(`- variant ${i + 1}/${count} (seed ${baseSeed + i * 101})`)
    await runGenerate({
      ...opts,
      out: variantOut,
      seed: baseSeed + i * 101,
      temperature,
      log: (m) => log(`  ${m}`),
    })
    variantPaths.push(variantOut)
  }

  if (!opts.contactSheet) return { out: dir, variantPaths }

  // grid: cols = ceil(sqrt(N)); each candidate trimmed to content and centered in its cell
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const cell = 640
  const pad = 24
  const sheetW = cols * cell + (cols + 1) * pad
  const sheetH = rows * cell + (rows + 1) * pad
  const bg = opts.backgroundHex ?? opts.config.background.hex

  const composites: OverlayOptions[] = []
  for (let i = 0; i < variantPaths.length; i += 1) {
    const trimmed = await sharp(variantPaths[i]!).trim().resize(cell - pad * 2, cell - pad * 2, { fit: 'inside' }).png().toBuffer()
    const meta = await sharp(trimmed).metadata()
    const col = i % cols
    const row = Math.floor(i / cols)
    const left = pad + col * (cell + pad) + Math.round((cell - (meta.width ?? cell)) / 2)
    const top = pad + row * (cell + pad) + Math.round((cell - (meta.height ?? cell)) / 2)
    composites.push({ input: trimmed, left, top })
    if (opts.label) {
      const badge = Buffer.from(
        `<svg width="44" height="44"><circle cx="22" cy="22" r="20" fill="#000000" opacity="0.75"/><text x="22" y="29" font-family="monospace" font-size="22" fill="#ffffff" text-anchor="middle">${i + 1}</text></svg>`,
      )
      composites.push({ input: badge, left: pad + col * (cell + pad) + 8, top: pad + row * (cell + pad) + 8 })
    }
  }

  await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: bg } })
    .composite(composites)
    .png()
    .toFile(out)
  log(`+ contact sheet: ${out}`)
  return { out, variantPaths }
}
