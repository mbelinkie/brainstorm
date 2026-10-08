// Issue #92: consume the host-authenticated Worker catalogue for the Prompt
// Battle selector while keeping one confirmed model for the RPC and Test.
// app.js cannot be imported in Node, so the UI functions are lifted from its
// source and exercised with narrow host/RPC/fetch stubs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { battleEngineMenu, battleTestStatus, isBattleRound } from "../quiz-core.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

const SCHNELL = "@cf/black-forest-labs/flux-1-schnell";
const KLEIN_4B = "@cf/black-forest-labs/flux-2-klein-4b";
const LUCID = "@cf/leonardo/lucid-origin";
const GROK = "x-ai/grok-imagine-image-quality";
const GEMINI = "google/gemini-3.1-flash-image";
const KAPLAN_GEMINI = "gemini-3.1-flash-image";
const FLUX = "black-forest-labs/flux-3-image";

const workersModels = [
  { provider: "workers_ai", value: SCHNELL, label: "Flux Schnell (Workers AI, free)", default: false },
  { provider: "workers_ai", value: KLEIN_4B, label: "Flux 2 Klein 4B (Workers AI, free)", default: false },
  { provider: "workers_ai", value: LUCID, label: "Lucid Origin (Workers AI, paid)", default: false }
];
const openRouterModels = [
  { provider: "openrouter", value: GROK, label: "Grok Imagine Image Quality", default: true },
  { provider: "openrouter", value: GEMINI, label: "Gemini 3.1 Flash Image (more expensive)", default: false },
  { provider: "openrouter", value: FLUX, label: "FLUX.3 Image (less expensive)", default: false }
];
const kaplanModels = [
  { provider: "kaplan_proxy", value: KAPLAN_GEMINI, label: "Gemini 3.1 Flash Image (Kaplan proxy)", default: false }
];
const catalogue = [...workersModels, ...openRouterModels, ...kaplanModels];
const ids = openRouterModels.map((model) => model.value);

const providerFor = (model) => model.startsWith("@cf/") ? "workers_ai" : model.startsWith("kaplan/") ? "kaplan_proxy" : "openrouter";
const battleRound = (permittedModels, defaultModel = permittedModels[0], defaultProvider = providerFor(defaultModel || "")) => ({
  id: "r-battle", type: "prompt_battle", title: "Battle",
  engine: { defaultProvider, defaultModel, permittedModels }
});
const quizRound = { id: "r-quiz", title: "Quiz", questions: [] };

function lift(names, scope = {}) {
  const sources = names.map((name) => {
    const ordinary = app.indexOf(`\nfunction ${name}(`);
    const start = ordinary >= 0 ? ordinary : app.indexOf(`\nasync function ${name}(`);
    assert.notEqual(start, -1, `${name} not found in app.js — did it get renamed?`);
    const end = app.indexOf("\n}\n", start);
    assert.notEqual(end, -1, `could not find the end of ${name} in app.js`);
    return app.slice(start + 1, end + 3);
  });
  const keys = Object.keys(scope);
  const factory = new Function(...keys, `${sources.join("\n")}\nreturn { ${names.join(", ")} };`);
  return factory(...keys.map((key) => scope[key]));
}

// ---- pure catalogue/quiz intersection logic ------------------------------

test("the catalogue order is preserved after intersection with permittedModels", () => {
  const menu = battleEngineMenu(catalogue, [battleRound([FLUX, GROK])]);
  assert.deepEqual(menu.map((entry) => entry.value), [GROK, FLUX]);
});

test("every battle round must permit a selectable model", () => {
  const menu = battleEngineMenu(catalogue, [battleRound([GROK, GEMINI]), quizRound, battleRound([GROK, FLUX])]);
  assert.deepEqual(menu.map((entry) => entry.value), [GROK]);
});

test("catalogue entries not permitted by the quiz and authored IDs absent from the catalogue stay hidden", () => {
  const menu = battleEngineMenu(catalogue, [battleRound([GROK, "unknown/vendor-model"])]);
  assert.deepEqual(menu.map((entry) => entry.value), [GROK]);
  assert.deepEqual(battleEngineMenu(catalogue, [quizRound]), []);
  assert.deepEqual(battleEngineMenu(undefined, [battleRound([GROK])]), []);
});

