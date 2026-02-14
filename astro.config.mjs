import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  outDir: "docs",
  site: "https://mmikhasenko.github.io",
  base: "/TikzHadronGallery/"
});
