import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as core from "../quiz-core.js";
import * as roster from "../battle-roster.js";

// Execute the shipped host functions; fake only transport, time and browser UI.
const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const functions = [...source.matchAll(/^(?:async )?function \w+\([^\n]*\) \{[\s\S]*?^\}/gm)].map(match => match[0]).join("\n");
const requestGlobals = (source.match(/^let battle(?:Lock|Refresh)[^\n]*$/gm) || []).join("\n");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function host(api = {}) {
  const broadcasts = [];
  const ctx = vm.createContext({ ...core, ...roster, structuredClone, Date, Promise, Number,
    console: { warn() {} }, setTimeout: (fn) => { fn(); }, clearInterval() {}, setInterval: () => 1,
    document: { hidden: false, querySelector: () => null, querySelectorAll: () => [] },
    hostSecretKey: code => `quiz-host-secret:${code}`, localStorage: { getItem: () => "synthetic-host-secret" }, params: new URLSearchParams("view=host&room=TEST"),
    view: "host", isHostedRoom: true, roomCode: "TEST", realtimeChannel: null,
    localChannel: { postMessage: message => broadcasts.push(structuredClone(message)) },
    roomApi: api, recordDiagnostic() {}, hostQuizDefinition: { rounds: [{ type: "prompt_battle", title: "Battle" }] },
    hostQuestion: { id: "q1", type: "single_choice", prompt: "Previous question", options: [] },
    state: { phase: "battle_prompt", presentationScreen: "battle_prompt", battleRoundIndex: 0,
      revision: 1, question: { round: 1 }, players: [], submitted: {} },
    battleRoundPanel: { busy: false, error: "", state: null, stale: false, lockBusy: false, roundIndex: null },
    battleRosterPollTimer: null, hostStateSaveSequence: Promise.resolve(), hostStateSaveRequest: 0,
    hostStateSaveFailure: null, hostStateSaveRetrying: false, HOST_STATE_SAVE_BACKOFF_MS: [0, 0],
  });
  vm.runInContext(requestGlobals + "\n" + functions + `
    render = () => {};
    refreshHostSyncNotice = () => {};
    renderBattleAfterSaveRecovered = () => {};
  `, ctx);
  return { ctx, broadcasts, run: code => vm.runInContext(code, ctx) };
}
const battle = (phase = "battle_prompt", revision = 1) => ({ phase, revision, roundIndex: 0,
  matchups: [{ entrants: [{ playerName: "Private creator", submitted: true }, { submitted: false }] }] });

test("locking waits for an older save so that save cannot reopen submissions", async () => {
  const held = deferred();
  let serverPhase = "battle_prompt", lockCalls = 0;
  const h = host({
    async setRoomState(payload) { await held.promise; serverPhase = payload.phase; return { revision: 2 }; },
    async lockBattlePrompt() { lockCalls++; serverPhase = "battle_review"; return battle("battle_review", 3); },
  });
  const save = h.run("persistHostState()");
  await settle();
  const lock = h.run("lockBattlePrompt()");
  await settle();
  assert.equal(lockCalls, 0, "lock must wait for the already-issued host save");
  held.resolve();
  await Promise.all([save, lock]);
  assert.equal(serverPhase, "battle_review");
  assert.equal(h.ctx.state.phase, "battle_review");
});

test("confirmed roster refresh broadcasts only public counts to both transports", async () => {
  const h = host({ async getHostBattleState() { return battle(); } });
  const remote = [];
  h.ctx.realtimeChannel = { send: message => remote.push(structuredClone(message)) };
  await h.run("refreshBattlePairing()");
  assert.equal(h.broadcasts.length, 1);
  assert.deepEqual(h.broadcasts[0].state.battleProgress, { submitted: 1, total: 2 });
  assert.equal(remote.length, 1);
  assert.deepEqual(remote[0].payload.state, h.broadcasts[0].state);
  assert.doesNotMatch(JSON.stringify(h.broadcasts), /Private creator|matchups|entrants/);
});

test("refresh publishes a recovered lock to Presentation without saving a guessed phase", async () => {
  let writes = 0;
  const h = host({ async getHostBattleState() { return battle("battle_review", 3); },
    async setRoomState() { writes++; return { revision: 4 }; } });
  await h.run("refreshBattlePairing()");
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.broadcasts[0].state.phase, "battle_review");
  assert.equal(h.broadcasts[0].state.presentationScreen, "battle_review");
  assert.equal(writes, 0);
});

test("a roster response for an older server round preserves confirmed state", async () => {
  const h = host({ async getHostBattleState() { return { ...battle("battle_review", 9), roundIndex: 2 }; } });
  h.ctx.battleRoundPanel.state = battle();
  await h.run("refreshBattlePairing()");
  assert.equal(h.ctx.state.phase, "battle_prompt");
  assert.equal(h.ctx.state.revision, 1);
  assert.equal(h.ctx.battleRoundPanel.state.roundIndex, 0);
});

