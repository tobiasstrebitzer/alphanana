<div align="center">

# alphanana

**Transparent PNGs from Gemini image models — exact alpha, solved rather than thresholded.**

Image models can't draw transparency. alphanana stops asking them to.

[![npm](https://img.shields.io/npm/v/alphanana?logo=npm&color=CB3837)](https://www.npmjs.com/package/alphanana)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.3-5FA04E?logo=nodedotjs&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-nano_banana-4285F4?logo=googlegemini&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757)
![License](https://img.shields.io/badge/license-MIT-blue)

<img src="https://raw.githubusercontent.com/tobiasstrebitzer/alphanana/master/docs/banner.png" alt="alphanana: render on white, edit to black, solve the exact matte" width="900">

</div>

## Quickstart

Requires Node ≥ 20.3 and a Gemini API key in `GEMINI_API_KEY` (or `GOOGLE_API_KEY`),
read from the environment or the nearest `.env` above the working directory.

```sh
npx alphanana generate "a brass compass rose, engraved" --out compass.png
npx alphanana generate "deep navy sky" --out bg.png --opaque --aspect 16:9
npx alphanana batch assets.manifest.json
```

Install it properly when you want the library or a pinned version:

```sh
npm install alphanana
```

<div align="center">
<img src="https://raw.githubusercontent.com/tobiasstrebitzer/alphanana/master/docs/demo.svg" alt="alphanana generating a transparent PNG: render on white, edit to black, guard the matte, write the result" width="900">
</div>

Progress goes to stderr and the output path to stdout, so a run pipes cleanly. The `matte:`
line is the guard reporting what it measured — see [Highlights](#highlights).

### Set up with Claude

```sh
claude plugin marketplace add tobiasstrebitzer/alphanana
claude plugin install alphanana@alphanana
```

The bundled skill teaches Claude the whole pipeline — the prompting rules that actually
matter, the config and manifest formats, and what to do when the guard trips. Asking
Claude for "a set of game icons with real transparency" then just works.

<div align="center">
<img src="https://raw.githubusercontent.com/tobiasstrebitzer/alphanana/master/docs/demo-claude.svg" alt="asking Claude Code for a transparent asset: it picks the alphanana skill, runs the pipeline and reports the guard result" width="900">
</div>

## Why

Ask an image model for a transparent background and it paints the grey-and-white
checkerboard that *stands for* transparency in image editors. There is no alpha channel to
ask for: the model emits RGB pixels, and every "background remover" bolted on afterwards is
guessing — thresholds, chroma keys, matting networks. They all fail the same way, on
exactly the pixels that matter: glass, smoke, hair, antialiased edges, anything genuinely
semi-transparent.

alphanana works around the model rather than arguing with it. Render the subject twice —
once on white, once on black — and alpha stops being a guess and becomes arithmetic
(Smith & Blinn, *Blue Screen Matting*, SIGGRAPH 1996):

```
white = a·F + (1−a)·1        black = a·F + (1−a)·0
  ⇒    a = 1 − (white − black)        F = black / a
```

Two aligned renders give the **exact** matte and un-contaminated foreground colour. No
thresholds, no despill, no halo. The glass bottle in the banner is the whole argument: you
can see the checkerboard through its shoulders, because the solve recovers real partial
alpha instead of deciding each pixel is in or out.

The one assumption is that the model changed *nothing but the background* between the two
frames — so every matte is measured, and re-rolled when it drifted.

## Highlights

- **Exact alpha, not a cutout** — partial transparency (glass, glow, soft edges) survives,
  because it is solved per pixel rather than classified.
- **A guard that measures drift** — roughness, stray blobs, border alpha, opaque ratio and
  painted-checkerboard detection. A matte that fails is re-rolled automatically; one that
  never passes still gets written, with exit code `3` and a warning, so you can look.
- **Radial art isn't accused** — the checkerboard test requires contrast *and* an
  axis-aligned lattice, so compass roses, sunbursts and pinwheels stop being convicted of
  their own alternating facets.
- **No baked shadows** — cast shadows fuse into the alpha channel and can't be lifted back
  out afterwards, so they're refused by default. Shading on the subject's own form stays.
- **Style-locked sets** — one style preamble in `alphanana.json` prepends to every subject,
  so a whole asset set comes out coherent. Contact sheets let you pick a direction first.
- **Manifest-driven batches** — concurrent, idempotent (existing outputs are skipped),
  filterable with `--only`, and durable: every run writes `assets.report.json`.
- **Agent-ready** — progress on stderr, output paths on stdout, meaningful exit codes, and
  a Claude Code plugin that ships the prompting rules as a skill.

## Usage

```sh
alphanana generate <prompt> --out <file.png> [options]
alphanana batch <manifest.json> [options]
```

```sh
# one transparent cutout
alphanana generate "a brass compass rose, engraved, face-on" --out compass.png

# an opaque background — direct render, no matte
alphanana generate "deep navy sky with faint gold constellations" \
  --out bg.png --opaque --aspect 16:9

# six candidates of one subject, composited into a labelled contact sheet
alphanana generate "a wax seal stamp" --out sheet.png --variants 6 --contact-sheet --label

# the whole set, four at a time, skipping files that already exist
alphanana batch assets.manifest.json --concurrency 4
```

Useful flags: `--reference <path>` (repeatable, steers form and identity), `--seed`,
`--temperature`, `--aspect`, `--size` (`512`/`1K`/`2K`/`4K`), `--model` (or the `pro` /
`flash` aliases), `--retries`, and `--debug` to write the `.white.png` / `.black.png` /
`.matte.png` intermediates next to the output.

`generate` prints the output path on stdout and progress on stderr. Exit codes: `0` ok,
`1` error, `3` the guard never passed — the best attempt is still written, review it.
`batch` exits `1` if any asset failed.

## Manifest

Per-asset fields override `defaults`:

```json
{
  "outDir": "assets",
  "defaults": { "size": "2K", "retries": 2, "seed": 7 },
  "assets": [
    { "id": "compass", "prompt": "a brass compass rose, engraved, face-on" },
    { "id": "background", "prompt": "deep navy sky", "opaque": true, "aspect": "16:9" },
    { "id": "seal", "prompt": "a wax seal stamp", "reference": ["ref/seal-sketch.png"] }
  ]
}
```

`reference` images steer the subject's form, identity and composition only — never the
background. Pin `defaults.seed` for reproducibility; retries offset it automatically, so a
re-roll is still a re-roll.

## Config

An optional `alphanana.json` next to your assets. Every field is defaulted, so a missing
file means all defaults:

```json
{
  "model": { "name": "gemini-3-pro-image", "aspectRatio": "1:1", "imageSize": "2K" },
  "generation": { "seed": 7, "temperature": 0.9 },
  "prompts": { "style": "Style: hand-painted picture-book illustration ..." },
  "background": { "hex": "#0b0e1a" },
  "guard": { "maxAttempts": 3 }
}
```

`prompts.style` is the preamble prepended to every subject — lock it once and the set is
coherent. `guard` holds the matte thresholds; the defaults are tuned on real assets and
rarely need touching. `prompts.white` / `prompts.black` / `prompts.isolation` are the
scaffolding around your subject, overridable if you know what you're doing.

## Library

```ts
import { getConfig, runGenerate, requireKey } from 'alphanana'

const outcome = await runGenerate({
  prompt: 'a small apothecary glass bottle, amber elixir',
  out: 'potion.png',
  apiKey: requireKey('GEMINI_API_KEY'),
  config: getConfig('alphanana.json'),
})

outcome.guardPassed // false means: written anyway, look at it
outcome.stats       // opaqueRatio, strayRatio, roughness, borderAlpha,
                    // checkerRatio, checkerRegularity
```

The lower-level pieces are exported too: `generateImage` (the raw Gemini call, normalized
to PNG), `differenceMatte` / `analyzeMatte` (the solver and the guard), `runVariants`
(candidates plus contact sheet), `getManifest` / `runBatch`.

## Prompting rules that matter

Each of these is a recurring, real failure — not a hypothetical.

- **Never ask for a transparent background.** The model paints a checkerboard. Describe the
  subject on flat white; transparency is solved afterwards.
- **Name the fills you don't want.** A frame whose centre got painted solid passes every
  statistic. Say "NOT a panel, NOT a plate, NOT paper", and check the centre alpha yourself.
- **Say where a glow ends.** "A soft glow around the frame" bleeds across the opening —
  pin it to the outer edge.
- **Don't ask for a shadow unless you want it baked in.** Cast shadows are refused by
  default for a reason: they cannot be removed afterwards without eating the antialiased
  edge with them.
- **Reword refusals.** A prompt that returns "No image in response" across seeds is not a
  transient error — it's the wording.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck   # oxlint + tsgo
pnpm test                     # vitest — the matte solver and guard
pnpm build                    # tsdown: src/ → build/ (what the package ships)
```

Layout: `src/matte.ts` (the alpha solve and the guard statistics — the unit-tested core),
`src/gemini.ts` (the two model calls), `src/generate.ts` (one asset: render, matte, guard,
re-roll), `src/variants.ts` (candidates and contact sheets), `src/batch.ts` (manifests and
the report), `src/config.ts` + `src/env.ts` (schema and key discovery), `src/cli.ts`.

The README's terminal demos are hand-authored asciicasts rather than real recordings, so
they stay reproducible without spending API calls. Regenerate with:

```sh
node docs/make-casts.mjs                        # writes both docs/*.cast
npx svg-term-cli --in docs/demo.cast        --out docs/demo.svg        --width 92 --height 9  --padding 18
npx svg-term-cli --in docs/demo-claude.cast --out docs/demo-claude.svg --width 92 --height 15 --padding 18
```

Then set `.a{fill:#0b0e1a}` and `rx="10" ry="10"` on each SVG's background rect — svg-term
has no flag for either. The casts avoid `⏺`/`⎿`: svg-term embeds no webfont, so glyphs
resolve against the viewer's own monospace, and those codepoints are missing from most of
them. `●` and `└` look the same and are universally available.

Releases are automated: pushing a version bump to `master` publishes to npm through
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no tokens) with a
provenance attestation, and tags the commit.

## License

MIT
