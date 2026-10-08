// Issue #18: the host picks the effective Prompt Battle image engine from a
// menu, tests it, and sees the cost before the round starts.
//
// Contract (docs/roadmap, issue #18):
//   - the current static menu (BATTLE_TEST_MODELS) mirrors the Worker's
//     Workers AI entries and intersects them with the battle round's
//     permittedModels; OpenRouter options come from the Worker catalogue
//     until the browser adopts it in #92;
//   - selecting an engine calls the existing set_battle_engine RPC;
//   - the saved choice is read back after a host refresh;
//   - the Test button uses that same selection and shows an image and its
//     cost, with loading, failure and success visibly distinct.
//
// app.js cannot be imported under node, so the pure logic lives in
// quiz-core.js and is called directly, and the app.js functions are lifted
// out of its source and run against stubs (as in standings-consistency.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { battleEngineMenu, battleEngineSelection, battleTestStatus, isBattleRound } from "../quiz-core.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../cloudflare-worker.js", import.meta.url), "utf8");

const SCHNELL = "@cf/black-forest-labs/flux-1-schnell";
const KLEIN_4B = "@cf/black-forest-labs/flux-2-klein-4b";
const KLEIN_9B = "@cf/black-forest-labs/flux-2-klein-9b";
const LUCID = "@cf/leonardo/lucid-origin";

const allowlist = [
  { provider: "workers_ai", value: SCHNELL, label: "Flux Schnell" },
  { provider: "workers_ai", value: KLEIN_4B, label: "Flux 2 Klein 4B" },
  { provider: "workers_ai", value: LUCID, label: "Lucid Origin" }
];

const battleRound = (permittedModels, defaultModel = permittedModels[0]) => ({
  id: "r-battle", type: "prompt_battle", title: "Battle",
  engine: { defaultProvider: "workers_ai", defaultModel, permittedModels }
});
const quizRound = { id: "r-quiz", title: "Quiz", questions: [] };

function lift(names, scope = {}, constants = []) {
  const sources = names.map((name) => {
    const start = app.indexOf(`\nfunction ${name}(`) >= 0 ? app.indexOf(`\nfunction ${name}(`) : app.indexOf(`\nasync function ${name}(`);
    assert.notEqual(start, -1, `${name} not found in app.js — did it get renamed?`);
    const end = app.indexOf("\n}\n", start);
    assert.notEqual(end, -1, `could not find the end of ${name} in app.js`);
    return app.slice(start + 1, end + 3);
  });
  // Constants are lifted from the real source so the test sees the real list.
  const constantSources = constants.map((name) => {
    const start = app.indexOf(`\nconst ${name} = `);
    assert.notEqual(start, -1, `${name} not found in app.js`);
    const end = app.indexOf("\n];\n", start);
    assert.notEqual(end, -1, `could not find the end of ${name} in app.js`);
    return app.slice(start + 1, end + 4);
  });
  const keys = Object.keys(scope);
  const factory = new Function(...keys, `${constantSources.join("\n")}\n${sources.join("\n")}\nreturn { ${[...constants, ...names].join(", ")} };`);
  return factory(...keys.map((key) => scope[key]));
}

// ---- pure menu logic (quiz-core.js) --------------------------------------

test("the menu is the allowlist intersected with the round's permittedModels", () => {
  const menu = battleEngineMenu(allowlist, [battleRound([SCHNELL, LUCID])]);
  assert.deepEqual(menu.map((entry) => entry.value), [SCHNELL, LUCID]);
});

test("a permitted model outside the allowlist does not appear", () => {
  const menu = battleEngineMenu(allowlist, [battleRound([SCHNELL, "someone/else-image-model"])]);
  assert.deepEqual(menu.map((entry) => entry.value), [SCHNELL]);
});

test("an allowlisted model outside permittedModels does not appear", () => {
  const menu = battleEngineMenu(allowlist, [battleRound([KLEIN_4B])]);
  assert.deepEqual(menu.map((entry) => entry.value), [KLEIN_4B]);
  assert.equal(menu.some((entry) => entry.value === SCHNELL), false);
  assert.equal(menu.some((entry) => entry.value === LUCID), false);
});

test("with several battle rounds a model must be permitted by every one (set_battle_engine's rule)", () => {
  const menu = battleEngineMenu(allowlist, [battleRound([SCHNELL, LUCID]), quizRound, battleRound([LUCID, KLEIN_4B])]);
  assert.deepEqual(menu.map((entry) => entry.value), [LUCID]);
});

