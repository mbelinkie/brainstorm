// Disposable Postgres for behavior tests: PGlite (real Postgres compiled to
// WASM, in-process) with every migration in supabase/migrations applied in
// order. No Docker, no psql, no network, nothing touches the live project.
//
// Supabase provides some schemas and roles that plain Postgres does not. The
// stubs below are the minimum the migrations reference: the three API roles,
// pgcrypto in the `extensions` schema (where Supabase installs it, and where
// 0002's token_hash() calls it), auth.users / auth.uid(), and
// storage.buckets / storage.objects. They are not a model of Supabase's
// behavior, only enough shape for the DDL to apply.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url).pathname;

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema extensions;
  create extension pgcrypto with schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create schema storage;
  create table storage.buckets (
    id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text, name text, owner uuid
  );
  alter table storage.objects enable row level security;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
}

// Postgres refuses to use an enum value in the same transaction that added
// it, so each migration file runs as its own simple-protocol script, exactly
// as `supabase db push` applies them one file at a time.
export async function createMigratedDb({ upTo } = {}) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  for (const name of migrationFiles()) {
    if (upTo && name > upTo) break;
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  return db;
}