test("normal Workers AI and Kaplan catalogue entries remain selectable", () => {
  const mixedCatalogue = [...catalogue, { provider: "kaplan_proxy", value: "kaplan/proxy-model", label: "Kaplan proxy", default: false }];
  const permitted = [SCHNELL, "kaplan/proxy-model"];
  assert.deepEqual(battleEngineMenu(mixedCatalogue, [battleRound(permitted)]).map((entry) => `${entry.provider}:${entry.value}`), [
    `workers_ai:${SCHNELL}`, "kaplan_proxy:kaplan/proxy-model"
  ]);
  assert.match(build({ rounds: [battleRound([SCHNELL])] }).lifted.battleTestImagePanel(), /Provider: Workers AI/);
});

test("the Kaplan Gemini model stays distinct from OpenRouter Gemini in the host selector", () => {
  const round = battleRound([GEMINI, KAPLAN_GEMINI], KAPLAN_GEMINI, "kaplan_proxy");
  const menu = battleEngineMenu(catalogue, [round]);
  assert.deepEqual(menu.map((entry) => `${entry.provider}:${entry.value}`), [
    `openrouter:${GEMINI}`,
    `kaplan_proxy:${KAPLAN_GEMINI}`
  ]);
  assert.match(build({ rounds: [round] }).lifted.battleTestImagePanel(), /Provider: Kaplan proxy/);
});

test("test result status distinguishes idle, loading, failure and success", () => {
  const image = { mimeType: "image/png", bytesBase64: "AAAA" };
  assert.equal(battleTestStatus({ busy: false, error: "", result: null }), "idle");
  assert.equal(battleTestStatus({ busy: true, error: "", result: null }), "loading");
  assert.equal(battleTestStatus({ busy: true, error: "old", result: { images: [image] } }), "loading");
  assert.equal(battleTestStatus({ busy: false, error: "offline", result: null }), "failure");
  assert.equal(battleTestStatus({ busy: false, error: "", result: { images: [], blocked: true } }), "failure");
  assert.equal(battleTestStatus({ busy: false, error: "", result: { images: [image], costUsd: 0 } }), "success");
});

// ---- app.js host model state and catalogue loading -----------------------

function withPanel(overrides = {}) {
  return {
    model: SCHNELL, models: catalogue, modelsStatus: "ready", modelsError: "",
    prompt: "p", busy: false, error: "", result: null, engineBusy: false,
    engineError: "", engineReadFailed: false, unavailableModel: "",
    unavailableSource: "", savedModel: null, ...overrides
  };
}

function build(options = {}) {
  const battleTestPanel = withPanel(options.panel);
  const calls = { setBattleEngine: [], getHostBattleState: [], openBattleRound: [], catalogue: [], renders: 0 };
  const scope = {
    view: options.view || "host",
    state: { phase: options.phase || "lobby", presentationScreen: options.presentationScreen || "round_start", battleRoundIndex: 0, ...options.state },
    battleRoundPanel: { busy: false, error: "" },
    hostStateSaveFailure: null,
    roomCode: "ABC123",
    quizWorkerOrigin: "https://worker.example",
    getHostSecret: () => options.noSecret ? "" : "secret",
    hostQuizDefinition: { rounds: options.rounds || [battleRound(ids)] },
    battleTestPanel,
    battleEngineMenu,
    isBattleRound,
    battleTestStatus,
    escapeHtml: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    render: () => { calls.renders += 1; },
    fetch: async (url, init) => {
      calls.catalogue.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return { ok: true, status: 200, json: async () => ({ models: catalogue.map(({ provider, value: id, label, default: isDefault }) => ({ id, provider, label, default: isDefault })) }) };
    },
    roomApi: {
      setBattleEngine: async (args) => {
        calls.setBattleEngine.push(args);
        if (options.setBattleEngine) return options.setBattleEngine(args);
        return { roomCode: args.roomCode, provider: args.provider, model: args.model };
      },
      getHostBattleState: async (args) => {
        calls.getHostBattleState.push(args);
        if (options.getHostBattleState) return options.getHostBattleState(args);
        return { engine: options.savedEngine ?? { provider: null, model: null } };
      },
      openBattleRound: async (args) => { calls.openBattleRound.push(args); return { roundIndex: 1, matchups: [] }; }
    }
  };
  const lifted = lift([
    "battleEngineMenuEntries", "effectiveBattleModel", "authoredBattleEngineEntry", "authoredBattleEngineRound",
    "selectBattleEngine", "loadSavedBattleEngine", "loadBattleModelCatalogue",
    "battleTestStatusMarkup", "battleTestImagePanel", "openBattleRoundFromHost", "showNextScreen"
  ], scope);
  return { calls, scope, lifted, battleTestPanel };
}

