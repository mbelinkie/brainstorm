import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("presentation mode is a fixed no-scroll viewport", () => {
  assert.match(app, /is-presentation/);
  assert.match(styles, /body\.is-presentation\{[^}]*overflow:hidden/);
  assert.match(styles, /height:calc\(100dvh/);
});

test("music-note title logo remains present beside optional title artwork", () => {
  assert.match(app, /presentation-title-music-logo/);
  assert.match(app, /presentation-title-art-with-logo/);
  assert.match(styles, /presentation-title-art-with-logo \.presentation-title-music-logo/);
});

test("fullscreen control belongs to the hidden presenter corner, not Host view", () => {
  assert.match(app, /presentation-fullscreen-corner/);
  assert.match(app, /view === "presenter" && event\.key\.toLowerCase\(\) === "f"/);
  assert.doesNotMatch(app.match(/function hostUtilityControls\(\)[\s\S]*?\n\}/)?.[0] || "", /data-toggle-fullscreen/);
});

test("presentation cards expose question-type and side-media layout hooks", () => {
  assert.match(app, /presentation-card--\$\{escapeHtml\(state\.question\?\.type/);
  assert.match(app, /presentation-card--with-side-image/);
  assert.match(styles, /presentation-card--matching/);
  assert.match(styles, /presentation-card--categorize/);
  assert.match(styles, /presentation-card--with-side-image/);
});

test("presenter images fill their pane without duplicate captions", () => {
  assert.match(app, /\$\{presenter \? "" : "<figcaption>Answer reveal/);
  assert.match(styles, /presentation-card--with-side-image .*position:absolute.*object-fit:cover/);
  assert.match(styles, /presentation-card \.question-image figcaption.*display:none/);
  assert.match(styles, /presentation-card--with-reveal-image \.reveal-image img\{height:100%/);
});

test("next-question navigation follows the authored question ID, not a restored display count", () => {
  assert.match(app, /function questionPosition\(questionId = hostQuestion\?\.id\)/);
  assert.match(app, /const current = questionPosition\(\) \|\|/);
  assert.match(app, /hostQuizDefinition\?\.rounds\?\.\[roundIndex\]\?\.questions\?\.length/);
});

test("presenter timer is a prominent shared-screen control", () => {
  assert.match(styles, /presentation-round \.question-timer\{[^}]*min-width:clamp\(112px,13vw,190px\)[^}]*font-size:clamp\(30px,5\.6vh,68px\)/);
});
