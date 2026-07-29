// Hand-authored asciicasts for the README terminal demos. Kept as source so the demos can
// be regenerated without spending real (slow, paid) generate runs. See README > Development.
//
// Glyphs are deliberately conservative: svg-term emits no webfont, so text resolves against
// the viewer's own Monaco/Consolas/Menlo/monospace. U+25CF and U+2514 exist everywhere;
// Claude Code's actual U+23FA/U+23BF do not, and would render as tofu on many machines.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ESC = ''
const C = (r, g, b) => `${ESC}[38;2;${r};${g};${b}m`
const R = `${ESC}[0m`

const AMBER = C(224, 160, 77)
const TEXT = C(238, 240, 245)
const STEP = C(127, 166, 221)
const OK = C(126, 200, 140)
const DIM = C(125, 133, 152)
const CLAUDE = C(217, 119, 87) // the Claude Code mark colour

const HERE = dirname(fileURLToPath(import.meta.url))

function cast(width, height) {
  const ev = []
  let t = 0
  const at = (dt, data) => {
    t += dt
    ev.push([Number(t.toFixed(3)), 'o', data])
  }
  const type = (text, perChar = 0.026) => {
    for (const ch of text) at(perChar + (ch === ' ' ? 0.02 : 0), ch)
  }
  const done = async (name) => {
    const header = {
      version: 2,
      width,
      height,
      timestamp: 0,
      env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
    }
    const out = join(HERE, name)
    await writeFile(out, [JSON.stringify(header), ...ev.map((e) => JSON.stringify(e))].join('\n') + '\n')
    console.log(`${name} — ${t.toFixed(1)}s, ${ev.length} events`)
  }
  return { at, type, done }
}

// ── 1. the bare CLI ────────────────────────────────────────────────────────────
{
  const { at, type, done } = cast(92, 9)
  // The prompt lands at t=0 deliberately: a viewer whose browser restarts the animation on
  // scroll-into-view would otherwise be shown an empty terminal.
  at(0.0, `${AMBER}$ ${R}`)
  at(0.65, TEXT)
  type('alphanana generate "apothecary glass bottle, amber elixir" --out potion.png')
  at(0.55, `\r\n${R}`)

  at(0.35, `${STEP}> [1/3]${R} generating subject on white...\r\n`)
  at(1.7, `${STEP}> [2/3]${R} edit to black...\r\n`)
  at(1.45, `${DIM}        matte: roughness=0.0008 stray=0.0008 border=0.000 opaque=0.151 checker=0.0378/0.38${R}\r\n`)
  at(0.3, `${OK}        + alignment guard passed${R}\r\n`)
  at(0.45, `${STEP}> [3/3]${R} writing transparent PNG...\r\n`)
  at(0.6, `${OK}+ wrote potion.png${R}\r\n`)
  at(0.35, `${AMBER}$ ${R}`)
  at(4.5, '') // long hold: most of the loop sits on the finished run, not mid-typing
  await done('demo.cast')
}

// ── 2. the same asset, asked for in Claude Code ────────────────────────────────
{
  const { at, type, done } = cast(92, 15)
  const B = `${CLAUDE}●${R}` // the assistant bullet

  at(0.0, `${DIM}> ${R}${TEXT}`)
  type('generate a transparent apothecary bottle icon for the shop screen')
  at(0.6, `${R}\r\n\r\n`)

  at(0.5, `${B} ${TEXT}I'll use the alphanana skill - it solves alpha from two renders${R}\r\n`)
  at(0.35, `  ${TEXT}rather than asking the model for transparency.${R}\r\n\r\n`)

  at(0.7, `${B} ${TEXT}alphanana${R}${DIM}(generate · apothecary glass bottle)${R}\r\n`)
  at(0.5, `  ${DIM}└ ${STEP}> [1/3]${R} generating subject on white...${R}\r\n`)
  at(1.7, `    ${STEP}> [2/3]${R} edit to black...${R}\r\n`)
  at(1.5, `    ${OK}+ alignment guard passed${R}\r\n`)
  at(0.55, `    ${OK}+ wrote potion.png${R}\r\n\r\n`)

  at(0.8, `${B} ${TEXT}Done - potion.png, 1024×1024, guard passed first try. The${R}\r\n`)
  at(0.35, `  ${TEXT}glass kept real partial alpha, so it composites anywhere.${R}\r\n\r\n`)
  at(0.4, `${DIM}> ${R}`)
  at(4.5, '')
  await done('demo-claude.cast')
}