test("catalogue loading uses host authentication, no-store, and then reads the saved engine", async () => {
  const { calls, lifted, battleTestPanel } = build({ savedEngine: { provider: "openrouter", model: GEMINI } });
  await lifted.loadBattleModelCatalogue();
  assert.deepEqual(calls.catalogue[0], {
    url: "https://worker.example/battle/models",
    init: { method: "GET", cache: "no-store", headers: { "x-quiz-room": "ABC123", "x-quiz-host-secret": "secret" } }
  });
  assert.deepEqual(calls.getHostBattleState, [{ roomCode: "ABC123", hostSecret: "secret" }]);
  assert.equal(battleTestPanel.modelsStatus, "ready");
  assert.deepEqual(battleTestPanel.models.map((model) => model.value), catalogue.map((model) => model.value));
  assert.equal(battleTestPanel.model, GEMINI);
  assert.equal(battleTestPanel.savedModel, GEMINI);
});

test("catalogue failures are distinct and cannot expose a stale static model menu", async () => {
  const failed = build({ fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: "Catalogue unavailable" }) }) });
  await failed.lifted.loadBattleModelCatalogue();
  assert.equal(failed.battleTestPanel.modelsStatus, "failure");
  assert.match(failed.lifted.battleTestImagePanel(), /Catalogue unavailable/);
  assert.doesNotMatch(failed.lifted.battleTestImagePanel(), /<select|data-battle-test-generate/);
  assert.equal(failed.calls.getHostBattleState.length, 0);
});

test("catalogue loading is host-only and needs host authorization", async () => {
  const noSecret = build({ noSecret: true });
  await noSecret.lifted.loadBattleModelCatalogue();
  assert.equal(noSecret.calls.catalogue.length, 0);
  assert.match(noSecret.lifted.battleTestImagePanel(), /authorization/i);
  const player = build({ view: "player" });
  await player.lifted.loadBattleModelCatalogue();
  assert.equal(player.calls.catalogue.length, 0);
});

test("the menu uses catalogue labels and all-round permittedModels while keeping a select, not free text", () => {
  const { lifted } = build({ rounds: [battleRound([GROK, GEMINI, FLUX, "unlisted/model"])] });
  const html = lifted.battleTestImagePanel();
  assert.match(html, /<select data-battle-test-model/);
  assert.match(html, /Provider: OpenRouter/);
  assert.match(html, /Grok Imagine Image Quality/);
  assert.match(html, /Gemini 3\.1 Flash Image \(more expensive\)/);
  assert.match(html, /FLUX\.3 Image \(less expensive\)/);
  assert.doesNotMatch(html, /unlisted\/model/);
  assert.doesNotMatch(html, /<input[^>]*data-battle-test-model/);
});

test("a saved model unavailable from the catalogue blocks Test and requires a confirmed new choice", async () => {
  const { lifted, battleTestPanel, calls } = build({
    rounds: [battleRound(ids)],
    savedEngine: { provider: "openrouter", model: "openrouter/new-model" }
  });
  await lifted.loadSavedBattleEngine();
  assert.equal(battleTestPanel.model, "");
  assert.equal(battleTestPanel.unavailableModel, "openrouter/new-model");
  assert.equal(lifted.effectiveBattleModel(), "");
  assert.match(lifted.battleTestImagePanel(), /saved model openrouter\/new-model is unavailable/);
  assert.match(lifted.battleTestImagePanel(), /data-battle-test-generate[^>]*disabled/);
  assert.equal(calls.setBattleEngine.length, 0);
  await lifted.selectBattleEngine(GROK);
  assert.deepEqual(calls.setBattleEngine[0], { roomCode: "ABC123", hostSecret: "secret", provider: "openrouter", model: GROK });
  assert.equal(battleTestPanel.unavailableModel, "");
  assert.equal(lifted.effectiveBattleModel(), GROK);
});

test("an unavailable authored default is explicit, with no silent fallback until the host confirms a choice", async () => {
  const { lifted, battleTestPanel } = build({
    rounds: [battleRound(ids, "openrouter/retired-model", "openrouter")],
    savedEngine: { provider: null, model: null }
  });
  await lifted.loadSavedBattleEngine();
  assert.equal(battleTestPanel.model, "");
  assert.equal(battleTestPanel.unavailableSource, "round default");
  assert.equal(lifted.effectiveBattleModel(), "");
  const panel = lifted.battleTestImagePanel();
  assert.match(panel, /round default model openrouter\/retired-model is unavailable/);
  assert.match(panel, /data-battle-test-generate[^>]*disabled/);
});

