import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_PRESENTER_CREDIT, resolvePresenterCredit } from "../quiz-core.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const author = fs.readFileSync(new URL("../author.js", import.meta.url), "utf8");
const validation = fs.readFileSync(new URL("../quiz-validation.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const core = fs.readFileSync(new URL("../quiz-core.js", import.meta.url), "utf8");

// --- Resolution rules (the actual behavior, not a source match) -------------

test("a non-empty host override wins over the quiz file's credit line", () => {
  assert.equal(resolvePresenterCredit("Acme Corp Offsite", "ADO&S PRESENTS"), "Acme Corp Offsite");
  // Surrounding whitespace is a typing artifact, not intent.
  assert.equal(resolvePresenterCredit("  Acme Corp Offsite  ", "ADO&S PRESENTS"), "Acme Corp Offsite");
});

test("an empty or whitespace-only override falls back to the quiz file's value", () => {
  assert.equal(resolvePresenterCredit("", "ADO&S PRESENTS"), "ADO&S PRESENTS");
  assert.equal(resolvePresenterCredit("   ", "ADO&S PRESENTS"), "ADO&S PRESENTS");
  assert.equal(resolvePresenterCredit(undefined, "ADO&S PRESENTS"), "ADO&S PRESENTS");
  assert.equal(resolvePresenterCredit(null, "ADO&S PRESENTS"), "ADO&S PRESENTS");
});

test("clearing the override restores the authored credit rather than blanking it", () => {
  const authored = "ADO&S PRESENTS";
  const withOverride = resolvePresenterCredit("Tuesday Night Crowd", authored);
  const afterClearing = resolvePresenterCredit("", authored);
  assert.equal(withOverride, "Tuesday Night Crowd");
  assert.equal(afterClearing, authored);
  assert.notEqual(afterClearing, "");
});

test("a quiz that authored no presenter still gets the default, and one that authored an empty string still hides the line", () => {
  assert.equal(resolvePresenterCredit("", undefined), DEFAULT_PRESENTER_CREDIT);
  // `??` not `||`: an explicit empty string is how a quiz opts out entirely.
  assert.equal(resolvePresenterCredit("", ""), "");
  // ...but an override still wins over that deliberate opt-out.
  assert.equal(resolvePresenterCredit("One Night Only", ""), "One Night Only");
});

// --- The override reaches the presentation screen ---------------------------

test("the override travels to the presentation screen in the broadcast room state", () => {
  // publicRoomState() is the only payload the presenter and players receive.
  const roomState = app.match(/function publicRoomState\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(roomState, /presenterOverride: state\.presenterOverride \|\| ""/);
});

test("both the opening and closing title cards resolve the override against the quiz file", () => {
  const opening = app.match(/function presentationTitlePage\(\)[\s\S]*?\n}\n/)?.[0] || "";
  const closing = app.match(/function finalScoreTitlePage\(\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.match(opening, /resolvePresenterCredit\(state\.presenterOverride, titlePage\.presenter\)/);
  assert.match(closing, /resolvePresenterCredit\(state\.presenterOverride, titlePage\.presenter\)/);
});

test("a changed override redraws the presentation screen instead of being filtered out", () => {
  // presenterRenderKey strips only the non-visual fields; anything it does not
  // destructure away stays in the key, so the shared screen repaints on change.
  const renderKey = core.match(/function presenterRenderKey\(roomState\)[\s\S]*?\n}\n/)?.[0] || "";
  assert.notEqual(renderKey, "");
  assert.doesNotMatch(renderKey, /presenterOverride/);
});

test("the host screen carries an editable override input wired to state and the broadcast", () => {
  assert.match(app, /data-presenter-override/);
  assert.match(app, /function presenterOverrideControl\(\)/);
  // hostUtilityControls() renders on every host screen, so the credit line is
  // reachable at the opening title page and again before the closing card.
  assert.match(app, /function hostUtilityControls\(\)[\s\S]*?\$\{presenterOverrideControl\(\)\}/);
  const handler = app.match(/const presenterOverrideInput = document\.querySelector\("\[data-presenter-override\]"\);[\s\S]*?\n  }\n/)?.[0] || "";
  assert.match(handler, /state\.presenterOverride = presenterOverrideInput\.value/);
  assert.match(handler, /addEventListener\("input"/);
  assert.match(handler, /emit\(\)/);
  assert.match(handler, /persistHostState\(\)/);
  assert.match(styles, /\.host-presenter-override/);
});

test("typing in the override never re-renders the host panel out from under the caret", () => {
  // The input handler mirrors the audio-volume control: state + emit only.
  // A render() here would replace the host panel's innerHTML mid-keystroke.
  const handler = app.match(/const presenterOverrideInput = document\.querySelector\("\[data-presenter-override\]"\);[\s\S]*?\n  }\n/)?.[0] || "";
  assert.notEqual(handler, "");
  assert.doesNotMatch(handler, /\brender\(\)/);
});

// --- The override is per-session, never written back to the quiz ------------

test("the override is never persisted into the quiz definition", () => {
  // It is session state, not authored content: the quiz editor, the quiz
  // schema, and the in-memory quiz definition all stay unaware of it.
  assert.doesNotMatch(author, /presenterOverride/);
  assert.doesNotMatch(validation, /presenterOverride/);
  assert.doesNotMatch(app, /hostQuizDefinition[^\n]*\.presenter\s*=/);
  assert.doesNotMatch(app, /titlePage\.presenter\s*=[^=]/);
});

test("the authored presenter field remains the quiz file's own validated property", () => {
  // Unchanged authoring contract: the editor still writes titlePage.presenter
  // and validation still bounds it, so existing quiz files keep working.
  assert.match(author, /data-title-field="presenter"/);
  assert.match(validation, /candidate\.titlePage\?\.presenter/);
});