test("a refresh cannot regress a confirmed locked phase or revision", async () => {
  const h = host({ async getHostBattleState() { return battle("battle_prompt", 2); } });
  h.ctx.state.phase = "battle_review";
  h.ctx.state.revision = 3;
  h.ctx.battleRoundPanel.state = battle("battle_review", 3);
  await h.run("refreshBattlePairing()");
  assert.equal(h.ctx.state.phase, "battle_review");
  assert.equal(h.ctx.state.revision, 3);
  assert.equal(h.ctx.battleRoundPanel.state.phase, "battle_review");
});

test("refresh without host authorization makes no private RPC and shows an error", async () => {
  let calls = 0;
  const h = host({ async getHostBattleState() { calls++; return battle(); } });
  h.run("getHostSecret = () => '';");
  await h.run("refreshBattlePairing()");
  assert.equal(calls, 0);
  assert.match(h.ctx.battleRoundPanel.error, /Host authorization is required/);
});

test("roster requests remain serialized across a round change", async () => {
  const old = deferred(), current = deferred();
  let calls = 0;
  const h = host({ getHostBattleState() { calls++; return calls === 1 ? old.promise : current.promise; } });
  h.ctx.hostQuizDefinition.rounds.push({ type: "prompt_battle", title: "Next battle" });
  const first = h.run("refreshBattlePairing()");
  h.run("enterBattleRound(1); state.phase='battle_prompt';");
  const second = h.run("refreshBattlePairing()");
  await settle();
  assert.equal(calls, 1, "the old round's request must finish before another RPC starts");
  old.resolve(battle());
  await first;
  const third = h.run("refreshBattlePairing()");
  await settle();
  assert.ok(calls <= 2, "a third refresh must not overlap the current request");
  current.resolve({ ...battle(), roundIndex: 1 });
  await Promise.all([second, third]);
});

test("an invalidated pre-lock roster read cannot strand recovery after a lost response", async () => {
  const old = deferred();
  let calls = 0;
  const h = host({ getHostBattleState() { return ++calls === 1 ? old.promise : Promise.resolve(battle("battle_review", 3)); },
    async lockBattlePrompt() { throw new Error("Lost lock response"); } });
  const refresh = h.run("refreshBattlePairing()");
  await h.run("lockBattlePrompt()");
  old.resolve(battle());
  await refresh;
  await h.run("refreshBattlePairing()");
  assert.equal(calls, 2, "obsolete request must release its own busy state");
  assert.equal(h.ctx.state.phase, "battle_review");
});

test("ending a round while lock is uncertain cannot bypass the phase-write guard", async () => {
  let writes = 0;
  const h = host({ async lockBattlePrompt() { throw new Error("Lost response"); },
    async setRoomState() { writes++; return { revision: 4 }; } });
  // Navigation is outside this boundary; spy only on whether it was allowed.
  let navigations = 0;
  h.ctx.navigation = () => { navigations++; };
  h.run("startFinale = navigation; startRoundEnd = navigation;");
  await h.run("lockBattlePrompt()");
  await h.run("endBattleRound()");
  await h.run("persistHostState()");
  assert.equal(navigations, 0, "refresh/retry lock before navigating");
  assert.equal(writes, 0);
  assert.equal(h.ctx.state.battleRoundIndex, 0);
});

test("a lock response arriving after a round change cannot lock the new round", async () => {
  const held = deferred();
  const h = host({ lockBattlePrompt: () => held.promise });
  h.ctx.hostQuizDefinition.rounds.push({ type: "prompt_battle", title: "Next battle" });
  const lock = h.run("lockBattlePrompt()");
  await settle();
  h.run("enterBattleRound(1); state.phase='battle_prompt';");
  held.resolve(battle("battle_review", 3));
  await lock;
  assert.equal(h.ctx.state.battleRoundIndex, 1);
  assert.equal(h.ctx.state.phase, "battle_prompt");
  assert.equal(h.ctx.battleRoundPanel.state, null);
});

test("a lost lock response prevents later saves from reopening submissions until recovery", async () => {
  let serverPhase = "battle_prompt";
  const recovery = deferred();
  const h = host({
    async setRoomState(payload) { serverPhase = payload.phase; return { revision: 4 }; },
    async lockBattlePrompt() { serverPhase = "battle_review"; throw new Error("Lost response"); },
    async getHostBattleState() { return recovery.promise; },
  });
  const lock = h.run("lockBattlePrompt()");
  await settle();
  assert.equal(h.ctx.state.phase, "battle_prompt", "no optimistic success");
  const save = h.run("persistHostState()");
  await settle();
  assert.equal(serverPhase, "battle_review", "uncertain prompt phase must not be persisted");
  recovery.resolve(battle("battle_review", 3));
  await lock;
  await h.run("refreshBattlePairing()");
  await save;
  await h.run("persistHostState()");
  assert.equal(serverPhase, "battle_review");
  assert.equal(h.ctx.state.phase, "battle_review");
});
