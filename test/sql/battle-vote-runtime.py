#!/usr/bin/env python3
"""Runtime SQL behavior driver for issue #29 (migration 0041).

Requires Python 3.8+, psql in PATH, and a disposable PostgreSQL 16.2
acceptance database. No external packages.

Usage:
  python3 test/sql/battle-vote-runtime.py --psql /path/to/psql \\
      --host /path/to/private/socket --user postgres --database acceptance_db \\
      [--migration /path/to/0041.sql]

The runner applies the supplied migration if given, then executes all ten
contract cases (V1-V10). Without a migration it still runs every case; each
case first asserts that the required RPCs exist, so a missing migration
produces ten individual assertion failures, not one global preflight exit.
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import queue
import time
import uuid
from random import choices
from string import ascii_uppercase, digits

# ---------------------------------------------------------------------------
# Load the existing issue #24 runtime helper as a module to reuse its fixtures
# and subprocess helpers without duplicating assumptions.
# ---------------------------------------------------------------------------

_HELPER_PATH = os.path.join(os.path.dirname(__file__), "battle-submission-runtime.py")
if not os.path.exists(_HELPER_PATH):
    sys.exit(f"Helper module not found at {_HELPER_PATH}")

_spec = importlib.util.spec_from_file_location("battle_submission_runtime", _HELPER_PATH)
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)

ARGS = _helper.ARGS

# Re-export helper functions under convenient names.
psql_exec = _helper.psql_exec
psql_check = _helper.psql_check
rpc = _helper.rpc
assert_rpc_exists = _helper.assert_rpc_exists
assert_required_rpcs_exist = _helper.assert_required_rpcs_exist
start_psql_async = _helper.start_psql_async
wait_for_lock = _helper.wait_for_lock
terminate_proc = _helper.terminate_proc
read_until_marker = _helper.read_until_marker
get_entry_session_snapshot = _helper.get_entry_session_snapshot
create_fixture = _helper.create_fixture
add_media_asset = _helper.add_media_asset
add_generation = _helper.add_generation
add_previous_round_entries = _helper.add_previous_round_entries
cleanup_fixture = _helper.cleanup_fixture
check_entry_submission = _helper.check_entry_submission
get_session_phase_revision = _helper.get_session_phase_revision
check_session_phase_revision = _helper.check_session_phase_revision

# ---------------------------------------------------------------------------
# Additional helpers specific to vote tests
# ---------------------------------------------------------------------------

def qlit(value):
    """SQL string literal, handling None as NULL."""
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def set_session_state(fid, state_updates):
    """Update the session's public state JSON by merging the given dict."""
    state_json = json.dumps(state_updates)
    sql = f"""
    UPDATE public.sessions
    SET state = state || {qlit(state_json)}::jsonb
    WHERE id = {qlit(fid['session_id'])};
    """
    psql_check(sql)


def update_phase(fid, phase):
    """Set session phase and state.phase."""
    sql = f"""
    UPDATE public.sessions
    SET phase = {qlit(phase)},
        state = state || jsonb_build_object('phase', {qlit(phase)})
    WHERE id = {qlit(fid['session_id'])};
    """
    psql_check(sql)


def set_matchup_index(fid, index):
    """Set state->battleMatchupIndex."""
    set_session_state(fid, {"battleMatchupIndex": index})


def get_current_matchups(fid):
    """Return list of matchup IDs for the current round."""
    sql = f"""
    SELECT id FROM public.session_battle_matchups
    WHERE session_id = {qlit(fid['session_id'])}
      AND round_index = (SELECT current_round_index FROM public.sessions WHERE id = {qlit(fid['session_id'])})
    ORDER BY matchup_index;
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"get_current_matchups failed: {err}")
    return [line.strip() for line in out.strip().splitlines() if line.strip()]


def get_entries_for_matchup(fid, matchup_id):
    """Return entry rows (id, player_id) for a given matchup."""
    sql = f"""
    SELECT id, player_id FROM public.session_battle_entries
    WHERE matchup_id = {qlit(matchup_id)}
    ORDER BY id;
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"get_entries_for_matchup failed: {err}")
    rows = []
    for line in out.strip().splitlines():
        if line:
            eid, pid = line.split("|")
            rows.append((eid, pid))
    return rows


def add_late_player(fid, display_name="Late Joiner"):
    """Insert a late-joining player with no entry and return player ID."""
    player_id = str(uuid.uuid4())
    sql = f"""
    INSERT INTO public.session_players (id, session_id, player_token_hash, display_name)
    VALUES ({qlit(player_id)}, {qlit(fid['session_id'])}, public.token_hash({qlit('late-' + player_id[:8])}), {qlit(display_name)});
    """
    psql_check(sql)
    fid["players"].append(player_id)
    return player_id


def mark_entry_viable(fid, entry_id, forfeited=False, vetoed=False):
    """Set entry submitted_asset_id to a new asset generation, or clear/forfeit."""
    if forfeited:
        sql = f"UPDATE public.session_battle_entries SET forfeited_at = now(), submitted_asset_id = NULL, submitted_at = NULL WHERE id = {qlit(entry_id)};"
        psql_check(sql)
        return
    # fresh asset
    player_id_sql = f"SELECT player_id FROM public.session_battle_entries WHERE id = {qlit(entry_id)};"
    rc, out, _ = psql_exec(player_id_sql)
    if rc != 0:
        raise RuntimeError("player lookup failed")
    player_id = out.strip()
    asset_id = add_media_asset(fid, player_id)
    # derive next attempt_index to avoid unique(entry_id, attempt_index) collision
    next_attempt_sql = f"SELECT COALESCE(MAX(attempt_index) + 1, 0) FROM public.session_battle_generations WHERE entry_id = {qlit(entry_id)};"
    rc, out, _ = psql_exec(next_attempt_sql)
    if rc != 0:
        raise RuntimeError("attempt index query failed")
    next_attempt = int(out.strip())
    add_generation(fid, entry_id, next_attempt, [asset_id])
    if vetoed:
        sql = f"UPDATE public.session_battle_entries SET vetoed_at = now(), veto_reason = 'test veto' WHERE id = {qlit(entry_id)};"
    else:
        sql = f"UPDATE public.session_battle_entries SET submitted_asset_id = {qlit(asset_id)}, submitted_at = now(), forfeited_at = NULL, vetoed_at = NULL WHERE id = {qlit(entry_id)};"
    psql_check(sql)
    return asset_id


def clear_entry_submission(fid, entry_id):
    """Clear submission and forfeit flags."""
    sql = f"UPDATE public.session_battle_entries SET submitted_asset_id = NULL, submitted_at = NULL, forfeited_at = NULL, vetoed_at = NULL WHERE id = {qlit(entry_id)};"
    psql_check(sql)


