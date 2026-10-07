import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMigratedDb } from "./helpers/migrated-db.js";
import { battleFixtures } from "./helpers/battle-fixtures.js";

// Issue #38: battle images are purged 30 days after creation (migration
// 0043), executed for real in PGlite. purge lists; the Worker deletes the
// storage objects (#39); finalize deletes the rows.

const db = await createMigratedDb();
const { makeMatchup } = battleFixtures(db);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

async function storageObject(path) {
  await rows("insert into storage.objects (bucket_id, name) values ('quiz-media', $1)", [path]);
}
async function removeObject(path) {
  await rows("delete from storage.objects where bucket_id = 'quiz-media' and name = $1", [path]);
}
async function battleAsset({ expiresIn = "-1 day", playerId = null } = {}) {
  const id = randomUUID(), path = `battle/${id}.webp`;
  await rows(
    `insert into public.media_assets (id, storage_path, kind, mime_type, byte_size, source, generated_by_player_id, expires_at)
     values ($1, $2, 'image', 'image/webp', 100, 'battle', $3, ${expiresIn === null ? "null" : `now() + interval '${expiresIn}'`})`,
    [id, path, playerId]
  );
  await storageObject(path);
  return { id, path };
}
async function authorAsset({ expiresIn = "-1 day" } = {}) {
  const userId = randomUUID(), id = randomUUID(), path = `${userId}/${id}.webp`;
  await rows("insert into auth.users (id) values ($1)", [userId]);
  await rows(
    `insert into public.media_assets (id, storage_path, kind, mime_type, byte_size, uploaded_by, source, expires_at)
     values ($1, $2, 'image', 'image/webp', 100, $3, 'author', now() + interval '${expiresIn}')`,
    [id, path, userId]
  );
  await storageObject(path);
  return { id, path };
}
const purge = async (limit) => (await rows("select public.purge_expired_battle_media($1) as r", [limit ?? null]))[0].r;
const finalize = async (ids) => (await rows("select public.finalize_battle_media_purge($1::uuid[]) as r", [ids]))[0].r;
const exists = async (id) => (await rows("select 1 from public.media_assets where id = $1", [id])).length === 1;

test("only expired battle images are listed; fresh, undated and author media never are", async () => {
  const expired = await battleAsset({ expiresIn: "-2 days" });
  const fresh = await battleAsset({ expiresIn: "29 days" });
  const undated = await battleAsset({ expiresIn: null });
  const author = await authorAsset({ expiresIn: "-30 days" });

  const listed = await purge(1000);
  const ids = listed.map((entry) => entry.assetId);
  assert.ok(ids.includes(expired.id));
  for (const kept of [fresh, undated, author]) assert.ok(!ids.includes(kept.id));
  assert.deepEqual(listed.find((entry) => entry.assetId === expired.id), { assetId: expired.id, storagePath: expired.path });
  assert.ok(await exists(expired.id), "listing writes nothing");
});

test("the list is oldest first and bounded", async () => {
  for (let index = 0; index < 3; index += 1) await battleAsset({ expiresIn: `-${40 + index} days` });
  const two = await purge(2);
  assert.equal(two.length, 2);
  const all = await purge(1000);
  assert.deepEqual(two.map((entry) => entry.assetId), all.slice(0, 2).map((entry) => entry.assetId));
  assert.equal((await purge(0)).length, 1, "a zero or negative limit still returns at least one");
});

test("finalize deletes a row only after its storage object is gone, and is idempotent", async () => {
  const removed = await battleAsset({ expiresIn: "-3 days" });
  const stillThere = await battleAsset({ expiresIn: "-3 days" });
  await removeObject(removed.path);

  const first = await finalize([removed.id, stillThere.id]);
  assert.deepEqual(first, { deleted: [removed.id], keptObjectStillPresent: [stillThere.id] });
  assert.equal(await exists(removed.id), false);
  assert.equal(await exists(stillThere.id), true, "an object the Worker failed to delete keeps its row for the next run");

  const second = await finalize([removed.id, stillThere.id]);
  assert.deepEqual(second, { deleted: [], keptObjectStillPresent: [stillThere.id] }, "calling again changes nothing");
});

