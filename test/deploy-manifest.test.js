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
        // `generatedArtifacts` already excused this reference from the two
        // checks above; excusing it here too is what lets a clean checkout be
        // green before `npm run build:video` has ever run.
        generatedArtifacts.has(reference) || fs.existsSync(new URL(reference, root)),
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

test("raw source media is never shipped", () => {
  // Same guarantee as `local-reference/`, for the invariant that matters more:
  // original filenames name the tracks, so shipping them would reveal answers.
  for (const entry of publicFiles) {
    assert.ok(!entry.startsWith("music quiz originals"), `prepare-deploy.mjs must not ship "${entry}"`);
  }
  assert.match(fs.readFileSync(new URL(".gitignore", root), "utf8"), /^music quiz originals\/$/m);
});

test("no shipped file carries a secret", () => {
  // `config.js` is publishable by design and holds a Supabase *publishable*
  // key; a service-role key or secret key in anything the browser downloads is
  // a critical defect. This scans what actually ships, so it also covers a key
  // pasted into a quiz definition, a CSS comment, or an SVG.
  const secretPatterns = [
    [/service_role/i, "a service_role reference"],
    [/SUPABASE_SECRET_KEY/i, "a SUPABASE_SECRET_KEY reference"],
    [/\bsb_secret_[A-Za-z0-9_-]+/, "a Supabase secret key"],
    // A signed JWT: three base64url segments. Supabase's legacy anon and
    // service-role keys both take this shape, and neither belongs in a
    // shipped file now that publishable keys exist.
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a JWT-shaped credential"]
  ];
  const scannable = /\.(js|mjs|html|css|json|svg|txt|md)$/i;

  function scan(relativePath) {
    const target = new URL(relativePath, root);
    if (fs.statSync(target).isDirectory()) {
      for (const child of fs.readdirSync(target)) scan(`${relativePath}/${child}`);
      return;
    }
    if (!scannable.test(relativePath)) return;
    const source = fs.readFileSync(target, "utf8");
    for (const [pattern, description] of secretPatterns) {
      assert.doesNotMatch(source, pattern, `prepare-deploy.mjs ships "${relativePath}", which contains ${description}`);
    }
  }

  let scanned = 0;
  for (const entry of publicFiles) {
    if (generatedArtifacts.has(entry)) continue;
    scan(entry);
    scanned += 1;
  }
  assert.ok(scanned > 0, "expected to scan at least one shipped file");
  // Guard against the scan quietly passing because the patterns stopped
  // matching anything: they must still fire on a known-bad sample.
  const sample = 'const key = "sb_secret_AAAAAAAAAA"; // service_role, SUPABASE_SECRET_KEY, eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWEifQ.c2lnbmF0dXJl';
  for (const [pattern, description] of secretPatterns) {
    assert.match(sample, pattern, `the pattern for ${description} no longer matches a known-bad sample`);
  }
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
