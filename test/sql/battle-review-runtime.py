#!/usr/bin/env python3
"""Runtime SQL behavior driver for issue #25 (migration 0040).

Loads the existing issue #24 runtime module as a helper library and
executes eight contract cases (R1-R8) for veto_battle_entry and the
review projection.  CLI arguments are identical to the old runner.
"""
import importlib.util
import json
import pathlib
import sys
import uuid

# Load the old_runner module; it parses CLI args at import time.
OLD_RUNNER_PATH = pathlib.Path(__file__).resolve().parent / "battle-submission-runtime.py"
spec = importlib.util.spec_from_file_location("old_runner", OLD_RUNNER_PATH)
old_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(old_runner)  # runs parse_args()

ARGS = old_runner.ARGS

# Frequently used helpers
psql_exec = old_runner.psql_exec
psql_check = old_runner.psql_check
rpc = old_runner.rpc
assert_rpc_exists = old_runner.assert_rpc_exists
start_psql_async = old_runner.start_psql_async
read_until_marker = old_runner.read_until_marker
terminate_proc = old_runner.terminate_proc
gen_uuid = old_runner.gen_uuid
gen_room = old_runner.gen_room
qlit = old_runner.qlit
create_fixture = old_runner.create_fixture
add_media_asset = old_runner.add_media_asset
add_previous_round_entries = old_runner.add_previous_round_entries
cleanup_fixture = old_runner.cleanup_fixture
get_entry_session_snapshot = old_runner.get_entry_session_snapshot

VETO_SIGNATURE = "public.veto_battle_entry(text, text, uuid, text, boolean)"


def assert_veto_rpc_exists():
    assert_rpc_exists(VETO_SIGNATURE)


def apply_migration(migration_path):
    with open(migration_path) as f:
        sql = f.read()
    old_runner.psql_check(sql)


def simulate_old_helper_grants():
    """Grant helper EXECUTE to browser and service roles BEFORE migration 0040."""
    old_runner.psql_check(
        "GRANT EXECUTE ON FUNCTION public.host_battle_state_payload(uuid, integer) "
        "TO anon, authenticated, service_role, public;"
    )


def sql_lit(value):
    """Return a SQL literal for a Python value, using NULL for None."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    return qlit(str(value))


def bool_sql_lit(value):
    if value is None:
        return "NULL"
    return "true" if value else "false"


def assert_rejection_is_validation(err):
    """Ensure a rejection came from our validation raise, not syntax/permission/etc."""
    lower = err.lower()
    forbidden = ["syntax error", "does not exist", "permission denied"]
    for bad in forbidden:
        if bad in lower:
            raise AssertionError(f"Rejection was not a validation error: {err}")
    if "error" not in lower:
        raise AssertionError(f"Rejection did not produce an error: {err}")


def wait_for_lock_strict(appname, timeout=15):
    """Return None after confirmed lock wait; raise AssertionError on timeout."""
    observed = old_runner.wait_for_lock(appname, timeout)
    if not observed:
        raise AssertionError(f"Process {appname} did not enter lock wait within {timeout}s")
    return None


def add_generation_with_prompt(fid, entry_id, attempt_index, asset_ids, status='complete',
                               cost_usd=None, player_prompt='prompt'):
    """Insert a session_battle_generations row with explicit player_prompt."""
    generation_id = old_runner.gen_uuid()
    if asset_ids:
        array_literal = "ARRAY[" + ",".join(qlit(str(a)) for a in asset_ids) + "]::uuid[]"
    else:
        array_literal = "ARRAY[]::uuid[]"
    cost_lit = "NULL" if cost_usd is None else str(cost_usd)
    sql = f"""
    INSERT INTO public.session_battle_generations
      (id, entry_id, attempt_index, player_prompt, provider, model,
       asset_ids, status, cost_usd)
    VALUES ({qlit(generation_id)}, {qlit(entry_id)}, {attempt_index}, {qlit(player_prompt)},
            'fake', 'test', {array_literal}, {qlit(status)}, {cost_lit});
    """
    old_runner.psql_check(sql)
    fid["extra_ids"].append(generation_id)
    return generation_id


def get_host_state(fid):
    return old_runner.rpc('anon', f"SELECT public.get_host_battle_state('{fid['room_code']}', 'hostsecret');")


def set_session_phase(fid, phase):
    sql = f"UPDATE public.sessions SET phase = {qlit(phase)} WHERE id = {qlit(fid['session_id'])};"
    old_runner.psql_check(sql)


def set_entry_submitted(fid, entry_id, asset_id=None, submitted_time="now()"):
    asset_lit = "NULL" if asset_id is None else qlit(asset_id)
    sql = f"""
    UPDATE public.session_battle_entries
       SET submitted_asset_id = {asset_lit},
           submitted_at = {submitted_time},
           forfeited_at = NULL
     WHERE id = {qlit(entry_id)};
    """
    old_runner.psql_check(sql)


def set_entry_forfeited(fid, entry_id):
    sql = f"""
    UPDATE public.session_battle_entries
       SET forfeited_at = now(), submitted_asset_id = NULL, submitted_at = NULL
     WHERE id = {qlit(entry_id)};
    """
    old_runner.psql_check(sql)


def get_entry_row(fid, entry_id):
    sql = f"""
    SELECT submitted_asset_id, submitted_at, forfeited_at, vetoed_at, veto_reason
      FROM public.session_battle_entries WHERE id = {qlit(entry_id)};
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Entry row query failed: {err}")
    parts = out.strip().split("|")
    if len(parts) != 5:
        raise AssertionError(f"Unexpected entry row output: {out!r}")
    return {
        "submitted_asset_id": parts[0] if parts[0] != "" else None,
        "submitted_at": parts[1] if parts[1] != "" else None,
        "forfeited_at": parts[2] if parts[2] != "" else None,
        "vetoed_at": parts[3] if parts[3] != "" else None,
        "veto_reason": parts[4] if parts[4] != "" else None,
    }


