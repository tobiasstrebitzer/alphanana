// Hand-authored asciicast for the README terminal demo. Kept as source so the demo can be
// regenerated without spending a real (slow, paid) generate run. See README > Development.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ESC = ''
const C = (r, g, b) => `${ESC}[38;2;${r};${g};${b}m`
const AMBER = C(224, 160, 77)
const TEXT = C(238, 240, 245)
const STEP = C(127, 166, 221)
const OK = C(126, 200, 140)
const DIM = C(125, 133, 152)
const R = `${ESC}[0m`

const ev = []
let t = 0
const at = (dt, data) => {
  t += dt
  ev.push([Number(t.toFixed(3)), 'o', data])
}

at(0.30, `${AMBER}$ ${R}`)
const cmd = 'alphanana generate "apothecary glass bottle, amber elixir" --out potion.png'
at(0.35, TEXT)
for (const ch of cmd) at(0.026 + (ch === ' ' ? 0.02 : 0), ch) // slight hesitation on spaces
at(0.55, `\r\n${R}`)

at(0.35, `${STEP}> [1/3]${R} generating subject on white...\r\n`)
at(1.70, `${STEP}> [2/3]${R} edit to black...\r\n`)
at(1.45, `${DIM}        matte: roughness=0.0008 stray=0.0008 border=0.000 opaque=0.151 checker=0.0378/0.38${R}\r\n`)
at(0.30, `${OK}        + alignment guard passed${R}\r\n`)
at(0.45, `${STEP}> [3/3]${R} writing transparent PNG...\r\n`)
at(0.60, `${OK}+ wrote potion.png${R}\r\n`)
at(0.35, `${AMBER}$ ${R}`)
at(2.60, '') // hold the final frame

const header = {
  version: 2,
  width: 92,
  height: 9,
  timestamp: 0,
  env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'demo.cast')
await writeFile(out, [JSON.stringify(header), ...ev.map((e) => JSON.stringify(e))].join('\n') + '\n')
console.log(`cast written: ${out} — ${t.toFixed(1)}s, ${ev.length} events`)