test("a quiz with no battle round has an empty menu", () => {
  assert.deepEqual(battleEngineMenu(allowlist, [quizRound]), []);
  assert.deepEqual(battleEngineMenu(allowlist, undefined), []);
  assert.deepEqual(battleEngineMenu(undefined, [battleRound([SCHNELL])]), []);
});

test("adding an allowlist entry later makes it appear with no other change (kaplan_proxy, issue #21)", () => {
  const permitted = [SCHNELL, "kaplan/proxy-model"];
  assert.deepEqual(battleEngineMenu(allowlist, [battleRound(permitted)]).map((entry) => entry.value), [SCHNELL]);
  const extended = [...allowlist, { provider: "kaplan_proxy", value: "kaplan/proxy-model", label: "Kaplan proxy" }];
  const menu = battleEngineMenu(extended, [battleRound(permitted)]);
  assert.deepEqual(menu.map((entry) => `${entry.provider}:${entry.value}`), [`workers_ai:${SCHNELL}`, "kaplan_proxy:kaplan/proxy-model"]);
});

test("the selection keeps a model that is on the menu, else the round default, else the first entry", () => {
  const rounds = [battleRound([SCHNELL, LUCID], LUCID)];
  const menu = battleEngineMenu(allowlist, rounds);
  assert.equal(battleEngineSelection(menu, SCHNELL, rounds), SCHNELL);
  assert.equal(battleEngineSelection(menu, KLEIN_4B, rounds), LUCID, "an off-menu model falls back to the round's default");
  assert.equal(battleEngineSelection(menu, null, rounds), LUCID);
  assert.equal(battleEngineSelection(menu, null, [battleRound([SCHNELL, LUCID], "unlisted/default")]), SCHNELL, "an off-menu default falls back to the first entry");
  assert.equal(battleEngineSelection([], SCHNELL, rounds), "");
});

test("the test status separates loading, failure, success and idle", () => {
  const image = { mimeType: "image/png", bytesBase64: "AAAA" };
  assert.equal(battleTestStatus({ busy: false, error: "", result: null }), "idle");
  assert.equal(battleTestStatus({ busy: true, error: "", result: null }), "loading");
  assert.equal(battleTestStatus({ busy: true, error: "old", result: { images: [image] } }), "loading");
  assert.equal(battleTestStatus({ busy: false, error: "Could not reach the image generator.", result: null }), "failure");
  assert.equal(battleTestStatus({ busy: false, error: "", result: { images: [], blocked: true } }), "failure");
  assert.equal(battleTestStatus({ busy: false, error: "", result: { images: [] } }), "failure");
  assert.equal(battleTestStatus({ busy: false, error: "", result: { images: [image], costUsd: 0.004 } }), "success");
});

// ---- the static Workers AI allowlist mirror -------------------------------

test("BATTLE_TEST_MODELS strictly mirrors the Worker allowlist's Workers AI entries", () => {
  const { BATTLE_TEST_MODELS } = lift([], {}, ["BATTLE_TEST_MODELS"]);
  const workerBlock = worker.slice(worker.indexOf("const BATTLE_MODEL_ALLOWLIST = {"));
  const workerEntries = [...workerBlock.slice(0, workerBlock.indexOf("};")).matchAll(/"([^"]+)":\s*\{\s*provider:\s*"([^"]+)"/g)].map((match) => `${match[2]}:${match[1]}`);
  assert.ok(workerEntries.length > 0, "could not read the Worker allowlist");
  const workerAiEntries = workerEntries.filter((entry) => entry.startsWith("workers_ai:"));
  assert.deepEqual(BATTLE_TEST_MODELS.map((entry) => `${entry.provider}:${entry.value}`), workerAiEntries);
  assert.equal(BATTLE_TEST_MODELS.some((entry) => entry.provider === "openrouter"), false, "the browser menu remains on its current Workers AI choices until #92 consumes the host-authenticated catalogue");
});

// ---- app.js wiring, lifted and run against stubs ---------------------------

// battleTestPanel is mutated in place in app.js; the lifted functions share
// one object through the stub scope.
function withPanel(overrides = {}) {
  return { model: SCHNELL, prompt: "p", busy: false, error: "", result: null, engineBusy: false, engineError: "", savedModel: null, ...overrides };
}