def get_session_revision(fid):
    return int(old_runner.psql_exec(
        f"SELECT revision FROM public.sessions WHERE id = {qlit(fid['session_id'])};"
    )[1].strip())


def call_veto(role, room_code, secret, entry_id, reason, veto=True, expect_error=False):
    """Call veto_battle_entry and return parsed JSON or raise if expected error."""
    call = (
        f"SELECT public.veto_battle_entry("
        f"{sql_lit(room_code)}, {sql_lit(secret)}, {sql_lit(entry_id)}, "
        f"{sql_lit(reason)}, {bool_sql_lit(veto)});"
    )
    rc, out, err = old_runner.psql_exec(call, role=role)
    if expect_error:
        if rc == 0:
            raise AssertionError(f"Expected error but call succeeded as {role}")
        assert_rejection_is_validation(err)
        return err
    if rc != 0:
        raise AssertionError(f"Veto call failed as {role}: {err}")
    cleaned = out.strip()
    if not cleaned:
        raise AssertionError("Veto call returned empty output")
    return json.loads(cleaned)


# ---------------------------------------------------------------------------
# Contract cases R1-R8
# ---------------------------------------------------------------------------

def case_r1():
    assert_veto_rpc_exists()
    fid = create_fixture(session_phase='battle_review', num_players=2, has_entries=True)
    entry0 = fid['entries'][0]
    entry1 = fid['entries'][1]
    try:
        initial_rev = get_session_revision(fid)

        # Authenticated valid
        out = call_veto('anon', fid['room_code'], 'hostsecret', entry0, 'test reason', True)
        assert out.get('roomCode') == fid['room_code']
        assert 'revision' in out and 'phase' in out
        row = get_entry_row(fid, entry0)
        assert row['vetoed_at'] is not None
        assert row['veto_reason'] == 'test reason'
        assert get_session_revision(fid) == initial_rev + 1

        # authenticated role also works, undo first
        call_veto('authenticated', fid['room_code'], 'hostsecret', entry0, None, False)
        row = get_entry_row(fid, entry0)
        assert row['vetoed_at'] is None and row['veto_reason'] is None

        # Veto other entry as authenticated
        out = call_veto('authenticated', fid['room_code'], 'hostsecret', entry1, 'auth reason', True)
        assert 'roomCode' in out
        row = get_entry_row(fid, entry1)
        assert row['vetoed_at'] is not None and row['veto_reason'] == 'auth reason'

        # Invalid auth cases (no writes)
        rev_before = get_session_revision(fid)
        row_before = get_entry_row(fid, entry1)
        for bad_secret in [None, 'wrongsecret', '']:
            call_veto('anon', fid['room_code'], bad_secret, entry1, 'x', True, expect_error=True)
        call_veto('anon', fid['room_code'], 'hostsecret', None, 'x', True, expect_error=True)
        call_veto('anon', None, 'hostsecret', entry1, 'x', True, expect_error=True)
        # player token as host secret should fail
        call_veto('anon', fid['room_code'], 'player-' + fid['players'][0][:8], entry1, 'x', True, expect_error=True)
        row_after = get_entry_row(fid, entry1)
        assert row_after == row_before, "entry changed after invalid auth"
        assert get_session_revision(fid) == rev_before, "revision changed after invalid auth"
    finally:
        cleanup_fixture(fid)


