// Gemini image API: text-to-image and image-to-image editing, normalized to PNG.
// The API returns JPEG bytes with no alpha channel, so every result is re-encoded to a
// lossless PNG via sharp. Calls the REST endpoint directly via fetch, no @google/* SDK.
// The caller passes apiKey (sourced from the user's .env via env.ts); this module never
// touches .env itself.

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

export const MODEL_ALIASES: Record<string, string> = {
  pro: 'gemini-3-pro-image',
  'nano-banana-pro': 'gemini-3-pro-image',
  flash: 'gemini-2.5-flash-image',
  'nano-banana': 'gemini-2.5-flash-image',
  'flash-2': 'gemini-3.1-flash-image',
}

export const VALID_ASPECTS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1',
])
export const VALID_SIZES = new Set(['512', '1K', '2K', '4K'])

export function resolveModel(model?: string): string {
  return MODEL_ALIASES[model ?? 'pro'] ?? model ?? 'gemini-3-pro-image'
}

/** Sampling/generation knobs forwarded verbatim into the request's generationConfig. */
export interface GenerationParams {
  temperature?: number
  topP?: number
  topK?: number
  seed?: number
  candidateCount?: number
  maxOutputTokens?: number
}

export interface GenerateOpts {
  apiKey: string
  prompt: string
  model?: string
  aspect?: string
  size?: string
  /** Edit-input images: file paths or in-memory PNG buffers. Triggers image-to-image. */
  images?: (string | Buffer)[]
  /** Top-level developer system instruction (text only). */
  systemInstruction?: string
  /** Extra generationConfig fields (temperature, seed, ...) merged into the request. */
  generation?: GenerationParams
}

export interface GenerateResult {
  png: Buffer
  srcMime: string
  model: string
}

type Part = { text: string } | { inlineData: { mimeType: string; data: string } }

export async function generateImage(opts: GenerateOpts): Promise<GenerateResult> {
  const model = resolveModel(opts.model)
  const aspect = opts.aspect ?? '1:1'
  const size = opts.size ?? '2K'
  if (!VALID_ASPECTS.has(aspect)) throw new Error(`Unsupported aspect "${aspect}".`)
  if (!VALID_SIZES.has(size)) throw new Error(`Unsupported size "${size}".`)
  if (!opts.prompt) throw new Error('A prompt is required.')

  const parts: Part[] = [{ text: opts.prompt }]
  for (const img of opts.images ?? []) {
    if (Buffer.isBuffer(img)) {
      parts.push({ inlineData: { mimeType: 'image/png', data: img.toString('base64') } })
    } else {
      const bytes = await readFile(resolve(img))
      const mimeType = img.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
      parts.push({ inlineData: { mimeType, data: bytes.toString('base64') } })
    }
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: aspect, imageSize: size },
      ...opts.generation,
    },
  }
  if (opts.systemInstruction) {
    body['systemInstruction'] = { parts: [{ text: opts.systemInstruction }] }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify(body),
  })

  if (!res.ok) throw new Error(`Gemini API ${res.status} ${res.statusText}\n${await res.text()}`)

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; inlineData?: { data?: string; mimeType?: string } }[] } }[]
    promptFeedback?: { blockReason?: string }
  }
  if (json.promptFeedback?.blockReason) throw new Error(`Prompt blocked: ${json.promptFeedback.blockReason}`)

  const responseParts = json.candidates?.[0]?.content?.parts ?? []
  const imagePart = responseParts.find((p) => p.inlineData?.data)
  if (!imagePart?.inlineData?.data) {
    const note = responseParts.map((p) => p.text).filter(Boolean).join(' ')
    throw new Error(`No image in response.${note ? ` Model said: ${note}` : ''}`)
  }

  const srcMime = imagePart.inlineData.mimeType ?? 'image/unknown'
  const png = await sharp(Buffer.from(imagePart.inlineData.data, 'base64')).png({ compressionLevel: 9 }).toBuffer()
  return { png, srcMime, model }
}
