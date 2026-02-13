#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const talksRoot = path.resolve(expandHome(process.argv[2] || "~/cernbox/talks_preparation"));
const outRoot = path.resolve(process.argv[3] || "data/figures");
const reportPath = path.resolve("data/_generated/seed-report.json");
const rulesPath = path.resolve("config/class-rules.json");
const rules = loadRules(rulesPath);

if (!fs.existsSync(talksRoot)) {
  console.error(`Talks root not found: ${talksRoot}`);
  process.exit(1);
}

await fsp.mkdir(outRoot, { recursive: true });

const candidates = [];
for await (const filePath of walk(talksRoot)) {
  if (path.extname(filePath).toLowerCase() !== ".tex") continue;
  candidates.push(filePath);
}

const families = new Map();

for (const texPath of candidates) {
  const src = await fsp.readFile(texPath, "utf8");
  if (!src.includes("\\begin{tikzpicture}")) continue;
  if (isLikelyBeamerSlide(src)) continue;

  const rel = path.relative(talksRoot, texPath);
  const stem = path.basename(texPath, ".tex");
  const normalized = normalizeTex(src);
  const hash = sha(normalized);

  if (!families.has(hash)) {
    families.set(hash, {
      hash,
      rel,
      stem,
      className: classifyFigure(rel, stem, rules),
      texPath,
      texCode: src
    });
  }
}

let copiedTex = 0;
let copiedPdf = 0;
let copiedPng = 0;

for (const item of families.values()) {
  const classDir = path.join(outRoot, slug(item.className));
  await fsp.mkdir(classDir, { recursive: true });

  const baseName = sanitizeStem(item.stem) || item.hash.slice(0, 12);
  const texTarget = await uniquePath(classDir, `${baseName}.tex`);
  await fsp.writeFile(texTarget, item.texCode, "utf8");
  copiedTex += 1;

  const pdfSrc = await findSidecar(item.texPath, ".pdf");
  if (pdfSrc) {
    const pdfTarget = texTarget.replace(/\.tex$/i, ".pdf");
    await fsp.copyFile(pdfSrc, pdfTarget);
    copiedPdf += 1;
  }

  const pngSrc = await findSidecar(item.texPath, ".png");
  if (pngSrc) {
    const pngTarget = texTarget.replace(/\.tex$/i, ".png");
    await fsp.copyFile(pngSrc, pngTarget);
    copiedPng += 1;
  }
}

await fsp.mkdir(path.dirname(reportPath), { recursive: true });
await fsp.writeFile(
  reportPath,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      talks_root: talksRoot,
      out_root: outRoot,
      totals: {
        scanned_tex: candidates.length,
        unique_figures: families.size,
        copied_tex: copiedTex,
        copied_pdf: copiedPdf,
        copied_png: copiedPng
      }
    },
    null,
    2
  ),
  "utf8"
);

console.log(`Talks root: ${talksRoot}`);
console.log(`Output root: ${outRoot}`);
console.log(`Unique TikZ figures copied: ${copiedTex}`);
console.log(`Sidecar PDFs copied: ${copiedPdf}`);
console.log(`Sidecar PNGs copied: ${copiedPng}`);
console.log(`Wrote: ${reportPath}`);

function expandHome(inputPath) {
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(fullPath);
    if (entry.isFile()) yield fullPath;
  }
}

function loadRules(filePath) {
  if (!fs.existsSync(filePath)) {
    return { path_rules: [], stem_rules: [], generic_folder_names: [] };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeTex(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*/, "$1"))
    .join("\n")
    .replace(/\s+/g, "");
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function classifyFigure(relPath, stem, localRules) {
  const lowPath = relPath.toLowerCase();
  const lowStem = stem.toLowerCase();

  for (const rule of localRules.path_rules || []) {
    if (lowPath.includes(String(rule.contains).toLowerCase())) return rule.class;
  }

  for (const rule of localRules.stem_rules || []) {
    const rx = new RegExp(rule.regex, "i");
    if (rx.test(lowStem)) return rule.class;
  }

  const folders = relPath.split(path.sep).slice(0, -1);
  const candidateFolder = [...folders].reverse().find((name) => {
    const n = name.toLowerCase();
    if ((localRules.generic_folder_names || []).includes(n)) return false;
    if (/^\d{4}/.test(n)) return false;
    if (/talk|seminar|meeting|lecture|presentation|workshop/.test(n)) return false;
    return /[a-z]/.test(n);
  });

  if (candidateFolder) return titleCase(candidateFolder.replace(/[_-]+/g, " "));
  return titleCase(lowStem.replace(/[_-]+/g, " ").replace(/\d+/g, " ").trim().split(/\s+/).slice(0, 2).join(" ")) || "misc";
}

function titleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "misc";
}

function sanitizeStem(value) {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

async function findSidecar(texPath, ext) {
  const exact = texPath.replace(/\.tex$/i, ext);
  if (fs.existsSync(exact)) return exact;

  const dir = path.dirname(texPath);
  const stem = path.basename(texPath, ".tex").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${stem}([._-].*)?\\${ext}$`, "i");
  const names = await fsp.readdir(dir);
  const found = names.find((name) => rx.test(name));
  return found ? path.join(dir, found) : "";
}
