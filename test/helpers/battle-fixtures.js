// Prompt Battle fixtures for behaviour tests that run against the migrated
// PGlite database (test/helpers/migrated-db.js). Rows are inserted directly as
// the database owner; only the RPC under test goes through its public
// signature. Shared by the #30 resolution tests and the #34 score audit.
import { randomUUID } from "node:crypto";

export const HOST_SECRET = "host-secret-30";

export function battleFixtures(db) {
  let roomCounter = 0;
  function nextRoomCode() {
    roomCounter += 1;
    return `R${String(roomCounter).padStart(5, "0")}`;
  }

  // entrants: [{ name, submitted = true, vetoed = false, forfeited = false }]
  // voters:   number of joined non-entrant players
  async function makeMatchup({
    entrants,
    voters = 0,
    phase = "battle_vote",
    scoring = { winnerPoints: 100, voterPoints: 10 },
    roundIndex = 0,
    matchupIndex = 0,
    pointer = matchupIndex,
  } = {}) {
    const ids = { quiz: randomUUID(), version: randomUUID(), session: randomUUID(), matchup: randomUUID() };
    const roomCode = nextRoomCode();
    const rounds = [];
    for (let index = 0; index <= roundIndex; index += 1) {
      rounds.push({ type: "prompt_battle", prompts: [{ id: `p${index}`, text: "Draw a cat" }], scoring });
    }
    await db.query("insert into public.quizzes (id, slug, title) values ($1, $2, 'Battle')", [ids.quiz, `q-${ids.quiz.slice(0, 8)}`]);
    await db.query("insert into public.quiz_versions (id, quiz_id, version, definition) values ($1, $2, 1, $3)", [ids.version, ids.quiz, JSON.stringify({ rounds })]);
    await db.query(
      `insert into public.sessions (id, room_code, quiz_version_id, host_secret_hash, phase, current_round_index, state)
       values ($1, $2, $3, public.token_hash($4), $5::public.session_phase, $6, $7)`,
      [ids.session, roomCode, ids.version, HOST_SECRET, phase, roundIndex, JSON.stringify({ phase, battleRoundIndex: roundIndex, battleMatchupIndex: pointer })]
    );
    await db.query(
      "insert into public.session_battle_matchups (id, session_id, round_index, matchup_index, prompt_id, prompt_text) values ($1, $2, $3, $4, 'p0', 'Draw a cat')",
      [ids.matchup, ids.session, roundIndex, matchupIndex]
    );

    async function addPlayer(name) {
      const playerId = randomUUID();
      await db.query(
        "insert into public.session_players (id, session_id, player_token_hash, display_name) values ($1, $2, public.token_hash($3), $4)",
        [playerId, ids.session, `token-${playerId}`, name]
      );
      return playerId;
    }

    const entries = [];
    for (const entrant of entrants) {
      const playerId = await addPlayer(entrant.name);
      const entryId = randomUUID();
      let assetId = null;
      if (entrant.submitted !== false) {
        assetId = randomUUID();
        await db.query(
          "insert into public.media_assets (id, storage_path, kind, mime_type, byte_size, source, generated_by_player_id) values ($1, $2, 'image', 'image/webp', 100, 'battle', $3)",
          [assetId, `battle/${assetId}.webp`, playerId]
        );
      }
      await db.query(
        `insert into public.session_battle_entries (id, matchup_id, player_id, submitted_asset_id, submitted_at, vetoed_at, veto_reason, forfeited_at)
         values ($1, $2, $3, $4, case when $4::uuid is null then null else now() end,
                 case when $5 then now() end, case when $5 then 'Not allowed' end, case when $6 then now() end)`,
        [entryId, ids.matchup, playerId, assetId, Boolean(entrant.vetoed), Boolean(entrant.forfeited)]
      );
      entries.push({ name: entrant.name, playerId, entryId, assetId });
    }

    const voterIds = [];
    for (let index = 0; index < voters; index += 1) voterIds.push(await addPlayer(`Voter ${index + 1}`));

    // Votes are inserted directly so a fixture can hold votes for an entry that
    // was vetoed afterwards (the host can walk phase back to battle_review).
    async function vote(voterIndex, entrantIndex) {
      await db.query("insert into public.session_battle_votes (matchup_id, voter_player_id, entry_id) values ($1, $2, $3)", [
        ids.matchup, voterIds[voterIndex], entries[entrantIndex].entryId,
      ]);
    }

    return { ...ids, roomCode, entries, voterIds, vote, addPlayer };
  }

  async function resolve(fixture, { hostSecret = HOST_SECRET, matchupId = fixture.matchup } = {}) {
    const { rows } = await db.query("select public.resolve_battle_matchup($1, $2, $3) as result", [fixture.roomCode, hostSecret, matchupId]);
    return rows[0].result;
  }

  return { makeMatchup, resolve };
}
