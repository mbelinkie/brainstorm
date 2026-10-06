#!/usr/bin/env python3
"""Runtime SQL behavior driver for issue #24 (migration 0039).

Requires Python 3.8+, psql in PATH, and a disposable PostgreSQL 16.2
acceptance database.  No external packages.  Uses subprocess psql exclusively.

Usage:
  python3 test/sql/battle-submission-runtime.py --psql /path/to/psql \
      --host /path/to/private/socket --user postgres --database acceptance_db \
      [--migration /path/to/0039.sql]

The runner applies the supplied migration if given, then executes all ten
contract cases (A1-A10).  Without a migration it still runs every case; each
case first asserts that the required RPCs exist, so a missing migration
produces ten individual assertion failures, not one global preflight exit.
"""

import argparse
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
# Command line / environment
# ---------------------------------------------------------------------------

def parse_args():
    ap = argparse.ArgumentParser(description="Issue #24 SQL behavior driver")
    ap.add_argument("--psql", required=True, help="path to psql binary")
    ap.add_argument("--host", required=True,
                    help="absolute private Unix socket path (directory containing .s.PGSQL.5432)")
    ap.add_argument("--user", required=True, help="PostgreSQL user, normally postgres")
    ap.add_argument("--database", required=True, help="database name; must include 'acceptance'")
    ap.add_argument("--migration", help="path to 0039 migration SQL file (optional)")
    args = ap.parse_args()

    if not os.path.isabs(args.host):
        sys.exit("host must be an absolute Unix socket path")
    if "acceptance" not in args.database:
        sys.exit("database name must include 'acceptance'")
    if not os.path.exists(args.psql):
        sys.exit(f"psql not found at {args.psql}")
    if args.migration and not os.path.exists(args.migration):
        sys.exit(f"migration file not found: {args.migration}")
    return args


ARGS = parse_args()


# ---------------------------------------------------------------------------
# Basic subprocess helpers
# ---------------------------------------------------------------------------

def qlit(s):
    return "'" + s.replace("'", "''") + "'"


def gen_uuid():
    return str(uuid.uuid4())


def gen_room():
    return "".join(choices(ascii_uppercase + digits, k=6))


def run_psql_sync(sql, role=None, appname=None, timeout=30, check=False):
    """Run SQL synchronously through psql.

    Returns (returncode, stdout, stderr).  If role is given and sql does not
    already start with BEGIN, the SQL is wrapped in a transaction with
    SET LOCAL ROLE.  If sql starts with BEGIN, SET LOCAL ROLE is inserted
    after the BEGIN line.
    """
    final_sql = sql
    if role:
        if re.match(r"^\s*BEGIN\b", sql, re.IGNORECASE):
            parts = sql.split("\n", 1)
            final_sql = parts[0] + "\nSET LOCAL ROLE " + role + ";\n" + parts[1]
        else:
            final_sql = "BEGIN;\nSET LOCAL ROLE " + role + ";\n" + sql + "\nCOMMIT;"

    cmd = [
        ARGS.psql, "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        "-h", ARGS.host, "-U", ARGS.user, "-d", ARGS.database,
    ]
    env = os.environ.copy()
    env["PGPASSWORD"] = ""
    if appname:
        env["PGAPPNAME"] = appname
    proc = subprocess.run(
        cmd, input=final_sql, capture_output=True, text=True,
        timeout=timeout, env=env,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"psql failed rc={proc.returncode}\nSQL: {final_sql[:300]}\n"
            f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
        )
    return proc.returncode, proc.stdout, proc.stderr


def psql_exec(sql, role=None, appname=None, timeout=30, check=False):
    return run_psql_sync(sql, role=role, appname=appname, timeout=timeout, check=check)


def psql_check(sql, role=None, appname=None, timeout=30):
    rc, out, err = run_psql_sync(sql, role=role, appname=appname, timeout=timeout, check=False)
    if rc != 0:
        raise RuntimeError(f"psql failed rc={rc}\nSQL: {sql[:200]}\nSTDERR: {err}")
    return rc, out, err


def rpc(role, call, timeout=30):
    """Call an RPC as a browser role and return parsed JSON result.

    Raises AssertionError if psql returns non-zero or output is not valid JSON.
    """
    rc, out, err = psql_exec(call, role=role, timeout=timeout)
    if rc != 0:
        raise AssertionError(f"RPC failed as {role}: {err.strip()}")
    cleaned = out.strip()
    if not cleaned:
        return None
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"RPC returned non-JSON output: {cleaned!r}") from exc


def assert_rpc_exists(signature):
    sql = f"SELECT to_regprocedure('{signature}') IS NOT NULL;"
    rc, out, err = psql_exec(sql)
    if rc != 0 or out.strip() != "t":
        raise AssertionError(f"Required RPC {signature} does not exist")


def assert_required_rpcs_exist(required):
    missing = []
    for sig in required:
        try:
            assert_rpc_exists(sig)
        except AssertionError as exc:
            missing.append(str(exc))
    if missing:
        raise AssertionError("; ".join(missing))


# ---------------------------------------------------------------------------
# Async psql process helpers for deterministic concurrency tests
# ---------------------------------------------------------------------------

def start_psql_async(sql, appname, keep_open=False):
    """Start a psql process and optionally keep stdin open.

    If keep_open is True, the function writes 'sql' to stdin, flushes, and
    returns the Popen object without closing stdin.  The caller is responsible
    for later writing more commands and closing stdin.

    If keep_open is False, the function writes 'sql', flushes, then closes
    stdin immediately.  The process will execute all commands and exit when
    done (possibly after blocking on a lock).
    """
    cmd = [
        ARGS.psql, "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        "-h", ARGS.host, "-U", ARGS.user, "-d", ARGS.database,
    ]
    env = os.environ.copy()
    env["PGPASSWORD"] = ""
    if appname:
        env["PGAPPNAME"] = appname
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
    )
    proc.stdin.write(sql)
    proc.stdin.flush()
    if not keep_open:
        proc.stdin.close()
    return proc


