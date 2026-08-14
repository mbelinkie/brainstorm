import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const brand = fs.readFileSync(new URL("../kaplan-brand-layer.css", import.meta.url), "utf8");
const deploy = fs.readFileSync(new URL("../prepare-deploy.mjs", import.meta.url), "utf8");

test("Kaplan brand layer and mask are loaded and deployed", () => {
  assert.match(index, /kaplan-brand-layer\.css/);
  assert.match(brand, /assets\/kaplan-k-mask\.svg/);
  assert.match(brand, /assets\/kaplan-k\.svg/);
  assert.ok(fs.existsSync(new URL("../assets/kaplan-k-mask.svg", import.meta.url)));
  assert.ok(fs.existsSync(new URL("../assets/kaplan-k.svg", import.meta.url)));
  assert.match(deploy, /"kaplan-brand-layer\.css"/);
  assert.match(deploy, /"assets"/);
  assert.match(deploy, /recursive: true/);
});

test("active player questions separate the prompt from the response surface", () => {
  assert.match(app, /player-prompt-card/);
  assert.match(app, /player-response-panel/);
  assert.match(app, /player-card--\$\{playerType\}/);
  assert.match(brand, /player-response-panel \.answer/);
});

test("brand layer protects rare mobile response layouts", () => {
  assert.match(brand, /player-response-panel \.drag-sort-list/);
  assert.match(brand, /player-response-panel \.matching-select-row/);
  assert.match(brand, /player-response-panel \.categorize-tap-row/);
  assert.match(brand, /player-card--image_selection \.answer-grid/);
  assert.match(brand, /overflow-y: visible/);
  assert.match(brand, /closest-number-help/);
  assert.match(brand, /number-reveal/);
  assert.match(brand, /body\.is-presentation \.player-shell::before/);
  assert.match(brand, /presentation-main:not\(\.presentation-main--title\)::before/);
});

test("motion pauses for accessibility and hidden tabs", () => {
  assert.match(brand, /prefers-reduced-motion: reduce/);
  assert.match(brand, /presenter-motion-paused/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /document\.hidden/);
});
