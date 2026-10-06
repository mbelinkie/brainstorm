import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createMigratedDb } from "./helpers/migrated-db.js";
import { publicBattleResult, publicBattleVote, sanitizePublicBattleResult, sanitizePublicBattleVote } from "../battle-vote.js";

// Issue #35: what a player can and cannot see, across every battle phase.
//
// One room is driven through a whole battle with the real RPCs, in a real
// Postgres (test/helpers/migrated-db.js): pairing, generation, submission,
// lock, veto, vote, resolution, and the move to the next matchup. At every
// step, every player-facing read is checked against what that player must not
// hold yet. The leak finder each check uses is itself tested against
// deliberately leaky payloads at the bottom, so a check that could never fail
// cannot pass silently.

const HOST = "host-secret-35";
const db = await createMigratedDb();

// --- leak finder -------------------------------------------------------------

// Every forbidden value found anywhere in a payload, by label.
function findLeaks(payload, forbidden) {
  const text = JSON.stringify(payload ?? null);
  return Object.entries(forbidden).filter(([, value]) => value && text.includes(String(value))).map(([label]) => label);
}
const MEDIA_URL = /https?:\/\/|\/storage\/v1|\/media\/|battle\/[0-9a-f-]{36}\./i;

// --- one battle room -----------------------------------------------------------

async function sql(text, params = []) { return (await db.query(text, params)).rows; }
async function one(text, params = []) { return (await sql(text, params))[0]; }

const room = { code: "PRIV35", players: [] };
const NAMES = ["Ada Arden", "Bo Birch", "Cy Cobb", "Di Dale", "Ed Erle"]; // five players: a duel and a three-way
room.prompts = [
  { id: "p-office", text: "Depict the worst office party ever." },
  { id: "p-monday", text: "Illustrate Monday morning as a natural disaster." },
];

{
  const quizId = randomUUID(), versionId = randomUUID();
  room.session = randomUUID();
  const definition = { rounds: [{
    type: "prompt_battle", title: "Battle", prompts: room.prompts,
    engine: { defaultProvider: "workers_ai", defaultModel: "flux", permittedModels: ["flux"], attemptBudget: 3, maxSessionSpendUsd: 5, maxSessionGenerations: 50, variants: 2, resolution: "1024x1024", outputFormat: "webp" },
    scoring: { winnerPoints: 100, voterPoints: 10 },
  }] };
  await sql("insert into public.quizzes (id, slug, title) values ($1, 'priv-35', 'Privacy')", [quizId]);
  await sql("insert into public.quiz_versions (id, quiz_id, version, definition) values ($1, $2, 1, $3)", [versionId, quizId, JSON.stringify(definition)]);
  await sql(`insert into public.sessions (id, room_code, quiz_version_id, host_secret_hash, phase, state, battle_engine_provider, battle_engine_model)
             values ($1, $2, $3, public.token_hash($4), 'lobby', '{"phase":"lobby"}', 'workers_ai', 'flux')`, [room.session, room.code, versionId, HOST]);
  for (const name of NAMES) {
    const id = randomUUID(), token = `token-${name}`;
    await sql("insert into public.session_players (id, session_id, player_token_hash, display_name) values ($1, $2, public.token_hash($3), $4)", [id, room.session, token, name]);
    room.players.push({ id, token, name, assets: [] });
  }
}

const hostCall = (fn, ...args) => one(`select public.${fn}($1, $2${args.map((_, i) => `, $${i + 3}`).join("")}) as r`, [room.code, HOST, ...args]).then((row) => row.r);
const playerCall = (fn, player, ...args) => one(`select public.${fn}($1, $2${args.map((_, i) => `, $${i + 3}`).join("")}) as r`, [room.code, player.token, ...args]).then((row) => row.r);
const canSee = async (player, assetId) => (await one("select public.can_access_live_media($1, $2, null, $3) as ok", [room.code, assetId, player.token])).ok;
const setPublicState = (phase, matchupIndex) => sql(
  "update public.sessions set phase = $2::public.session_phase, state = state || jsonb_build_object('phase', $2::text, 'battleMatchupIndex', $3::int), revision = revision + 1 where id = $1",
  [room.session, phase, matchupIndex]
);

// The pairing, read the way only the host may read it.
async function pairing() {
  const matchups = await sql(
    `select m.id, m.matchup_index, m.prompt_text, e.id as entry_id, e.player_id, e.submitted_asset_id
     from public.session_battle_matchups m join public.session_battle_entries e on e.matchup_id = m.id
     where m.session_id = $1 order by m.matchup_index, e.player_id`, [room.session]);
  for (const player of room.players) {
    const row = matchups.find((entry) => entry.player_id === player.id);
    Object.assign(player, row ? { matchupIndex: row.matchup_index, matchupId: row.id, entryId: row.entry_id, promptText: row.prompt_text, submitted: row.submitted_asset_id } : {});
  }
}

