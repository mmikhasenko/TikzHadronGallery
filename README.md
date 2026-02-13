# TikZ Gallery

Static gallery for TikZ figures organized in class folders inside this repository.

## Source Layout
- `figures/<class-name>/*.tex`
- Optional sidecar assets next to each TeX file: `*.pdf`, `*.png`

## Local Workflow
1. Prepare gallery data and assets:
   - `npm run gallery:prepare`
2. Start site dev server:
   - `npm run dev`
3. Build static site into `docs/`:
   - `npm run build`

## What Prepare Does
- Scans `figures/` for TeX files containing `tikzpicture`.
- Removes complete duplicates using normalized TikZ hash.
- Builds class-first metadata at `src/generated/gallery-index.json`.
- Reuses sidecar PNG/PDF when available, and can render PNG previews from PDF.
- Copies available assets into:
  - `public/generated/pdf/`
  - `public/generated/png/`
  - `public/generated/thumbs/`

## Generated Files
- `src/generated/gallery-index.json`: class and figure metadata consumed by Astro.
- `data/audit-report.json`: stats and duplicate summary.
- `docs/`: final built static site for GitHub Pages deployment.

## Deployment Target
- GitHub Pages via GitHub Actions.