def get_vote_count(fid, matchup_id):
    sql = f"SELECT count(*) FROM public.session_battle_votes WHERE matchup_id = {qlit(matchup_id)};"
    rc, out, _ = psql_exec(sql)
    if rc != 0:
        raise RuntimeError("vote count query failed")
    return int(out.strip())


def get_session_snapshot(fid):
    """Return dict of session fields relevant for change comparison."""
    base_sql = f"""
    SELECT jsonb_build_object(
      'phase', s.phase,
      'state', s.state,
      'revision', s.revision,
      'updated_at', s.updated_at,
      'current_round_index', s.current_round_index
    ) FROM public.sessions s WHERE s.id = {qlit(fid['session_id'])};
    """
    rc, out, _ = psql_exec(base_sql)
    if rc != 0:
        raise RuntimeError("session snapshot failed")
    return json.loads(out.strip())


def get_entries_snapshot(fid):
    """Return list of entries for current round with key fields."""
    sql = f"""
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'submitted_asset_id', e.submitted_asset_id,
      'submitted_at', e.submitted_at,
      'forfeited_at', e.forfeited_at,
      'vetoed_at', e.vetoed_at,
      'veto_reason', e.veto_reason,
      'attempts_used', e.attempts_used,
      'player_id', e.player_id
    ) ORDER BY e.id)
    FROM public.session_battle_entries e
    JOIN public.session_battle_matchups m ON m.id = e.matchup_id
    WHERE m.session_id = {qlit(fid['session_id'])}
      AND m.round_index = (SELECT current_round_index FROM public.sessions WHERE id = {qlit(fid['session_id'])});
    """
    rc, out, _ = psql_exec(sql)
    if rc != 0:
        raise RuntimeError("entries snapshot failed")
    return json.loads(out.strip()) if out.strip() else []


def get_generations_snapshot(fid):
    """Return generations for current round entries."""
    sql = f"""
    SELECT jsonb_agg(jsonb_build_object(
      'id', g.id,
      'entry_id', g.entry_id,
      'attempt_index', g.attempt_index,
      'status', g.status,
      'cost_usd', g.cost_usd,
      'asset_ids', to_jsonb(g.asset_ids)
    ) ORDER BY g.id)
    FROM public.session_battle_generations g
    JOIN public.session_battle_entries e ON e.id = g.entry_id
    JOIN public.session_battle_matchups m ON m.id = e.matchup_id
    WHERE m.session_id = {qlit(fid['session_id'])}
      AND m.round_index = (SELECT current_round_index FROM public.sessions WHERE id = {qlit(fid['session_id'])});
    """
    rc, out, _ = psql_exec(sql)
    if rc != 0:
        raise RuntimeError("generations snapshot failed")
    return json.loads(out.strip()) if out.strip() else []


def get_score_events_snapshot(fid):
    """Return count of score events for session."""
    sql = f"SELECT COUNT(*) FROM public.score_events WHERE session_id = {qlit(fid['session_id'])};"
    rc, out, _ = psql_exec(sql)
    if rc != 0:
        raise RuntimeError("score events snapshot failed")
    return int(out.strip())


def get_votes_snapshot(fid):
    """Return all vote rows for session's current matchups."""
    sql = f"""
    SELECT jsonb_agg(jsonb_build_object(
      'matchup_id', v.matchup_id,
      'voter_player_id', v.voter_player_id,
      'entry_id', v.entry_id,
      'created_at', v.created_at
    ) ORDER BY v.id)
    FROM public.session_battle_votes v
    JOIN public.session_battle_matchups m ON m.id = v.matchup_id
    WHERE m.session_id = {qlit(fid['session_id'])}
      AND m.round_index = (SELECT current_round_index FROM public.sessions WHERE id = {qlit(fid['session_id'])});
    """
    rc, out, _ = psql_exec(sql)
    if rc != 0:
        raise RuntimeError("votes snapshot failed")
    return json.loads(out.strip()) if out.strip() else []


def get_full_snapshot(fid):
    """Full snapshot of session, entries, generations, score events, votes."""
    return {
        "session": get_session_snapshot(fid),
        "entries": get_entries_snapshot(fid),
        "generations": get_generations_snapshot(fid),
        "score_events": get_score_events_snapshot(fid),
        "votes": get_votes_snapshot(fid),
    }


def probe_media(role, room, asset_id, host_secret=None, player_token=None):
    """Call can_access_live_media and return a Python bool using to_jsonb output."""
    args = [qlit(room), qlit(asset_id)]
    if host_secret is not None:
        args.append(qlit(host_secret))
    else:
        args.append("NULL")
    if player_token is not None:
        args.append(qlit(player_token))
    else:
        args.append("NULL")
    call = f"SELECT to_jsonb(public.can_access_live_media({', '.join(args)}));"
    return rpc(role, call)


def host_battle_state(fid, host_secret="hostsecret"):
    """Call get_host_battle_state as anon and return parsed JSON."""
    call = f"SELECT public.get_host_battle_state({qlit(fid['room_code'])}, {qlit(host_secret)});"
    return rpc("anon", call)


# ---------------------------------------------------------------------------
# Contract cases V1-V10
# ---------------------------------------------------------------------------