const others = (player) => room.players.filter((other) => other.id !== player.id);
const opponents = (player) => others(player).filter((other) => other.matchupIndex === player.matchupIndex);

// What `player` must never find in a payload of their own, in any phase.
function alwaysForbidden(player) {
  const forbidden = {};
  for (const other of others(player)) {
    forbidden[`${other.name}'s player id`] = other.id;
    forbidden[`${other.name}'s token`] = other.token;
    forbidden[`${other.name}'s entry id`] = other.entryId;
    forbidden[`${other.name}'s name`] = other.name;
    other.assets.forEach((assetId, index) => { forbidden[`${other.name}'s asset ${index}`] = assetId; });
  }
  for (const prompt of room.prompts) if (prompt.text !== player.promptText) forbidden[`prompt "${prompt.id}"`] = prompt.text;
  forbidden["own entry id"] = player.entryId;
  forbidden["own player id"] = player.id;
  return forbidden;
}

async function assertPlayerReadsClean(stage) {
  for (const player of room.players) {
    const roomState = await playerCall("get_live_room_state", player);
    const battleState = await playerCall("get_player_battle_state", player);
    for (const [label, payload] of [["get_live_room_state", roomState], ["get_player_battle_state", battleState]]) {
      assert.deepEqual(findLeaks(payload, alwaysForbidden(player)), [], `${stage}: ${player.name}'s ${label} leaks`);
      assert.doesNotMatch(JSON.stringify(payload), MEDIA_URL, `${stage}: ${player.name}'s ${label} carries a media URL`);
    }
    // Public room state carries the battle position and nothing else battle-shaped.
    const battleKeys = Object.keys(roomState.state).filter((key) => /battle/i.test(key)).sort();
    assert.deepEqual(battleKeys.filter((key) => !["battleMatchupCount", "battleMatchupIndex", "battleRoundIndex"].includes(key)), [], `${stage}: unexpected battle keys in public state`);
  }
}

// --- the walk ---------------------------------------------------------------

test("lobby: no battle data exists for any player", async () => {
  await assertPlayerReadsClean("lobby");
  for (const player of room.players) assert.equal((await playerCall("get_player_battle_state", player)).entry, null);
});

test("battle_prompt: each phone gets only its own prompt; pairing and other prompts stay on the host", async () => {
  await hostCall("open_battle_round");
  await pairing();
  assert.deepEqual(room.players.map((player) => player.matchupIndex).sort(), [0, 0, 1, 1, 1], "five players: one duel, one three-way");

  for (const player of room.players) {
    const own = await playerCall("get_player_battle_state", player);
    assert.equal(own.entry.promptText, player.promptText);
    assert.deepEqual(Object.keys(own.entry).sort(), ["attemptsRemaining", "generations", "promptText"]);
  }
  await assertPlayerReadsClean("battle_prompt, after pairing");
});

test("battle_prompt: a phone sees its own variants and no one else's", async () => {
  // One three-way entrant generates nothing, so the lock forfeits them. (A
  // player who generated but never submitted is auto-submitted instead.)
  room.forfeiter = room.players.find((player) => player.matchupIndex === 1);
  for (const player of room.players) {
    if (player === room.forfeiter) continue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const authorized = (await one("select public.authorize_battle_generation($1, $2, $3) as r", [room.code, player.token, `idea ${attempt}`])).r;
      const assetIds = [randomUUID(), randomUUID()];
      for (const assetId of assetIds) {
        await sql("insert into public.media_assets (id, storage_path, kind, mime_type, byte_size, source, generated_by_player_id) values ($1, $2, 'image', 'image/webp', 100, 'battle', $3)", [assetId, `battle/${assetId}.webp`, player.id]);
      }
      await sql("select public.record_battle_generation($1, $2, 0)", [authorized.generationId, assetIds]);
      player.assets.push(...assetIds);
    }
  }
  for (const player of room.players) {
    const generations = (await playerCall("get_player_battle_state", player)).entry.generations;
    assert.deepEqual(generations.flatMap((generation) => generation.assetIds).sort(), [...player.assets].sort());
    for (const assetId of player.assets) assert.equal(await canSee(player, assetId), true, `${player.name} sees own variant`);
    for (const other of others(player)) for (const assetId of other.assets) assert.equal(await canSee(player, assetId), false, `${player.name} must not see ${other.name}'s variant`);
  }
  await assertPlayerReadsClean("battle_prompt, after generation");
});