def wait_for_lock(appname, timeout=15):
    """Poll pg_stat_activity until a process with given application_name is
    waiting on a PostgreSQL lock.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        check_sql = (
            f"SELECT COUNT(*) FROM pg_stat_activity "
            f"WHERE application_name = {qlit(appname)} "
            f"AND wait_event_type = 'Lock';"
        )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        rc, out, err = psql_exec(check_sql, timeout=remaining)
        if rc == 0 and out.strip() == "1":
            return True
        time.sleep(0.05)
    return False


def terminate_proc(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def read_until_marker(proc, marker, timeout=15):
    """Read stdout lines until marker appears, with a bounded timeout.

    Uses a daemon thread and queue so the caller never blocks indefinitely.
    Returns True when marker is seen, False on timeout or process exit.
    Stores every read line on proc.captured_lines for later inspection.
    """
    proc.captured_lines = []
    q = queue.Queue()

    def _reader():
        try:
            for line in iter(proc.stdout.readline, ''):
                proc.captured_lines.append(line)
                q.put(line)
        except Exception:
            pass
        finally:
            q.put(None)

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            line = q.get(timeout=remaining)
        except queue.Empty:
            return False
        if line is None:
            return False
        if line.strip() == marker:
            return True
    return False


def get_entry_session_snapshot(fid):
    """Return a JSON snapshot of the session phase/state/revision/updated_at
    and all current-round entries' submitted_asset_id/submitted_at/forfeited_at.
    """
    sql = f"""
    SELECT jsonb_build_object(
      'phase', s.phase,
      'state', s.state,
      'revision', s.revision,
      'updated_at', s.updated_at,
      'entries', (
        SELECT jsonb_agg(jsonb_build_object(
          'entry_id', e.id,
          'submitted_asset_id', e.submitted_asset_id,
          'submitted_at', e.submitted_at,
          'forfeited_at', e.forfeited_at
        ) ORDER BY e.id)
        FROM public.session_battle_entries e
        WHERE e.matchup_id IN (
          SELECT id FROM public.session_battle_matchups
          WHERE session_id = s.id AND round_index = {fid['current_round_index']}
        )
      )
    )
    FROM public.sessions s
    WHERE s.id = {qlit(fid['session_id'])};
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Snapshot query failed: {err}")
    snapshot = out.strip()
    if not snapshot:
        raise AssertionError("Snapshot query returned no data")
    return json.loads(snapshot)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def create_fixture(session_phase='battle_prompt', current_round_index=0,
                   num_players=2, has_entries=True):
    """Create a prompt battle session with matchups and entries.

    Returns a dict with all created IDs, including a list of media_asset IDs
    (initially empty).  All inserts happen in one transaction.
    """
    fid = {
        "quiz_id": gen_uuid(),
        "version_id": gen_uuid(),
        "session_id": gen_uuid(),
        "room_code": gen_room(),
        "players": [gen_uuid() for _ in range(num_players)],
        "entries": [],
        "matchups": [],
        "asset_ids": [],
        "session_phase": session_phase,
        "current_round_index": current_round_index,
        "extra_ids": [],
        "auth_user_ids": [],
    }

    # Build exactly current_round_index+1 prompt_battle rounds so any
    # fixture current_round_index points at an existing round.
    rounds = []
    for round_idx in range(current_round_index + 1):
        rounds.append({
            "type": "prompt_battle",
            "prompts": [
                {"id": f"p{round_idx}", "text": f"Prompt {round_idx}"}
            ],
            "engine": {
                "defaultProvider": "fake",
                "defaultModel": "test",
                "attemptBudget": 3,
                "maxSessionSpendUsd": 10,
                "maxSessionGenerations": 10,
                "variants": 2,
                "resolution": "1024x1024",
                "outputFormat": "png"
            }
        })
    definition = {"rounds": rounds}
    definition_literal = qlit(json.dumps(definition))

    queries = []
    queries.append(f"""
    INSERT INTO public.quizzes (id, slug, title)
    VALUES ({qlit(fid["quiz_id"])}, {qlit(fid["quiz_id"][:8])}, 'Acceptance Quiz');

    INSERT INTO public.quiz_versions (id, quiz_id, version, definition)
    VALUES (
      {qlit(fid["version_id"])}, {qlit(fid["quiz_id"])}, 1,
      {definition_literal}::jsonb
    );

    INSERT INTO public.sessions
      (id, room_code, quiz_version_id, host_secret_hash, phase, current_round_index, state)
    VALUES (
      {qlit(fid["session_id"])}, {qlit(fid["room_code"])},
      {qlit(fid["version_id"])}, public.token_hash('hostsecret'),
      {qlit(session_phase)}, {current_round_index}, '{{"phase":"{session_phase}"}}'::jsonb
    );
    """)

    for p in fid["players"]:
        queries.append(f"""
        INSERT INTO public.session_players (id, session_id, player_token_hash, display_name)
        VALUES ({qlit(p)}, {qlit(fid["session_id"])}, public.token_hash('player-{p[:8]}'), 'Player {p[:8]}');
        """)

    if has_entries:
        matchup_count = max(1, num_players // 2)
        for i in range(matchup_count):
            mid = gen_uuid()
            fid["matchups"].append(mid)
            queries.append(f"""
            INSERT INTO public.session_battle_matchups
              (id, session_id, round_index, matchup_index, prompt_id, prompt_text)
            VALUES ({qlit(mid)}, {qlit(fid["session_id"])}, {current_round_index},
                    {i}, 'p1', 'Test prompt');
            """)
        for idx, pid in enumerate(fid["players"]):
            mid = fid["matchups"][idx % len(fid["matchups"])]
            eid = gen_uuid()
            fid["entries"].append(eid)
            queries.append(f"""
            INSERT INTO public.session_battle_entries (id, matchup_id, player_id)
            VALUES ({qlit(eid)}, {qlit(mid)}, {qlit(pid)});
            """)

    sql = "BEGIN;\n" + "".join(queries) + "\nCOMMIT;"
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Fixture setup failed: {err}")
    return fid


def add_media_asset(fid, player_id, storage_path=None, source='battle', kind='image', uploaded_by=None):
    asset_id = gen_uuid()
    if storage_path is None:
        storage_path = f"battle/{asset_id}.png"
    mime_type = 'image/png' if kind == 'image' else 'video/mp4'
    uploaded_by_lit = "NULL" if uploaded_by is None else qlit(uploaded_by)
    sql = f"""
    INSERT INTO public.media_assets
      (id, storage_path, kind, mime_type, byte_size, source, generated_by_player_id, uploaded_by)
    VALUES ({qlit(asset_id)}, {qlit(storage_path)}, {qlit(kind)}, {qlit(mime_type)},
            100, {qlit(source)}, {qlit(player_id)}, {uploaded_by_lit});
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Media asset insert failed: {err}")
    fid["asset_ids"].append(asset_id)
    return asset_id


def add_generation(fid, entry_id, attempt_index, asset_ids, status='complete',
                   cost_usd=None, return_id=False):
    """Insert a session_battle_generations row.

    asset_ids may be a list of UUID strings or an empty list.  The SQL uses a
    valid ARRAY[]::uuid[] literal, never a Python list repr.  Returns the new
    generation ID if return_id is True.
    """
    generation_id = gen_uuid()
    if asset_ids:
        array_literal = "ARRAY[" + ",".join(qlit(a) for a in asset_ids) + "]::uuid[]"
    else:
        array_literal = "ARRAY[]::uuid[]"
    cost_lit = "NULL" if cost_usd is None else str(cost_usd)
    sql = f"""
    INSERT INTO public.session_battle_generations
      (id, entry_id, attempt_index, player_prompt, provider, model,
       asset_ids, status, cost_usd)
    VALUES ({qlit(generation_id)}, {qlit(entry_id)}, {attempt_index}, 'test',
            'fake', 'test', {array_literal}, {qlit(status)}, {cost_lit});
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Generation insert failed: {err}")
    fid["extra_ids"].append(generation_id)
    if return_id:
        return generation_id
    return None


def add_previous_round_entries(fid, num_players, round_index):
    """Add matchups and entries for an earlier round to the same session.

    Used by A8 to create spend from all rounds.  Returns a dict with
    'matchup_ids' and 'entry_ids' for that round.
    """
    matchup_ids = []
    entry_ids = []
    matchup_count = max(1, num_players // 2)
    sql = ""
    for i in range(matchup_count):
        mid = gen_uuid()
        matchup_ids.append(mid)
        sql += f"""
        INSERT INTO public.session_battle_matchups
          (id, session_id, round_index, matchup_index, prompt_id, prompt_text)
        VALUES ({qlit(mid)}, {qlit(fid["session_id"])}, {round_index}, {i}, 'p1', 'Old prompt');
        """
    for idx, pid in enumerate(fid["players"][:num_players]):
        mid = matchup_ids[idx % len(matchup_ids)]
        eid = gen_uuid()
        entry_ids.append(eid)
        sql += f"""
        INSERT INTO public.session_battle_entries (id, matchup_id, player_id)
        VALUES ({qlit(eid)}, {qlit(mid)}, {qlit(pid)});
        """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Previous round entries failed: {err}")
    fid["extra_ids"].extend(matchup_ids)
    fid["extra_ids"].extend(entry_ids)
    return {"matchup_ids": matchup_ids, "entry_ids": entry_ids}


def cleanup_fixture(fid):
    """Delete all rows owned by this fixture, including media_assets.

    Order matters: children first, then parents.  media_assets are deleted
    after session players because their generated_by_player_id may be set null
    on player deletion, but we still have the IDs.
    """
    if not fid:
        return
    # Collect all entry_ids (including extra_ids that are entries) for
    # generation deletion.  We delete generations by entry_id in a safe way.
    entry_ids = fid["entries"]
    extra_entries = [eid for eid in fid["extra_ids"] if isinstance(eid, str)]
    # We don't know types; but extra_ids may contain matchup/generation IDs.
    # Deletion order below handles all.

    sql = f"""
    DELETE FROM public.session_battle_generations
      WHERE entry_id IN (SELECT id FROM public.session_battle_entries
                         WHERE matchup_id IN (SELECT id FROM public.session_battle_matchups
                                              WHERE session_id = {qlit(fid['session_id'])}));
    DELETE FROM public.session_battle_entries
      WHERE matchup_id IN (SELECT id FROM public.session_battle_matchups
                           WHERE session_id = {qlit(fid['session_id'])});
    DELETE FROM public.session_battle_matchups WHERE session_id = {qlit(fid['session_id'])};
    DELETE FROM public.session_players WHERE session_id = {qlit(fid['session_id'])};
    DELETE FROM public.sessions WHERE id = {qlit(fid['session_id'])};
    DELETE FROM public.quiz_versions WHERE id = {qlit(fid['version_id'])};
    DELETE FROM public.quizzes WHERE id = {qlit(fid['quiz_id'])};
    """
    if fid["asset_ids"]:
        ids = ", ".join(qlit(a) for a in fid["asset_ids"])
        sql += f"DELETE FROM public.media_assets WHERE id IN ({ids});\n"
    if fid.get("auth_user_ids"):
        ids = ", ".join(qlit(a) for a in fid["auth_user_ids"])
        sql += f"DELETE FROM auth.users WHERE id IN ({ids});\n"
    # Also delete any extra_ids that might be orphan generations/media? Not needed if cascaded.
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Cleanup failed for session {fid.get('session_id', '?')}: {err}")


def check_entry_submission(fid, entry_id, expected_asset_id=None, expected_forfeit=False):
    sql = f"""
    SELECT submitted_asset_id IS NOT DISTINCT FROM {qlit(expected_asset_id) if expected_asset_id else 'NULL'},
           (forfeited_at IS NOT NULL) = {str(expected_forfeit).lower()}
    FROM public.session_battle_entries WHERE id = {qlit(entry_id)};
    """
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Entry check failed: {err}")
    result = out.strip()
    if result != "t|t":
        raise AssertionError(f"Entry {entry_id} mismatch: {result}")


def get_session_phase_revision(fid):
    sql = f"SELECT phase, revision FROM public.sessions WHERE id = {qlit(fid['session_id'])};"
    rc, out, err = psql_exec(sql)
    if rc != 0:
        raise RuntimeError(f"Session check failed: {err}")
    parts = out.strip().split("|")
    return parts[0], parts[1]


def check_session_phase_revision(fid, expected_phase, expected_revision):
    phase, rev = get_session_phase_revision(fid)
    if phase != expected_phase or rev != str(expected_revision):
        raise AssertionError(f"Session mismatch: phase={phase} rev={rev}, expected {expected_phase}/{expected_revision}")


# ---------------------------------------------------------------------------
# Individual contract cases
# ---------------------------------------------------------------------------

def run_case_a1():
    assert_required_rpcs_exist(["public.submit_battle_entry(text,text,uuid)"])
    fid = create_fixture()
    try:
        p1 = fid["players"][0]
        e1 = fid["entries"][0]
        asset1 = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [asset1])
        res = rpc("anon", f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'player-{p1[:8]}', {qlit(asset1)});")
        assert set(res.keys()) == {"entryId", "submittedAssetId", "submittedAt"}, f"A1 response keys wrong: {res}"
        assert res["submittedAssetId"] == asset1
        check_entry_submission(fid, e1, asset1)

        asset2 = add_media_asset(fid, p1)
        add_generation(fid, e1, 1, [asset2])
        res2 = rpc("anon", f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'player-{p1[:8]}', {qlit(asset2)});")
        assert res2["submittedAssetId"] == asset2
        check_entry_submission(fid, e1, asset2)
        print("A1 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_a2():
    assert_required_rpcs_exist(["public.submit_battle_entry(text,text,uuid)"])
    fid = create_fixture(num_players=3)
    fid2 = None
    try:
        p1 = fid["players"][0]
        p2 = fid["players"][1]
        e1 = fid["entries"][0]
        e2 = fid["entries"][1]
        valid_asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [valid_asset])

        foreign_asset = add_media_asset(fid, p2)
        add_generation(fid, e2, 0, [foreign_asset])

        arbitrary_asset = add_media_asset(fid, p1)

        unrecorded_asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 1, [unrecorded_asset], status='pending')

        # previous round asset (round_index 1) for p1
        prev_matchup_id = gen_uuid()
        prev_entry_id = gen_uuid()
        prev_asset = add_media_asset(fid, p1)
        sql = f"""
        INSERT INTO public.session_battle_matchups
          (id, session_id, round_index, matchup_index, prompt_id, prompt_text)
        VALUES ({qlit(prev_matchup_id)}, {qlit(fid['session_id'])}, 1, 0, 'p1', 'Old prompt');
        INSERT INTO public.session_battle_entries (id, matchup_id, player_id)
        VALUES ({qlit(prev_entry_id)}, {qlit(prev_matchup_id)}, {qlit(p1)});
        """
        psql_check(sql)
        add_generation(fid, prev_entry_id, 0, [prev_asset])

        fid2 = create_fixture()
        p_other = fid2["players"][0]
        e_other = fid2["entries"][0]
        other_asset = add_media_asset(fid2, p_other)
        add_generation(fid2, e_other, 0, [other_asset])

        # Include p2's foreign asset in p1's own complete generation to prove media owner check
        add_generation(fid, e1, 4, [foreign_asset], status='complete')

        # Insert a minimal auth.users row for the author-source media asset.
        auth_user_id = gen_uuid()
        psql_check(f"INSERT INTO auth.users (id) VALUES ({qlit(auth_user_id)});")
        fid["auth_user_ids"].append(auth_user_id)

        # wrong media source and kind boundary checks
        wrong_source_asset = add_media_asset(fid, p1, source='author', uploaded_by=auth_user_id)
        add_generation(fid, e1, 2, [wrong_source_asset])
        wrong_kind_asset = add_media_asset(fid, p1, kind='video')
        add_generation(fid, e1, 3, [wrong_kind_asset])

        attempts = [
            (foreign_asset, "foreign"),
            (arbitrary_asset, "arbitrary"),
            (unrecorded_asset, "unrecorded"),
            (prev_asset, "old round"),
            (other_asset, "other session"),
            (wrong_source_asset, "wrong media source"),
            (wrong_kind_asset, "wrong media kind"),
            (None, "null asset"),
        ]
        for asset, label in attempts:
            asset_lit = qlit(asset) if asset is not None else "NULL"
            rc, out, err = psql_exec(
                f"BEGIN; SET LOCAL ROLE anon; "
                f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'player-{p1[:8]}', {asset_lit}); "
                f"ROLLBACK;",
                check=False,
            )
            if rc == 0:
                raise AssertionError(f"A2 rejected {label} should fail but succeeded")
            err_lower = err.lower()
            assert "permission denied" not in err_lower, f"A2 {label} error was permission denied: {err}"
            assert "syntax error" not in err_lower, f"A2 {label} error was syntax error: {err}"
            if label == "null asset":
                assert "asset" in err_lower and "null" in err_lower, f"A2 null asset error not meaningful: {err}"
            else:
                assert any(token in err_lower for token in ["asset", "image", "generation", "battle", "source", "kind", "own"]), \
                    f"A2 {label} error not meaningful: {err}"

        sql = f"SELECT submitted_asset_id IS NULL AND submitted_at IS NULL FROM public.session_battle_entries WHERE id = {qlit(e1)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "t", "A2 entry was mutated"
        phase, rev = get_session_phase_revision(fid)
        assert phase == "battle_prompt", f"A2 session phase changed: {phase}"
        assert rev == "0", f"A2 session revision changed: {rev}"
        print("A2 PASS")
    finally:
        cleanup_fixture(fid)
        if fid2:
            cleanup_fixture(fid2)


