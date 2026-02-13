#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";

const sourceDir = path.resolve(process.argv[2] || process.env.TIKZ_SOURCE_DIR || "figures");
const generatedDir = path.resolve("src/generated");
const publicGeneratedDir = path.resolve("public/generated");
const reportPath = path.resolve("data/audit-report.json");
const galleryPath = path.resolve("src/generated/gallery-index.json");

if (!fs.existsSync(sourceDir)) {
  console.error(`Source folder not found: ${sourceDir}`);
  console.error("Expected structure: figures/<class>/*.tex");
  process.exit(1);
}

const allFiles = [];
for await (const filePath of walk(sourceDir)) {
  allFiles.push(filePath);
}

const extensionCounts = new Map();
for (const filePath of allFiles) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "") || "<none>";
  extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
}

const candidates = allFiles.filter((p) => path.extname(p).toLowerCase() === ".tex");
const instances = [];

for (const absPath of candidates) {
  const source = await fsp.readFile(absPath, "utf8");
  if (!source.includes("\\begin{tikzpicture}")) continue;

  const relPath = path.relative(sourceDir, absPath);
  const parts = relPath.split(path.sep);
  const className = parts[0] || "Misc";
  const stem = path.basename(absPath, ".tex");
  const normalized = normalizeTex(source);
  const familyHash = hash(normalized);

  instances.push({
    abs_path: absPath,
    rel_path: relPath,
    class_name: className,
    stem,
    family_hash: familyHash,
    tex_code: source
  });
}

const familyMap = new Map();
for (const item of instances) {
  if (!familyMap.has(item.family_hash)) familyMap.set(item.family_hash, []);
  familyMap.get(item.family_hash).push(item);
}

await prepareAssetDirs(publicGeneratedDir);

const uniqueFigures = [];
for (const [familyHash, group] of familyMap.entries()) {
  const sorted = [...group].sort((a, b) => a.rel_path.localeCompare(b.rel_path));
  const canonical = sorted[0];
  const primaryClass = pickPrimaryClass(sorted);
  const id = familyHash.slice(0, 16);

  const pngSource = await findAsset(sorted, ".png");
  const pdfSource = await findAsset(sorted, ".pdf");

  let pngUrl = "";
  let pdfUrl = "";
  let thumbUrl = "";

  if (pngSource) {
    const pngTarget = path.join(publicGeneratedDir, "png", `${id}.png`);
    const thumbTarget = path.join(publicGeneratedDir, "thumbs", `${id}.png`);
    await fsp.copyFile(pngSource, pngTarget);
    await writeThumb(pngTarget, thumbTarget);
    pngUrl = `/generated/png/${id}.png`;
    thumbUrl = `/generated/thumbs/${id}.png`;
  }

  if (pdfSource) {
    const pdfTarget = path.join(publicGeneratedDir, "pdf", `${id}.pdf`);
    await fsp.copyFile(pdfSource, pdfTarget);
    pdfUrl = `/generated/pdf/${id}.pdf`;

    if (!pngUrl) {
      const pngTarget = path.join(publicGeneratedDir, "png", `${id}.png`);
      const thumbTarget = path.join(publicGeneratedDir, "thumbs", `${id}.png`);
      const rendered = renderPngFromPdf(pdfSource, pngTarget);
      if (rendered) {
        await writeThumb(pngTarget, thumbTarget);
        pngUrl = `/generated/png/${id}.png`;
        thumbUrl = `/generated/thumbs/${id}.png`;
      }
    }
  }

  uniqueFigures.push({
    id,
    title: prettifyTitle(canonical.stem),
    stem: canonical.stem,
    class_name: primaryClass,
    class_id: slug(primaryClass),
    family_hash: familyHash,
    duplicate_count: group.length,
    tex_code: canonical.tex_code,
    png_url: pngUrl,
    pdf_url: pdfUrl,
    thumb_url: thumbUrl,
    source_count: group.length
  });
}

const classMap = new Map();
for (const figure of uniqueFigures) {
  if (!classMap.has(figure.class_name)) classMap.set(figure.class_name, []);
  classMap.get(figure.class_name).push(figure);
}