test("finalize never deletes author media, fresh battle images or unknown IDs, whatever it is passed", async () => {
  const author = await authorAsset({ expiresIn: "-30 days" });
  const fresh = await battleAsset({ expiresIn: "10 days" });
  await removeObject(author.path);
  await removeObject(fresh.path);
  const result = await finalize([author.id, fresh.id, randomUUID()]);
  assert.deepEqual(result, { deleted: [], keptObjectStillPresent: [] });
  assert.ok(await exists(author.id));
  assert.ok(await exists(fresh.id));
  assert.deepEqual(await finalize(null), { deleted: [], keptObjectStillPresent: [] });
});

test("a purged submission leaves the entry, its votes and its points intact", async () => {
  const fixture = await makeMatchup({ entrants: [{ name: "Ada" }, { name: "Bo" }], voters: 1 });
  await fixture.vote(0, 0);
  const [ada] = fixture.entries;
  const unused = await battleAsset({ expiresIn: "-1 day", playerId: ada.playerId });
  await rows("update public.media_assets set expires_at = now() - interval '1 day' where id = $1", [ada.assetId]);
  await rows(
    "insert into public.session_battle_generations (entry_id, attempt_index, player_prompt, provider, model, asset_ids, status) values ($1, 1, 'idea', 'workers_ai', 'flux', $2, 'complete')",
    [ada.entryId, [ada.assetId, unused.id]]
  );
  await rows("select public.resolve_battle_matchup($1, 'host-secret-30', $2)", [fixture.roomCode, fixture.matchup]);
  const pointsBefore = await rows("select player_id, points::float8 as points, reason from public.score_events where session_id = $1 order by reason", [fixture.session]);

  // Ada's submitted image has no storage object in the fixture, as if the Worker already removed it.
  await removeObject(unused.path);
  const result = await finalize([ada.assetId, unused.id]);
  assert.deepEqual([...result.deleted].sort(), [ada.assetId, unused.id].sort());

  const [entry] = await rows("select submitted_asset_id, submitted_at from public.session_battle_entries where id = $1", [ada.entryId]);
  assert.equal(entry.submitted_asset_id, null);
  assert.ok(entry.submitted_at, "the entry still records that it was submitted");
  const [generation] = await rows("select asset_ids from public.session_battle_generations where entry_id = $1", [ada.entryId]);
  assert.deepEqual(generation.asset_ids, []);
  assert.equal((await rows("select 1 from public.session_battle_votes where matchup_id = $1", [fixture.matchup])).length, 1);
  assert.deepEqual(await rows("select player_id, points::float8 as points, reason from public.score_events where session_id = $1 order by reason", [fixture.session]), pointsBefore);
  const [access] = await rows("select public.can_access_live_media($1, $2, 'host-secret-30') as ok", [fixture.roomCode, ada.assetId]);
  assert.equal(access.ok, false, "a purged image is simply unavailable");
});

test("only the Worker's service role may call either function", async () => {
  const [grants] = await rows(`
    select
      has_function_privilege('anon', 'public.purge_expired_battle_media(integer)', 'execute') as anon_list,
      has_function_privilege('authenticated', 'public.purge_expired_battle_media(integer)', 'execute') as auth_list,
      has_function_privilege('service_role', 'public.purge_expired_battle_media(integer)', 'execute') as service_list,
      has_function_privilege('anon', 'public.finalize_battle_media_purge(uuid[])', 'execute') as anon_finalize,
      has_function_privilege('authenticated', 'public.finalize_battle_media_purge(uuid[])', 'execute') as auth_finalize,
      has_function_privilege('service_role', 'public.finalize_battle_media_purge(uuid[])', 'execute') as service_finalize
  `);
  assert.deepEqual(grants, { anon_list: false, auth_list: false, service_list: true, anon_finalize: false, auth_finalize: false, service_finalize: true });
});
