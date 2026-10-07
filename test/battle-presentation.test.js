import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { presentationBattleMarkup, presentationBattleScene } from "../battle-presentation.js";
import { publicBattleResult } from "../battle-vote.js";

// Issue #33: Presentation shows the current matchup side by side during
// battle_vote, then vote bars and the creator reveal during battle_result. It
// is a strict projection of broadcast state and never shows an image in any
// other phase. app.js renders presentationBattleMarkup() verbatim.

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
const M = "m0000000-0000-4000-8000-000000000000";
const A1 = "a1000000-0000-4000-8000-000000000000", A2 = "a2000000-0000-4000-8000-000000000000";
const ballot = { matchupId: M, matchupIndex: 1, promptText: "Draw a <cat>", entries: [{ entryId: "e1", assetId: A1 }, { entryId: "e2", assetId: A2 }] };
const result = publicBattleResult({
  matchupId: M, matchupIndex: 1, outcome: "winner", promptText: "Draw a <cat>", votesCast: 4,
  entries: [
    { entryId: "e1", assetId: A1, votes: 3, viable: true, winner: true, playerName: "Priya Nair", logoKey: "spark" },
    { entryId: "e2", assetId: A2, votes: 1, viable: true, winner: false, playerName: "Sam Okafor", logoKey: "wave" },
  ],
});
const render = (input) => presentationBattleMarkup(presentationBattleScene({ matchupIndex: 1, matchupCount: 3, ...input }), escapeHtml, { roundTitle: "Battle of the Brains", logo: (entry) => `<span class="logo">${entry.logoKey}</span>` });

test("no image outside battle_vote and battle_result", () => {
  const imageless = [
    { phase: "battle_review", battleVote: ballot, battleResult: result },
    { phase: "battle_vote", battleVote: null },
    { phase: "battle_vote", battleVote: { ...ballot, matchupIndex: 0 } },
    { phase: "battle_result", battleResult: null },
    { phase: "battle_result", battleResult: { ...result, outcome: "skipped", entries: [] } },
    { phase: "battle_prompt", battleVote: ballot, battleResult: result },
    { phase: "lobby", battleVote: ballot, battleResult: result },
  ];
  for (const input of imageless) {
    const markup = render(input);
    assert.doesNotMatch(markup, /<img/, `${input.phase}: ${markup.slice(0, 80)}`);
    assert.ok(!markup.includes(A1) && !markup.includes(A2), `${input.phase} carries no asset ID`);
  }
  assert.equal(render({ phase: "battle_prompt", battleVote: ballot }), "", "battle_prompt is presenterBattlePrompt's, not this module's");
});

test("battle_vote shows the prompt and the images side by side, unlabelled except A/B, preloaded hidden", () => {
  const markup = render({ phase: "battle_vote", battleVote: ballot });
  assert.match(markup, /Prompt Battle · Matchup 2 of 3/);
  assert.match(markup, /<h2 class="presentation-battle-prompt">Draw a &lt;cat&gt;<\/h2>/);
  assert.equal([...markup.matchAll(/<img /g)].length, 2);
  assert.match(markup, new RegExp(`data-battle-stage-image="${A1}" alt="Image A"`));
  assert.match(markup, new RegExp(`data-battle-stage-image="${A2}" alt="Image B"`));
  assert.ok(!/ src=/.test(markup), "images are filled in by app.js through the media proxy");
  assert.match(markup, /data-battle-stage aria-busy="true"/, "starts hidden until every image has loaded");
  assert.match(markup, /Vote on your phone/);
  for (const forbidden of ["Priya", "Sam", "vote" + "s", "presentation-battle-bar"]) assert.ok(!markup.includes(forbidden), forbidden);
});

test("battle_result reveals creators, counts and bars exactly as broadcast", () => {
  const markup = render({ phase: "battle_result", battleResult: result });
  assert.match(markup, /The winner is…/);
  assert.match(markup, /Priya Nair<\/strong>/);
  assert.match(markup, /Sam Okafor<\/strong>/);
  assert.match(markup, /--share:75%[\s\S]*3 votes/);
  assert.match(markup, /--share:25%[\s\S]*1 vote</);
  assert.equal([...markup.matchAll(/is-winner/g)].length, 1);
  assert.match(markup, /<span class="logo">spark<\/span>/);
});

test("Presentation computes no result: winners and counts come from the broadcast", () => {
  // A broadcast whose winner is not the vote leader is drawn as broadcast.
  const odd = { ...result, outcome: "tie", entries: result.entries.map((entry) => ({ ...entry, winner: true })) };
  const markup = render({ phase: "battle_result", battleResult: odd });
  assert.match(markup, /It's a tie!/);
  assert.equal([...markup.matchAll(/is-winner/g)].length, 2);
  const noVotes = render({ phase: "battle_result", battleResult: { ...result, votesCast: 0, entries: result.entries.map((entry) => ({ ...entry, votes: 0 })) } });
  assert.match(noVotes, /--share:0%/);
  assert.match(render({ phase: "battle_result", battleResult: { ...result, outcome: "default" } }), /Winner by default/);
  assert.match(render({ phase: "battle_result", battleResult: { ...result, outcome: "skipped", entries: [] } }), /Matchup skipped/);
});

test("review and waiting screens", () => {
  assert.match(render({ phase: "battle_review" }), /Battle of the Brains[\s\S]*checking the entries/);
  assert.doesNotMatch(render({ phase: "battle_review" }), /Matchup/, "no matchup position while judging");
  assert.match(render({ phase: "battle_vote", battleVote: null }), /Next matchup/);
  assert.match(render({ phase: "battle_result", battleResult: null }), /Counting the votes/);
});

// --- app.js wiring ---------------------------------------------------------

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const fn = (name) => { const start = app.indexOf(`function ${name}(`); assert.ok(start >= 0, name); return app.slice(start, app.indexOf("\n}\n", start) + 2); };

test("renderPresenter sends every battle phase to its battle scene, never the question card", () => {
  const presenter = fn("renderPresenter");
  const battle = presenter.indexOf('["battle_review", "battle_vote", "battle_result"].includes(state.phase)');
  const questionCard = presenter.indexOf("presentation-card--question");
  assert.ok(battle > 0 && battle < questionCard, "battle phases are routed before the question card");
  assert.match(presenter, /revealPresentationBattleStage\(\);/);
});

test("the battle scene renders only from broadcast state", () => {
  const stage = fn("presenterBattleStage");
  assert.match(stage, /battleVote: state\.battleVote/);
  assert.match(stage, /battleResult: state\.battleResult/);
  assert.doesNotMatch(stage, /battleRoundPanel|battleTestPanel|roomApi|hostSecret|getHostBattleState|resolve/);
  const reveal = fn("revealPresentationBattleStage");
  assert.doesNotMatch(reveal, /roomApi|battleRoundPanel/);
  assert.match(reveal, /battleVariantImageUrl\(image\.dataset\.battleStageImage\)/);
  assert.match(fn("battleVariantImageUrl"), /\.\.\.battleMediaCredential\(\)/);
  assert.match(fn("battleMediaCredential"), /\["host", "presenter"\]\.includes\(view\) \? getHostSecret\(\)/, "Presentation fetches media with the host secret");
  assert.match(fs.readFileSync(new URL("../prepare-deploy.mjs", import.meta.url), "utf8"), /"battle-presentation\.js"/);
});