test("a missing saved choice uses a matching authored default without writing a new save", async () => {
  const { lifted, calls, battleTestPanel } = build({
    rounds: [battleRound(ids, GROK, "openrouter")],
    savedEngine: { provider: null, model: null }
  });
  await lifted.loadSavedBattleEngine();
  assert.equal(battleTestPanel.model, GROK);
  assert.equal(battleTestPanel.savedModel, null);
  assert.equal(lifted.effectiveBattleModel(), GROK);
  assert.equal(calls.setBattleEngine.length, 0, "a valid authored default remains server behavior until the host changes it");
});

test("the unsaved Test model follows the upcoming battle round default, while a saved override stays fixed", async () => {
  const rounds = [
    battleRound([GROK, GEMINI], GROK, "openrouter"),
    battleRound([GROK, GEMINI], GEMINI, "openrouter")
  ];
  const { lifted, scope, battleTestPanel } = build({ rounds, state: { battleRoundIndex: 0 }, savedEngine: { provider: null, model: null } });
  await lifted.loadSavedBattleEngine();
  assert.equal(lifted.effectiveBattleModel(), GROK);
  scope.state.presentationScreen = "round_end";
  scope.state.battleRoundIndex = null;
  scope.state.targetRoundIndex = 1;
  assert.equal(lifted.effectiveBattleModel(), GEMINI, "player authorization for the upcoming second round uses its authored default");
  assert.match(lifted.battleTestImagePanel(), new RegExp(`<option value="${GEMINI}" selected>`));
  await lifted.selectBattleEngine(GROK);
  assert.equal(battleTestPanel.savedModel, GROK);
  assert.equal(lifted.effectiveBattleModel(), GROK, "an explicit room-level selection overrides later round defaults");
});

test("a saved model outside the all-round permission intersection stays unavailable", async () => {
  const rounds = [battleRound([GROK, GEMINI], GROK, "openrouter"), battleRound([GROK, FLUX], GROK, "openrouter")];
  const { lifted, battleTestPanel } = build({ rounds, savedEngine: { provider: "openrouter", model: GEMINI } });
  await lifted.loadSavedBattleEngine();
  assert.deepEqual(lifted.battleEngineMenuEntries().map((entry) => entry.value), [GROK]);
  assert.equal(battleTestPanel.model, "");
  assert.equal(battleTestPanel.unavailableModel, GEMINI);
  assert.equal(lifted.effectiveBattleModel(), "");
});

test("selecting an engine saves the catalogue provider and model together through the existing RPC", async () => {
  const { lifted, calls, battleTestPanel } = build();
  await lifted.selectBattleEngine(GEMINI);
  assert.deepEqual(calls.setBattleEngine, [{ roomCode: "ABC123", hostSecret: "secret", provider: "openrouter", model: GEMINI }]);
  assert.equal(battleTestPanel.model, GEMINI);
  assert.equal(battleTestPanel.savedModel, GEMINI);
  assert.equal(lifted.effectiveBattleModel(), GEMINI);
  assert.equal(battleTestPanel.engineBusy, false);
});

test("a model outside the catalogue/menu and an active battle phase never reach the save RPC", async () => {
  const notPermitted = build({ rounds: [battleRound([GROK])] });
  await notPermitted.lifted.selectBattleEngine(GEMINI);
  await notPermitted.lifted.selectBattleEngine("typed/by-the-host");
  assert.equal(notPermitted.calls.setBattleEngine.length, 0);
  const active = build({ phase: "battle_vote" });
  await active.lifted.selectBattleEngine(GEMINI);
  assert.equal(active.calls.setBattleEngine.length, 0);
  assert.match(active.lifted.battleTestImagePanel(), /<select data-battle-test-model[^>]*disabled/);
  assert.match(active.lifted.battleTestImagePanel(), /data-battle-test-generate[^>]*disabled/);
});

test("the N/right-arrow action cannot open a round while the shared engine save is pending", async () => {
  let finishSave;
  const pendingSave = new Promise((resolve) => { finishSave = resolve; });
  const { lifted, calls, battleTestPanel } = build({ setBattleEngine: () => pendingSave });
  const save = lifted.selectBattleEngine(GEMINI);
  await Promise.resolve();
  assert.equal(battleTestPanel.engineBusy, true, "the model RPC has not settled yet");
  await lifted.showNextScreen();
  assert.equal(calls.openBattleRound.length, 0, "keyboard navigation reaches the shared open guard");
  finishSave({ provider: "openrouter", model: GEMINI });
  await save;
  assert.equal(calls.openBattleRound.length, 0);
});

