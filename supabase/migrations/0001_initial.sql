-- Music Trivia Live: initial production schema.
-- Run this migration in the Supabase SQL Editor after creating the project.
-- Client apps do not get direct table-write permissions; the future server API
-- validates room/player/host actions before using its secret key to write.

create extension if not exists pgcrypto;

create type public.session_phase as enum (
  'lobby',
  'round_intro',
  'question_ready',
  'question_open',
  'question_locked',
  'answer_reveal',
  'leaderboard',
  'complete'
);

create table public.quizzes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quiz_versions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.quizzes(id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  unique (quiz_id, version)
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{6}$'),
  quiz_version_id uuid not null references public.quiz_versions(id),
  host_secret_hash text not null,
  phase public.session_phase not null default 'lobby',
  current_round_index integer not null default 0 check (current_round_index >= 0),
  current_question_index integer not null default 0 check (current_question_index >= 0),
  revision bigint not null default 0,
  state jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.session_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  player_token_hash text not null,
  display_name text not null check (char_length(display_name) between 1 and 32),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  unique (session_id, player_token_hash),
  unique (session_id, display_name)
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  question_id text not null,
  player_id uuid not null references public.session_players(id) on delete cascade,
  answer jsonb not null,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_revision bigint not null,
  is_locked boolean not null default false,
  unique (session_id, question_id, player_id)
);

create table public.score_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  player_id uuid not null references public.session_players(id) on delete cascade,
  question_id text,
  points numeric(7,2) not null,
  reason text not null check (char_length(reason) between 1 and 160),
  created_by text not null check (created_by in ('system', 'host')),
  created_at timestamptz not null default now()
);

create index sessions_room_code_idx on public.sessions (room_code);
create index session_players_session_id_idx on public.session_players (session_id);
create index submissions_session_question_idx on public.submissions (session_id, question_id);
create index score_events_session_player_idx on public.score_events (session_id, player_id);

-- The API layer owns write validation. Enable RLS now so a later client key
-- cannot accidentally bypass the session and scoring rules.
alter table public.quizzes enable row level security;
alter table public.quiz_versions enable row level security;
alter table public.sessions enable row level security;
alter table public.session_players enable row level security;
alter table public.submissions enable row level security;
alter table public.score_events enable row level security;

-- Realtime broadcasts should carry presentation state only. Do not publish
-- quiz definitions, answer keys, host notes, or audio asset names to players.