def run_case_v1():
    assert_required_rpcs_exist(["public.cast_battle_vote(text,text,uuid,uuid)"])
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=4)
    try:
        matchups = get_current_matchups(fid)
        assert len(matchups) == 2, "expected 2 matchups"
        matchup1, matchup2 = matchups
        entries1 = get_entries_for_matchup(fid, matchup1)
        entries2 = get_entries_for_matchup(fid, matchup2)
        assert len(entries1) == 2 and len(entries2) == 2
        for eid, _ in entries1 + entries2:
            mark_entry_viable(fid, eid)
        set_matchup_index(fid, 0)

        # Snapshot before any rejection
        before = get_full_snapshot(fid)

        # --- Rejection cases (no writes expected) ---
        # Wrong room
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote('AAAAAA', 'player-{entries1[0][1][:8]}', {qlit(matchup1)}, {qlit(entries1[1][0])}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 wrong room should fail"
        assert "permission denied" not in err.lower() and "syntax error" not in err.lower()

        # Wrong token
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'wrong-token', {qlit(matchup1)}, {qlit(entries1[1][0])}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 wrong token should fail"
        assert "permission denied" not in err.lower() and "syntax error" not in err.lower()

        # Null IDs
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{fid['players'][0][:8]}', NULL, {qlit(entries1[1][0])}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 null matchup should fail"
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{fid['players'][0][:8]}', {qlit(matchup1)}, NULL); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 null entry should fail"

        # Left player should reject
        left_pid = fid["players"][0]
        psql_check(f"UPDATE public.session_players SET left_at = now() WHERE id = {qlit(left_pid)};")
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'player-{left_pid[:8]}', {qlit(matchup1)}, {qlit(entries1[1][0])}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 left player should fail"
        psql_check(f"UPDATE public.session_players SET left_at = NULL WHERE id = {qlit(left_pid)};")

        # Entrant of current matchup should reject (even if moderated later)
        entrant_pid = entries1[0][1]
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'player-{entrant_pid[:8]}', {qlit(matchup1)}, {qlit(entries1[1][0])}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 entrant vote should fail"
        assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
        assert any(token in err.lower() for token in ["entrant", "matchup", "vote"]), f"V1 entrant error not meaningful: {err}"

        # Entrant still rejected when own entry moderated (vetoed) while other target viable
        # Veto first entrant, then they attempt to vote for second entry
        psql_check(f"UPDATE public.session_battle_entries SET vetoed_at = now(), veto_reason='test' WHERE id = {qlit(entries1[0][0])};")
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'player-{entrant_pid[:8]}', {qlit(matchup1)}, {qlit(entries1[1][0])}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V1 moderated entrant should fail"
        psql_check(f"UPDATE public.session_battle_entries SET vetoed_at = NULL, veto_reason=NULL WHERE id = {qlit(entries1[0][0])};")

        # Immutability check after rejections (excluding session_players left_at toggles)
        after_rejections = get_full_snapshot(fid)
        assert before == after_rejections, "V1 rejections mutated immutable tables"

        # --- Success cases ---
        late_pid = add_late_player(fid)
        # Anon late joiner votes
        res = rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup1)}, {qlit(entries1[1][0])});")
        assert set(res.keys()) == {"voteId", "matchupId", "votedAt"}, f"V1 vote receipt keys wrong: {res}"

        # Authenticated other matchup player votes (allowed)
        other_pid = entries2[0][1]
        res2 = rpc("authenticated", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'player-{other_pid[:8]}', {qlit(matchup1)}, {qlit(entries1[0][0])});")
        assert set(res2.keys()) == {"voteId", "matchupId", "votedAt"}, "V1 authenticated other matchup voter failed"

        assert get_vote_count(fid, matchup1) == 2, "V1 vote count should be 2 after two successes"
        print("V1 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_v2():
    assert_required_rpcs_exist(["public.cast_battle_vote(text,text,uuid,uuid)"])
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=3)
    try:
        matchups = get_current_matchups(fid)
        assert len(matchups) == 1
        matchup = matchups[0]
        entries = get_entries_for_matchup(fid, matchup)
        assert len(entries) == 3
        for eid, _ in entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)

        before = get_full_snapshot(fid)
        target_eid = entries[0][0]
        res = rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(target_eid)});")
        assert set(res.keys()) == {"voteId", "matchupId", "votedAt"}, f"V2 receipt keys: {res}"

        # Verify vote row exists
        sql = f"SELECT count(*) FROM public.session_battle_votes WHERE matchup_id = {qlit(matchup)} AND voter_player_id = {qlit(late_pid)} AND entry_id = {qlit(target_eid)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "1", "V2 vote row not correct"

        after = get_full_snapshot(fid)
        # Session: revision+1, updated_at increased; other fields unchanged
        assert after["session"]["revision"] == before["session"]["revision"] + 1, "V2 revision should increment by 1"
        assert after["session"]["updated_at"] > before["session"]["updated_at"], "V2 updated_at should increase"
        assert after["session"]["phase"] == before["session"]["phase"], "V2 phase changed"
        assert after["session"]["state"] == before["session"]["state"], "V2 state changed"
        assert after["session"]["current_round_index"] == before["session"]["current_round_index"]
        # Entries/generations/score_events unchanged
        assert after["entries"] == before["entries"], "V2 entries changed"
        assert after["generations"] == before["generations"], "V2 generations changed"
        assert after["score_events"] == before["score_events"], "V2 score events changed"
        # Votes now contains one row
        assert len(after["votes"]) == 1, "V2 expected one vote row"

        # Host helper counts
        host = host_battle_state(fid)
        matchup_data = next(m for m in host['matchups'] if m['matchupId'] == matchup)
        assert matchup_data['votesCast'] == 1, f"V2 votesCast wrong: {matchup_data['votesCast']}"
        assert matchup_data['eligibleVoters'] == 1, f"V2 eligibleVoters wrong: {matchup_data['eligibleVoters']}"
        print("V2 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_v3():
    assert_required_rpcs_exist(["public.cast_battle_vote(text,text,uuid,uuid)"])
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=2)
    try:
        matchup = get_current_matchups(fid)[0]
        entries = get_entries_for_matchup(fid, matchup)
        for eid, _ in entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)
        target_eid = entries[0][0]

        rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(target_eid)});")
        after_first = get_full_snapshot(fid)

        # Duplicate identical
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(target_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V3 duplicate identical should fail"
        assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
        assert any(token in err.lower() for token in ["duplicate", "unique", "already voted"]), f"V3 duplicate error not meaningful: {err}"

        # Changed choice
        other_eid = entries[1][0]
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(other_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V3 changed choice should fail"
        assert any(token in err.lower() for token in ["duplicate", "unique", "already voted"]), f"V3 changed choice error not meaningful: {err}"

        # Only one vote, original choice preserved
        sql = f"SELECT entry_id FROM public.session_battle_votes WHERE matchup_id = {qlit(matchup)} AND voter_player_id = {qlit(late_pid)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == target_eid, "V3 original vote row changed"
        assert get_vote_count(fid, matchup) == 1

        # Full snapshot unchanged after duplicates
        after_dupes = get_full_snapshot(fid)
        assert after_first == after_dupes, "V3 session/state changed on duplicate"
        print("V3 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_v4():
    assert_required_rpcs_exist([
        "public.cast_battle_vote(text,text,uuid,uuid)",
        "public.set_live_room_state(text,text,public.session_phase,integer,integer,jsonb)",
    ])
    fid = create_fixture(session_phase='battle_vote', current_round_index=1, num_players=4)
    other_fid = None
    try:
        matchups = get_current_matchups(fid)
        assert len(matchups) == 2, "V4 expected 2 current matchups"
        entries = []
        for m in matchups:
            entries.extend(get_entries_for_matchup(fid, m))
        assert len(entries) == 4
        for eid, _ in entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)
        current_matchup0 = matchups[0]
        current_matchup1 = matchups[1]
        entries_m0 = get_entries_for_matchup(fid, current_matchup0)
        entries_m1 = get_entries_for_matchup(fid, current_matchup1)
        target_m0 = entries_m0[0][0]
        target_m1 = entries_m1[0][0]

        # Add previous round entries ONCE at round 0
        prev = add_previous_round_entries(fid, num_players=2, round_index=0)
        prev_matchup_id = prev['matchup_ids'][0]
        prev_entry_id = prev['entry_ids'][0]

        # Wrong phases
        for phase in ['lobby', 'battle_prompt', 'battle_review', 'battle_result', 'complete']:
            update_phase(fid, phase)
            rc, out, err = psql_exec(
                f"BEGIN; SET LOCAL ROLE anon; "
                f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(current_matchup0)}, {qlit(target_m0)}); "
                f"ROLLBACK;", check=False)
            assert rc != 0, f"V4 phase {phase} should fail"
            assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
            assert any(token in err.lower() for token in ["battle_vote", "phase"]), f"V4 {phase} error not meaningful: {err}"
            assert get_vote_count(fid, current_matchup0) == 0, f"V4 vote inserted in phase {phase}"
            update_phase(fid, 'battle_vote')

        # Invalid pointer values
        invalid_states = [
            ("missing", None),
            ("null", {"battleMatchupIndex": None}),
            ("string", {"battleMatchupIndex": "0"}),
            ("bool", {"battleMatchupIndex": True}),
            ("fractional", {"battleMatchupIndex": 1.5}),
            ("negative", {"battleMatchupIndex": -1}),
            ("huge", {"battleMatchupIndex": 2147483648}),
        ]
        for label, state_val in invalid_states:
            if state_val is None:
                psql_check(f"UPDATE public.sessions SET state = state - 'battleMatchupIndex' WHERE id = {qlit(fid['session_id'])};")
            else:
                set_session_state(fid, state_val)
            rc, out, err = psql_exec(
                f"BEGIN; SET LOCAL ROLE anon; "
                f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(current_matchup0)}, {qlit(target_m0)}); "
                f"ROLLBACK;", check=False)
            assert rc != 0, f"V4 pointer {label} should fail"
            assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
            assert any(token in err.lower() for token in ["battleMatchupIndex", "matchup", "pointer"]), f"V4 pointer {label} error not meaningful: {err}"
            set_matchup_index(fid, 0)

        # Old round / wrong matchup (previous round matchup/entry)
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(prev_matchup_id)}, {qlit(prev_entry_id)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V4 old round should fail"
        assert any(token in err.lower() for token in ["round", "matchup"]), f"V4 old round error: {err}"

        # Other room
        other_fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=2)
        other_matchup = get_current_matchups(other_fid)[0]
        other_entries = get_entries_for_matchup(other_fid, other_matchup)
        for eid, _ in other_entries:
            mark_entry_viable(other_fid, eid)
        other_target = other_entries[0][0]
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(other_matchup)}, {qlit(other_target)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V4 other room should fail"
        assert any(token in err.lower() for token in ["room", "session", "not"]), f"V4 other room error: {err}"

        # Resolved matchup
        psql_check(f"UPDATE public.session_battle_matchups SET resolved_at = now() WHERE id = {qlit(current_matchup0)};")
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(current_matchup0)}, {qlit(target_m0)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V4 resolved should fail"
        psql_check(f"UPDATE public.session_battle_matchups SET resolved_at = NULL WHERE id = {qlit(current_matchup0)};")

        # Host set_live_room_state valid as anon and authenticated
        anon_res = rpc("anon", f"SELECT public.set_live_room_state({qlit(fid['room_code'])}, 'hostsecret', 'battle_vote', 1, 0, jsonb_build_object('battleMatchupIndex', 1));")
        assert anon_res['state'].get('battleMatchupIndex') == 1, "V4 anon host setter did not set pointer"
        auth_res = rpc("authenticated", f"SELECT public.set_live_room_state({qlit(fid['room_code'])}, 'hostsecret', 'battle_vote', 1, 0, jsonb_build_object('battleMatchupIndex', 0));")
        assert auth_res['state'].get('battleMatchupIndex') == 0, "V4 authenticated host setter did not set pointer"

        # Wrong host secret rejects
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.set_live_room_state({qlit(fid['room_code'])}, 'wrongsecret', 'battle_vote', 1, 0, jsonb_build_object('battleMatchupIndex', 0)); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V4 wrong host secret should reject"
        assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
        assert "host" in err.lower() or "authorization" in err.lower(), f"V4 wrong host error not meaningful: {err}"

        # After setting pointer to 1, only matchup1 entries accept votes
        rpc("anon", f"SELECT public.set_live_room_state({qlit(fid['room_code'])}, 'hostsecret', 'battle_vote', 1, 0, jsonb_build_object('battleMatchupIndex', 1));")
        # vote for matchup1 entry should succeed
        res = rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(current_matchup1)}, {qlit(target_m1)});")
        assert set(res.keys()) == {"voteId", "matchupId", "votedAt"}, "V4 pointer1 vote for matchup1 failed"
        # vote for matchup0 entry should reject
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(current_matchup0)}, {qlit(target_m0)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V4 pointer1 vote for matchup0 should reject"
        assert get_vote_count(fid, current_matchup1) == 1, "V4 vote count after valid pointer vote wrong"
        print("V4 PASS")
    finally:
        cleanup_fixture(fid)
        if other_fid:
            cleanup_fixture(other_fid)


def run_case_v5():
    assert_required_rpcs_exist(["public.cast_battle_vote(text,text,uuid,uuid)"])
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=4)
    other_fid = None
    try:
        matchups = get_current_matchups(fid)
        assert len(matchups) == 2
        target_matchup = matchups[0]
        other_matchup = matchups[1]
        target_entries = get_entries_for_matchup(fid, target_matchup)
        other_entries = get_entries_for_matchup(fid, other_matchup)
        assert len(target_entries) == 2 and len(other_entries) == 2
        # Mark all viable initially
        for eid, _ in target_entries + other_entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)

        normal_eid, normal_pid = target_entries[0]
        unsubmitted_eid, _ = target_entries[1]

        # Unsubmitted target
        clear_entry_submission(fid, unsubmitted_eid)
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(unsubmitted_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V5 unsubmitted should fail"
        assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
        assert any(token in err.lower() for token in ["submitted", "asset", "valid"]), f"V5 unsubmitted error: {err}"
        # restore submission
        mark_entry_viable(fid, unsubmitted_eid)

        # Vetoed target
        psql_check(f"UPDATE public.session_battle_entries SET vetoed_at = now(), veto_reason='test' WHERE id = {qlit(normal_eid)};")
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(normal_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V5 vetoed should fail"
        assert any(token in err.lower() for token in ["veto", "entry", "valid"]), f"V5 vetoed error: {err}"
        psql_check(f"UPDATE public.session_battle_entries SET vetoed_at = NULL, veto_reason=NULL WHERE id = {qlit(normal_eid)};")

        # Forfeited target
        mark_entry_viable(fid, normal_eid, forfeited=True)
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(normal_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V5 forfeited should fail"
        assert any(token in err.lower() for token in ["forfeit", "entry", "valid"]), f"V5 forfeited error: {err}"
        mark_entry_viable(fid, normal_eid)

        # Wrong matchup entry
        other_eid = other_entries[0][0]
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(other_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V5 wrong matchup entry should fail"
        assert any(token in err.lower() for token in ["matchup", "belong", "valid"]), f"V5 wrong matchup error: {err}"

        # Cross session entry
        other_fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=2)
        other_matchup2 = get_current_matchups(other_fid)[0]
        other_entries2 = get_entries_for_matchup(other_fid, other_matchup2)
        for eid, _ in other_entries2:
            mark_entry_viable(other_fid, eid)
        cross_eid = other_entries2[0][0]
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(cross_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V5 cross session should fail"
        assert any(token in err.lower() for token in ["session", "matchup", "belong", "valid"]), f"V5 cross session error: {err}"

        # Media wrong owner
        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(normal_eid)};"
        rc, out, _ = psql_exec(sql)
        asset_id = out.strip()
        asset_owner = normal_pid
        other_player_id = other_entries[0][1]
        psql_check(f"UPDATE public.media_assets SET generated_by_player_id = {qlit(other_player_id)} WHERE id = {qlit(asset_id)};")
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(normal_eid)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "V5 media wrong owner should fail"
        assert any(token in err.lower() for token in ["asset", "image", "generated", "owner"]), f"V5 media owner error: {err}"
        psql_check(f"UPDATE public.media_assets SET generated_by_player_id = {qlit(asset_owner)} WHERE id = {qlit(asset_id)};")

        # Membership: other matchup player allowed, late joiner allowed (entrant already rejected in V1)
        other_pid = other_entries[0][1]
        res = rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'player-{other_pid[:8]}', {qlit(target_matchup)}, {qlit(normal_eid)});")
        assert set(res.keys()) == {"voteId", "matchupId", "votedAt"}, "V5 other matchup voter should succeed"
        # Late joiner already added; test late joiner success
        res2 = rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(target_matchup)}, {qlit(unsubmitted_eid)});")
        assert set(res2.keys()) == {"voteId", "matchupId", "votedAt"}, "V5 late joiner should succeed"
        print("V5 PASS")
    finally:
        cleanup_fixture(fid)
        if other_fid:
            cleanup_fixture(other_fid)