test("battle_review: submissions and vetoes are invisible to players", async () => {
  // Everyone with images submits their first variant; the forfeiter has none
  // and forfeits at lock. The host then vetoes one entry of the three-way.
  for (const player of room.players) if (player !== room.forfeiter) await playerCall("submit_battle_entry", player, player.assets[0]);
  await hostCall("lock_battle_prompt");
  await pairing();
  const forfeited = await one("select forfeited_at from public.session_battle_entries where id = $1", [room.forfeiter.entryId]);
  assert.ok(forfeited.forfeited_at, "a player with no images forfeits at lock");
  room.vetoed = room.players.find((player) => player.matchupIndex === 1 && player !== room.forfeiter);
  await hostCall("veto_battle_entry", room.vetoed.entryId, "Not allowed");

  await assertPlayerReadsClean("battle_review");
  for (const player of room.players) {
    for (const other of others(player)) for (const assetId of other.assets) assert.equal(await canSee(player, assetId), false, `review: ${player.name} vs ${other.name}`);
  }
});

test("battle_vote: only the current matchup's viable submissions are viewable; future matchups, unused variants and vetoes are not", async () => {
  await setPublicState("battle_vote", 0);
  const current = room.players.filter((player) => player.matchupIndex === 0);
  const future = room.players.filter((player) => player.matchupIndex === 1);
  for (const viewer of room.players) {
    for (const entrant of current) {
      assert.equal(await canSee(viewer, entrant.assets[0]), true, `${viewer.name} sees current submission of ${entrant.name}`);
      for (const unused of entrant.assets.slice(1)) assert.equal(await canSee(viewer, unused), false, `${viewer.name} must not see ${entrant.name}'s unused variant`);
    }
    for (const entrant of future) for (const assetId of entrant.assets) assert.equal(await canSee(viewer, assetId), false, `${viewer.name} must not see future matchup image of ${entrant.name}`);
  }
  await assertPlayerReadsClean("battle_vote, matchup 1");
});

test("battle_vote: the public ballot (#31) built from the real host payload names no one", async () => {
  const hostPayload = await hostCall("get_host_battle_state");
  for (const matchupIndex of [0, 1]) {
    const ballot = sanitizePublicBattleVote(publicBattleVote(hostPayload, matchupIndex));
    const entrants = room.players.filter((player) => player.matchupIndex === matchupIndex);
    const forbidden = {};
    for (const player of room.players) {
      forbidden[`${player.name}'s name`] = player.name;
      forbidden[`${player.name}'s player id`] = player.id;
      forbidden[`${player.name}'s token`] = player.token;
      for (const assetId of player.assets) if (assetId !== player.submitted || player === room.vetoed) forbidden[`${player.name}'s unused or vetoed image ${assetId}`] = assetId;
    }
    for (const prompt of room.prompts) forbidden[`prompt "${prompt.id}"`] = prompt.text;
    assert.deepEqual(findLeaks(ballot, forbidden), [], `matchup ${matchupIndex + 1} ballot`);
    assert.doesNotMatch(JSON.stringify(ballot), /votes|count|name|player|prompt/i);
    const viable = entrants.filter((player) => player !== room.vetoed && player !== room.forfeiter);
    assert.deepEqual(ballot.entries.map((entry) => entry.assetId).sort(), viable.map((player) => player.submitted).sort());
    assert.deepEqual(ballot.entries.map((entry) => entry.entryId), [...ballot.entries.map((entry) => entry.entryId)].sort(), "ballot order follows entry IDs, not names");
  }
});

test("battle_vote: casting a vote returns nothing about creators or counts", async () => {
  const [left] = room.players.filter((player) => player.matchupIndex === 0);
  const voters = room.players.filter((player) => player.matchupIndex === 1);
  for (const voter of voters) {
    const reply = await playerCall("cast_battle_vote", voter, left.matchupId, left.entryId);
    assert.deepEqual(Object.keys(reply).sort(), ["matchupId", "voteId", "votedAt"]);
    assert.deepEqual(findLeaks(reply, { creatorName: left.name, creatorId: left.id, entryId: left.entryId }), []);
  }
  await assertPlayerReadsClean("battle_vote, after votes");
});

test("battle_result: creators are revealed only to the host's resolution, never pushed to phones", async () => {
  const [left] = room.players.filter((player) => player.matchupIndex === 0);
  const result = await hostCall("resolve_battle_matchup", left.matchupId);
  assert.ok(result.entries.some((entry) => entry.playerName === left.name), "the host's result names the creators");
  const broadcast = sanitizePublicBattleResult(publicBattleResult(result));
  assert.ok(broadcast.entries.some((entry) => entry.playerName === left.name), "the result broadcast reveals creators, as the spec allows");
  assert.deepEqual(findLeaks(broadcast, Object.fromEntries(room.players.flatMap((player) => [[`${player.name} id`, player.id], [`${player.name} token`, player.token]]))), [], "but never player IDs or tokens");
  await assertPlayerReadsClean("battle_result");
});

