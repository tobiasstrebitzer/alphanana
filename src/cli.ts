#!/usr/bin/env node
// The alphanana CLI: `alphanana generate` for one asset, `alphanana batch` for a manifest.
// A thin argv layer over the library; all behaviour lives in generate.ts / batch.ts.

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { getConfig } from './config.ts'
import { loadEnv } from './env.ts'
import { runBatch } from './batch.ts'
import { runGenerate, runGenerateOpaque } from './generate.ts'
import { runVariants } from './variants.ts'

const HELP = `alphanana - transparent PNG generation with Gemini image models (nano banana)

Usage:
  alphanana generate <prompt> --out <file.png> [options]
  alphanana batch <manifest.json> [options]

Generate options:
  --out <path>           Output PNG path (required)
  --reference <path>     Reference image steering form/identity (repeatable)
  --opaque               Direct render, no matte transparency (backgrounds)
  --variants <n>         Generate n candidates of the same subject
  --contact-sheet        Composite variants into one grid
  --label                Burn index badges into contact sheet cells
  --bg <hex>             Contact sheet background fill
  --model <name>         Model or alias (pro, flash)
  --aspect <ratio>       e.g. 1:1, 16:9
  --size <s>             512, 1K, 2K, 4K
  --seed <n>             Reproducibility seed
  --temperature <t>      Sampling temperature, 0-2
  --retries <n>          Black-edit retries for the matte guard
  --no-style             Skip the style preamble
  --no-isolate           Skip the plain-background isolation instruction
  --debug                Write white/black/matte intermediates next to the output

Batch options:
  --concurrency <n>      Parallel generation workers (default 4)
  --force                Regenerate even when the output already exists
  --only <id>            Asset ids to run (repeatable)
  --dry-run              Print the plan without calling the API
  --report <path>        Report output path
  --no-isolate           Skip the isolation instruction for the whole batch

Common:
  --config <path>        Config file (default alphanana.json)
  --help, --version

The API key is read from GEMINI_API_KEY (or GOOGLE_API_KEY), including from the
nearest .env above the working directory.`

function getApiKey(): string {
  loadEnv()
  const key = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY']
  if (!key) throw new Error('Missing GEMINI_API_KEY (or GOOGLE_API_KEY). Add it to a .env file in your project.')
  return key
}

const log = (message: string) => console.error(message)

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      reference: { type: 'string', multiple: true },
      opaque: { type: 'boolean', default: false },
      variants: { type: 'string' },
      'contact-sheet': { type: 'boolean', default: false },
      label: { type: 'boolean', default: false },
      bg: { type: 'string' },
      model: { type: 'string' },
      aspect: { type: 'string' },
      size: { type: 'string' },
      seed: { type: 'string' },
      temperature: { type: 'string' },
      retries: { type: 'string' },
      'no-style': { type: 'boolean', default: false },
      'no-isolate': { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      force: { type: 'boolean', default: false },
      only: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      report: { type: 'string' },
      config: { type: 'string', default: 'alphanana.json' },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  })

  if (values.version) {
    console.log(createRequire(import.meta.url)('../package.json').version)
    return 0
  }
  const [command, subject] = positionals
  if (values.help || !command) {
    console.log(HELP)
    return values.help ? 0 : 2
  }

  const num = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (Number.isNaN(n)) throw new Error(`--${name} must be a number, got "${raw}"`)
    return n
  }

  if (command === 'generate') {
    if (!subject) throw new Error('generate needs a prompt: alphanana generate "<subject>" --out out.png')
    if (!values.out) throw new Error('generate needs --out <file.png>')
    const common = {
      prompt: subject,
      out: values.out,
      apiKey: getApiKey(),
      config: getConfig(values.config),
      reference: values.reference,
      model: values.model,
      aspect: values.aspect,
      size: values.size,
      seed: num('seed', values.seed),
      temperature: num('temperature', values.temperature),
      style: !values['no-style'],
      log,
    }
    if (values.opaque) {
      console.log(await runGenerateOpaque(common))
      return 0
    }
    const variants = num('variants', values.variants)
    if (variants) {
      const outcome = await runVariants({
        ...common,
        isolate: !values['no-isolate'],
        retries: num('retries', values.retries),
        variants,
        contactSheet: values['contact-sheet'],
        label: values.label,
        backgroundHex: values.bg,
      })
      console.log(outcome.out)
      return 0
    }
    const outcome = await runGenerate({
      ...common,
      isolate: !values['no-isolate'],
      retries: num('retries', values.retries),
      debug: values.debug,
    })
    console.log(outcome.out)
    return outcome.guardPassed ? 0 : 3
  }

  if (command === 'batch') {
    if (!subject) throw new Error('batch needs a manifest: alphanana batch assets.manifest.json')
    const result = await runBatch({
      manifestPath: subject,
      apiKey: getApiKey(),
      config: getConfig(values.config),
      concurrency: num('concurrency', values.concurrency),
      force: values.force,
      only: values.only,
      isolate: !values['no-isolate'],
      dryRun: values['dry-run'],
      reportPath: values.report,
      log,
    })
    console.log(result.reportPath)
    return result.success ? 0 : 1
  }

  throw new Error(`Unknown command "${command}". Try: alphanana --help`)
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
