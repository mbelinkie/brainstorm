import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const output = join(root, ".deploy-assets");
const publicFiles = [
  "index.html",
  "styles.css",
  "kaplan-brand-layer.css",
  "assets",
  "app.js",
  "room-api.js",
  "quiz-core.js",
  "quiz-validation.js",
  "diagnostics.js",
  "author.html",
  "author.css",
  "author.js",
  "config.js",
  "music-trivia.question-bank.json",
  "quiz.sample.json"
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(publicFiles.map((file) => cp(join(root, file), join(output, file), { recursive: true })));
console.log(`Prepared ${publicFiles.length} public files for deployment.`);
