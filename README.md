# alphanana

Transparent PNG generation with Gemini image models (nano banana): exact difference-matte
alpha, quality guards, style-locked variants and manifest-driven batches.

Image models cannot produce transparency. Ask one for a "transparent background" and it
paints the grey-and-white checkerboard that stands for transparency in image editors.
alphanana works around the model instead of arguing with it:

1. Render the subject on a pure white background.
2. Edit that image to the identical subject on pure black.
3. Solve for alpha and un-contaminated color per pixel (Smith & Blinn,
   "Blue Screen Matting", SIGGRAPH 1996): `a = 1 - (white - black)`, `F = black / a`.

Two aligned renders give an exact matte - no thresholds, no despill, no halo. The only
assumption is that the model changed nothing but the background between the two frames, so
every matte is analyzed by an alignment guard (roughness, stray blobs, border alpha,
opaque ratio, painted-checkerboard detection) and re-rolled automatically when it drifted.

## Install

```
npm install alphanana        # library
npx alphanana --help         # CLI, no install
```

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in your environment or in a `.env` file
anywhere above the working directory.

### As a Claude Code plugin

```
/plugin marketplace add tobiasstrebitzer/alphanana
/plugin install alphanana
```

The bundled skill teaches Claude the whole pipeline: prompting rules (never ask for
transparency), the config and manifest formats, and the guard-failure playbook.

## CLI

```
# one transparent cutout
alphanana generate "a brass compass rose, engraved, face-on" --out compass.png

# an opaque background (no matte)
alphanana generate "deep navy sky with faint gold constellations" --out bg.png --opaque --aspect 16:9

# 6 style candidates composited into one contact sheet
alphanana generate "a wax seal stamp" --out sheet.png --variants 6 --contact-sheet --label

# everything in a manifest, 4 at a time, skipping files that exist
alphanana batch assets.manifest.json
```

`generate` prints the output path on stdout and progress on stderr. Exit codes: `0` ok,
`1` error, `3` the matte guard never passed (the best attempt is still written - review it).
`batch` writes a durable report (default `assets.report.json` next to the manifest) and
exits `1` if any asset failed.

## Manifest

Batches are driven by a JSON manifest; per-asset fields override `defaults`:

```json
{
  "outDir": "assets",
  "defaults": { "size": "2K", "retries": 2 },
  "assets": [
    { "id": "compass", "prompt": "a brass compass rose, engraved, face-on" },
    { "id": "background", "prompt": "deep navy sky", "opaque": true, "aspect": "16:9" },
    { "id": "seal", "prompt": "a wax seal stamp", "reference": ["ref/seal-sketch.png"] }
  ]
}
```

`reference` images steer the subject's form and identity only - never the background.
Generation is concurrent (`--concurrency`), idempotent (existing outputs are skipped
unless `--force`), and filterable (`--only <id>`).

## Config

An optional `alphanana.json` next to your assets pins the model and the prompt scaffolding.
Every field has a sensible default; a missing file means all defaults:

```json
{
  "model": { "name": "gemini-3-pro-image", "aspectRatio": "1:1", "imageSize": "2K" },
  "generation": { "seed": 7, "temperature": 0.9 },
  "prompts": { "style": "Style: hand-painted picture-book illustration ..." },
  "background": { "hex": "#0b0e1a" },
  "guard": { "maxAttempts": 3 }
}
```

`prompts.style` is the style preamble prepended to every subject - lock it once and a
whole asset set comes out coherent. `guard` holds the matte-guard thresholds; the defaults
are tuned on real assets and rarely need touching.

## Library

```ts
import { getConfig, runGenerate, runBatch, requireKey } from 'alphanana'

const outcome = await runGenerate({
  prompt: 'a brass compass rose, engraved, face-on',
  out: 'compass.png',
  apiKey: requireKey('GEMINI_API_KEY'),
  config: getConfig('alphanana.json'),
})
// outcome.stats: opaqueRatio, strayRatio, roughness, borderAlpha, checkerRatio
```

Lower-level pieces are exported too: `generateImage` (the raw Gemini call, normalized to
PNG), `differenceMatte` / `analyzeMatte` (the solver and the guard), `runVariants`
(candidates + contact sheet), `getManifest` / `runBatch`.

## Prompting rules that matter

- **Never ask for a transparent background.** The model will paint a checkerboard. Ask
  for the subject on flat white; transparency is solved afterwards.
- If the subject has a hole or opening, say that the background color must show through
  it - otherwise the model fills it in.
- References steer form, identity and composition; restyle them in the prompt, and never
  let their backgrounds leak.

## License

MIT