function build(options = {}) {
  const battleTestPanel = withPanel(options.panel);
  const env = (() => {
    const calls = { setBattleEngine: [], getHostBattleState: [], renders: 0 };
    const scope = {
      view: options.view || "host",
      roomCode: "ABC123",
      getHostSecret: () => (options.noSecret ? "" : "secret"),
      hostQuizDefinition: { rounds: options.rounds || [battleRound([SCHNELL, KLEIN_4B])] },
      battleTestPanel,
      battleEngineMenu,
      isBattleRound,
      battleEngineSelection,
      battleTestStatus,
      escapeHtml: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      render: () => { calls.renders += 1; },
      roomApi: {
        setBattleEngine: async (args) => { calls.setBattleEngine.push(args); if (options.setBattleEngine) return options.setBattleEngine(args); return { roomCode: args.roomCode, provider: args.provider, model: args.model }; },
        getHostBattleState: async (args) => { calls.getHostBattleState.push(args); if (options.getHostBattleState) return options.getHostBattleState(args); return { engine: options.savedEngine ?? { provider: null, model: null } }; }
      }
    };
    const lifted = lift(
      ["battleEngineMenuEntries", "effectiveBattleModel", "selectBattleEngine", "loadSavedBattleEngine", "battleTestStatusMarkup", "battleTestImagePanel"],
      scope,
      ["BATTLE_TEST_MODELS"]
    );
    return { calls, scope, lifted };
  })();
  return { battleTestPanel, ...env };
}

test("app.js builds the host menu from BATTLE_TEST_MODELS and the quiz's battle rounds", () => {
  const { lifted } = build({ rounds: [quizRound, battleRound([KLEIN_4B, "not/in-the-allowlist"])] });
  assert.deepEqual(lifted.battleEngineMenuEntries().map((entry) => entry.value), [KLEIN_4B]);
});

test("selecting an engine calls set_battle_engine with the allowlist entry's provider and model", async () => {
  const { lifted, calls, battleTestPanel } = build();
  await lifted.selectBattleEngine(KLEIN_4B);
  assert.equal(calls.setBattleEngine.length, 1);
  assert.deepEqual(calls.setBattleEngine[0], { roomCode: "ABC123", hostSecret: "secret", provider: "workers_ai", model: KLEIN_4B });
  assert.equal(battleTestPanel.model, KLEIN_4B);
  assert.equal(battleTestPanel.savedModel, KLEIN_4B);
  assert.equal(battleTestPanel.engineBusy, false);
  assert.equal(battleTestPanel.engineError, "");
});

test("a model that is not on the menu is never sent to set_battle_engine", async () => {
  const { lifted, calls, battleTestPanel } = build({ rounds: [battleRound([SCHNELL])] });
  await lifted.selectBattleEngine(KLEIN_4B); // allowlisted, not permitted by the round
  await lifted.selectBattleEngine("typed/by-the-host"); // not allowlisted
  assert.equal(calls.setBattleEngine.length, 0);
  assert.equal(battleTestPanel.model, SCHNELL);
});

test("a failed save keeps the previous selection and says so", async () => {
  const { lifted, battleTestPanel } = build({ setBattleEngine: async () => { throw new Error("That model is not permitted by this quiz"); } });
  await lifted.selectBattleEngine(KLEIN_4B);
  assert.equal(battleTestPanel.model, SCHNELL, "the menu must not show an engine the server did not accept");
  assert.equal(battleTestPanel.engineError, "That model is not permitted by this quiz");
  assert.equal(battleTestPanel.engineBusy, false);
});

test("changing the engine drops the previous test result, which belonged to the old model", async () => {
  const { lifted, battleTestPanel } = build({ panel: { result: { images: [{ mimeType: "image/png", bytesBase64: "AAAA" }], costUsd: 0.01 }, error: "stale" } });
  await lifted.selectBattleEngine(KLEIN_4B);
  assert.equal(battleTestPanel.result, null);
  assert.equal(battleTestPanel.error, "");
});

test("the engine call is host-only and needs host authorization", async () => {
  const noSecret = build({ noSecret: true });
  await noSecret.lifted.selectBattleEngine(KLEIN_4B);
  assert.equal(noSecret.calls.setBattleEngine.length, 0);
  assert.match(noSecret.battleTestPanel.engineError, /authorization/i);
  const player = build({ view: "player" });
  await player.lifted.selectBattleEngine(KLEIN_4B);
  assert.equal(player.calls.setBattleEngine.length, 0);
});

test("after a refresh the saved engine is read back from session state and shown selected", async () => {
  const { lifted, calls, battleTestPanel } = build({ savedEngine: { provider: "workers_ai", model: KLEIN_4B } });
  await lifted.loadSavedBattleEngine();
  assert.deepEqual(calls.getHostBattleState, [{ roomCode: "ABC123", hostSecret: "secret" }]);
  assert.equal(battleTestPanel.model, KLEIN_4B);
  assert.equal(battleTestPanel.savedModel, KLEIN_4B);
  assert.match(lifted.battleTestImagePanel(), new RegExp(`<option value="${KLEIN_4B}" selected>`));
});