def case_r2():
    assert_veto_rpc_exists()
    # Phase gate: veto/undo must fail outside battle_review and produce no writes.
    for phase in ['battle_prompt', 'lobby', 'battle_vote', 'battle_result']:
        fid = create_fixture(session_phase=phase, num_players=2, has_entries=True)
        try:
            entry_id = fid['entries'][0]
            snapshot_before = get_entry_session_snapshot(fid)
            row_before = get_entry_row(fid, entry_id)

            call_veto('anon', fid['room_code'], 'hostsecret', entry_id, 'reason', True, expect_error=True)
            call_veto('anon', fid['room_code'], 'hostsecret', entry_id, None, False, expect_error=True)

            snapshot_after = get_entry_session_snapshot(fid)
            row_after = get_entry_row(fid, entry_id)
            assert snapshot_after == snapshot_before, f"session snapshot changed in phase {phase}"
            assert row_after == row_before, f"entry changed in phase {phase}"
        finally:
            cleanup_fixture(fid)

    # Invalid targets with current round 1, old round 0.
    fid = create_fixture(session_phase='battle_review', current_round_index=1, num_players=2, has_entries=True)
    try:
        valid_entry = fid['entries'][0]  # current round entry
        snapshot_before = get_entry_session_snapshot(fid)
        row_before = get_entry_row(fid, valid_entry)

        # null entry
        call_veto('anon', fid['room_code'], 'hostsecret', None, 'reason', True, expect_error=True)
        # nonexistent UUID
        call_veto('anon', fid['room_code'], 'hostsecret', str(uuid.uuid4()), 'reason', True, expect_error=True)
        # foreign session entry
        fid2 = create_fixture(session_phase='battle_review', current_round_index=0, num_players=1, has_entries=True)
        try:
            foreign_entry = fid2['entries'][0]
            call_veto('anon', fid['room_code'], 'hostsecret', foreign_entry, 'reason', True, expect_error=True)
        finally:
            cleanup_fixture(fid2)
        # old round entry
        old = add_previous_round_entries(fid, 2, round_index=0)
        old_entry = old['entry_ids'][0]
        call_veto('anon', fid['room_code'], 'hostsecret', old_entry, 'reason', True, expect_error=True)
        # null secret
        call_veto('anon', fid['room_code'], None, valid_entry, 'reason', True, expect_error=True)

        snapshot_after = get_entry_session_snapshot(fid)
        row_after = get_entry_row(fid, valid_entry)
        assert snapshot_after == snapshot_before, "session snapshot changed after invalid targets"
        assert row_after == row_before, "entry changed after invalid targets"
    finally:
        cleanup_fixture(fid)

    # Reason validation on veto true
    fid = create_fixture(session_phase='battle_review', current_round_index=0, num_players=2, has_entries=True)
    try:
        entry_id = fid['entries'][0]
        snapshot_before = get_entry_session_snapshot(fid)
        row_before = get_entry_row(fid, entry_id)

        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, 'reason', None, expect_error=True)  # null bool
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, None, True, expect_error=True)     # null reason
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, '   ', True, expect_error=True)     # blank reason
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, 'a' * 501, True, expect_error=True) # >500 chars

        snapshot_after = get_entry_session_snapshot(fid)
        row_after = get_entry_row(fid, entry_id)
        assert snapshot_after == snapshot_before, "session snapshot changed after invalid reason"
        assert row_after == row_before, "entry changed after invalid reason"
    finally:
        cleanup_fixture(fid)


