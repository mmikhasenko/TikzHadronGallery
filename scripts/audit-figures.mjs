#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";

const sourceDir = path.resolve(process.argv[2] || process.env.TIKZ_SOURCE_DIR || "data/figures");
const publicGeneratedDir = path.resolve("public/generated");
const reportPath = path.resolve("data/_generated/audit-report.json");
const galleryPath = path.resolve("src/generated/gallery-index.json");
const compileFailuresPath = path.resolve("data/_generated/compile-failures.json");
const dataStylesDir = path.resolve("data/styles");
const talksRoot = path.resolve(process.env.TIKZ_TALKS_ROOT || path.join(os.homedir(), "cernbox", "talks_preparation"));
const excludedFiguresPath = path.resolve("config/excluded-figures.txt");
const hasLatexmk = commandExists("latexmk");
const hasTalksRoot = fs.existsSync(talksRoot);
let talksIndex = null;
await fsp.mkdir(dataStylesDir, { recursive: true });
const excludedFigures = loadExcludedFigures(excludedFiguresPath);

if (!fs.existsSync(sourceDir)) {
  console.error(`Source folder not found: ${sourceDir}`);
  console.error("Expected structure: data/figures/<class>/*.tex");
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
let excludedCount = 0;

for (const absPath of candidates) {
  const source = await fsp.readFile(absPath, "utf8");
  if (!source.includes("\\begin{tikzpicture}")) continue;
  if (isLikelyBeamerSlide(source)) continue;

  const relPath = path.relative(sourceDir, absPath);
  if (excludedFigures.has(relPath.replace(/\\/g, "/"))) {
    excludedCount += 1;
    continue;
  }
  const parts = relPath.split(path.sep);
  const stem = path.basename(absPath, ".tex");
  const className = parts.length > 1 ? prettifyTitle(parts[0]) : "Uncategorized";
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
let compiledPdfCount = 0;
let copiedPdfCount = 0;
let copiedPngCount = 0;
let renderedPngFromPdfCount = 0;
const compileFailures = [];
let resolvedInputsCount = 0;
let unresolvedInputsCount = 0;
for (const [familyHash, group] of familyMap.entries()) {
  const sorted = [...group].sort((a, b) => a.rel_path.localeCompare(b.rel_path));
  const canonical = sorted[0];
  const primaryClass = pickPrimaryClass(sorted);
  const id = familyHash.slice(0, 16);
  const pdfTarget = path.join(publicGeneratedDir, "pdf", `${id}.pdf`);
  const pngTarget = path.join(publicGeneratedDir, "png", `${id}.png`);
  const thumbTarget = path.join(publicGeneratedDir, "thumbs", `${id}.png`);

  const compileResult = hasLatexmk ? compilePdfFromTex(canonical, pdfTarget) : { ok: false };
  if (compileResult.ok) {
    compiledPdfCount += 1;
    resolvedInputsCount += compileResult.resolvedInputs || 0;
    unresolvedInputsCount += compileResult.unresolvedInputs || 0;
  } else if (hasLatexmk && compileFailures.length < 300) {
    resolvedInputsCount += compileResult.resolvedInputs || 0;
    unresolvedInputsCount += compileResult.unresolvedInputs || 0;
    compileFailures.push({
      figure: canonical.rel_path,
      class_name: primaryClass,
      message: compileResult.message || "Unknown compile error"
    });
  }

  const pngSource = await findAsset(sorted, ".png");
  const pdfSource = await findAsset(sorted, ".pdf");

  let pngUrl = "";
  let pdfUrl = "";
  let thumbUrl = "";

  if (pngSource) {
    await fsp.copyFile(pngSource, pngTarget);
    await writeThumb(pngTarget, thumbTarget);
    copiedPngCount += 1;
    pngUrl = `/generated/png/${id}.png`;
    thumbUrl = `/generated/thumbs/${id}.png`;
  }

  if (!fs.existsSync(pdfTarget) && pdfSource) {
    await fsp.copyFile(pdfSource, pdfTarget);
    copiedPdfCount += 1;
  }

  if (fs.existsSync(pdfTarget)) {
    pdfUrl = `/generated/pdf/${id}.pdf`;
    if (!pngUrl) {
      const rendered = renderPngFromPdf(pdfTarget, pngTarget);
      if (rendered) {
        await writeThumb(pngTarget, thumbTarget);
        renderedPngFromPdfCount += 1;
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
    classes: classes.length,
    compiled_pdfs: compiledPdfCount,
    copied_pdfs: copiedPdfCount,
    copied_pngs: copiedPngCount,
    rendered_pngs_from_pdf: renderedPngFromPdfCount
    ,
    resolved_inputs: resolvedInputsCount,
    unresolved_inputs: unresolvedInputsCount
    ,
    excluded_files: excludedCount
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
await fsp.mkdir(path.dirname(compileFailuresPath), { recursive: true });

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
await fsp.writeFile(
  compileFailuresPath,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      compile_failures: compileFailures
    },
    null,
    2
  ),
  "utf8"
);

console.log(`Source: ${sourceDir}`);
console.log(`TikZ files: ${report.totals.tikz_tex_files}`);
console.log(`Unique figures: ${report.totals.unique_families}`);
console.log(`Classes: ${report.totals.classes}`);
console.log(`PDFs compiled from TeX: ${compiledPdfCount}`);
console.log(`PDFs copied from sidecars: ${copiedPdfCount}`);
console.log(`PNGs copied from sidecars: ${copiedPngCount}`);
console.log(`PNGs rendered from PDFs: ${renderedPngFromPdfCount}`);
console.log(`Resolved style inputs: ${resolvedInputsCount}`);
console.log(`Unresolved style inputs: ${unresolvedInputsCount}`);
console.log(`Excluded non-renderable files: ${excludedCount}`);
if (!hasLatexmk) {
  console.log("Note: latexmk not found, skipping TeX->PDF compilation and using sidecars only.");
}
console.log(`Compile failures logged: ${compileFailures.length}`);
console.log(`Wrote: ${galleryPath}`);
console.log(`Wrote: ${reportPath}`);
console.log(`Wrote: ${compileFailuresPath}`);

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

function loadExcludedFigures(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return new Set(lines);
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

function isLikelyBeamerSlide(source) {
  const s = source.toLowerCase();
  return (
    s.includes("\\documentclass{beamer}") ||
    s.includes("\\usetheme") ||
    s.includes("\\begin{frame}") ||
    s.includes("\\frametitle")
  );
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

function compilePdfFromTex(canonical, outPdfPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tikz-pdf-"));
  try {
    const prepared = prepareTexForCompilation(canonical);
    const sourcePath = path.join(tmpDir, "source.tex");
    const hasDocumentClass = prepared.tex.includes("\\documentclass");
    fs.writeFileSync(sourcePath, prepared.tex, "utf8");
    for (const dep of prepared.dependencies) {
      if (dep.binary) {
        fs.writeFileSync(path.join(tmpDir, dep.fileName), dep.content);
      } else {
        fs.writeFileSync(path.join(tmpDir, dep.fileName), dep.content, "utf8");
      }
    }

    let entryFile = sourcePath;
    if (!hasDocumentClass) {
      const wrapperPath = path.join(tmpDir, "wrapper.tex");
      const wrapper = [
        "\\documentclass[tikz,border=2pt]{standalone}",
        "\\usepackage{tikz}",
        "\\usepackage{amsmath}",
        "\\usepackage{amssymb}",
        "\\begin{document}",
        "\\input{source.tex}",
        "\\end{document}",
        ""
      ].join("\n");
      fs.writeFileSync(wrapperPath, wrapper, "utf8");
      entryFile = wrapperPath;
    }

    const run = spawnSync(
      "latexmk",
      ["-pdf", "-interaction=nonstopmode", "-halt-on-error", entryFile],
      { cwd: tmpDir, encoding: "utf8" }
    );
    if (run.status !== 0) {
      const logPath = path.join(tmpDir, `${path.basename(entryFile, ".tex")}.log`);
      const logMsg = fs.existsSync(logPath) ? extractLogError(fs.readFileSync(logPath, "utf8")) : "";
      const msg = logMsg || (run.stdout || run.stderr || "").split("\n").slice(-12).join(" ").trim();
      return {
        ok: false,
        message: msg || `latexmk exited with code ${run.status}`,
        resolvedInputs: prepared.resolvedCount,
        unresolvedInputs: prepared.unresolved.length
      };
    }

    const producedPdf = path.join(tmpDir, `${path.basename(entryFile, ".tex")}.pdf`);
    if (!fs.existsSync(producedPdf)) {
      return {
        ok: false,
        message: "latexmk reported success but no PDF produced",
        resolvedInputs: prepared.resolvedCount,
        unresolvedInputs: prepared.unresolved.length
      };
    }
    fs.copyFileSync(producedPdf, outPdfPath);
    return { ok: true, resolvedInputs: prepared.resolvedCount, unresolvedInputs: prepared.unresolved.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function commandExists(cmd) {
  const out = spawnSync("sh", ["-lc", `command -v ${cmd}`], { stdio: "ignore" });
  return out.status === 0;
}

function prepareTexForCompilation(canonical) {
  const inputRefs = [...canonical.tex_code.matchAll(/\\input\{([^}]+)\}/g)].map((m) => m[1]);
  const uniqueInputRefs = [...new Set(inputRefs)];

  let tex = canonical.tex_code;
  const dependencies = [];
  const unresolved = [];
  let resolvedCount = 0;

  for (const ref of uniqueInputRefs) {
    const replacement = normalizeInputRef(ref);
    tex = tex.replaceAll(`\\input{${ref}}`, `\\input{${replacement.tokenForTex}}`);

    const resolved = resolveInputFile(canonical, ref, replacement.fileName);
    if (resolved) {
      dependencies.push({ fileName: resolved.fileName, content: resolved.content, binary: false });
      resolvedCount += 1;
    } else {
      unresolved.push(ref);
    }
  }

  if (canonical.tex_code.includes("\\usetikzlibrary{timeline}")) {
    const timelineLib = resolveInputFile(canonical, "tikzlibrarytimeline.code.tex", "tikzlibrarytimeline.code.tex");
    if (timelineLib) {
      dependencies.push({ fileName: timelineLib.fileName, content: timelineLib.content });
      resolvedCount += 1;
    } else {
      unresolved.push("tikzlibrarytimeline.code.tex");
    }
  }

  const graphicsRefs = [...canonical.tex_code.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((m) => m[1]);
  for (const ref of [...new Set(graphicsRefs)]) {
    const replacement = normalizeGraphicRef(ref);
    tex = tex.replaceAll(`{${ref}}`, `{${replacement.tokenForTex}}`);
    const resolvedGraphic = resolveGraphicFile(canonical, ref, replacement.fileName);
    if (resolvedGraphic) {
      dependencies.push({ fileName: resolvedGraphic.fileName, content: resolvedGraphic.content, binary: true });
      resolvedCount += 1;
    } else {
      unresolved.push(ref);
    }
  }

  return { tex, dependencies, unresolved, resolvedCount };
}

function normalizeInputRef(ref) {
  const rawBase = path.basename(ref);
  const ext = path.extname(rawBase);
  if (ext) {
    return { tokenForTex: rawBase, fileName: rawBase };
  }
  return { tokenForTex: rawBase, fileName: `${rawBase}.tex` };
}

function resolveInputFile(canonical, ref, outFileName) {
  const rawBase = path.basename(ref);
  const noExt = rawBase.replace(/\.[^.]+$/, "");
  const candidates = [];

  candidates.push(path.resolve(path.dirname(canonical.abs_path), ref));
  candidates.push(path.resolve(path.dirname(canonical.abs_path), `${ref}.tex`));
  candidates.push(path.resolve(dataStylesDir, rawBase));
  candidates.push(path.resolve(dataStylesDir, `${rawBase}.tex`));
  candidates.push(path.resolve(dataStylesDir, `${rawBase}.sty`));
  candidates.push(path.resolve(dataStylesDir, `${noExt}.tex`));
  candidates.push(path.resolve(dataStylesDir, `${noExt}.sty`));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { fileName: outFileName, content: fs.readFileSync(candidate, "utf8") };
    }
  }

  const talked = findInTalks(rawBase) || findInTalks(`${rawBase}.tex`) || findInTalks(`${noExt}.tex`) || findInTalks(`${noExt}.sty`);
  if (talked) {
    const content = fs.readFileSync(talked, "utf8");
    const persistTarget = path.join(dataStylesDir, path.basename(talked));
    if (!fs.existsSync(persistTarget)) {
      fs.writeFileSync(persistTarget, content, "utf8");
    }
    return { fileName: outFileName, content };
  }

  return null;
}

function normalizeGraphicRef(ref) {
  const rawBase = path.basename(ref);
  if (path.extname(rawBase)) {
    return { tokenForTex: rawBase, fileName: rawBase };
  }
  return { tokenForTex: rawBase, fileName: `${rawBase}.pdf` };
}

function resolveGraphicFile(canonical, ref, outFileName) {
  const rawBase = path.basename(ref);
  const noExt = rawBase.replace(/\.[^.]+$/, "");
  const candidates = [];

  candidates.push(path.resolve(path.dirname(canonical.abs_path), ref));
  candidates.push(path.resolve(path.dirname(canonical.abs_path), `${ref}.pdf`));
  candidates.push(path.resolve(path.dirname(canonical.abs_path), `${ref}.png`));
  candidates.push(path.resolve(dataStylesDir, rawBase));
  candidates.push(path.resolve(dataStylesDir, `${rawBase}.pdf`));
  candidates.push(path.resolve(dataStylesDir, `${rawBase}.png`));
  candidates.push(path.resolve(dataStylesDir, `${noExt}.pdf`));
  candidates.push(path.resolve(dataStylesDir, `${noExt}.png`));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { fileName: outFileName, content: fs.readFileSync(candidate) };
    }
  }

  const talked =
    findInTalks(rawBase) ||
    findInTalks(`${rawBase}.pdf`) ||
    findInTalks(`${rawBase}.png`) ||
    findInTalks(`${noExt}.pdf`) ||
    findInTalks(`${noExt}.png`);

  if (talked) {
    const content = fs.readFileSync(talked);
    const persistTarget = path.join(dataStylesDir, path.basename(talked));
    if (!fs.existsSync(persistTarget)) {
      fs.writeFileSync(persistTarget, content);
    }
    return { fileName: outFileName, content };
  }

  return null;
}

function findInTalks(baseName) {
  if (!hasTalksRoot) return "";
  if (!talksIndex) {
    talksIndex = buildTalksIndexSync(talksRoot);
  }
  const key = baseName.toLowerCase();
  const hits = talksIndex.get(key) || [];
  if (hits.length === 0) return "";
  return hits.sort((a, b) => b.size - a.size)[0].path;
}

function buildTalksIndexSync(rootDir) {
  const index = new Map();
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const key = entry.name.toLowerCase();
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ path: full, size: fs.statSync(full).size });
      }
    }
  }
  return index;
}

function extractLogError(logText) {
  const lines = logText.split(/\r?\n/);
  const bang = lines.findIndex((line) => line.startsWith("! "));
  if (bang >= 0) {
    return lines.slice(bang, Math.min(lines.length, bang + 6)).join(" ").trim();
  }
  const missing = lines.find((line) => /File `.*' not found/.test(line));
  if (missing) return missing.trim();
  return "";
}
