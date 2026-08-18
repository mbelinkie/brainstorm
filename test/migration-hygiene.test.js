import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Two offline checks on `supabase/migrations/`. Neither can see the live
// schema — mistakes.md #13 is about drift between the two, and that is not
// locally testable. These cover the halves that are: that the ordering
// discipline the deploy process depends on actually holds, and that the
// Worker's service-role credential has been granted the tables it reads.

const root = new URL("../", import.meta.url);
const migrationsDir = new URL("supabase/migrations/", root);
const migrations = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

test("migrations are numbered sequentially with no gaps or duplicates", () => {
  // Migration history is production state. A colliding or out-of-order number
  // is how that history stops being replayable, which is exactly the drift
  // mistakes.md #13 records discovering the hard way.
  assert.ok(migrations.length > 0, "expected migration files");

  const numbers = migrations.map((name) => {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name);
    assert.ok(match, `migration "${name}" is not named NNNN_lower_snake_case.sql`);
    return Number(match[1]);
  });

  const seen = new Map();
  for (const [index, number] of numbers.entries()) {
    const previous = seen.get(number);
    assert.equal(previous, undefined, `migrations "${previous}" and "${migrations[index]}" share the number ${String(number).padStart(4, "0")}`);
    seen.set(number, migrations[index]);
  }

  assert.equal(numbers[0], 1, `the first migration is ${migrations[0]}, expected 0001`);
  for (let index = 1; index < numbers.length; index += 1) {
    assert.equal(
      numbers[index],
      numbers[index - 1] + 1,
      `migration numbering jumps from ${migrations[index - 1]} to ${migrations[index]}; numbers must be contiguous`
    );
  }
});

test("every table the Worker reads is granted to service_role", () => {
  // `cloudflare-worker.js` is the only holder of the service-role key. A
  // PostgREST read of a table that role has no `select` privilege on fails at
  // request time with a 401/permission error — invisible locally, and visible
  // to the room as an empty panel mid-show. Function EXECUTE is not checked
  // here: only `room_code()` and `token_hash()` are revoked from public, so
  // the RPC calls do not depend on an explicit grant.
  const workerSource = fs.readFileSync(new URL("cloudflare-worker.js", root), "utf8");

  const tables = new Set();
  for (const match of workerSource.matchAll(/rest\/v1\/([a-z_][a-z0-9_]*)/g)) {
    if (match[1] !== "rpc") tables.add(match[1]);
  }
  // PostgREST resource embedding: `select=answer,player:session_players(...)`
  // joins a second table, and that join needs its own grant.
  for (const select of workerSource.matchAll(/select=([^"'`&\s]+)/g)) {
    for (const embed of select[1].matchAll(/(?:[a-z_][a-z0-9_]*:)?([a-z_][a-z0-9_]*)\(/g)) tables.add(embed[1]);
  }
  assert.ok(tables.size > 0, "expected to find tables the Worker reads");

  const granted = new Set();
  for (const name of migrations) {
    const sql = fs.readFileSync(new URL(name, migrationsDir), "utf8");
    for (const grant of sql.matchAll(/grant\s+select\s+on\s+table\s+public\.([a-z_][a-z0-9_]*)\s+to\s+([^;]+);/gi)) {
      if (/\bservice_role\b/i.test(grant[2])) granted.add(grant[1]);
    }
  }

  const missing = [...tables].filter((table) => !granted.has(table)).sort();

  // No known-open gaps. `0028_answer_wall_service_role_read.sql` granted
  // `sessions` and `submissions` when the answer wall shipped; the
  // closest-number guess board later embedded `session_players` for the
  // display name and logo, and `0033_closest_number_player_names.sql` grants
  // it. Whoever reads a new table adds a grant rather than an exception.
  const knownMissingGrants = [];
  assert.deepEqual(
    missing,
    knownMissingGrants,
    `service_role table grants no longer match what cloudflare-worker.js reads.\n  reads:   ${[...tables].sort().join(", ")}\n  granted: ${[...granted].sort().join(", ")}\n  missing: ${missing.join(", ") || "(none)"}\n  expected missing: ${knownMissingGrants.join(", ") || "(none)"}`
  );
});