def case_r3():
    assert_veto_rpc_exists()
    fid = create_fixture(session_phase='battle_review', num_players=2, has_entries=True)
    entry_id = fid['entries'][0]
    try:
        # Prepare submitted entry with generations
        asset_id = add_media_asset(fid, fid['players'][0])
        set_entry_submitted(fid, entry_id, asset_id)
        add_generation_with_prompt(fid, entry_id, 0, [asset_id], status='complete', cost_usd=1.0, player_prompt='R3 complete')

        rev_before = get_session_revision(fid)
        row_before = get_entry_row(fid, entry_id)

        # meaningful veto with trimming
        out = call_veto('anon', fid['room_code'], 'hostsecret', entry_id, '   reason with spaces   ', True)
        assert 'roomCode' in out
        rev_after = get_session_revision(fid)
        assert rev_after == rev_before + 1
        row = get_entry_row(fid, entry_id)
        assert row['vetoed_at'] is not None
        assert row['veto_reason'] == 'reason with spaces'
        # preserved submitted and generations
        assert row['submitted_asset_id'] == asset_id
        assert row['submitted_at'] == row_before['submitted_at']
        assert row['forfeited_at'] is None

        # identical veto no-op
        rev_before = get_session_revision(fid)
        timestamp_before = row['vetoed_at']
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, 'reason with spaces', True)
        row = get_entry_row(fid, entry_id)
        assert row['vetoed_at'] == timestamp_before
        assert row['veto_reason'] == 'reason with spaces'
        assert get_session_revision(fid) == rev_before

        # changed reason meaningful
        rev_before = get_session_revision(fid)
        old_timestamp = row['vetoed_at']
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, '  new reason  ', True)
        row = get_entry_row(fid, entry_id)
        assert row['veto_reason'] == 'new reason'
        assert row['vetoed_at'] != old_timestamp
        assert get_session_revision(fid) == rev_before + 1

        # undo clears both
        rev_before = get_session_revision(fid)
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, None, False)
        row = get_entry_row(fid, entry_id)
        assert row['vetoed_at'] is None
        assert row['veto_reason'] is None
        assert row['submitted_asset_id'] == asset_id
        assert get_session_revision(fid) == rev_before + 1

        # repeated undo no-op
        rev_before = get_session_revision(fid)
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, None, False)
        row = get_entry_row(fid, entry_id)
        assert row['vetoed_at'] is None and row['veto_reason'] is None
        assert get_session_revision(fid) == rev_before

        # after battle_vote no change
        set_session_phase(fid, 'battle_vote')
        rev_before = get_session_revision(fid)
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, 'again', True, expect_error=True)
        call_veto('anon', fid['room_code'], 'hostsecret', entry_id, None, False, expect_error=True)
        row = get_entry_row(fid, entry_id)
        assert row['vetoed_at'] is None and row['veto_reason'] is None
        assert get_session_revision(fid) == rev_before
    finally:
        cleanup_fixture(fid)


def case_r4():
    assert_veto_rpc_exists()
    fid = create_fixture(session_phase='battle_review', num_players=4, has_entries=True)
    matchup1_entries = fid['entries'][0::2]
    matchup2_entries = fid['entries'][1::2]
    try:
        # Matchup1: entry0 submitted viable, entry1 forfeited
        asset = add_media_asset(fid, fid['players'][0])
        set_entry_submitted(fid, matchup1_entries[0], asset)
        set_entry_forfeited(fid, matchup1_entries[1])
        # Matchup2: both submitted viable, then vetoed
        for eid in matchup2_entries:
            owner_player_id = fid['players'][fid['entries'].index(eid)]
            asset = add_media_asset(fid, owner_player_id)
            set_entry_submitted(fid, eid, asset)
        for eid in matchup2_entries:
            call_veto('anon', fid['room_code'], 'hostsecret', eid, 'veto', True)

        out = get_host_state(fid)
        matchups = out['matchups']
        assert len(matchups) == 2
        m1 = matchups[0]
        m2 = matchups[1]
        assert m1['skipped'] is False
        assert m1['viableEntryIds'] == [matchup1_entries[0]]
        assert m2['skipped'] is True
        assert m2['viableEntryIds'] == []

        # Undo veto on one of matchup2 entries -> skipped false, viableEntryIds contains that one
        call_veto('anon', fid['room_code'], 'hostsecret', matchup2_entries[0], None, False)
        out = get_host_state(fid)
        m2 = out['matchups'][1]
        assert m2['skipped'] is False
        assert m2['viableEntryIds'] == [matchup2_entries[0]]

        # Forfeit undo does not make viable: veto then undo on forfeited entry
        call_veto('anon', fid['room_code'], 'hostsecret', matchup1_entries[1], 'temp', True)
        call_veto('anon', fid['room_code'], 'hostsecret', matchup1_entries[1], None, False)
        out = get_host_state(fid)
        m1 = out['matchups'][0]
        assert m1['viableEntryIds'] == [matchup1_entries[0]]  # forfeited entry not viable

        # no revision changes on read
        rev_before = get_session_revision(fid)
        out = get_host_state(fid)
        assert get_session_revision(fid) == rev_before
        # no resolved_at writes
        sql = f"SELECT resolved_at IS NULL FROM public.session_battle_matchups WHERE id = {qlit(fid['matchups'][0])};"
        rc, out2, _ = psql_exec(sql)
        assert out2.strip() == 't'
    finally:
        cleanup_fixture(fid)


