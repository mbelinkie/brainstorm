import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The image suggestion assistant (author-only Wikimedia Commons / Google Images
// research tool) was removed from both the main authoring screen and the
// per-image "Find image" control. These assertions fail if any part of that
// feature's UI, wiring, or backend route reappears.

const authorHtml = fs.readFileSync(new URL("../author.html", import.meta.url), "utf8");
const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../cloudflare-worker.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("the main authoring screen has no image suggestion assistant panel", () => {
  assert.doesNotMatch(authorHtml, /media-assistant/);
  assert.doesNotMatch(authorHtml, /Image suggestion assistant/);
  assert.doesNotMatch(authorHtml, /id="suggest-images"/);
  assert.doesNotMatch(authorHtml, /id="image-draft-mode"/);
});

test("the per-image upload interface has no image finder dialog or trigger", () => {
  assert.doesNotMatch(authorHtml, /id="image-finder"/);
  assert.doesNotMatch(authorHtml, /Find an image/);
  assert.doesNotMatch(author, /data-find-image/);
  assert.doesNotMatch(author, /Find image/);
});

test("author.js no longer wires up image-suggestion search or approval", () => {
  assert.doesNotMatch(author, /openImageFinder/);
  assert.doesNotMatch(author, /findImageIdeas/);
  assert.doesNotMatch(author, /approveSuggestedImage/);
  assert.doesNotMatch(author, /draftImageSearch/);
  assert.doesNotMatch(author, /IMAGE_SEARCH_DRAFT_KEY/);
});

test("the media-assistant search route no longer exists on the Worker, local proxy, or asset routing", () => {
  assert.doesNotMatch(worker, /\/media-assistant\/search/);
  assert.doesNotMatch(server, /\/media-assistant\/search/);
  assert.doesNotMatch(config, /media-assistant/);
});

test("other image-menu actions (paste, upload) remain available on every image slot", () => {
  assert.match(author, /data-paste-image="\$\{escapeHtml\(target\)\}"/);
  assert.match(author, /Upload image\$\{uploadInput\}/);
});
