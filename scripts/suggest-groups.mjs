#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const sourceDir = path.resolve(process.argv[2] || process.env.TIKZ_SOURCE_DIR || "data/figures");
const outPath = path.resolve("data/_generated/similarity-report.json");
const minSimilarity = Number(process.argv[3] || 0.55);
const STOPWORDS = new Set([
  "begin",
  "end",
  "tikzpicture",
  "draw",
  "node",
  "path",
  "fill",
  "color",
  "scope",
  "tikz",
  "useasboundingbox",
  "documentclass",
  "input",
  "def",
  "newcommand"
]);

if (!fs.existsSync(sourceDir)) {
  console.error(`Source folder not found: ${sourceDir}`);
  process.exit(1);
}

const figures = [];
for await (const filePath of walk(sourceDir)) {
  if (path.extname(filePath).toLowerCase() !== ".tex") continue;
  const tex = await fsp.readFile(filePath, "utf8");
  if (!tex.includes("\\begin{tikzpicture}")) continue;

  const rel = path.relative(sourceDir, filePath);
  const className = rel.split(path.sep)[0] || "Uncategorized";
  const stem = path.basename(filePath, ".tex");
  const tokens = tokenize(tex);

  figures.push({
    rel_path: rel,
    class_name: className,
    stem,
    tokens
  });
}

const pairs = [];
for (let i = 0; i < figures.length; i += 1) {
  for (let j = i + 1; j < figures.length; j += 1) {
    const a = figures[i];
    const b = figures[j];
    const score = jaccard(a.tokens, b.tokens);
    if (score < minSimilarity) continue;

    pairs.push({
      similarity: Number(score.toFixed(4)),
      a: a.rel_path,
      b: b.rel_path,
      same_class: a.class_name === b.class_name
    });
  }
}

pairs.sort((x, y) => y.similarity - x.similarity);

const suggestions = pairs
  .filter((p) => !p.same_class)
  .slice(0, 200)
  .map((p) => ({
    similarity: p.similarity,
    from: p.a,
    to: p.b,
    suggestion: "Consider grouping these in the same class"
  }));

await fsp.mkdir(path.dirname(outPath), { recursive: true });
await fsp.writeFile(
  outPath,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      source_dir: sourceDir,
      min_similarity: minSimilarity,
      figures_scanned: figures.length,
      similar_pairs: pairs.length,
      cross_class_suggestions: suggestions
    },
    null,
    2
  ),
  "utf8"
);

console.log(`Scanned: ${figures.length} figures`);
console.log(`Pairs above threshold (${minSimilarity}): ${pairs.length}`);
console.log(`Cross-class suggestions: ${suggestions.length}`);
console.log(`Wrote: ${outPath}`);

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    if (entry.isFile()) yield full;
  }
}

function tokenize(tex) {
  const stripped = tex
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*/, "$1"))
    .join("\n")
    .toLowerCase();

  const raw = stripped.match(/[a-z]+|\\[a-z]+/g) || [];
  const filtered = raw.filter((t) => !STOPWORDS.has(t));
  return new Set(filtered);
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