def run_case_a3():
    assert_required_rpcs_exist(["public.submit_battle_entry(text,text,uuid)"])
    fid = create_fixture(num_players=2)
    try:
        p1 = fid["players"][0]
        e1 = fid["entries"][0]
        valid_asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [valid_asset])

        late = gen_uuid()
        psql_check(f"""
        INSERT INTO public.session_players (id, session_id, player_token_hash, display_name)
        VALUES ({qlit(late)}, {qlit(fid['session_id'])}, public.token_hash('late-token'), 'Late joiner');
        """)

        attempts = [
            ("wrong token", f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'wrong-token', {qlit(valid_asset)});"),
            ("missing token", f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, NULL, {qlit(valid_asset)});"),
            ("wrong room", f"SELECT public.submit_battle_entry('AAAAAA', 'player-{p1[:8]}', {qlit(valid_asset)});"),
            ("late joiner", f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'late-token', {qlit(valid_asset)});"),
        ]
        for label, call in attempts:
            rc, out, err = psql_exec(f"BEGIN; SET LOCAL ROLE anon; {call} ROLLBACK;", check=False)
            assert rc != 0, f"A3 {label} call should fail"
            err_lower = err.lower()
            assert "permission denied" not in err_lower, f"A3 {label} error was permission denied: {err}"
            assert "syntax error" not in err_lower, f"A3 {label} error was syntax error: {err}"
            assert any(token in err_lower for token in ["player", "room", "matchup", "token", "not in"]), \
                f"A3 {label} error not meaningful: {err}"

        sql = f"SELECT submitted_asset_id IS NULL AND submitted_at IS NULL FROM public.session_battle_entries WHERE id = {qlit(e1)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "t", "A3 entry was mutated"
        sql = f"SELECT submitted_asset_id IS NULL FROM public.session_battle_entries WHERE id = {qlit(fid['entries'][1])};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "t", "A3 other entry was mutated"
        phase, rev = get_session_phase_revision(fid)
        assert phase == "battle_prompt", f"A3 session phase changed: {phase}"
        assert rev == "0", f"A3 session revision changed: {rev}"
        print("A3 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_a4():
    assert_required_rpcs_exist([
        "public.submit_battle_entry(text,text,uuid)",
        "public.lock_battle_prompt(text,text)",
        "public.host_battle_state_payload(uuid,integer)",
    ])
    fid_review = create_fixture(session_phase='battle_review')
    fid_lobby = None
    fid_prompt = None
    try:
        p1 = fid_review["players"][0]
        e1 = fid_review["entries"][0]
        asset = add_media_asset(fid_review, p1)
        add_generation(fid_review, e1, 0, [asset])

        # submit in battle_review should fail meaningfully
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.submit_battle_entry({qlit(fid_review['room_code'])}, 'player-{p1[:8]}', {qlit(asset)}); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "A4 submit wrong phase should fail"
        err_lower = err.lower()
        assert "permission denied" not in err_lower and "syntax error" not in err_lower
        assert any(token in err_lower for token in ["battle_prompt", "phase", "not open", "closed"]), f"A4 submit error not meaningful: {err}"

        # host lock in battle_review should succeed with locked:false
        res = rpc("anon", f"SELECT public.lock_battle_prompt({qlit(fid_review['room_code'])}, 'hostsecret');")
        assert res.get("locked") == False, f"A4 battle_review lock should return locked:false, got {res}"
        check_session_phase_revision(fid_review, "battle_review", 0)

        # other phase (lobby) host lock should error meaningfully
        fid_lobby = create_fixture(session_phase='lobby')
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.lock_battle_prompt({qlit(fid_lobby['room_code'])}, 'hostsecret'); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "A4 lobby lock should fail"
        err_lower = err.lower()
        assert "permission denied" not in err_lower and "syntax error" not in err_lower
        assert any(token in err_lower for token in ["battle_prompt", "phase", "not open"]), f"A4 lobby error not meaningful: {err}"
        check_session_phase_revision(fid_lobby, "lobby", 0)

        # unauthorized host in battle_prompt should error meaningfully
        fid_prompt = create_fixture(session_phase='battle_prompt')
        rc, out, err = psql_exec(
            f"BEGIN; SET LOCAL ROLE anon; "
            f"SELECT public.lock_battle_prompt({qlit(fid_prompt['room_code'])}, 'wrongsecret'); "
            f"ROLLBACK;", check=False)
        assert rc != 0, "A4 unauthorized host should fail"
        err_lower = err.lower()
        assert "permission denied" not in err_lower and "syntax error" not in err_lower
        assert "host" in err_lower or "authorization" in err_lower, f"A4 unauthorized host error not meaningful: {err}"
        check_session_phase_revision(fid_prompt, "battle_prompt", 0)
        print("A4 PASS")
    finally:
        cleanup_fixture(fid_review)
        if fid_lobby:
            cleanup_fixture(fid_lobby)
        if fid_prompt:
            cleanup_fixture(fid_prompt)


def run_case_a5():
    assert_required_rpcs_exist([
        "public.lock_battle_prompt(text,text)",
        "public.host_battle_state_payload(uuid,integer)",
    ])
    fid = create_fixture(current_round_index=1, num_players=4)
    fid_other = create_fixture(num_players=2)
    try:
        p1, p2, p3, p4 = fid["players"][:4]
        e1, e2, e3, e4 = fid["entries"][:4]

        # previous round entries with sentinel submission/timestamps
        prev = add_previous_round_entries(fid, num_players=2, round_index=0)
        prev_entry_ids = prev["entry_ids"]
        for prev_eid in prev_entry_ids:
            prev_asset = add_media_asset(fid, fid["players"][0])
            add_generation(fid, prev_eid, 0, [prev_asset])
            psql_check(f"UPDATE public.session_battle_entries SET submitted_asset_id = {qlit(prev_asset)}, submitted_at = now(), forfeited_at = now() WHERE id = {qlit(prev_eid)};")

        # p1 explicit choice older image
        asset_old = add_media_asset(fid, p1)
        asset_new = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [asset_old])
        add_generation(fid, e1, 1, [asset_new])
        psql_check(f"UPDATE public.session_battle_entries SET submitted_asset_id = {qlit(asset_old)}, submitted_at = now() WHERE id = {qlit(e1)};")

        # p2 latest complete generation with two images; must select FINAL one
        asset_p2_0 = add_media_asset(fid, p2)
        asset_p2_1a = add_media_asset(fid, p2)
        asset_p2_1b = add_media_asset(fid, p2)
        add_generation(fid, e2, 0, [asset_p2_0])
        add_generation(fid, e2, 1, [asset_p2_1a, asset_p2_1b])

        # p3 has complete lower, then failed/blocked/pending higher and empty complete
        asset_p3_complete = add_media_asset(fid, p3)
        add_generation(fid, e3, 0, [asset_p3_complete])
        add_generation(fid, e3, 1, [], status='failed')
        add_generation(fid, e3, 2, [], status='blocked')
        add_generation(fid, e3, 3, [], status='pending')
        add_generation(fid, e3, 4, [], status='complete')

        # p4 no complete generation -> forfeit
        add_generation(fid, e4, 0, [], status='pending')

        # other session sentinel: explicit choice and timestamps
        p_other = fid_other["players"][0]
        e_other = fid_other["entries"][0]
        asset_other = add_media_asset(fid_other, p_other)
        add_generation(fid_other, e_other, 0, [asset_other])
        psql_check(f"UPDATE public.session_battle_entries SET submitted_asset_id = {qlit(asset_other)}, submitted_at = now(), forfeited_at = null WHERE id = {qlit(e_other)};")
        other_snapshot_before = get_entry_session_snapshot(fid_other)

        fid_prev = dict(fid)
        fid_prev['current_round_index'] = 0
        prev_snapshot_before = get_entry_session_snapshot(fid_prev)['entries']

        res = rpc("anon", f"SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');")
        assert res.get("locked") == True

        # Verify selections
        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(e1)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == asset_old, "A5 explicit choice preserved"

        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(e2)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == asset_p2_1b, "A5 auto-pick final image of highest complete generation"

        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(e3)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == asset_p3_complete, "A5 ignore failed/blocked/pending/empty complete"

        sql = f"SELECT forfeited_at IS NOT NULL, submitted_asset_id IS NULL, submitted_at IS NULL FROM public.session_battle_entries WHERE id = {qlit(e4)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "t|t|t", "A5 p4 should be forfeited with no submission"

        check_session_phase_revision(fid, "battle_review", 1)
        sql = f"SELECT state ->> 'phase' FROM public.sessions WHERE id = {qlit(fid['session_id'])};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "battle_review", "A5 sessions.state.phase not updated"

        # previous round entries unchanged (exact entries snapshot)
        fid_prev = dict(fid)
        fid_prev['current_round_index'] = 0
        prev_snapshot_after = get_entry_session_snapshot(fid_prev)['entries']
        assert prev_snapshot_before == prev_snapshot_after, "A5 previous round entries changed"

        # other session unchanged
        other_snapshot_after = get_entry_session_snapshot(fid_other)
        assert other_snapshot_before == other_snapshot_after, "A5 other session changed"
        print("A5 PASS")
    finally:
        cleanup_fixture(fid)
        cleanup_fixture(fid_other)


