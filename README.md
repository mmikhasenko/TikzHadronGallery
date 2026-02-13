# TikZ Gallery

Static gallery generated from real TikZ source files stored in this repository.
This repository is a curated collection of my TikZ pictures, used primarily in talks and presentations.

## Source of Truth
- `data/figures/<class-name>/*.tex`
- Optional sidecar assets next to each TeX file: `*.pdf`, `*.png` (fallback only)

This is the only content you should edit manually.
You can keep only `.tex` files; PDFs and PNGs can be generated during `gallery:prepare`.

## 1) Clean Up (keep only non-generated sources)
Run:

```bash
npm run gallery:clean
```

This removes generated outputs only:
- `docs/`
- `public/generated/`
- `src/generated/gallery-index.json`
- `data/_generated/`

It keeps your originals intact in `data/figures/`.

## 2) Manual Content Manipulation
You control grouping by folder layout:
- Create a class: add folder `data/figures/<new-class>/`
- Move a figure to another class: move its `.tex` file to a different class folder
- Rename class: rename the folder
- Remove figure: delete the `.tex` file (and optional sidecars)

After any changes, regenerate:

```bash
npm run gallery:prepare
ASTRO_TELEMETRY_DISABLED=1 npm run build
```

What `gallery:prepare` does:
- Deduplicates `.tex` figures by normalized TikZ content.
- Compiles unique figures from TeX to PDF (`latexmk`) when available.
- Generates PNG and thumbnails from PDFs.
- Uses sidecar PDF/PNG only as fallback when compilation is unavailable or fails.

## 3) Better Arrangement via Similarity
Use overlap-based similarity suggestions:

```bash
npm run gallery:similarity
```

Output:
- `data/_generated/similarity-report.json`

What to do with it:
- Inspect `cross_class_suggestions`
- For high-similarity pairs, move files into the same class folder if desired
- Re-run `gallery:prepare` and `build`

Optional threshold (default `0.55`):

```bash
node scripts/suggest-groups.mjs data/figures 0.65
```

## Bootstrap from talks folder (one-time)
If needed:

```bash
npm run gallery:seed -- /path/to/talks_preparation
```

This imports unique TikZ `.tex` files into `data/figures`, excludes Beamer slide files, and copies sidecar PDF/PNG when found.

## Local Preview
```bash
cd docs
python3 -m http.server 4173 --bind 127.0.0.1
```

Open: [http://127.0.0.1:4173/](http://127.0.0.1:4173/)

## Deployment
- GitHub Pages from GitHub Actions.
- Astro output directory is `docs/`.
