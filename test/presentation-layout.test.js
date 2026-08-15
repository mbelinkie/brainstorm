import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const brand = fs.readFileSync(new URL("../kaplan-brand-layer.css", import.meta.url), "utf8");

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

test("opening presentation shows an icon-forward waiting-room roster without crowding names", () => {
  assert.match(app, /const visiblePlayers = state\.players\.slice\(0, 8\)/);
  assert.match(app, /player-logo--waiting-room/);
  assert.match(app, /presentation-waiting-more">and more!<\/p>/);
  assert.match(brand, /presentation-waiting-room/);
  assert.match(brand, /transform-origin: top/);
  assert.match(brand, /grid-template-columns: clamp\(52px, 6\.2vh, 74px\) minmax\(0, 1fr\)/);
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
  const imageRenderers = app.slice(app.indexOf("function revealImage"), app.indexOf("function answerReady"));
  assert.match(imageRenderers, /if \(!presenter/);
  assert.doesNotMatch(imageRenderers, /figcaption/);
  assert.match(styles, /presentation-card--with-side-image .*position:absolute.*object-fit:cover/);
  assert.match(styles, /presentation-card \.question-image figcaption.*display:none/);
  assert.match(styles, /presentation-card--with-reveal-image \.reveal-image img\{height:100%/);
});

test("image-selection answers keep their full-width album grid when reveal art is present", () => {
  assert.match(styles, /presentation-card--image_selection\.presentation-card--with-side-image>\.answer-grid\{grid-column:1\/-1;grid-row:3\}/);
  assert.match(styles, /presentation-card--with-side-image \.question-image,.+?z-index:1/);
});

test("next-question navigation follows the authored question ID, not a restored display count", () => {
  assert.match(app, /function questionPosition\(questionId = hostQuestion\?\.id\)/);
  assert.match(app, /const current = questionPosition\(\) \|\|/);
  assert.match(app, /hostQuizDefinition\?\.rounds\?\.\[roundIndex\]\?\.questions\?\.length/);
});

test("presenter timer is a prominent shared-screen control", () => {
  assert.match(styles, /presentation-round \.question-timer\{[^}]*min-width:clamp\(112px,13vw,190px\)[^}]*font-size:clamp\(30px,5\.6vh,68px\)/);
});

test("presentation reserves one title QR and uses a large corner QR with two-column intermission cards", () => {
  assert.match(app, /const isPresenterCornerQr = Boolean\(qrCanvas\.closest\("\.presenter-join-qr--corner"\)\)/);
  assert.match(app, /const width = isPresenterCornerQr \? 144 : 150/);
  assert.match(app, /function presentationCornerJoinQr\(\) \{[\s\S]*<span>\$\{escapeHtml\(roomCode\)\}<\/span>/);
  assert.match(app, /brandTopbar\(false, false, state\.presentationScreen === "title"\)/);
  assert.match(app, /return `<section class="presentation-card presentation-card--intermission">\$\{presentationLeaderboard\(\)\}<\/section>`/);
  assert.match(brand, /presentation-card--intermission \.presentation-leaderboard \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(brand, /presentation-card--intermission \.player-logo--presentation \{[^}]*width:min\(100%,150px\)/);
});

test("shared-screen labels have presentation-specific legibility floors", () => {
  assert.match(brand, /\.is-presentation \.eyebrow \{[^}]*font-size: clamp\(17px,2\.1vh,25px\)/);
  assert.match(brand, /\.is-presentation \.presenter-join-qr--corner \{[^}]*font-size: clamp\(18px,2\.2vh,25px\)/);
  assert.match(brand, /\.is-presentation \.presentation-leaderboard-heading > span \{[^}]*font-size: clamp\(17px,2vh,23px\)/);
  assert.match(brand, /\.is-presentation \.presentation-points small \{[^}]*font-size: clamp\(15px,1\.8vh,20px\)/);
  assert.match(brand, /presentation-card--matching \.drag-card,[\s\S]*font-size: clamp\(16px,1\.9vh,23px\)/);
});

test("final presentation removes duplicate headings and uses two columns when crowded", () => {
  const presenterRenderer = app.slice(app.indexOf("function renderPresenter"), app.indexOf("function playerScoreCards"));
  const finalCard = presenterRenderer.match(/state\.phase === "complete"[\s\S]*?: state\.phase === "lobby"/)?.[0] || "";
  assert.doesNotMatch(finalCard, /Final leaderboard<\/p><h2>Thanks for playing/);
  assert.match(finalCard, /presentationLeaderboard\(\{ final: true \}\)/);
  assert.match(brand, /presentation-card--final \.presentation-leaderboard:has\(> :nth-child\(5\)\)/);
});

test("the host runs a three-cue finale with a podium, winner confetti, and QR-free full standings", () => {
  assert.match(app, /async function startFinale\(\)/);
  assert.match(app, /presentationScreen: "final_suspense"/);
  assert.match(app, /async function revealFinalPodium\(\)/);
  assert.match(app, /presentationScreen = "final_podium"/);
  assert.match(app, /async function showFinalScores\(\)/);
  assert.match(app, /presentationScreen = "final_scores"/);
  assert.match(app, /function finalPodiumCard\(\)/);
  assert.match(app, /function finalScoreTitlePage\(\)/);
  assert.match(app, /function playerFinale\(\)/);
  assert.match(app, /isWinner \? confettiMarkup\(34\)/);
  assert.match(app, /const cornerJoinQr = isFullscreenFinale \? ""/);
  assert.match(styles, /presentation-final-score-list/);
  assert.match(styles, /podium-place--1/);
});

test("finale drumroll and closing music are host-authored presentation cues", () => {
  assert.match(app, /cueFinaleAudio\("drumroll"\)/);
  assert.match(app, /cueFinaleAudio\("outro"\)/);
  assert.match(app, /command\?\.audioScope === "finale"/);
});