const classes = [...classMap.entries()]
  .map(([className, figures]) => {
    const sortedFigures = [...figures].sort((a, b) => a.title.localeCompare(b.title));
    const sample = sortedFigures.find((f) => f.thumb_url) || sortedFigures[0];
    return {
      class_id: slug(className),
      class_name: className,
      figure_count: sortedFigures.length,
      class_thumb_url: sample?.thumb_url || "",
      figures: sortedFigures
    };
  })
  .sort((a, b) => b.figure_count - a.figure_count);

const report = {
  generated_at: new Date().toISOString(),
  source_dir: sourceDir,
  totals: {
    all_files: allFiles.length,
    tex_files: candidates.length,
    tikz_tex_files: instances.length,
    unique_families: uniqueFigures.length,
    duplicate_instances: instances.length - uniqueFigures.length,
    classes: classes.length
  },
  by_extension: Object.fromEntries([...extensionCounts.entries()].sort((a, b) => b[1] - a[1])),
  top_classes: classes.slice(0, 25).map((c) => ({ key: c.class_name, count: c.figure_count })),
  top_families: uniqueFigures
    .map((f) => ({ key: f.id, count: f.duplicate_count, sample: `${f.class_name}/${f.stem}.tex` }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)
};

await fsp.mkdir(path.dirname(galleryPath), { recursive: true });
await fsp.mkdir(path.dirname(reportPath), { recursive: true });

await fsp.writeFile(
  galleryPath,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      classes
    },
    null,
    2
  ),
  "utf8"
);

await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

console.log(`Source: ${sourceDir}`);
console.log(`TikZ files: ${report.totals.tikz_tex_files}`);
console.log(`Unique figures: ${report.totals.unique_families}`);
console.log(`Classes: ${report.totals.classes}`);
console.log(`Wrote: ${galleryPath}`);
console.log(`Wrote: ${reportPath}`);

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function normalizeTex(source) {
  const withoutComments = source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*/, "$1"))
    .join("\n");
  return withoutComments.replace(/\s+/g, "");
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "misc";
}

function prettifyTitle(stem) {
  const title = stem
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.length ? title[0].toUpperCase() + title.slice(1) : "Untitled";
}

function pickPrimaryClass(group) {
  const counts = new Map();
  for (const item of group) {
    counts.set(item.class_name, (counts.get(item.class_name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

async function findAsset(group, ext) {
  const byPath = [...group].sort((a, b) => a.rel_path.localeCompare(b.rel_path));

  for (const item of byPath) {
    const exact = item.abs_path.replace(/\.tex$/i, ext);
    if (fs.existsSync(exact)) return exact;
  }

  for (const item of byPath) {
    const dir = path.dirname(item.abs_path);
    const stem = item.stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`^${stem}([._-].*)?\\${ext}$`, "i");
    const names = await fsp.readdir(dir);
    const found = names.find((name) => rx.test(name));
    if (found) return path.join(dir, found);
  }

  return "";
}

async function prepareAssetDirs(baseDir) {
  await fsp.mkdir(baseDir, { recursive: true });
  await fsp.rm(path.join(baseDir, "png"), { recursive: true, force: true });
  await fsp.rm(path.join(baseDir, "pdf"), { recursive: true, force: true });
  await fsp.rm(path.join(baseDir, "thumbs"), { recursive: true, force: true });
  await fsp.mkdir(path.join(baseDir, "png"), { recursive: true });
  await fsp.mkdir(path.join(baseDir, "pdf"), { recursive: true });
  await fsp.mkdir(path.join(baseDir, "thumbs"), { recursive: true });
}

function renderPngFromPdf(pdfPath, pngTarget) {
  const tmpPrefix = path.join(os.tmpdir(), `tikz-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const pdfToPpm = spawnSync(
    "pdftoppm",
    ["-singlefile", "-f", "1", "-l", "1", "-png", pdfPath, tmpPrefix],
    { stdio: "ignore" }
  );

  if (pdfToPpm.status !== 0) return false;

  const produced = `${tmpPrefix}.png`;
  if (!fs.existsSync(produced)) return false;
  fs.copyFileSync(produced, pngTarget);
  fs.rmSync(produced, { force: true });
  return true;
}

async function writeThumb(sourcePng, thumbTarget) {
  const resize = spawnSync("magick", [sourcePng, "-thumbnail", "600x380^", "-gravity", "center", "-extent", "600x380", thumbTarget], { stdio: "ignore" });
  if (resize.status === 0 && fs.existsSync(thumbTarget)) return;
  await fsp.copyFile(sourcePng, thumbTarget);
}