def run_case_a6():
    assert_required_rpcs_exist([
        "public.lock_battle_prompt(text,text)",
        "public.host_battle_state_payload(uuid,integer)",
        "public.record_battle_generation(uuid, uuid[], numeric)",
    ])
    fid = create_fixture(num_players=2)
    try:
        p1, p2 = fid["players"]
        e1, e2 = fid["entries"]

        asset_p2 = add_media_asset(fid, p2)
        add_generation(fid, e2, 0, [asset_p2])

        pending_gen_id = add_generation(fid, e1, 0, [], status='pending', return_id=True)

        first = rpc("anon", f"SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');")
        assert first.get("locked") == True

        snapshot1 = get_entry_session_snapshot(fid)
        rev1 = snapshot1["revision"]
        upd1 = snapshot1["updated_at"]

        check_entry_submission(fid, e1, expected_forfeit=True)
        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(e2)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == asset_p2, "A6 p2 selected"

        replay = rpc("anon", f"SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');")
        assert replay.get("locked") == False
        snapshot2 = get_entry_session_snapshot(fid)
        assert snapshot1 == snapshot2, "A6 replay changed snapshot"

        late_asset = add_media_asset(fid, p1)
        record_call = (
            f"SELECT public.record_battle_generation({qlit(pending_gen_id)}, "
            f"ARRAY[{qlit(late_asset)}]::uuid[], 0.01);"
        )
        rc, out, err = psql_exec(record_call, role="service_role", check=False)
        if rc != 0:
            raise AssertionError(f"A6 record_battle_generation failed: {err}")
        record_res = json.loads(out.strip())
        assert record_res.get("status") == "complete", f"A6 record should return status complete, got {record_res}"
        assert record_res.get("recorded") == True, f"A6 record should return recorded true, got {record_res}"
        assert record_res.get("assetIds") == [late_asset], f"A6 record assetIds mismatch, got {record_res}"

        replay2 = rpc("anon", f"SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');")
        assert replay2.get("locked") == False
        snapshot3 = get_entry_session_snapshot(fid)
        assert snapshot1 == snapshot3, "A6 late completion changed snapshot"

        sql = f"SELECT forfeited_at IS NOT NULL, submitted_asset_id IS NULL, submitted_at IS NULL FROM public.session_battle_entries WHERE id = {qlit(e1)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == "t|t|t", "A6 late completion must not reopen forfeit or add submission"
        print("A6 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_a7():
    assert_required_rpcs_exist([
        "public.host_battle_state_payload(uuid,integer)",
        "public.get_host_battle_state(text,text)",
        "public.submit_battle_entry(text,text,uuid)",
        "public.lock_battle_prompt(text,text)",
    ])
    fid = create_fixture()
    try:
        p1 = fid["players"][0]
        e1 = fid["entries"][0]
        asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [asset])

        # helper denied to anon, authenticated, service_role
        for role in ["anon", "authenticated", "service_role"]:
            rc, out, err = psql_exec(
                f"BEGIN; SET LOCAL ROLE {role}; "
                f"SELECT public.host_battle_state_payload({qlit(fid['session_id'])}, 0); "
                f"ROLLBACK;", check=False)
            assert rc != 0, f"A7 helper as {role} should be denied"
            assert "permission denied" in err.lower(), f"A7 expected permission denied for {role}, got: {err}"

            # catalog check
            sql = f"SELECT has_function_privilege('{role}', 'public.host_battle_state_payload(uuid, integer)', 'EXECUTE');"
            rc_cat, out_cat, _ = psql_exec(sql)
            if rc_cat != 0:
                raise RuntimeError(f"A7 has_function_privilege query failed for {role}")
            assert out_cat.strip() == "f", f"A7 has_function_privilege should be false for {role}, got {out_cat.strip()}"

        # host state accessible via public RPC with valid host secret for both roles
        for role in ["anon", "authenticated"]:
            res = rpc(role, f"SELECT public.get_host_battle_state({qlit(fid['room_code'])}, 'hostsecret');")
            assert "sessionSpendUsd" in res, f"A7 host state missing sessionSpendUsd: {res}"
            assert "maxSessionSpendUsd" in res, f"A7 host state missing maxSessionSpendUsd: {res}"
            assert "roundIndex" in res
            assert "opened" in res
            assert "matchups" in res
            matchup = res["matchups"][0]
            for key in ["matchupId", "matchupIndex", "promptId", "promptText", "resolvedAt"]:
                assert key in matchup, f"A7 matchup missing {key}"
            entrant = matchup["entrants"][0]
            for key in ["entryId", "playerId", "playerName", "logoKey", "attemptsUsed", "submitted", "submittedAssetId", "submittedAt", "forfeited", "forfeitedAt", "vetoed"]:
                assert key in entrant, f"A7 entrant missing {key}"

        # wrong host secret denied for both roles
        for role in ["anon", "authenticated"]:
            rc, out, err = psql_exec(
                f"BEGIN; SET LOCAL ROLE {role}; "
                f"SELECT public.get_host_battle_state({qlit(fid['room_code'])}, 'wrongsecret'); "
                f"ROLLBACK;", check=False)
            assert rc != 0, f"A7 wrong host secret as {role} should fail"
            assert "permission denied" not in err.lower() and "syntax error" not in err.lower()
            assert "host" in err.lower() or "authorization" in err.lower(), f"A7 wrong host secret error not meaningful: {err}"

        # direct table select denied for both browser roles
        for role in ["anon", "authenticated"]:
            rc, out, err = psql_exec(
                f"BEGIN; SET LOCAL ROLE {role}; SELECT * FROM public.session_battle_entries; ROLLBACK;",
                check=False)
            assert rc != 0, f"A7 direct table select as {role} should be denied"
            assert "permission denied" in err.lower(), f"A7 direct table select as {role} should be permission denied, got: {err}"

        # submit usable as both browser roles with valid credentials
        for role in ["anon", "authenticated"]:
            submit_res = rpc(role, f"SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'player-{p1[:8]}', {qlit(asset)});")
            assert submit_res["submittedAssetId"] == asset

        # Exercise lock_battle_prompt as authenticated, then anon replay.
        lock_auth = rpc("authenticated", f"SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');")
        assert lock_auth.get("locked") == True
        snapshot_after_auth_lock = get_entry_session_snapshot(fid)
        lock_anon_replay = rpc("anon", f"SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');")
        assert lock_anon_replay.get("locked") == False
        snapshot_after_replay = get_entry_session_snapshot(fid)
        assert snapshot_after_auth_lock == snapshot_after_replay, "A7 authenticated lock replay changed snapshot"

        # Ensure forfeited fields are real booleans in host projection.
        for role in ["anon", "authenticated"]:
            res = rpc(role, f"SELECT public.get_host_battle_state({qlit(fid['room_code'])}, 'hostsecret');")
            matchup = res["matchups"][0]
            entrant = matchup["entrants"][0]
            assert isinstance(entrant["forfeited"], bool), f"A7 forfeited not boolean for {role}: {entrant['forfeited']}"
        print("A7 PASS")
    finally:
        cleanup_fixture(fid)