def run_case_v6():
    assert_required_rpcs_exist([
        "public.cast_battle_vote(text,text,uuid,uuid)",
        "public.can_access_live_media(text, uuid, text, text)",
    ])
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=4)
    try:
        matchups = get_current_matchups(fid)
        target_matchup = matchups[0]
        other_matchup = matchups[1]
        target_entries = get_entries_for_matchup(fid, target_matchup)
        other_entries = get_entries_for_matchup(fid, other_matchup)
        for eid, _ in target_entries + other_entries:
            mark_entry_viable(fid, eid)
        asset_for_target = None
        for eid, _ in target_entries:
            sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(eid)};"
            rc, out, _ = psql_exec(sql)
            if out.strip():
                asset_for_target = out.strip()
                break
        assert asset_for_target, "V6 no asset for target"
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)
        entrant_pid = target_entries[0][1]
        other_pid = other_entries[0][1]

        # Allowed in battle_vote phase
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + entrant_pid[:8]) is True, "V6 entrant should access"
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='late-' + late_pid[:8]) is True, "V6 late joiner should access"
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + other_pid[:8]) is True, "V6 other matchup player should access"

        # Denied: other matchup asset
        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(other_entries[0][0])};"
        rc, out, _ = psql_exec(sql)
        asset_other = out.strip()
        assert asset_other, "V6 no asset for other matchup"
        assert probe_media("anon", fid['room_code'], asset_other, player_token='player-' + entrant_pid[:8]) is False, "V6 other matchup asset denied"

        # Own unused variant (new generation not submitted)
        unused_asset = add_media_asset(fid, entrant_pid)
        next_attempt = int(psql_exec(f"SELECT COALESCE(MAX(attempt_index)+1,0) FROM public.session_battle_generations WHERE entry_id = {qlit(target_entries[0][0])};")[1].strip())
        add_generation(fid, target_entries[0][0], next_attempt, [unused_asset], status='complete')
        assert probe_media("anon", fid['room_code'], unused_asset, player_token='player-' + entrant_pid[:8]) is False, "V6 own unused variant denied"

        # Unsubmitted asset (owned by other player but not submitted)
        unsubmitted_asset = add_media_asset(fid, other_pid)
        next_attempt2 = int(psql_exec(f"SELECT COALESCE(MAX(attempt_index)+1,0) FROM public.session_battle_generations WHERE entry_id = {qlit(other_entries[0][0])};")[1].strip())
        add_generation(fid, other_entries[0][0], next_attempt2, [unsubmitted_asset], status='complete')
        assert probe_media("anon", fid['room_code'], unsubmitted_asset, player_token='player-' + entrant_pid[:8]) is False, "V6 unsubmitted asset denied"

        # Vetoed and forfeited asset
        psql_check(f"UPDATE public.session_battle_entries SET vetoed_at = now(), veto_reason='x' WHERE id = {qlit(target_entries[0][0])};")
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + entrant_pid[:8]) is False, "V6 vetoed asset denied"
        psql_check(f"UPDATE public.session_battle_entries SET vetoed_at = NULL, veto_reason=NULL WHERE id = {qlit(target_entries[0][0])};")
        psql_check(f"UPDATE public.session_battle_entries SET forfeited_at = now(), submitted_asset_id = NULL, submitted_at = NULL WHERE id = {qlit(target_entries[0][0])};")
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + entrant_pid[:8]) is False, "V6 forfeited asset denied"
        mark_entry_viable(fid, target_entries[0][0])
        asset_for_target = psql_exec(f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(target_entries[0][0])};")[1].strip()

        # Invalid cursor fails closed
        set_matchup_index(fid, 99)
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + entrant_pid[:8]) is False, "V6 invalid cursor should deny"
        set_matchup_index(fid, 0)

        # Unknown asset/room/token/null creds
        unknown_asset = str(uuid.uuid4())
        assert probe_media("anon", fid['room_code'], unknown_asset, player_token='player-' + entrant_pid[:8]) is False, "V6 unknown asset denied"
        assert probe_media("anon", 'AAAAAA', asset_for_target, player_token='player-' + entrant_pid[:8]) is False, "V6 wrong room denied"
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='wrong-token') is False, "V6 wrong token denied"
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token=None) is False, "V6 null token denied"

        # Now test battle_result phase (subset)
        update_phase(fid, 'battle_result')
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + entrant_pid[:8]) is True, "V6 result phase entrant should access"
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='late-' + late_pid[:8]) is True, "V6 result phase late joiner should access"
        set_matchup_index(fid, 99)
        assert probe_media("anon", fid['room_code'], asset_for_target, player_token='player-' + entrant_pid[:8]) is False, "V6 result phase invalid cursor denied"
        set_matchup_index(fid, 0)
        print("V6 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_v7():
    assert_required_rpcs_exist([
        "public.cast_battle_vote(text,text,uuid,uuid)",
        "public.can_access_live_media(text, uuid, text, text)",
    ])
    fid = create_fixture(session_phase='battle_prompt', current_round_index=0, num_players=2)
    fid2 = None
    try:
        matchup = get_current_matchups(fid)[0]
        entries = get_entries_for_matchup(fid, matchup)
        p1, p2 = entries[0][1], entries[1][1]
        e1, e2 = entries[0][0], entries[1][0]

        # Own recorded asset for p1
        own_asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [own_asset])
        # Owner p1 allowed in battle_prompt
        assert probe_media("anon", fid['room_code'], own_asset, player_token='player-' + p1[:8]) is True, "V7 owner in prompt should be allowed"
        # Non-owner p2 denied
        assert probe_media("anon", fid['room_code'], own_asset, player_token='player-' + p2[:8]) is False, "V7 non-owner in prompt should be denied"

        # Other phase (complete) denied
        update_phase(fid, 'complete')
        assert probe_media("anon", fid['room_code'], own_asset, player_token='player-' + p1[:8]) is False, "V7 complete phase should deny"
        update_phase(fid, 'battle_review')

        # Host battle cross session denial
        fid2 = create_fixture(session_phase='battle_review', current_round_index=0, num_players=2)
        other_asset = add_media_asset(fid2, fid2['players'][0])
        other_entry = fid2['entries'][0]
        add_generation(fid2, other_entry, 0, [other_asset])
        assert probe_media("anon", fid['room_code'], other_asset, host_secret='hostsecret') is False, "V7 host cross session should be denied"

        # Host authored asset referenced in quiz definition
        auth_user_id = str(uuid.uuid4())
        psql_check(f"INSERT INTO auth.users (id) VALUES ({qlit(auth_user_id)});")
        fid["auth_user_ids"].append(auth_user_id)
        author_asset = add_media_asset(fid, p1, source='author', kind='image', uploaded_by=auth_user_id)
        psql_check(f"UPDATE public.media_assets SET generated_by_player_id = NULL WHERE id = {qlit(author_asset)};")
        # Update quiz definition to include the asset id string anywhere
        psql_check(f"""
        UPDATE public.quiz_versions
        SET definition = definition || jsonb_build_object('promptAssetRef', {qlit(author_asset)})
        WHERE id = {qlit(fid['version_id'])};
        """)
        assert probe_media("anon", fid['room_code'], author_asset, host_secret='hostsecret') is True, "V7 host authored asset should be allowed"

        # Player question options author asset
        # Set session state to include question options with imageAssetId = author_asset
        set_session_state(fid, {
            "question": {
                "options": [
                    {"imageAssetId": author_asset}
                ]
            }
        })
        assert probe_media("anon", fid['room_code'], author_asset, player_token='player-' + p1[:8]) is True, "V7 player question option asset should be allowed"
        # Remove state and verify denied
        psql_check(f"UPDATE public.sessions SET state = state - 'question' WHERE id = {qlit(fid['session_id'])};")
        assert probe_media("anon", fid['room_code'], author_asset, player_token='player-' + p1[:8]) is False, "V7 player question option asset removed should deny"

        print("V7 PASS")
    finally:
        cleanup_fixture(fid)
        if fid2:
            cleanup_fixture(fid2)