test("a failed save keeps the previous selection, and a successful model change clears its old test", async () => {
  const failed = build({ setBattleEngine: async () => { throw new Error("That model is not permitted by this quiz"); } });
  await failed.lifted.selectBattleEngine(GEMINI);
  assert.equal(failed.battleTestPanel.model, GROK);
  assert.equal(failed.lifted.effectiveBattleModel(), GROK, "the visible unsaved default remains the round-authored model");
  assert.match(failed.battleTestPanel.engineError, /not permitted/);
  const changed = build({ panel: { result: { images: [{ mimeType: "image/png", bytesBase64: "AAAA" }], costUsd: 0.01 }, error: "stale" } });
  await changed.lifted.selectBattleEngine(GEMINI);
  assert.equal(changed.battleTestPanel.result, null);
  assert.equal(changed.battleTestPanel.error, "");
});

test("a saved-engine read started before a successful selection cannot overwrite it", async () => {
  let resolveRead;
  const read = new Promise((resolve) => { resolveRead = resolve; });
  const { lifted, battleTestPanel } = build({ getHostBattleState: () => read });
  const pendingRead = lifted.loadSavedBattleEngine();
  await lifted.selectBattleEngine(GEMINI);
  resolveRead({ engine: { provider: "openrouter", model: GROK } });
  await pendingRead;
  assert.equal(battleTestPanel.model, GEMINI);
  assert.equal(battleTestPanel.savedModel, GEMINI);
  assert.equal(battleTestPanel.engineError, "");
});

test("a failed saved-engine read requires confirmation even when the authored default is available", async () => {
  const { lifted, battleTestPanel } = build({
    rounds: [battleRound(ids, GROK, "openrouter")],
    getHostBattleState: async () => { throw new Error("offline"); }
  });
  await lifted.loadSavedBattleEngine();
  assert.equal(battleTestPanel.model, GROK, "the authored choice is visible for context");
  assert.equal(lifted.effectiveBattleModel(), "", "an unconfirmed model cannot be tested");
  assert.equal(battleTestPanel.engineReadFailed, true);
  assert.match(lifted.battleTestImagePanel(), /not confirmed/);
  assert.match(lifted.battleTestImagePanel(), /data-battle-test-generate[^>]*disabled/);
  await lifted.selectBattleEngine(GROK);
  assert.equal(lifted.effectiveBattleModel(), GROK);
});