def run_case_a8():
    assert_required_rpcs_exist([
        "public.get_host_battle_state(text,text)",
        "public.get_player_battle_state(text,text)",
        "public.host_battle_state_payload(uuid,integer)",
    ])
    fid1 = create_fixture(current_round_index=1, num_players=4)
    fid2 = create_fixture(current_round_index=0, num_players=2)
    try:
        # session1 previous round (round 0) entries and spend
        prev = add_previous_round_entries(fid1, num_players=2, round_index=0)
        e1_prev = prev["entry_ids"][0]
        p1_prev_owner = fid1["players"][0]
        asset_prev = add_media_asset(fid1, p1_prev_owner)
        add_generation(fid1, e1_prev, 0, [asset_prev], cost_usd=5.0)

        # current round spend with complete,failed,blocked non-null cost and null cost ignored
        p1_curr = fid1["players"][0]
        e1_curr = fid1["entries"][0]
        asset_curr1 = add_media_asset(fid1, p1_curr)
        add_generation(fid1, e1_curr, 0, [asset_curr1], cost_usd=3.0)
        asset_curr2 = add_media_asset(fid1, p1_curr)
        add_generation(fid1, e1_curr, 1, [asset_curr2], cost_usd=2.0)
        add_generation(fid1, e1_curr, 2, [], status='failed', cost_usd=1.5)
        add_generation(fid1, e1_curr, 3, [], status='blocked', cost_usd=0.5)
        add_generation(fid1, e1_curr, 4, [], status='failed', cost_usd=None)

        # distinct current matchup prompts
        psql_check(f"""
        UPDATE public.session_battle_matchups SET prompt_id='p_current_0', prompt_text='Current Prompt A'
        WHERE id = {qlit(fid1['matchups'][0])};
        UPDATE public.session_battle_matchups SET prompt_id='p_current_1', prompt_text='Current Prompt B'
        WHERE id = {qlit(fid1['matchups'][1])};
        """)

        # own asset generation for player1; other player asset for player2
        own_asset = add_media_asset(fid1, p1_curr)
        add_generation(fid1, e1_curr, 5, [own_asset], cost_usd=0.01)
        p2_curr = fid1["players"][1]
        e2_curr = fid1["entries"][1]
        other_player_asset = add_media_asset(fid1, p2_curr)
        add_generation(fid1, e2_curr, 0, [other_player_asset], cost_usd=0.02)

        # session2 only cost 7, excluded
        p2 = fid2["players"][0]
        e2 = fid2["entries"][0]
        asset2 = add_media_asset(fid2, p2)
        add_generation(fid2, e2, 0, [asset2], cost_usd=7.0)

        # host state for session1
        res = rpc("anon", f"SELECT public.get_host_battle_state({qlit(fid1['room_code'])}, 'hostsecret');")
        assert "sessionSpendUsd" in res, f"A8 host state missing sessionSpendUsd: {res}"
        assert "maxSessionSpendUsd" in res, f"A8 host state missing maxSessionSpendUsd: {res}"
        assert res["sessionSpendUsd"] == 12.03, f"A8 sessionSpendUsd should be 12.03, got {res['sessionSpendUsd']}"
        assert res["maxSessionSpendUsd"] == 10, "A8 maxSessionSpendUsd from engine"

        # null cap: set JSON null
        psql_check(f"""
        UPDATE public.quiz_versions SET definition = jsonb_set(
            definition, '{{"rounds",1,"engine","maxSessionSpendUsd"}}', 'null'::jsonb)
        WHERE id = {qlit(fid1['version_id'])};
        """)
        res_null = rpc("anon", f"SELECT public.get_host_battle_state({qlit(fid1['room_code'])}, 'hostsecret');")
        assert "maxSessionSpendUsd" in res_null, "A8 null cap key missing"
        assert res_null["maxSessionSpendUsd"] is None, f"A8 JSON null cap should return null, got {res_null['maxSessionSpendUsd']}"

        # missing cap: remove key entirely
        psql_check(f"""
        UPDATE public.quiz_versions SET definition = definition #- '{{"rounds",1,"engine","maxSessionSpendUsd"}}'
        WHERE id = {qlit(fid1['version_id'])};
        """)
        res_missing = rpc("anon", f"SELECT public.get_host_battle_state({qlit(fid1['room_code'])}, 'hostsecret');")
        assert "maxSessionSpendUsd" in res_missing, "A8 missing cap key should still return key"
        assert res_missing["maxSessionSpendUsd"] is None, f"A8 missing key should return null, got {res_missing['maxSessionSpendUsd']}"

        # 0 cap
        psql_check(f"""
        UPDATE public.quiz_versions SET definition = jsonb_set(
            definition, '{{"rounds",1,"engine","maxSessionSpendUsd"}}', '0'::jsonb)
        WHERE id = {qlit(fid1['version_id'])};
        """)
        res_zero = rpc("anon", f"SELECT public.get_host_battle_state({qlit(fid1['room_code'])}, 'hostsecret');")
        assert "maxSessionSpendUsd" in res_zero, "A8 zero cap key missing"
        assert res_zero["maxSessionSpendUsd"] == 0, f"A8 0 cap should return 0, got {res_zero['maxSessionSpendUsd']}"

        # public state recursive forbidden keys check
        sql = f"SELECT state FROM public.sessions WHERE id = {qlit(fid1['session_id'])};"
        rc, out, _ = psql_exec(sql)
        state = json.loads(out.strip())
        forbidden_keys = ["sessionSpendUsd", "maxSessionSpendUsd", "roster", "spend", "assetId", "assetIds", "prompt", "promptText"]
        def walk(obj, path="state"):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if k in forbidden_keys:
                        raise AssertionError(f"A8 state leaks {k} at {path}: {obj}")
                    walk(v, f"{path}.{k}")
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    walk(v, f"{path}[{i}]")
        walk(state)

        # player payload: own prompt/asset only, no other player/asset/prompt or host spend/roster
        player_res = rpc("anon", f"SELECT public.get_player_battle_state({qlit(fid1['room_code'])}, 'player-{p1_curr[:8]}');")
        assert "entry" in player_res, "A8 player payload missing entry"
        entry = player_res["entry"]
        assert entry is not None, "A8 player entry should exist"
        assert entry.get("promptText") == "Current Prompt A", f"A8 player prompt wrong: {entry}"
        assert "sessionSpendUsd" not in player_res, "A8 player read leaks sessionSpendUsd"
        assert "maxSessionSpendUsd" not in player_res, "A8 player read leaks maxSessionSpendUsd"
        assert "roster" not in player_res, "A8 player read leaks roster"
        own_asset_ids = set()
        for gen in entry.get("generations", []):
            for aid in gen.get("assetIds", []):
                own_asset_ids.add(aid)
        assert own_asset in own_asset_ids, "A8 own asset missing from player generations"
        assert other_player_asset not in own_asset_ids, "A8 other player asset leaked to player"
        ps_json = json.dumps(player_res, sort_keys=True)
        assert p2_curr not in ps_json, "A8 other player UUID leaked"
        assert "Current Prompt B" not in ps_json, "A8 other matchup prompt leaked"
        print("A8 PASS")
    finally:
        cleanup_fixture(fid1)
        cleanup_fixture(fid2)


