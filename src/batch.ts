// Manifest-driven concurrent asset generation with a fixed worker pool, skip-if-exists,
// an --only filter and a durable report. Assets default to the transparent matte pipeline;
// `opaque: true` assets (backgrounds) are generated directly without matting.

import { existsSync, readFileSync } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { ASPECT_RATIOS, IMAGE_SIZES } from './config.ts'
import type { AlphananaConfig } from './config.ts'
import { runGenerate, runGenerateOpaque } from './generate.ts'
import type { MatteStats } from './matte.ts'

const assetDefaultsSchema = z
  .object({
    aspect: z.enum(ASPECT_RATIOS).optional(),
    size: z.enum(IMAGE_SIZES).optional(),
    isolate: z.boolean().optional(),
    retries: z.number().int().min(0).optional(),
    seed: z.number().int().optional(),
    temperature: z.number().min(0).max(2).optional(),
    model: z.string().optional(),
    style: z.boolean().optional(),
  })
  .strict()
  .default({})

const assetSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    aspect: z.enum(ASPECT_RATIOS).optional(),
    size: z.enum(IMAGE_SIZES).optional(),
    /** i2i form steering (NOT background) */
    reference: z.array(z.string()).optional(),
    /** true = direct opaque render (no matte); for backgrounds */
    opaque: z.boolean().optional(),
    isolate: z.boolean().optional(),
    seed: z.number().int().optional(),
    temperature: z.number().min(0).max(2).optional(),
    retries: z.number().int().min(0).optional(),
    model: z.string().optional(),
    style: z.boolean().optional(),
    /** explicit path; defaults to <outDir>/<id>.png */
    out: z.string().optional(),
  })
  .strict()

export const manifestSchema = z.object({
  $schema: z.string().optional(),
  outDir: z.string().default('assets'),
  defaults: assetDefaultsSchema,
  assets: z.array(assetSchema).min(1),
})

export type AssetManifest = z.infer<typeof manifestSchema>
export type ManifestAsset = z.infer<typeof assetSchema>

