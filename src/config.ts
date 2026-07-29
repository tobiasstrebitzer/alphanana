// alphanana config: `alphanana.json` next to the theme being generated, validated with zod.
// Missing file resolves to all defaults; partial file resolves per-field defaults; invalid
// config fails fast with the precise zod issue list. The style preamble is supplied per theme
// (see themes/default/STYLE-GUIDE.md); the defaults are brand-agnostic.

import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

// Aspect ratios / sizes accepted by the Gemini image models.
export const ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1',
] as const
export const IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const

const DEFAULT_STYLE =
  `Style: follow the project's supplied style preamble exactly. If no specific style is given, produce a clean, neutral, premium illustration with confident, cinematic lighting and crisp high-fidelity detail on a plain background - nothing gimmicky. Avoid rendering any text at all costs, unless explicitly asked.`

// Appended to the white prompt on every generate unless isolate is off, so the white frame is
// genuinely empty. That keeps borderAlpha low and lets the matte fade to 0 at the frame.
const DEFAULT_ISOLATION =
  `CRITICAL: this is an isolated cut-out of just the subject described - no room, no walls, no window, no furniture, no floor, no ground, no environment or scenery of any kind behind or around it; nothing but the subject itself on the plain background described above. If the subject has a hole, opening or cut-out in it, the flat background colour must be visible straight through that opening, exactly as it is around the subject. NEVER draw a checkerboard, chequered pattern, grey-and-white grid or any other stand-in for transparency: transparency is produced afterwards from the background colour, so an opening is simply painted in the background colour.`

const DEFAULT_WHITE =
  `Render the subject isolated and centered, floating, with a soft semi-transparent drop shadow directly beneath it. Leave generous margin: the subject together with its glow and shadow must stay well inside the frame and never touch the edges. Background: a perfectly flat, evenly lit, pure solid white #FFFFFF - completely uniform, no gradient, no texture, no floor, no other objects, nothing besides the subject and its own glow and shadow. Any opening or hollow area in the subject shows that same flat pure white through it - never a pattern, never a checkerboard, never a grid.`
const DEFAULT_BLACK =
  `Replace ONLY the white background with pure, uniform, flat #000000 black. The new background must be completely empty and featureless: NO glow, NO reflection, NO floor, NO gradient, NO light spill, NO ambient lighting, nothing added anywhere. Do not re-light or re-render the scene. Every foreground pixel - the subject, its glow halo, and its soft drop shadow - must stay byte-for-byte identical in position, size, color, and opacity. This is a pure background color swap, nothing else.`

const modelSchema = z
  .object({
    name: z.string().default('gemini-3-pro-image'),
    aspectRatio: z.enum(ASPECT_RATIOS).default('1:1'),
    imageSize: z.enum(IMAGE_SIZES).default('2K'),
  })
  .prefault({})

// Only fields the generateContent endpoint accepts for image models; unsupported fields 400.
const generationSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().positive().optional(),
    seed: z.number().int().optional(),
    candidateCount: z.number().int().min(1).max(8).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
  .prefault({})

const promptsSchema = z
  .object({
    style: z.string().default(DEFAULT_STYLE),
    isolation: z.string().default(DEFAULT_ISOLATION),
    white: z.string().default(DEFAULT_WHITE),
    black: z.string().default(DEFAULT_BLACK),
    systemInstruction: z.string().optional(),
  })
  .prefault({})

// Contact-sheet backdrop: a flat hex fill (the theme's background color works well).
const backgroundSchema = z
  .object({
    hex: z.string().default('#0b0e1a'),
  })
  .prefault({})

// Alignment guard thresholds (see matte.ts analyzeMatte). maxBorderAlpha / maxOpaqueRatio
// catch the "background never removed" failure; minOpaqueRatio catches an empty matte;
// maxChecker catches a hollow opening the model painted as a transparency checkerboard.
const guardSchema = z
  .object({
    roughness: z.number().min(0).max(1).default(0.02),
    strayRatio: z.number().min(0).max(1).default(0.05),
    maxBorderAlpha: z.number().min(0).max(1).default(0.35),
    maxOpaqueRatio: z.number().min(0).max(1).default(0.92),
    minOpaqueRatio: z.number().min(0).max(1).default(0.01),
    /**
     * Rejects a painted transparency checkerboard (see MatteStats.checkerRatio). Sits between
     * measured clean art (0.001 - 0.024, an ornate engraved frame at the top of that) and a
     * measured painted checkerboard (0.049 - 0.067). Retuned with CHECKER_CONTRAST; the two
     * numbers only mean anything together.
     */
    maxChecker: z.number().min(0).max(1).default(0.03),
    maxAttempts: z.number().int().min(1).default(3),
  })
  .prefault({})

export const configSchema = z.object({
  model: modelSchema,
  generation: generationSchema,
  prompts: promptsSchema,
  background: backgroundSchema,
  guard: guardSchema,
})

export type AlphananaConfig = z.infer<typeof configSchema>
export type GenerationConfig = z.infer<typeof generationSchema>

export const DEFAULT_CONFIG: AlphananaConfig = configSchema.parse({})

export function getConfig(path = 'alphanana.json'): AlphananaConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new Error(`Could not parse ${path} as JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid config in ${path}:\n${issues}`)
  }
  return result.data
}