test("next matchup: the previous matchup's images close and the new current ones open, minus the veto and the forfeit", async () => {
  await setPublicState("battle_vote", 1);
  const previous = room.players.filter((player) => player.matchupIndex === 0);
  const current = room.players.filter((player) => player.matchupIndex === 1);
  const viewer = previous[0];
  for (const entrant of previous) assert.equal(await canSee(viewer, entrant.assets[0]), false, `previous matchup image of ${entrant.name} is closed`);
  for (const entrant of current) {
    const viable = entrant !== room.vetoed && entrant !== room.forfeiter;
    for (const assetId of entrant.assets) {
      assert.equal(await canSee(viewer, assetId), viable && assetId === entrant.submitted, `${entrant.name} ${assetId === entrant.submitted ? "submission" : "variant"}`);
    }
  }
  await assertPlayerReadsClean("battle_vote, matchup 2");
});

test("a late joiner sees no battle data and only the current viable images", async () => {
  const late = { id: randomUUID(), token: "token-late", name: "Late", assets: [] };
  await sql("insert into public.session_players (id, session_id, player_token_hash, display_name) values ($1, $2, public.token_hash($3), 'Late')", [late.id, room.session, late.token]);
  assert.equal((await playerCall("get_player_battle_state", late)).entry, null);
  const forbidden = {};
  for (const other of room.players) { forbidden[other.name] = other.name; forbidden[other.id] = other.id; forbidden[`${other.name} entry`] = other.entryId; }
  assert.deepEqual(findLeaks(await playerCall("get_live_room_state", late), forbidden), []);
  const viable = room.players.filter((player) => player.matchupIndex === 1 && player !== room.vetoed && player !== room.forfeiter);
  for (const player of viable) assert.equal(await canSee(late, player.submitted), true);
});

// --- host-only fields never reach publicRoomState --------------------------

test("publicRoomState() forwards only the battle position, never host-only battle data", () => {
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = app.indexOf("function publicRoomState() {");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  const keys = [...body.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((match) => match[1]);
  assert.deepEqual(keys.filter((key) => /battle/i.test(key)).sort(), ["battleMatchupCount", "battleMatchupIndex", "battleResult", "battleRoundIndex", "battleVote"]);
  // #31: the ballot and the result are re-whitelisted and phase-gated.
  assert.match(body, /battleVote: state\.phase === "battle_vote" \? sanitizePublicBattleVote\(state\.battleVote\) : null/);
  assert.match(body, /battleResult: state\.phase === "battle_result" \? sanitizePublicBattleResult\(state\.battleResult\) : null/);
  assert.doesNotMatch(body, /battleRoundPanel|battleTestPanel|battlePlayer\b|pairing|matchups|entrants|shuffleSeed|sessionSpendUsd/);
  // Nothing host-only is ever assigned onto `state`, the object it reads.
  assert.doesNotMatch(app, /state\.(battleRoundPanel|battleTestPanel|battlePairing|matchups|entrants|shuffleSeed)\s*=/);
});

// --- the checks can fail ------------------------------------------------------

test("the leak finder catches each leak category", () => {
  const player = { id: "p1", entryId: "e1", promptText: "Mine" };
  const other = { id: "p2", token: "t2", entryId: "e2", name: "Zed", assets: ["a2"] };
  const forbidden = { "other id": other.id, "other token": other.token, "other entry": other.entryId, "other name": other.name, "other asset": other.assets[0], "future prompt": "Their prompt", "own entry id": player.entryId };
  assert.deepEqual(findLeaks({ entry: { promptText: "Mine", generations: [] } }, forbidden), []);
  assert.deepEqual(findLeaks({ opponent: { playerName: "Zed" } }, forbidden), ["other name"], "other player / creator name");
  assert.deepEqual(findLeaks({ assetIds: ["a2"] }, forbidden), ["other asset"], "other player's variant");
  assert.deepEqual(findLeaks({ matchups: [{ promptText: "Their prompt" }] }, forbidden), ["future prompt"], "future matchup");
  assert.deepEqual(findLeaks({ pairing: [{ entryId: "e2", playerId: "p2" }] }, forbidden), ["other id", "other entry"], "pairing");
  assert.match(JSON.stringify({ url: "https://x.supabase.co/storage/v1/object/sign/quiz-media/battle/abc" }), MEDIA_URL, "usable media URL");
});
