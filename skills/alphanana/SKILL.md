---
name: alphanana
description: Generate transparent PNG assets (icons, frames, sprites, cutouts) and opaque backgrounds with Gemini image models (nano banana) via the alphanana difference-matte pipeline. Use when the user wants game or app art with real alpha transparency, a coherent set of themed assets, or asks to generate images with "nano banana" / Gemini. Requires GEMINI_API_KEY.
---

# alphanana - transparent asset generation

You generate production assets with Gemini image models through `npx -y alphanana`. The
pipeline renders each subject twice (on white, then edited to black) and solves the exact
alpha matte from the difference - so the transparency is real, not model-painted.

## Commands

```bash
npx -y alphanana generate "<subject>" --out <file.png> [flags]   # one transparent cutout
npx -y alphanana generate "<subject>" --out bg.png --opaque      # background, no matte
npx -y alphanana generate "<subject>" --out sheet.png --variants 6 --contact-sheet --label
npx -y alphanana batch assets.manifest.json                      # the whole set
npx -y alphanana --help
```

Progress goes to stderr, the output path to stdout. Exit `3` from `generate` means the
matte guard never passed and the best attempt was written anyway - look at the file before
using it. `batch` writes `assets.report.json` next to the manifest; read it after a run.

The API key comes from `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), loaded from the nearest
`.env` above the working directory. If it is missing, ask the user for one rather than
guessing.

## The workflow for a coherent set

1. **Lock the style first.** Write an `alphanana.json` with a `prompts.style` preamble
   describing the art direction once (medium, palette, lighting, mood). Every prompt then
   describes only its subject.
2. **Variants before batch.** Generate 4-6 variants of one representative subject with
   `--variants --contact-sheet --label`, show the sheet to the user, and let them pick a
   direction. Adjust the style preamble until one sticks.
3. **Batch the rest** from a manifest. Use `reference` images (the picked variant works
   well) to hold form and identity together across separately generated assets.
4. **Verify, don't trust.** Check the report for failures and guard warnings, and check
   transparency where it matters (see the failure modes below).

## Prompting rules (each one is a recurring, real failure)

- **Never write "transparent" in a prompt.** The model paints the grey-and-white editor
  checkerboard instead. Describe an opening as the flat background colour continuing
  through it unchanged. The guard's `checkerRatio` catches most of these; the prompt is
  the real fix.
- **The filled hole is the guard's blind spot.** A frame whose centre was painted solid
  (a "panel", "plate", "paper" fill) passes every stat. Name the fills as negatives in
  the prompt ("NOT a panel, NOT a plate, NOT paper") and verify centre alpha directly on
  the output (e.g. `magick f.png -format "%[fx:round(100*p{w/2,h/2}.a)]" info:` must be 0
  for a hollow frame).
- **Pin glows to the outside.** "A soft glow around the frame" bleeds across the opening;
  say "hugging only the outer edge, never spreading into the empty middle".
- **Reword outright refusals.** A prompt that returns "No image in response" across seeds
  is not a transient error - reword the same intent. If one asset fails repeatedly while
  its siblings generate, it is the wording.
- **References steer form only.** Reference images carry the subject's form, identity and
  composition; the style preamble restyles them, and their backgrounds must never leak.

## Config and manifest

`alphanana.json` (optional, all fields defaulted): `model` (name/aspectRatio/imageSize),
`generation` (seed, temperature, ...), `prompts` (style, isolation, white, black,
systemInstruction), `background.hex` (contact-sheet fill), `guard` (matte thresholds,
`maxAttempts`).

`assets.manifest.json`: `outDir`, `defaults`, and `assets: [{ id, prompt, aspect?, size?,
reference?, opaque?, seed?, retries?, out? }]`. Batches are concurrent, skip existing
outputs unless `--force`, and `--only <id>` reruns one asset.

Pin `defaults.seed` (any integer) for reproducibility; retries offset it automatically so
re-rolls still vary.