def case_r5():
    assert_veto_rpc_exists()
    fid = create_fixture(session_phase='battle_review', current_round_index=1, num_players=3, has_entries=True)
    entry0 = fid['entries'][0]
    entry1 = fid['entries'][1]
    entry2 = fid['entries'][2]
    fid_foreign = None
    try:
        # Assets for current round
        a1 = add_media_asset(fid, fid['players'][0])
        a2 = add_media_asset(fid, fid['players'][0])
        a3 = add_media_asset(fid, fid['players'][1])
        a_partial_fail = add_media_asset(fid, fid['players'][0])

        # Entry0 generations: complete, failed with partial asset, pending empty
        add_generation_with_prompt(fid, entry0, 0, [a1, a2], status='complete', cost_usd=1.5, player_prompt='player0 prompt attempt0 complete')
        add_generation_with_prompt(fid, entry0, 1, [a_partial_fail], status='failed', cost_usd=None, player_prompt='player0 prompt attempt1 failed partial')
        add_generation_with_prompt(fid, entry0, 2, [], status='pending', cost_usd=None, player_prompt='player0 prompt attempt2 pending')
        # Entry1 generations: complete with one asset, pending empty
        add_generation_with_prompt(fid, entry1, 0, [a3], status='complete', cost_usd=0.75, player_prompt='player1 prompt attempt0 complete')
        add_generation_with_prompt(fid, entry1, 1, [], status='pending', cost_usd=None, player_prompt='player1 prompt attempt1 pending')
        # Entry2 has no generations

        # Old round generation for exclusion and spend across all rounds
        old = add_previous_round_entries(fid, 2, round_index=0)
        old_entry0 = old['entry_ids'][0]
        old_asset = add_media_asset(fid, fid['players'][0])
        add_generation_with_prompt(fid, old_entry0, 0, [old_asset], status='complete', cost_usd=0.5, player_prompt='old round player0 prompt')

        # Foreign session fixture with generations, should be excluded entirely
        fid_foreign = create_fixture(session_phase='battle_review', current_round_index=0, num_players=1, has_entries=True)
        foreign_entry = fid_foreign['entries'][0]
        foreign_asset = add_media_asset(fid_foreign, fid_foreign['players'][0])
        add_generation_with_prompt(fid_foreign, foreign_entry, 0, [foreign_asset], status='complete', cost_usd=2.0, player_prompt='foreign should not appear')

        out = get_host_state(fid)
        assert 'sessionSpendUsd' in out and 'maxSessionSpendUsd' in out
        matchups = out['matchups']
        m = matchups[0]
        entrants_by_id = {e['entryId']: e for e in m['entrants']}

        e0 = entrants_by_id[entry0]
        generations0 = e0['generations']
        assert len(generations0) == 3
        assert generations0[0]['attemptIndex'] == 0
        assert generations0[0]['status'] == 'complete'
        assert generations0[0]['playerPrompt'] == 'player0 prompt attempt0 complete'
        assert generations0[0]['assetIds'] == [a1, a2]
        assert generations0[1]['attemptIndex'] == 1
        assert generations0[1]['status'] == 'failed'
        assert generations0[1]['playerPrompt'] == 'player0 prompt attempt1 failed partial'
        assert generations0[1]['assetIds'] == [a_partial_fail]  # partial image asset array, not empty
        assert generations0[2]['attemptIndex'] == 2
        assert generations0[2]['status'] == 'pending'
        assert generations0[2]['playerPrompt'] == 'player0 prompt attempt2 pending'
        assert generations0[2]['assetIds'] == []

        e1 = entrants_by_id[entry1]
        assert len(e1['generations']) == 2
        assert e1['generations'][0]['playerPrompt'] == 'player1 prompt attempt0 complete'
        assert e1['generations'][0]['assetIds'] == [a3]
        assert e1['generations'][1]['playerPrompt'] == 'player1 prompt attempt1 pending'
        assert e1['generations'][1]['assetIds'] == []

        e2 = entrants_by_id[entry2]
        assert e2['generations'] == []

        # creator identity
        assert e0['playerId'] == fid['players'][0]
        assert e0['playerName'].startswith('Player ')
        # old keys retained
        assert 'submittedAssetId' in e0 and 'submittedAt' in e0 and 'forfeited' in e0

        # Cross-session/round exclusion: current entrants only contain current round and not foreign
        all_current_entry_ids = [e['entryId'] for e in m['entrants']]
        assert old_entry0 not in all_current_entry_ids
        assert foreign_entry not in all_current_entry_ids

        # Assert actual spend numeric across all statuses/all rounds
        expected_spend_sql = f"""
        SELECT COALESCE(SUM(g.cost_usd), 0)::numeric
        FROM public.session_battle_generations g
        JOIN public.session_battle_entries e ON e.id = g.entry_id
        JOIN public.session_battle_matchups m ON m.id = e.matchup_id
        WHERE m.session_id = {qlit(fid['session_id'])}
        """
        rc, spend_out, spend_err = psql_exec(expected_spend_sql)
        assert rc == 0, spend_err
        expected_spend = float(spend_out.strip()) if spend_out.strip() else 0.0
        assert out['sessionSpendUsd'] == expected_spend, f"sessionSpendUsd {out['sessionSpendUsd']} != expected {expected_spend}"
        # maxSessionSpendUsd key exists; value can be null or numeric
        assert 'maxSessionSpendUsd' in out
    finally:
        cleanup_fixture(fid)
        if fid_foreign:
            cleanup_fixture(fid_foreign)