def run_case_a9():
    assert_required_rpcs_exist([
        "public.submit_battle_entry(text,text,uuid)",
        "public.lock_battle_prompt(text,text)",
    ])
    fid = create_fixture(num_players=2)
    proc1 = None
    proc2 = None
    try:
        p1 = fid["players"][0]
        e1 = fid["entries"][0]
        asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [asset])

        app1 = "a9_submit_" + fid["room_code"]
        app2 = "a9_lock_" + fid["room_code"]

        sql1 = f"""
        BEGIN;
        SET LOCAL ROLE anon;
        SET LOCAL statement_timeout = '10s';
        SET LOCAL lock_timeout = '10s';
        SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'player-{p1[:8]}', {qlit(asset)});
        \\echo SUBMIT_READY
        """
        proc1 = start_psql_async(sql1, app1, keep_open=True)
        if not read_until_marker(proc1, "SUBMIT_READY", timeout=15):
            terminate_proc(proc1)
            raise AssertionError("A9 submit process did not signal ready")

        sql2 = f"""
        BEGIN;
        SET LOCAL ROLE anon;
        SET LOCAL statement_timeout = '10s';
        SET LOCAL lock_timeout = '10s';
        SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');
        COMMIT;
        """
        proc2 = start_psql_async(sql2, app2, keep_open=False)

        if not wait_for_lock(app2, timeout=15):
            raise AssertionError("A9 host lock did not wait on submit")

        proc1.stdin.write("COMMIT;\n")
        proc1.stdin.flush()
        proc1.stdin.close()
        rc1 = proc1.wait(timeout=20)
        if rc1 != 0:
            raise AssertionError(f"A9 submit process failed rc={rc1}")

        rc2 = proc2.wait(timeout=20)
        out2 = proc2.stdout.read()
        err2 = proc2.stderr.read()
        if rc2 != 0:
            raise AssertionError(f"A9 host lock failed rc={rc2}: {err2}")

        sql = f"SELECT submitted_asset_id FROM public.session_battle_entries WHERE id = {qlit(e1)};"
        rc, out, _ = psql_exec(sql)
        assert out.strip() == asset, "A9 submitted selection not preserved"
        print("A9 PASS")
    finally:
        terminate_proc(proc1)
        terminate_proc(proc2)
        cleanup_fixture(fid)


