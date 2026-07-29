// Environment loading without a dotenv dependency: parse KEY=VALUE lines from the nearest
// .env, walking up from cwd (so commands work from anywhere inside a project).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let loaded = false

function findEnvFile(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Load the nearest .env (walking up from cwd) exactly once. Idempotent. */
export function loadEnv(): void {
  if (loaded) return
  loaded = true
  const file = findEnvFile(process.cwd())
  if (!file) return
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const key = match[1]!
    let value = match[2]!
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

/** Read a required env var (loading .env first); throws with a clear message if absent. */
export function requireKey(name: string): string {
  loadEnv()
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}. Add it to a .env file in your project directory (${process.cwd()}).`)
  }
  return value
}