def case_r6():
    assert_veto_rpc_exists()
    fid = create_fixture(session_phase='battle_review', current_round_index=0, num_players=2, has_entries=True)
    entry0 = fid['entries'][0]
    entry1 = fid['entries'][1]
    try:
        # Snapshot BEFORE any veto
        snapshot_before = get_entry_session_snapshot(fid)
        state_before = snapshot_before['state']
        phase_before = snapshot_before['phase']

        # Populate both players with distinct private prompts and own assets
        asset0 = add_media_asset(fid, fid['players'][0], storage_path='owner0/asset.png')
        asset1 = add_media_asset(fid, fid['players'][1], storage_path='owner1/asset.png')
        add_generation_with_prompt(fid, entry0, 0, [asset0], status='complete', cost_usd=1.0, player_prompt='player0 private prompt R6')
        add_generation_with_prompt(fid, entry1, 0, [asset1], status='complete', cost_usd=1.0, player_prompt='player1 private prompt R6')

        # Moderate entry0
        call_veto('anon', fid['room_code'], 'hostsecret', entry0, 'secret reason', True)

        player0_token = 'player-' + fid['players'][0][:8]
        player1_token = 'player-' + fid['players'][1][:8]

        out0 = old_runner.rpc('anon', f"SELECT public.get_player_battle_state('{fid['room_code']}', '{player0_token}');")
        entry0_player = out0['entry']
        assert entry0_player is not None
        # own assets preserved
        own_assets0 = [a for gen in entry0_player.get('generations', []) for a in gen.get('assetIds', [])]
        assert asset0 in own_assets0
        # absolute absence of other player ID/name/prompt/asset
        entry0_str = json.dumps(entry0_player)
        assert fid['players'][1] not in entry0_str
        assert 'player1 private prompt R6' not in entry0_str
        assert asset1 not in entry0_str
        # host review structure absent
        for key in ['vetoedAt', 'vetoReason', 'viable', 'matchups', 'opponent']:
            assert key not in entry0_str

        out1 = old_runner.rpc('anon', f"SELECT public.get_player_battle_state('{fid['room_code']}', '{player1_token}');")
        entry1_player = out1['entry']
        assert entry1_player is not None
        own_assets1 = [a for gen in entry1_player.get('generations', []) for a in gen.get('assetIds', [])]
        assert asset1 in own_assets1
        entry1_str = json.dumps(entry1_player)
        assert fid['players'][0] not in entry1_str
        assert 'player0 private prompt R6' not in entry1_str
        assert asset0 not in entry1_str
        for key in ['vetoedAt', 'vetoReason', 'viable', 'matchups', 'opponent']:
            assert key not in entry1_str

        # Public room state must not contain review structure or private data
        out_room = old_runner.rpc('anon', f"SELECT public.get_live_room_state('{fid['room_code']}', '{player0_token}');")
        room_state_str = json.dumps(out_room.get('state', {}))
        for forbidden in ['vetoedAt', 'vetoReason', 'matchups', 'player0 private prompt R6',
                          'player1 private prompt R6', asset0, asset1, 'secret reason']:
            assert forbidden not in room_state_str, f"public room state leaked {forbidden}"

        # Session state unchanged after veto (phase unchanged too)
        snapshot_after = get_entry_session_snapshot(fid)
        assert snapshot_after['state'] == state_before, "sessions.state changed after veto"
        assert snapshot_after['phase'] == phase_before, "sessions.phase changed after veto"

        # wrong secret cannot expose review
        call_veto('anon', fid['room_code'], 'wrongsecret', entry0, None, False, expect_error=True)
    finally:
        cleanup_fixture(fid)