def run_case_v8():
    assert_required_rpcs_exist([
        "public.cast_battle_vote(text,text,uuid,uuid)",
        "public.get_live_room_state(text,text)",
        "public.get_player_battle_state(text,text)",
        "public.get_host_battle_state(text,text)",
    ])
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=3)
    try:
        matchup = get_current_matchups(fid)[0]
        entries = get_entries_for_matchup(fid, matchup)
        for eid, _ in entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)
        target_eid = entries[0][0]

        vote_receipt = rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(target_eid)});")
        assert set(vote_receipt.keys()) == {"voteId", "matchupId", "votedAt"}

        # Public state and get_live_room_state must not leak vote progress/creator/other choices
        forbidden_keys = ["votesCast", "eligibleVoters", "voteCounts", "voterPlayerId", "voterId", "creator"]
        sql = f"SELECT state FROM public.sessions WHERE id = {qlit(fid['session_id'])};"
        rc, out, _ = psql_exec(sql)
        state = json.loads(out.strip())
        def walk(obj, path="state"):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if k in forbidden_keys:
                        raise AssertionError(f"V8 state leaks {k}")
                    walk(v, path+"."+k)
            elif isinstance(obj, list):
                for item in obj:
                    walk(item, path)
        walk(state)

        # get_live_room_state (public)
        live_state = rpc("anon", f"SELECT public.get_live_room_state({qlit(fid['room_code'])}, 'late-{late_pid[:8]}')")
        for key in forbidden_keys:
            assert key not in live_state, f"V8 get_live_room_state leaks {key}"

        # get_player_battle_state: own entry null for late joiner; no forbidden keys
        player_battle = rpc("anon", f"SELECT public.get_player_battle_state({qlit(fid['room_code'])}, 'late-{late_pid[:8]}')")
        assert "entry" in player_battle and player_battle["entry"] is None, "V8 late joiner entry should be null"
        for key in forbidden_keys:
            assert key not in player_battle, f"V8 get_player_battle_state leaks {key}"

        # Host helper preserves 0040 keys at correct levels
        host = host_battle_state(fid)
        assert "roundIndex" in host and "opened" in host and "matchups" in host
        assert "sessionSpendUsd" in host and "maxSessionSpendUsd" in host
        assert "roomCode" in host and "revision" in host and "phase" in host
        assert "shuffleSeed" in host and "engine" in host
        matchup_data = next(m for m in host['matchups'] if m['matchupId'] == matchup)
        assert "matchupId" in matchup_data and "matchupIndex" in matchup_data
        assert "promptId" in matchup_data and "promptText" in matchup_data
        assert "resolvedAt" in matchup_data and "viableEntryIds" in matchup_data
        assert "skipped" in matchup_data and "entrants" in matchup_data
        assert "votesCast" in matchup_data and "eligibleVoters" in matchup_data
        assert matchup_data['votesCast'] == 1
        assert matchup_data['eligibleVoters'] == 1  # only late joiner eligible; 3 entrants + late = 4, entrants=3

        # Entrant keys
        entrant = matchup_data['entrants'][0]
        for key in ["entryId", "playerId", "playerName", "logoKey", "attemptsUsed", "submitted",
                    "submittedAssetId", "submittedAt", "forfeited", "forfeitedAt", "vetoed",
                    "vetoedAt", "vetoReason", "viable", "generations"]:
            assert key in entrant, f"V8 entrant missing {key}"
        assert isinstance(entrant["generations"], list), "V8 generations should be list"

        # Wrong host denied
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; SELECT public.get_host_battle_state({qlit(fid['room_code'])}, 'wrongsecret'); ROLLBACK;", check=False)
        assert rc != 0, "V8 wrong host denied"
        assert "host" in err.lower() or "authorization" in err.lower()

        # Host helper does not contain voter_player_id or entry_id (snake)
        helper_sql = f"SELECT jsonb_pretty(public.host_battle_state_payload({qlit(fid['session_id'])}, 0));"
        rc, out, _ = psql_exec(helper_sql)
        assert "voter_player_id" not in out, "V8 host helper leaks voter_player_id"
        assert "entry_id" not in out, "V8 host helper leaks entry_id"
        print("V8 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_v9():
    assert_required_rpcs_exist([
        "public.cast_battle_vote(text,text,uuid,uuid)",
        "public.can_access_live_media(text, uuid, text, text)",
    ])
    # Direct table ACLs and RLS
    table = "public.session_battle_votes"
    # RLS enabled?
    rc, out, _ = psql_exec(f"SELECT relrowsecurity FROM pg_class WHERE oid = '{table}'::regclass;")
    assert out.strip() == "t", "V9 RLS not enabled on votes table"
    # No policies
    rc, out, _ = psql_exec(f"SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='session_battle_votes';")
    assert out.strip() == "0", "V9 policies exist on votes table"

    # Direct browser role access denied
    for role in ["anon", "authenticated"]:
        for op in ["SELECT", "INSERT", "UPDATE", "DELETE"]:
            if op == "SELECT":
                sql = f"SELECT * FROM {table} LIMIT 1;"
            elif op == "INSERT":
                sql = f"INSERT INTO {table} (matchup_id, voter_player_id, entry_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid());"
            elif op == "UPDATE":
                sql = f"UPDATE {table} SET created_at = now() WHERE false;"
            elif op == "DELETE":
                sql = f"DELETE FROM {table} WHERE false;"
            rc, out, err = psql_exec(f"BEGIN; SET LOCAL ROLE {role}; {sql} ROLLBACK;", check=False)
            assert rc != 0, f"V9 direct {op} as {role} should be denied"
            assert "permission denied" in err.lower(), f"V9 expected permission denied for {role} {op}, got: {err}"

    # service_role SELECT works, writes denied
    rc, out, err = psql_exec(f"BEGIN; SET LOCAL ROLE service_role; SELECT count(*) FROM {table}; COMMIT;", check=False)
    assert rc == 0, f"V9 service_role select failed: {err}"
    for op in ["INSERT", "UPDATE", "DELETE"]:
        if op == "INSERT":
            sql = f"INSERT INTO {table} (matchup_id, voter_player_id, entry_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid());"
        elif op == "UPDATE":
            sql = f"UPDATE {table} SET created_at = now() WHERE false;"
        elif op == "DELETE":
            sql = f"DELETE FROM {table} WHERE false;"
        rc, out, err = psql_exec(f"BEGIN; SET LOCAL ROLE service_role; {sql} ROLLBACK;", check=False)
        assert rc != 0, f"V9 service_role {op} denied"
        assert "permission denied" in err.lower()

    # Function ACLs
    vote_fn = "public.cast_battle_vote(text,text,uuid,uuid)"
    # anon/auth have EXECUTE, service does not
    for role, expected in [("anon", "t"), ("authenticated", "t"), ("service_role", "f")]:
        rc, out, _ = psql_exec(f"SELECT has_function_privilege('{role}', '{vote_fn}', 'EXECUTE');")
        assert out.strip() == expected, f"V9 cast ACL for {role} expected {expected}"
    # PUBLIC has no privileges (grantee 0 via aclexplode)
    rc, out, _ = psql_exec(f"""
        SELECT EXISTS (
            SELECT 1 FROM pg_proc p
            CROSS JOIN LATERAL aclexplode(p.proacl) x
            WHERE p.oid = '{vote_fn}'::regprocedure AND x.grantee = 0
        );
    """)
    assert out.strip() == "f", "V9 PUBLIC should not have privileges on cast_battle_vote"

    # host_battle_state_payload revoked from all roles and public
    helper_fn = "public.host_battle_state_payload(uuid,integer)"
    for role in ["anon", "authenticated", "service_role", "public"]:
        if role == "public":
            rc, out, _ = psql_exec(f"""
                SELECT EXISTS (
                    SELECT 1 FROM pg_proc p
                    CROSS JOIN LATERAL aclexplode(p.proacl) x
                    WHERE p.oid = '{helper_fn}'::regprocedure AND x.grantee = 0
                );
            """)
            assert out.strip() == "f", "V9 PUBLIC should not have helper privileges"
        else:
            rc, out, _ = psql_exec(f"SELECT has_function_privilege('{role}', '{helper_fn}', 'EXECUTE');")
            assert out.strip() == "f", f"V9 helper {role} should be revoked"

    # Direct actual call to helper as each role denied
    for role in ["anon", "authenticated", "service_role"]:
        rc, out, err = psql_exec(f"BEGIN; SET LOCAL ROLE {role}; SELECT {helper_fn.split('(')[0]}(gen_random_uuid(), 0); ROLLBACK;", check=False)
        assert rc != 0, f"V9 direct helper call as {role} should fail"
        assert "permission denied" in err.lower()

    # can_access_live_media granted to anon/auth/service
    media_fn = "public.can_access_live_media(text,uuid,text,text)"
    for role, expected in [("anon", "t"), ("authenticated", "t"), ("service_role", "t")]:
        rc, out, _ = psql_exec(f"SELECT has_function_privilege('{role}', '{media_fn}', 'EXECUTE');")
        assert out.strip() == expected, f"V9 media ACL for {role} expected {expected}"

    # FK cascade cleanup
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=2)
    try:
        matchup = get_current_matchups(fid)[0]
        entries = get_entries_for_matchup(fid, matchup)
        for eid, _ in entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)
        target = entries[0][0]
        rpc("anon", f"SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(target)});")
        assert get_vote_count(fid, matchup) == 1
        cleanup_fixture(fid)
        fid = None
        # Verify votes removed
        rc, out, _ = psql_exec(f"SELECT count(*) FROM public.session_battle_votes WHERE matchup_id = {qlit(matchup)};")
        assert out.strip() == "0", "V9 cascade failed"
        print("V9 PASS")
    finally:
        if fid:
            cleanup_fixture(fid)