def run_case_a10():
    assert_required_rpcs_exist([
        "public.submit_battle_entry(text,text,uuid)",
        "public.lock_battle_prompt(text,text)",
    ])
    # Part 1: lock first, submit rejects
    fid = create_fixture(num_players=2)
    proc1 = proc2 = None
    try:
        p1 = fid["players"][0]
        e1 = fid["entries"][0]
        asset = add_media_asset(fid, p1)
        add_generation(fid, e1, 0, [asset])

        app1 = "a10_lock1_" + fid["room_code"]
        app2 = "a10_submit_" + fid["room_code"]

        sql1 = f"""
        BEGIN;
        SET LOCAL ROLE anon;
        SET LOCAL statement_timeout = '10s';
        SET LOCAL lock_timeout = '10s';
        SELECT public.lock_battle_prompt({qlit(fid['room_code'])}, 'hostsecret');
        SELECT jsonb_build_object('lockedAt', now());
        \\echo LOCK_READY
        """
        proc1 = start_psql_async(sql1, app1, keep_open=True)
        if not read_until_marker(proc1, "LOCK_READY", timeout=15):
            terminate_proc(proc1)
            raise AssertionError("A10 lock process did not signal ready")

        sql2 = f"""
        BEGIN;
        SET LOCAL ROLE anon;
        SET LOCAL statement_timeout = '10s';
        SET LOCAL lock_timeout = '10s';
        SELECT public.submit_battle_entry({qlit(fid['room_code'])}, 'player-{p1[:8]}', {qlit(asset)});
        COMMIT;
        """
        proc2 = start_psql_async(sql2, app2, keep_open=False)

        if not wait_for_lock(app2, timeout=15):
            raise AssertionError("A10 submit did not wait on lock")

        proc1.stdin.write("COMMIT;\n")
        proc1.stdin.flush()
        proc1.stdin.close()
        rc1 = proc1.wait(timeout=20)
        if rc1 != 0:
            raise AssertionError(f"A10 lock process failed rc={rc1}")

        rc2 = proc2.wait(timeout=20)
        out2 = proc2.stdout.read()
        err2 = proc2.stderr.read()
        if rc2 == 0:
            raise AssertionError("A10 submit after lock should have failed")

        # meaningful phase exception, not generic SQL/permission
        err_lower = err2.lower()
        assert "permission denied" not in err_lower, f"A10 submit error was permission denied: {err2}"
        assert "syntax error" not in err_lower, f"A10 submit error was syntax error: {err2}"
        assert any(token in err_lower for token in ["battle_prompt", "phase", "submission", "closed"]), \
            f"A10 submit error not meaningful: {err2}"

        # after commit, snapshot: entry should have auto-selected asset and timestamps
        snapshot = get_entry_session_snapshot(fid)
        assert snapshot["phase"] == "battle_review", f"A10 session phase wrong: {snapshot['phase']}"
        assert snapshot["revision"] == 1, f"A10 revision wrong: {snapshot['revision']}"
        ent = next(e for e in snapshot["entries"] if e["entry_id"] == e1)
        assert ent["submitted_asset_id"] == asset, f"A10 auto-selected asset mismatch: {ent}"
        assert ent["submitted_at"] is not None, "A10 submitted_at should be set"
        assert ent["forfeited_at"] is None, "A10 forfeited_at should be null"

        # Compare snapshot entries against the first host lock response captured earlier.
        first_lock_lines = [line for line in proc1.captured_lines if line.strip()]
        assert len(first_lock_lines) >= 2, "A10 first host did not emit lock JSON and lockedAt"
        first_lock_resp = json.loads(first_lock_lines[0])
        first_locked_at = json.loads(first_lock_lines[1])["lockedAt"]
        assert snapshot["updated_at"] == first_locked_at, (
            f"A10 session.updated_at {snapshot['updated_at']} != first lock lockedAt {first_locked_at}"
        )
        for entry in snapshot["entries"]:
            entrant = None
            for matchup in first_lock_resp.get("matchups", []):
                for ent in matchup.get("entrants", []):
                    if ent.get("entryId") == entry["entry_id"]:
                        entrant = ent
                        break
                if entrant:
                    break
            assert entrant is not None, f"A10 no entrant in first lock for entry {entry['entry_id']}"
            assert entry["submitted_asset_id"] == entrant.get("submittedAssetId"), (
                f"A10 submittedAssetId mismatch for {entry['entry_id']}: {entry['submitted_asset_id']} != {entrant.get('submittedAssetId')}"
            )
            assert entry["submitted_at"] == entrant.get("submittedAt"), (
                f"A10 submittedAt mismatch for {entry['entry_id']}: {entry['submitted_at']} != {entrant.get('submittedAt')}"
            )
            assert entry["forfeited_at"] == entrant.get("forfeitedAt"), (
                f"A10 forfeitedAt mismatch for {entry['entry_id']}: {entry['forfeited_at']} != {entrant.get('forfeitedAt')}"
            )
    finally:
        terminate_proc(proc1)
        terminate_proc(proc2)
        cleanup_fixture(fid)

    # Part 2: simultaneous host lock calls, total revision +1 and no choice/timestamp changes
    fid2 = create_fixture(num_players=2)
    proc3 = proc4 = None
    try:
        p1 = fid2["players"][0]
        e1 = fid2["entries"][0]
        asset = add_media_asset(fid2, p1)
        add_generation(fid2, e1, 0, [asset])

        app3 = "a10_lock2a_" + fid2["room_code"]
        app4 = "a10_lock2b_" + fid2["room_code"]

        sql3 = f"""
        BEGIN;
        SET LOCAL ROLE anon;
        SET LOCAL statement_timeout = '10s';
        SET LOCAL lock_timeout = '10s';
        SELECT public.lock_battle_prompt({qlit(fid2['room_code'])}, 'hostsecret');
        SELECT jsonb_build_object('lockedAt', now());
        \\echo LOCK2_READY_A
        """
        proc3 = start_psql_async(sql3, app3, keep_open=True)
        if not read_until_marker(proc3, "LOCK2_READY_A", timeout=15):
            terminate_proc(proc3)
            raise AssertionError("A10 lock2 first did not signal")

        sql4 = f"""
        BEGIN;
        SET LOCAL ROLE anon;
        SET LOCAL statement_timeout = '10s';
        SET LOCAL lock_timeout = '10s';
        SELECT public.lock_battle_prompt({qlit(fid2['room_code'])}, 'hostsecret');
        COMMIT;
        """
        proc4 = start_psql_async(sql4, app4, keep_open=False)

        if not wait_for_lock(app4, timeout=15):
            raise AssertionError("A10 simultaneous second lock did not wait")

        proc3.stdin.write("COMMIT;\n")
        proc3.stdin.flush()
        proc3.stdin.close()
        rc3 = proc3.wait(timeout=20)
        if rc3 != 0:
            raise AssertionError(f"A10 lock2 first process failed rc={rc3}")

        rc4 = proc4.wait(timeout=20)
        out4 = proc4.stdout.read()
        err4 = proc4.stderr.read()
        if rc4 != 0:
            raise AssertionError(f"A10 second lock failed rc={rc4}: {err4}")
        lock4_result = json.loads(out4.strip())
        assert lock4_result.get("locked") == False, f"A10 second lock should return locked:false, got {lock4_result}"

        snapshot_after = get_entry_session_snapshot(fid2)
        assert snapshot_after["revision"] == 1, f"A10 simultaneous locks revision should be 1, got {snapshot_after['revision']}"
        ent1 = next(e for e in snapshot_after["entries"] if e["entry_id"] == e1)
        assert ent1["submitted_asset_id"] == asset, "A10 second lock changed submitted_asset_id"
        assert ent1["forfeited_at"] is None, "A10 second lock changed forfeited_at"

        # Compare snapshot entries against the first host lock response captured earlier.
        first_lock2_lines = [line for line in proc3.captured_lines if line.strip()]
        assert len(first_lock2_lines) >= 2, "A10 simultaneous first host did not emit lock JSON and lockedAt"
        first_lock2_resp = json.loads(first_lock2_lines[0])
        first_locked_at2 = json.loads(first_lock2_lines[1])["lockedAt"]
        assert snapshot_after["updated_at"] == first_locked_at2, (
            f"A10 simultaneous session.updated_at {snapshot_after['updated_at']} != first lock lockedAt {first_locked_at2}"
        )
        for entry in snapshot_after["entries"]:
            entrant = None
            for matchup in first_lock2_resp.get("matchups", []):
                for ent in matchup.get("entrants", []):
                    if ent.get("entryId") == entry["entry_id"]:
                        entrant = ent
                        break
                if entrant:
                    break
            assert entrant is not None, f"A10 simultaneous no entrant in first lock for entry {entry['entry_id']}"
            assert entry["submitted_asset_id"] == entrant.get("submittedAssetId"), (
                f"A10 simultaneous submittedAssetId mismatch for {entry['entry_id']}"
            )
            assert entry["submitted_at"] == entrant.get("submittedAt"), (
                f"A10 simultaneous submittedAt mismatch for {entry['entry_id']}"
            )
            assert entry["forfeited_at"] == entrant.get("forfeitedAt"), (
                f"A10 simultaneous forfeitedAt mismatch for {entry['entry_id']}"
            )
        print("A10 PASS")
    finally:
        terminate_proc(proc3)
        terminate_proc(proc4)
        cleanup_fixture(fid2)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Optional migration application
    if ARGS.migration:
        # Simulate historical explicit grants that migration 0039 must remove.
        grant_sql = f"""
        GRANT EXECUTE ON FUNCTION public.host_battle_state_payload(uuid, integer) TO anon;
        GRANT EXECUTE ON FUNCTION public.host_battle_state_payload(uuid, integer) TO authenticated;
        GRANT EXECUTE ON FUNCTION public.host_battle_state_payload(uuid, integer) TO service_role;
        """
        rc, out, err = psql_exec(grant_sql, timeout=30)
        if rc != 0:
            print(f"Pre-migration grant simulation failed: {err}", file=sys.stderr)
            return 1

        with open(ARGS.migration, "r", encoding="utf-8") as f:
            migration_sql = f.read()
        rc, out, err = psql_exec(migration_sql, timeout=120)
        if rc != 0:
            print(f"Migration application failed: {err}", file=sys.stderr)
            return 1

    cases = [
        ("A1", run_case_a1),
        ("A2", run_case_a2),
        ("A3", run_case_a3),
        ("A4", run_case_a4),
        ("A5", run_case_a5),
        ("A6", run_case_a6),
        ("A7", run_case_a7),
        ("A8", run_case_a8),
        ("A9", run_case_a9),
        ("A10", run_case_a10),
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
