#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const targets = [
  "docs",
  "public/generated",
  "src/generated/gallery-index.json",
  "data/_generated"
];

for (const rel of targets) {
  const full = path.join(root, rel);
  await fs.rm(full, { recursive: true, force: true });
  console.log(`Removed: ${rel}`);
}

await fs.mkdir(path.join(root, "src/generated"), { recursive: true });
await fs.writeFile(
  path.join(root, "src/generated/gallery-index.json"),
  JSON.stringify({ generated_at: "", classes: [] }, null, 2) + "\n",
  "utf8"
);

await fs.mkdir(path.join(root, "data/_generated"), { recursive: true });
console.log("Recreated placeholders in src/generated and data/_generated");
console.log("Original sources in data/figures are untouched.");
