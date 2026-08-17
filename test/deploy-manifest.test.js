import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// `prepare-deploy.mjs` copies a hardcoded list of files into `.deploy-assets/`.
// Anything a shipped file references but that the list omits returns 404 in
// production while working fine locally, because the dev server serves the
// whole folder. That is how `video-utils.js` and `image-crop.js` — both static
// imports of `author.js` — went missing from the deployed authoring editor
// without any local symptom. These tests close that gap.

const root = new URL("../", import.meta.url);
const deploySource = fs.readFileSync(new URL("prepare-deploy.mjs", root), "utf8");

const publicFiles = (() => {
  const start = deploySource.indexOf("const publicFiles");
  const end = deploySource.indexOf("];", start);
  assert.ok(start >= 0 && end > start, "could not locate the publicFiles array in prepare-deploy.mjs");
  return [...deploySource.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
})();

// Built by `npm run build:video`, git-ignored, and absent in a fresh clone.
const generatedArtifacts = new Set(["video-processor.worker.bundle.js"]);

// A reference is satisfied by an exact manifest entry, or by a directory entry
// that contains it — `cp(..., { recursive: true })` ships whole directories.
function isShipped(reference) {
  return publicFiles.some((entry) => entry === reference || reference.startsWith(`${entry}/`));
}

// Strip comments so documented examples (app.js:85 mentions a placeholder
// avatar path in prose) are not mistaken for real references. Only `//` at the
// start of a trimmed line is treated as a comment, so URLs inside string
// literals survive.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function localReferences(source) {
  const references = new Set();
  for (const match of stripComments(source).matchAll(/["'](\.\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)["']/g)) {
    references.add(match[1].replace(/^\.\//, ""));
  }
  return references;
}

test("every file prepare-deploy ships exists in the repository", () => {
  for (const entry of publicFiles) {
    if (generatedArtifacts.has(entry)) continue;
    assert.ok(fs.existsSync(new URL(entry, root)), `prepare-deploy.mjs ships "${entry}", which does not exist`);
  }
});

test("every local file referenced by a shipped file is itself shipped", () => {
  for (const entry of publicFiles) {
    if (!/\.(js|html)$/.test(entry) || generatedArtifacts.has(entry)) continue;
    const source = fs.readFileSync(new URL(entry, root), "utf8");
    for (const reference of localReferences(source)) {
      assert.ok(
        isShipped(reference),
        `${entry} references "./${reference}", which prepare-deploy.mjs does not ship — it would 404 in production. Add it to publicFiles.`
      );
      assert.ok(
        fs.existsSync(new URL(reference, root)),
        `${entry} references "./${reference}", which does not exist in the repository`
      );
    }
  }
});

test("the deployed entry points' static imports all resolve", () => {
  // Narrower and stricter than the scan above: a static `import ... from` that
  // 404s fails the entire module graph, so the page loads no JavaScript at all.
  for (const entry of ["app.js", "author.js"]) {
    const source = fs.readFileSync(new URL(entry, root), "utf8");
    const imports = [...source.matchAll(/from\s+["']\.\/([A-Za-z0-9._/-]+)["']/g)].map((match) => match[1]);
    assert.ok(imports.length > 0, `expected ${entry} to have static local imports`);
    for (const specifier of imports) {
      assert.ok(isShipped(specifier), `${entry} statically imports "./${specifier}", which prepare-deploy.mjs does not ship`);
    }
  }
});

test("local reference material is never shipped", () => {
  // `local-reference/` holds promo art and vendor notes. It is git-ignored and
  // must stay out of the deploy manifest.
  for (const entry of publicFiles) {
    assert.ok(!entry.startsWith("local-reference"), `prepare-deploy.mjs must not ship "${entry}"`);
  }
  assert.match(fs.readFileSync(new URL(".gitignore", root), "utf8"), /^local-reference\/$/m);
});

test("assets referenced from the player icon set exist", () => {
  const appSource = fs.readFileSync(new URL("app.js", root), "utf8");
  const avatars = [...stripComments(appSource).matchAll(/["']\.\/(assets\/player-icons\/[A-Za-z0-9._-]+)["']/g)].map((match) => match[1]);
  assert.ok(avatars.length > 0, "expected app.js to reference player icon assets");
  for (const avatar of avatars) {
    assert.ok(fs.existsSync(new URL(avatar, root)), `app.js references "${avatar}", which is missing`);
  }
  assert.ok(publicFiles.includes("assets"), "prepare-deploy.mjs must ship the assets directory");
});

test("path handling is not accidentally OS-specific", () => {
  for (const entry of publicFiles) {
    assert.equal(entry, path.posix.normalize(entry), `manifest entry "${entry}" should be a normalized POSIX path`);
  }
});