def run_case_v10():
    assert_required_rpcs_exist([
        "public.cast_battle_vote(text,text,uuid,uuid)",
        "public.set_live_room_state(text,text,public.session_phase,integer,integer,jsonb)",
    ])
    # Part A: hold session row, start vote, host advances phase/cursor, vote rejects
    fid = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=2)
    proc_hold = proc_vote = None
    try:
        matchup = get_current_matchups(fid)[0]
        entries = get_entries_for_matchup(fid, matchup)
        for eid, _ in entries:
            mark_entry_viable(fid, eid)
        late_pid = add_late_player(fid)
        set_matchup_index(fid, 0)
        target = entries[0][0]

        # Holder admin locks session row (default superuser, no SET ROLE)
        app_hold = "v10_hold_" + fid["room_code"]
        hold_sql = f"""
BEGIN;
SELECT * FROM public.sessions WHERE id = {qlit(fid['session_id'])} FOR UPDATE;
\\echo HOLD_READY
"""
        proc_hold = start_psql_async(hold_sql, app_hold, keep_open=True)
        assert read_until_marker(proc_hold, "HOLD_READY", timeout=15), "V10 hold process did not signal ready"

        # Start voter async
        app_vote = "v10_vote_" + fid["room_code"]
        vote_sql = f"""
BEGIN;
SET LOCAL ROLE anon;
SET LOCAL statement_timeout = '15s';
SELECT public.cast_battle_vote({qlit(fid['room_code'])}, 'late-{late_pid[:8]}', {qlit(matchup)}, {qlit(target)});
COMMIT;
"""
        proc_vote = start_psql_async(vote_sql, app_vote, keep_open=False)
        assert wait_for_lock(app_vote, timeout=15), "V10 vote did not wait on lock"

        # Unrelated admin entry FOR UPDATE NOWAIT should succeed (not locked)
        rc, out, err = psql_exec(
            f"BEGIN; SELECT id FROM public.session_battle_entries WHERE id = {qlit(target)} FOR UPDATE NOWAIT; COMMIT;", check=False)
        assert rc == 0, f"V10 unrelated entry NOWAIT should succeed, got rc={rc}, err={err}"

        # Holder invokes host set_live_room_state (within held transaction) and commits
        host_setter_sql = f"""
SELECT public.set_live_room_state({qlit(fid['room_code'])}, 'hostsecret', 'battle_result', 0, 0, jsonb_build_object('battleMatchupIndex', 0));
COMMIT;
"""
        proc_hold.stdin.write(host_setter_sql)
        proc_hold.stdin.flush()
        proc_hold.stdin.close()
        rc_hold = proc_hold.wait(timeout=20)
        assert rc_hold == 0, f"V10 hold process failed rc={rc_hold}"

        # Voter should resume and reject with phase error
        rc_vote = proc_vote.wait(timeout=20)
        assert rc_vote != 0, "V10 vote should fail after host phase advance"
        vote_err = proc_vote.stderr.read()
        assert "battle_vote" in vote_err.lower() or "phase" in vote_err.lower(), f"V10 vote error not meaningful: {vote_err}"
        assert get_vote_count(fid, matchup) == 0, "V10 vote inserted despite failure"

        # Cleanup part A
        cleanup_fixture(fid)
        fid = None
    finally:
        terminate_proc(proc_hold)
        terminate_proc(proc_vote)
        if fid:
            cleanup_fixture(fid)

    # Part B: overlapping duplicate votes; second waits, then unique violation
    fid2 = create_fixture(session_phase='battle_vote', current_round_index=0, num_players=2)
    proc1 = proc2 = None
    try:
        matchup2 = get_current_matchups(fid2)[0]
        entries2 = get_entries_for_matchup(fid2, matchup2)
        for eid, _ in entries2:
            mark_entry_viable(fid2, eid)
        late2 = add_late_player(fid2)
        set_matchup_index(fid2, 0)
        target2 = entries2[0][0]

        # First vote holds transaction and signals
        app1 = "v10_dup1_" + fid2["room_code"]
        sql1 = f"""
BEGIN;
SET LOCAL ROLE anon;
SELECT public.cast_battle_vote({qlit(fid2['room_code'])}, 'late-{late2[:8]}', {qlit(matchup2)}, {qlit(target2)});
\\echo VOTE1_DONE
"""
        proc1 = start_psql_async(sql1, app1, keep_open=True)
        assert read_until_marker(proc1, "VOTE1_DONE", timeout=15), "V10 first vote didn't signal"

        # Second concurrent vote
        app2 = "v10_dup2_" + fid2["room_code"]
        sql2 = f"""
BEGIN;
SET LOCAL ROLE anon;
SET LOCAL statement_timeout = '15s';
SELECT public.cast_battle_vote({qlit(fid2['room_code'])}, 'late-{late2[:8]}', {qlit(matchup2)}, {qlit(entries2[1][0])});
COMMIT;
"""
        proc2 = start_psql_async(sql2, app2, keep_open=False)
        assert wait_for_lock(app2, timeout=15), "V10 duplicate second vote not waiting"

        # Commit first vote
        proc1.stdin.write("COMMIT;\n")
        proc1.stdin.flush()
        proc1.stdin.close()
        rc1 = proc1.wait(timeout=20)
        assert rc1 == 0, "V10 first vote commit failed"

        # Second should now fail with duplicate/unique
        rc2 = proc2.wait(timeout=20)
        assert rc2 != 0, "V10 duplicate second vote should fail"
        err2 = proc2.stderr.read()
        assert any(token in err2.lower() for token in ["duplicate", "unique", "already voted"]), f"V10 duplicate error: {err2}"

        # Only one vote, original choice
        sql = f"SELECT entry_id FROM public.session_battle_votes WHERE matchup_id = {qlit(matchup2)} AND voter_player_id = {qlit(late2)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == target2, "V10 original vote not preserved"
        assert get_vote_count(fid2, matchup2) == 1
        print("V10 PASS")
    finally:
        terminate_proc(proc1)
        terminate_proc(proc2)
        cleanup_fixture(fid2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if ARGS.migration:
        with open(ARGS.migration, "r", encoding="utf-8") as f:
            migration_sql = f.read()
        rc, out, err = psql_exec(migration_sql, timeout=120)
        if rc != 0:
            print(f"Migration application failed: {err}", file=sys.stderr)
            return 1

    cases = [
        ("V1", run_case_v1),
        ("V2", run_case_v2),
        ("V3", run_case_v3),
        ("V4", run_case_v4),
        ("V5", run_case_v5),
        ("V6", run_case_v6),
        ("V7", run_case_v7),
        ("V8", run_case_v8),
        ("V9", run_case_v9),
        ("V10", run_case_v10),
    ]

    results = []
    for name, func in cases:
        try:
            func()
            results.append({"case": name, "status": "PASS"})
        except Exception as exc:
            results.append({"case": name, "status": "FAIL", "error": str(exc)})
            print(f"{name} FAIL: {exc}", file=sys.stderr)

    total = len(results)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = total - passed
    summary = {
        "total": total,
        "passed": passed,
        "failed": failed,
        "cases": results,
    }
    print(json.dumps(summary, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
