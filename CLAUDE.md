# alphanana

Single-package repo (pnpm, ESM-only, built with tsdown). Ships three ways from one source
tree: an npm library, an `alphanana` CLI, and a Claude Code plugin.

See `README.md` for what the difference-matte pipeline does and why it exists.

## Commands

```
pnpm build       # tsdown -> build/ (esm + .d.mts, no sourcemaps)
pnpm typecheck   # tsgo -p tsconfig.json
pnpm lint        # oxlint src test
pnpm test        # vitest run
```

There is no aggregate `check` script — run `pnpm lint && pnpm typecheck` together.

## Layout

- `src/matte.ts` — the alpha solve (`a = 1 - (white - black)`, `F = black / a`) and the
  guard stats that decide whether a matte is trustworthy. The only unit-tested module.
- `src/gemini.ts` — Gemini image model calls (render, then edit-to-black).
- `src/generate.ts` — one asset: render pair, matte, guard, re-roll on drift.
- `src/variants.ts` — N seeds of one subject, optional contact sheet.
- `src/batch.ts` — manifest-driven runs; writes `assets.report.json`.
- `src/config.ts` / `src/env.ts` — `alphanana.json` schema (zod) and `.env` discovery.
- `src/cli.ts` — arg parsing; progress to stderr, output paths to stdout.
- `skills/alphanana/SKILL.md` + `.claude-plugin/` — the Claude Code plugin. The skill
  drives the published CLI via `npx -y alphanana`, so it is distributed through the
  plugin marketplace (git), never through the npm tarball.

## Publishing

Automated. `.github/workflows/publish.yml` publishes to npm on every push to `master`
whose `package.json` version is not on the registry yet — so **bumping the version is
what ships**, and an ordinary commit is a no-op.

- Auth is npm **trusted publishing** (OIDC): no `NPM_TOKEN` exists anywhere, and npm
  attaches a provenance attestation automatically. The trust relationship on npmjs.com is
  pinned to the filename `publish.yml` — renaming or moving that file breaks publishing.
- The publish step runs `npm publish`, not `pnpm publish`: pnpm has no OIDC support yet
  (pnpm#9812) and pnpm 11 404s on OIDC (pnpm#11513). pnpm is still used for install/build.
- `files: ["build"]` is the whitelist — the tarball is build output plus
  `package.json`/`README`/`LICENSE` only. Sourcemaps are off deliberately: they embed
  `sourcesContent`, which shipped the entire TS source in every install.

## Wrapup Config

- check: `pnpm lint && pnpm typecheck`
- test: `pnpm test`
- push: yes
- version_bump: no (bump manually when releasing — the bump IS the release trigger)
- publish: automatic on push to master via publish.yml; never run npm/pnpm publish by hand
- docs: single CLAUDE.md + README
- frontend_smoke: n/a (no frontend)
- co_authored_by: no (already disabled globally in ~/.claude/settings.json)