export function getManifest(path: string): AssetManifest {
  if (!existsSync(path)) throw new Error(`Manifest not found: ${path}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`Could not parse ${path} as JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const result = manifestSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid manifest in ${path}:\n${issues}`)
  }
  const seen = new Set<string>()
  for (const a of result.data.assets) {
    if (seen.has(a.id)) throw new Error(`Duplicate asset id "${a.id}" in ${path} (ids must be unique).`)
    seen.add(a.id)
  }
  return result.data
}

export interface BatchOptions {
  manifestPath: string
  apiKey: string
  config: AlphananaConfig
  concurrency?: number
  force?: boolean
  only?: string[]
  /** Force-disable the isolation suffix for the whole batch (rare). */
  isolate?: boolean
  dryRun?: boolean
  /** Report output path (default <manifest-dir>/assets.report.json). */
  reportPath?: string
  log?: (message: string) => void
}

interface OkEntry {
  id: string
  out: string
  attempts: number
  guardPassed: boolean
  stats: MatteStats | null
}
interface SkippedEntry {
  id: string
  out: string
  reason: string
}
interface FailedEntry {
  id: string
  error: string
}
interface GuardWarnEntry {
  id: string
  reason: string
}

export interface BatchReport {
  ranAt: string
  concurrency: number
  ok: OkEntry[]
  skipped: SkippedEntry[]
  failed: FailedEntry[]
  guardWarnings: GuardWarnEntry[]
}

export interface BatchResult {
  reportPath: string
  report: BatchReport
  /** true iff no asset failed (callers map to a non-zero exit when false). */
  success: boolean
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Run the manifest. Writes the durable report and returns it; never throws on per-asset failure. */
export async function runBatch(opts: BatchOptions): Promise<BatchResult> {
  const log = opts.log ?? (() => {})
  const manifestPath = resolve(opts.manifestPath)
  const manifestDir = dirname(manifestPath)
  const manifest = getManifest(manifestPath)

  const outDir = resolve(manifestDir, manifest.outDir)
  const reportPath = resolve(opts.reportPath ?? join(manifestDir, 'assets.report.json'))
  const concurrency = Math.max(1, opts.concurrency ?? 6)
  const d = manifest.defaults

  interface Job {
    asset: ManifestAsset
    out: string
    aspect?: string
    size?: string
    isolate?: boolean
    retries?: number
    seed?: number
    temperature?: number
    model?: string
    style?: boolean
    reference?: string[]
  }

  const onlySet = opts.only && opts.only.length ? new Set(opts.only) : null
  const jobs: Job[] = manifest.assets
    .filter((a) => (onlySet ? onlySet.has(a.id) : true))
    .map((asset) => ({
      asset,
      out: asset.out ? resolve(manifestDir, asset.out) : join(outDir, `${asset.id}.png`),
      aspect: asset.aspect ?? d.aspect,
      size: asset.size ?? d.size,
      isolate: opts.isolate === false ? false : (asset.isolate ?? d.isolate),
      retries: asset.retries ?? d.retries,
      seed: asset.seed ?? d.seed,
      temperature: asset.temperature ?? d.temperature,
      model: asset.model ?? d.model,
      style: asset.style ?? d.style,
      reference: asset.reference?.map((r) => resolve(manifestDir, r)),
    }))

  if (onlySet) {
    const missing = [...onlySet].filter((id) => !manifest.assets.some((a) => a.id === id))
    if (missing.length) log(`! --only ids not in manifest (ignored): ${missing.join(', ')}`)
  }

  const report: BatchReport = {
    ranAt: new Date().toISOString(),
    concurrency,
    ok: [],
    skipped: [],
    failed: [],
    guardWarnings: [],
  }

  if (opts.dryRun) {
    log(`Plan for ${jobs.length} asset(s) (concurrency ${concurrency}, dry-run):`)
    for (const j of jobs) {
      const willSkip = !opts.force && (await exists(j.out))
      log(`  ${willSkip ? 'skip' : 'gen '} ${j.asset.id} -> ${j.out}${willSkip ? ' (exists)' : ''}`)
    }
    return { reportPath, report, success: true }
  }

  await mkdir(outDir, { recursive: true })

  let cursor = 0
  let done = 0
  const total = jobs.length

  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const j = jobs[cursor++]!
      const id = j.asset.id
      if (!opts.force && (await exists(j.out))) {
        report.skipped.push({ id, out: j.out, reason: 'exists' })
        done += 1
        log(`. skip ${id} (exists) [${done}/${total}]`)
        continue
      }
      try {
        if (j.asset.opaque) {
          const out = await runGenerateOpaque({
            prompt: j.asset.prompt,
            out: j.out,
            apiKey: opts.apiKey,
            config: opts.config,
            reference: j.reference,
            model: j.model,
            aspect: j.aspect,
            size: j.size,
            style: j.style,
            seed: j.seed,
            temperature: j.temperature,
            log: () => {},
          })
          report.ok.push({ id, out, attempts: 1, guardPassed: true, stats: null })
          done += 1
          log(`+ [${done}/${total}] ${id} (opaque)`)
          continue
        }
        const outcome = await runGenerate({
          prompt: j.asset.prompt,
          out: j.out,
          apiKey: opts.apiKey,
          config: opts.config,
          reference: j.reference,
          model: j.model,
          aspect: j.aspect,
          size: j.size,
          retries: j.retries,
          style: j.style,
          isolate: j.isolate,
          seed: j.seed,
          temperature: j.temperature,
          log: () => {},
        })
        report.ok.push({
          id,
          out: outcome.out,
          attempts: outcome.attempts,
          guardPassed: outcome.guardPassed,
          stats: outcome.stats,
        })
        if (!outcome.guardPassed) {
          report.guardWarnings.push({ id, reason: 'guard never passed; best matte written - review' })
        }
        done += 1
        log(`+ [${done}/${total}] ${id}${outcome.guardPassed ? '' : ' (! guard)'}`)
      } catch (err) {
        report.failed.push({ id, error: err instanceof Error ? err.message : String(err) })
        done += 1
        log(`x [${done}/${total}] ${id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  log(`Generating ${total} asset(s) (concurrency ${concurrency})...`)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2))

  const success = report.failed.length === 0
  log(
    `\nDone. ${report.ok.length} ok, ${report.skipped.length} skipped, ${report.failed.length} failed` +
      `${report.guardWarnings.length ? `, ${report.guardWarnings.length} guard-warned` : ''}.`,
  )
  return { reportPath, report, success }
}