def case_r7():
    assert_veto_rpc_exists()

    # Catalog check: PUBLIC (grantee = 0) must NOT have EXECUTE on veto_battle_entry
    sql_public = """
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE n.nspname = 'public'
        AND p.proname = 'veto_battle_entry'
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
        AND acl.is_grantable = false
    );
    """
    rc, out, err = psql_exec(sql_public)
    assert rc == 0, err
    assert out.strip() == 'f', "PUBLIC should not have EXECUTE on veto_battle_entry"

    # anon/auth have EXECUTE on veto_battle_entry
    for role_name in ['anon', 'authenticated']:
        sql_role = f"""
        SELECT EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_roles r ON r.rolname = '{role_name}'
          CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE n.nspname = 'public'
            AND p.proname = 'veto_battle_entry'
            AND acl.grantee = r.oid
            AND acl.privilege_type = 'EXECUTE'
        );
        """
        rc, out, err = psql_exec(sql_role)
        assert rc == 0, err
        assert out.strip() == 't', f"{role_name} should have EXECUTE on veto_battle_entry"

    # Helper must have no EXECUTE for anon/auth/service/public
    for grantee_identifier in ['anon', 'authenticated', 'service_role', 'public']:
        if grantee_identifier == 'public':
            grantee_expr = "0"
        else:
            grantee_expr = f"(SELECT oid FROM pg_roles WHERE rolname = '{grantee_identifier}')"
        sql_helper = f"""
        SELECT EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE n.nspname = 'public'
            AND p.proname = 'host_battle_state_payload'
            AND acl.grantee = {grantee_expr}
            AND acl.privilege_type = 'EXECUTE'
        );
        """
        rc, out, err = psql_exec(sql_helper)
        assert rc == 0, err
        assert out.strip() == 'f', f"{grantee_identifier} should NOT have EXECUTE on helper"

    # Actually attempt direct helper calls as anon/auth/service_role and expect permission denied
    helper_call = "SELECT public.host_battle_state_payload('00000000-0000-0000-0000-000000000000'::uuid, 0);"
    for role in ['anon', 'authenticated', 'service_role']:
        rc, out, err = psql_exec(helper_call, role=role)
        if rc == 0:
            raise AssertionError(f"Helper call as {role} unexpectedly succeeded")
        if "permission denied" not in err.lower():
            raise AssertionError(f"Helper call as {role} failed for wrong reason: {err}")

    # Actually attempt direct table SELECT as anon/auth and expect permission denied
    table_call = "SELECT count(*) FROM public.session_battle_entries;"
    for role in ['anon', 'authenticated']:
        rc, out, err = psql_exec(table_call, role=role)
        if rc == 0:
            raise AssertionError(f"Table SELECT as {role} unexpectedly succeeded")
        if "permission denied" not in err.lower():
            raise AssertionError(f"Table SELECT as {role} failed for wrong reason: {err}")

    # service_role retains SELECT on session_battle_entries
    rc, out, err = psql_exec(table_call, role='service_role')
    assert rc == 0, f"service_role should retain SELECT on session_battle_entries: {err}"

    # No direct table grants to browser roles in information_schema
    for role in ['anon', 'authenticated', 'public']:
        rc, out, err = psql_exec(f"""
            SELECT COUNT(*) FROM information_schema.role_table_grants
             WHERE grantee = '{role}' AND table_schema = 'public'
               AND table_name IN ('session_battle_entries','session_battle_matchups');
        """)
        if rc != 0 or out.strip() != '0':
            raise AssertionError(f"Unexpected table grants for {role}")