test("a saved-engine read started before a successful selection cannot overwrite it", async () => {
  let resolveRead;
  const read = new Promise((resolve) => { resolveRead = resolve; });
  const { lifted, battleTestPanel } = build({ getHostBattleState: () => read });

  const pendingRead = lifted.loadSavedBattleEngine();
  await lifted.selectBattleEngine(KLEIN_4B);
  resolveRead({ engine: { provider: "workers_ai", model: SCHNELL } });
  await pendingRead;

  assert.equal(battleTestPanel.model, KLEIN_4B);
  assert.equal(battleTestPanel.savedModel, KLEIN_4B);
  assert.equal(battleTestPanel.engineError, "");
});

test("a failed saved-engine read started before a successful selection cannot overwrite it", async () => {
  let rejectRead;
  const read = new Promise((_, reject) => { rejectRead = reject; });
  const { lifted, battleTestPanel } = build({ getHostBattleState: () => read });

  const pendingRead = lifted.loadSavedBattleEngine();
  await lifted.selectBattleEngine(KLEIN_4B);
  rejectRead(new Error("stale read failure"));
  await pendingRead;

  assert.equal(battleTestPanel.model, KLEIN_4B);
  assert.equal(battleTestPanel.savedModel, KLEIN_4B);
  assert.equal(battleTestPanel.engineError, "");
});

test("with nothing saved yet the round's default is shown and nothing is claimed as saved", async () => {
  const { lifted, battleTestPanel } = build({ rounds: [battleRound([SCHNELL, KLEIN_4B], KLEIN_4B)], panel: { model: SCHNELL }, savedEngine: { provider: null, model: null } });
  await lifted.loadSavedBattleEngine();
  assert.equal(battleTestPanel.model, KLEIN_4B);
  assert.equal(battleTestPanel.savedModel, null);
});

test("a saved engine the menu no longer offers is not selected", async () => {
  const { lifted, battleTestPanel } = build({ rounds: [battleRound([SCHNELL])], savedEngine: { provider: "workers_ai", model: KLEIN_4B } });
  await lifted.loadSavedBattleEngine();
  assert.equal(battleTestPanel.model, SCHNELL);
});

test("saved-engine reads skip non-host and non-battle views; failure shows the authored default", async () => {
  const noBattle = build({ rounds: [quizRound] });
  await noBattle.lifted.loadSavedBattleEngine();
  assert.equal(noBattle.calls.getHostBattleState.length, 0);
  const player = build({ view: "player" });
  await player.lifted.loadSavedBattleEngine();
  assert.equal(player.calls.getHostBattleState.length, 0);
  const failing = build({ rounds: [battleRound([SCHNELL, KLEIN_4B], KLEIN_4B)], panel: { model: SCHNELL }, getHostBattleState: async () => { throw new Error("offline"); } });
  await failing.lifted.loadSavedBattleEngine();
  assert.equal(failing.battleTestPanel.model, KLEIN_4B);
  assert.equal(failing.battleTestPanel.savedModel, null);
  assert.match(failing.battleTestPanel.engineError, /saved engine/i);
});