test("test output preserves zero cost, unknown cost, partial success and failures distinctly", () => {
  const image = { mimeType: "image/png", bytesBase64: "QUJD" };
  const buildPanel = (panel) => build({ panel: { model: GROK, ...panel } }).lifted.battleTestImagePanel();
  const paidZero = buildPanel({ result: { images: [image], costUsd: 0 } });
  assert.match(paidZero, /battle-test-state--success/);
  assert.match(paidZero, /Reported cost: \$0\.0000/);
  assert.doesNotMatch(paidZero, /free tier/i);
  for (const cost of [undefined, "0", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const result = { images: [image] };
    if (cost !== undefined) result.costUsd = cost;
    assert.match(buildPanel({ result }), /Reported cost: unavailable/);
  }
  const partial = buildPanel({ result: { images: [image], costUsd: 0.01, partial: true } });
  assert.match(partial, /Only 1 of the requested variants came back/);
  const failure = buildPanel({ error: "Could not reach the image generator." });
  assert.match(failure, /battle-test-state--failure/);
  assert.match(failure, /Could not reach the image generator/);
});

// ---- source-level wiring ---------------------------------------------------

test("the menu change uses the existing save path and Test snapshots that same confirmed model", () => {
  const start = app.indexOf('"[data-battle-test-model]"');
  const handler = app.slice(start, app.indexOf("});", start));
  assert.match(handler, /selectBattleEngine\(event\.currentTarget\.value\)/);
  assert.equal((app.match(/data-battle-test-model/g) || []).length, 2, "one select and one handler; no second model picker");
  assert.equal((app.match(/roomApi\.setBattleEngine\(/g) || []).length, 1);
  const testStart = app.indexOf('"[data-battle-test-generate]"');
  const testHandler = app.slice(testStart, app.indexOf("\n  });", testStart));
  assert.match(testHandler, /const model = effectiveBattleModel\(\)/);
  assert.match(testHandler, /body: JSON\.stringify\(\{ model, prompt: battleTestPanel\.prompt \}\)/);
  assert.match(testHandler, /battle_prompt.*battle_review.*battle_vote.*battle_result/);
});

test("host boot loads the catalogue after adopting the room definition; model choice stays out of public room state", () => {
  const defined = app.indexOf("hostQuizDefinition = definition;");
  assert.ok(defined >= 0);
  const call = app.indexOf("loadBattleModelCatalogue()", defined);
  assert.ok(call > defined && call - defined < 3000, "host boot loads after the definition is available");
  assert.doesNotMatch(app, /state\.battleEngine|state\.battleModel/);
});

test("selector render sites cover the title and safe between-round host screens, not active battle UI", () => {
  assert.match(app, /const enginePanel = !opened && isHostedRoom \? battleTestImagePanel\(\) : ""/);
  assert.match(app, /\["round_end", "round_scoreboard"\]\.includes\(state\.presentationScreen\)/);
  assert.match(app, /isHostedRoom \? battleTestImagePanel\(\) : ""/);
  assert.match(app, /showNextScreen\(\);/);
});

test("a failed stale saved-engine read after a confirmed save cannot overwrite it", async () => {
  let reject;
  const read = new Promise((_, r) => (reject = r));
  const { lifted, battleTestPanel } = build({ getHostBattleState: () => read });
  const pending = lifted.loadSavedBattleEngine();
  await lifted.selectBattleEngine(GEMINI);
  reject(Error('Stale failure'));
  await pending;
  assert.equal(battleTestPanel.model, GEMINI);
  assert.equal(battleTestPanel.savedModel, GEMINI);
  assert.equal(battleTestPanel.engineReadFailed, false);
  assert.equal(battleTestPanel.engineError, '');
});

test("a pending save disables the model and Test controls, and a save failure is displayed", () => {
  const saving = build({ panel: { engineBusy: true } }).lifted.battleTestImagePanel();
  assert.match(saving, /<select data-battle-test-model[^>]*disabled/);
  assert.match(saving, /data-battle-test-generate[^>]*disabled/);
  assert.match(
    build({ panel: { engineError: 'Could not save' } }).lifted.battleTestImagePanel(),
    /role="alert"[^>]*>Could not save/
  );
});

test("test state markup is exclusive and two-image results show total and per-image costs", () => {
  const image = { mimeType: 'image/png', bytesBase64: 'QUJD' };
  const cases = [
    ['loading', { busy: true }],
    ['failure', { error: 'Offline' }],
    ['success', { result: { images: [image, image], costUsd: .008 } }]
  ];
  for (const [kind, panel] of cases) {
    const html = build({ panel }).lifted.battleTestImagePanel();
    assert.match(html, new RegExp('battle-test-state--' + kind));
    for (const other of ['loading', 'failure', 'success']) {
      if (other !== kind) {
        assert.doesNotMatch(html, new RegExp('battle-test-state--' + other));
      }
    }
    if (kind !== 'success') {
      assert.doesNotMatch(html, /<img|Reported cost/);
    } else {
      assert.equal((html.match(/<img class="battle-test-image"/g) || []).length, 2);
      assert.match(html, /Reported cost: \$0\.0080/);
      assert.match(html, /\$0\.0040 per image/);
    }
  }
});

test("a blocked result retains the refusal reason and provider details", () => {
  const html = build({
    panel: {
      result: {
        images: [],
        blocked: true,
        blockReason: 'Declined by the model.',
        costUsd: 0,
        providerErrors: [{ status: 502, message: 'upstream' }]
      }
    }
  }).lifted.battleTestImagePanel();
  assert.match(html, /battle-test-state--failure/);
  assert.match(html, /Declined by the model\./);
  assert.match(html, /\[502\] upstream/);
});

test("direct selection enforces host identity and authorization", async () => {
  const options = {};
  options['no' + 'Secret'] = true;
  const denied = build(options);
  await denied.lifted.selectBattleEngine(GEMINI);
  assert.equal(denied.calls.setBattleEngine.length, 0);
  assert.match(denied.battleTestPanel.engineError, /authorization/i);
  const player = build({ view: 'player' });
  await player.lifted.selectBattleEngine(GEMINI);
  assert.equal(player.calls.setBattleEngine.length, 0);
});