def case_r8():
    assert_veto_rpc_exists()
    fid = create_fixture(session_phase='battle_review', current_round_index=0, num_players=2, has_entries=True)
    entry_id = fid['entries'][0]
    procs = []
    try:
        snapshot_before = get_entry_session_snapshot(fid)
        row_before = get_entry_row(fid, entry_id)

        # --- Holder transaction locks session row and signals marker ---
        holder_sql = f"""
BEGIN;
SELECT * FROM public.sessions WHERE id = {qlit(fid['session_id'])} FOR UPDATE;
SELECT 'marker';
"""
        holder = start_psql_async(holder_sql, "battle-review-holder", keep_open=True)
        procs.append(holder)
        if not read_until_marker(holder, "marker", timeout=10):
            raise AssertionError("holder did not output marker")

        # --- Start waiter veto; will block on session lock ---
        waiter_sql = f"SELECT public.veto_battle_entry({qlit(fid['room_code'])}, 'hostsecret', {qlit(entry_id)}, 'block reason', true);"
        waiter = start_psql_async(waiter_sql, "battle-review-waiter", keep_open=False)
        procs.append(waiter)
        wait_for_lock_strict("battle-review-waiter", timeout=10)  # returns None or raises

        # --- Third transaction: entry remains lockable while veto blocked on session ---
        third_sql = f"""
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT * FROM public.session_battle_entries WHERE id = {qlit(entry_id)} FOR UPDATE;
COMMIT;
"""
        rc_third, out_third, err_third = psql_exec(third_sql, timeout=10)
        if rc_third != 0:
            raise AssertionError(f"entry should remain lockable while veto waits on session: {err_third}")

        # --- Holder changes phase and commits, causing waiter to fail ---
        holder.stdin.write(f"UPDATE public.sessions SET phase = 'battle_vote' WHERE id = {qlit(fid['session_id'])};\n")
        holder.stdin.write("COMMIT;\n")
        holder.stdin.close()
        holder.wait(timeout=15)

        waiter_stdout, waiter_stderr = waiter.communicate(timeout=15)
        if waiter.returncode == 0:
            raise AssertionError("waiter should have failed after phase change")
        assert_rejection_is_validation(waiter_stderr)

        # Snapshot after phase change: entry and session revision/state unchanged, phase is battle_vote
        snapshot_after = get_entry_session_snapshot(fid)
        row_after = get_entry_row(fid, entry_id)
        assert snapshot_after['revision'] == snapshot_before['revision'], "revision changed after blocked veto"
        assert snapshot_after['state'] == snapshot_before['state'], "sessions.state changed after blocked veto"
        assert snapshot_after['entries'] == snapshot_before['entries'], "entries changed after blocked veto"
        assert snapshot_after['phase'] == 'battle_vote', "holder phase change not visible"
        assert row_after == row_before, "entry changed after blocked veto"

        # --- Competing identical host veto actual overlap ---
        set_session_phase(fid, 'battle_review')
        rev_before = get_session_revision(fid)

        veto_call_sql = f"SELECT public.veto_battle_entry({qlit(fid['room_code'])}, 'hostsecret', {qlit(entry_id)}, 'same reason', true);"

        # First process: BEGIN, veto, marker, hold transaction open
        proc1_sql = f"BEGIN;\n{veto_call_sql}\nSELECT 'marker1';\n"
        proc1 = start_psql_async(proc1_sql, "compete1", keep_open=True)
        procs.append(proc1)
        if not read_until_marker(proc1, "marker1", timeout=10):
            raise AssertionError("proc1 did not output marker1")

        # Second process: start veto, will block on session lock
        proc2 = start_psql_async(veto_call_sql, "compete2", keep_open=False)
        procs.append(proc2)
        wait_for_lock_strict("compete2", timeout=10)

        # Commit proc1, then proc2 completes with no-op
        proc1.stdin.write("COMMIT;\n")
        proc1.stdin.close()
        proc1.wait(timeout=15)

        out2, err2 = proc2.communicate(timeout=15)
        if proc2.returncode != 0:
            raise AssertionError(f"proc2 should succeed after proc1 commit: {err2}")

        row_after_compete = get_entry_row(fid, entry_id)
        assert row_after_compete['vetoed_at'] is not None
        assert row_after_compete['veto_reason'] == 'same reason'
        rev_after = get_session_revision(fid)
        assert rev_after == rev_before + 1
    finally:
        for p in procs:
            terminate_proc(p)
        cleanup_fixture(fid)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if ARGS.migration:
        simulate_old_helper_grants()
        apply_migration(ARGS.migration)

    cases = [
        ("R1", case_r1),
        ("R2", case_r2),
        ("R3", case_r3),
        ("R4", case_r4),
        ("R5", case_r5),
        ("R6", case_r6),
        ("R7", case_r7),
        ("R8", case_r8),
    ]

    results = []
    for name, fn in cases:
        try:
            fn()
            print(f"{name} PASS")
            results.append({"case": name, "status": "passed"})
        except Exception as exc:
            print(f"{name} FAIL: {exc}")
            results.append({"case": name, "status": "failed", "error": str(exc)})

    total = len(results)
    failed = sum(1 for r in results if r["status"] == "failed")
    passed = total - failed
    print(json.dumps({"total": total, "passed": passed, "failed": failed, "cases": results}))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