test("the panel menu lists only permitted engines, as a <select>", () => {
  const { lifted } = build({ rounds: [battleRound([SCHNELL, LUCID, "not/in-the-allowlist"])] });
  const html = lifted.battleTestImagePanel();
  assert.match(html, /<select data-battle-test-model/);
  const options = [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(options, [SCHNELL, LUCID]);
  assert.doesNotMatch(html, /<input[^>]*data-battle-test-model/);
});

test("the panel has no menu and no Test button when no engine is permitted, and nothing without a battle round", () => {
  const none = build({ rounds: [battleRound(["not/in-the-allowlist"])] }).lifted.battleTestImagePanel();
  assert.doesNotMatch(none, /<select|data-battle-test-generate/);
  assert.match(none, /No permitted engine/);
  assert.equal(build({ rounds: [quizRound] }).lifted.battleTestImagePanel(), "");
});

test("an engine save in flight disables the menu and Test, and a save error shows", () => {
  const saving = build({ panel: { engineBusy: true } }).lifted.battleTestImagePanel();
  assert.match(saving, /<select data-battle-test-model[^>]*disabled/);
  assert.match(saving, /data-battle-test-generate[^>]*disabled/);
  const failed = build({ panel: { engineError: "Could not save the engine." } }).lifted.battleTestImagePanel();
  assert.match(failed, /role="alert"[^>]*>Could not save the engine\./);
});

test("loading, failure and success render distinctly, and only success shows the image and its cost", () => {
  const image = { mimeType: "image/png", bytesBase64: "QUJD" };
  const loading = build({ panel: { busy: true } }).lifted.battleTestImagePanel();
  const failure = build({ panel: { error: "Could not reach the image generator." } }).lifted.battleTestImagePanel();
  const success = build({ panel: { result: { images: [image, image], costUsd: 0.008 } } }).lifted.battleTestImagePanel();
  const idle = build().lifted.battleTestImagePanel();

  assert.match(loading, /battle-test-state--loading/);
  assert.match(failure, /battle-test-state--failure/);
  assert.match(success, /battle-test-state--success/);
  assert.doesNotMatch(idle, /battle-test-state/);

  for (const [name, html, own] of [["loading", loading, "loading"], ["failure", failure, "failure"], ["success", success, "success"]]) {
    for (const other of ["loading", "failure", "success"]) {
      if (other !== own) assert.doesNotMatch(html, new RegExp(`battle-test-state--${other}`), `${name} must not carry the ${other} style`);
    }
  }

  assert.match(loading, /Generating/);
  assert.doesNotMatch(loading, /<img|Reported cost/);
  assert.match(failure, /role="alert"/);
  assert.match(failure, /Could not reach the image generator\./);
  assert.doesNotMatch(failure, /<img|Reported cost/);
  assert.equal((success.match(/<img class="battle-test-image"/g) || []).length, 2);
  assert.match(success, /src="data:image\/png;base64,QUJD"/);
  assert.match(success, /Reported cost: \$0\.0080/);
  assert.match(success, /\$0\.0040 per image/);
  assert.doesNotMatch(success, /role="alert"/);
});

test("a paid engine's reported zero cost is provider-neutral", () => {
  const image = { mimeType: "image/png", bytesBase64: "QQ==" };
  const paidZero = build({ rounds: [battleRound([LUCID])], panel: { model: LUCID, result: { images: [image], costUsd: 0 } } }).lifted.battleTestImagePanel();
  assert.match(paidZero, /battle-test-state--success/);
  assert.match(paidZero, /Reported cost: \$0\.0000/);
  assert.doesNotMatch(paidZero, /free tier/i);
});

test("missing or invalid reported cost stays unavailable", () => {
  const image = { mimeType: "image/png", bytesBase64: "QQ==" };
  for (const cost of [undefined, "0", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const result = { images: [image] };
    if (cost !== undefined) result.costUsd = cost;
    const markup = build({ panel: { model: LUCID, result } }).lifted.battleTestImagePanel();
    assert.match(markup, /Reported cost: unavailable/);
    assert.doesNotMatch(markup, /free tier/i);
  }

  const blocked = build({ panel: { result: { images: [], blocked: true, blockReason: "Declined by the model.", costUsd: 0, providerErrors: [{ status: 502, message: "upstream" }] } } }).lifted.battleTestImagePanel();
  assert.match(blocked, /battle-test-state--failure/);
  assert.match(blocked, /Declined by the model\./);
  assert.match(blocked, /\[502\] upstream/);
});

// ---- source-level wiring ---------------------------------------------------

test("the menu's change event saves the engine through selectBattleEngine, with no second model picker", () => {
  const start = app.indexOf('"[data-battle-test-model]"');
  assert.ok(start >= 0, "expected a change handler for [data-battle-test-model]");
  const handler = app.slice(start, app.indexOf("});", start));
  assert.match(handler, /selectBattleEngine\(event\.currentTarget\.value\)/);
  assert.equal((app.match(/data-battle-test-model/g) || []).length, 2, "one select and one handler; no second model picker");
  assert.equal((app.match(/roomApi\.setBattleEngine\(/g) || []).length, 1, "set_battle_engine is called from one place");
});

test("the Test button generates with the menu's selection", () => {
  const start = app.indexOf('"[data-battle-test-generate]"');
  const handler = app.slice(start, app.indexOf("\n  });", start));
  assert.match(handler, /model:\s*effectiveBattleModel\(\)/);
  assert.doesNotMatch(handler, /model:\s*battleTestPanel\.model/);
});

test("a host refresh reads the saved engine back once the quiz definition is loaded", () => {
  const defined = app.indexOf("hostQuizDefinition = definition;");
  assert.ok(defined >= 0);
  const call = app.indexOf("loadSavedBattleEngine()", defined);
  assert.ok(call > defined, "the host boot path must call loadSavedBattleEngine() after hostQuizDefinition is set");
  assert.ok(call - defined < 3000, "the read-back belongs in the same host adoption block");
});

test("only the lifted-from-source wiring touches room state: the engine choice never goes onto `state`", () => {
  assert.doesNotMatch(app, /state\.battleEngine|state\.battleModel/);
});
