-- Prompt Battle generation RPCs (issue #20): the Worker's three budget calls
-- and the player's own battle read.
--
-- Spec: docs/superpowers/specs/2026-08-17-prompt-battle-design.md section 7.2,
-- as amended by docs/superpowers/specs/2026-08-24-prompt-battle-free-engine-addendum.md
-- sections 5 and 6, and docs/superpowers/specs/2026-08-26-prompt-battle-architecture.md
-- section 4.1 (partial success).
--
-- Deliberately NOT in this migration: the Worker's /battle/generate route,
-- submission, host veto, voting and scoring. No table or column changes;
-- 0037 already created session_battle_generations.
--
-- Attempt accounting:
--   * session_battle_entries.attempts_used counts attempts that are reserved
--     (pending) or consumed (complete). authorize adds one; refund gives it
--     back. record leaves it alone.
--   * session_battle_generations.attempt_index is monotonic per entry
--     (max + 1), NOT attempts_used, so a refunded attempt's row keeps its
--     index and the next attempt never collides with unique(entry_id, attempt_index).
--
-- Concurrency: authorize locks the sessions row, then the entry row, before
-- reading any budget, so two simultaneous calls for the same player (or two
-- players racing for the session-wide caps) are serialized and the second
-- one sees the first one's reservation. record and refund lock the
-- generation row first, which makes a retried call wait and then take the
-- idempotent replay branch. Lock order is session -> entry in authorize and
-- generation -> entry in refund; neither waits on a lock the other holds
-- first, so they cannot deadlock against each other.
--
-- Known limit of the spend cap: a pending generation has no cost until it is
-- recorded, so attempts already in flight when the cap is reached can still
-- land and overshoot it by at most their own cost. That is inherent in
-- "authorize before the provider reports cost" (base spec 7.2) and matches
-- the addendum's ">= cap" check.

-- Called by the Worker (service_role) before it calls an image provider.
-- Reserves one attempt by inserting a pending generation row and returns
-- everything the Worker needs to call the provider. The provider and model
-- are the session's effective engine from set_battle_engine (0036); when the
-- host never changed it, the battle round's authored defaults apply. Neither
-- ever comes from the request: the only request input stored is the player's
-- own prompt.
create or replace function public.authorize_battle_generation(
  p_room_code text,
  p_player_token text,
  p_player_prompt text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  active_entry public.session_battle_entries;
  active_matchup public.session_battle_matchups;
  quiz_definition jsonb;
  battle_round jsonb;
  battle_engine jsonb;
  engine_provider text;
  engine_model text;
  attempt_budget integer;
  max_spend numeric;
  current_spend numeric;
  max_generations integer;
  generation_count integer;
  next_attempt_index integer;
  new_generation_id uuid;
  safe_prompt text;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token)
  for update of s;
  if not found then raise exception 'Player is not in this room'; end if;
  select * into active_player from public.session_players
  where session_id = active_session.id and player_token_hash = public.token_hash(p_player_token);
  if active_session.phase::text <> 'battle_prompt' then raise exception 'Image generation is not open'; end if;

  safe_prompt := trim(coalesce(p_player_prompt, ''));
  if safe_prompt = '' or char_length(safe_prompt) > 2048 then
    raise exception 'Describe your image in 2048 characters or fewer';
  end if;

  -- A player who joined after the round opened has no entry, and gets no
  -- generation: this never creates one.
  select e.* into active_entry
  from public.session_battle_entries e
  join public.session_battle_matchups m on m.id = e.matchup_id
  where m.session_id = active_session.id
    and m.round_index = active_session.current_round_index
    and e.player_id = active_player.id
  for update of e;
  if not found then raise exception 'You are not in a matchup this round'; end if;
  select * into active_matchup from public.session_battle_matchups where id = active_entry.matchup_id;

  select definition into quiz_definition
  from public.quiz_versions where id = active_session.quiz_version_id;
  battle_round := quiz_definition -> 'rounds' -> active_session.current_round_index;
  if battle_round ->> 'type' is distinct from 'prompt_battle' then
    raise exception 'Round % is not a prompt battle round', active_session.current_round_index + 1;
  end if;
  battle_engine := battle_round -> 'engine';

  engine_provider := coalesce(active_session.battle_engine_provider, battle_engine ->> 'defaultProvider');
  engine_model := coalesce(active_session.battle_engine_model, battle_engine ->> 'defaultModel');
  if engine_provider is null or engine_model is null then
    raise exception 'No image engine is set for this game';
  end if;

  attempt_budget := (battle_engine ->> 'attemptBudget')::integer;
  if attempt_budget is null then raise exception 'This battle round has no attempt budget'; end if;
  -- ->> is SQL null for both a JSON null and a missing key, and both mean
  -- "no monetary cap". 0 means generation is disabled (addendum section 5).
  max_spend := (battle_engine ->> 'maxSessionSpendUsd')::numeric;
  max_generations := (battle_engine ->> 'maxSessionGenerations')::integer;

  if active_entry.attempts_used >= attempt_budget then raise exception 'You have no generation attempts left'; end if;

  if max_spend is not null then
    if max_spend <= 0 then raise exception 'Image generation is turned off for this game'; end if;
    select coalesce(sum(g.cost_usd), 0) into current_spend
    from public.session_battle_generations g
    join public.session_battle_entries ge on ge.id = g.entry_id
    join public.session_battle_matchups gm on gm.id = ge.matchup_id
    where gm.session_id = active_session.id;
    if current_spend >= max_spend then raise exception 'This game has reached its image spending limit'; end if;
  end if;

  -- The generation count is the only bound on a free provider, so it is
  -- enforced independently of the monetary cap. Refunded rows (failed,
  -- blocked) do not count.
  if max_generations is not null then
    select count(*) into generation_count
    from public.session_battle_generations g
    join public.session_battle_entries ge on ge.id = g.entry_id
    join public.session_battle_matchups gm on gm.id = ge.matchup_id
    where gm.session_id = active_session.id
      and g.status in ('pending', 'complete');
    if generation_count >= max_generations then raise exception 'This game has reached its image generation limit'; end if;
  end if;

  select coalesce(max(g.attempt_index) + 1, 0) into next_attempt_index
  from public.session_battle_generations g
  where g.entry_id = active_entry.id;

  insert into public.session_battle_generations (
    entry_id, attempt_index, player_prompt, provider, model, status
  ) values (
    active_entry.id, next_attempt_index, safe_prompt, engine_provider, engine_model, 'pending'
  )
  returning id into new_generation_id;

  update public.session_battle_entries set attempts_used = attempts_used + 1
  where id = active_entry.id
  returning * into active_entry;

  return jsonb_build_object(
    'generationId', new_generation_id,
    'attemptIndex', next_attempt_index,
    'promptText', active_matchup.prompt_text,
    'playerPrompt', safe_prompt,
    'provider', engine_provider,
    'model', engine_model,
    'variants', (battle_engine ->> 'variants')::integer,
    'resolution', battle_engine ->> 'resolution',
    'outputFormat', battle_engine ->> 'outputFormat',
    'steps', (battle_engine ->> 'steps')::integer,
    'attemptsRemaining', attempt_budget - active_entry.attempts_used
  );
end;
$$;

-- Called by the Worker (service_role) after at least one image came back and
-- was stored as a battle media_assets row. Partial success is normal: fewer
-- images than variants still completes the attempt (architecture spec 4.1);
-- zero images is a refund, not a record.
--
-- IDEMPOTENT. A retry of an already-complete generation returns the stored
-- row unchanged ('recorded': false). Cost is assigned to the row, never added
-- to a running total, so a replay cannot double-count spend. A refunded row
-- cannot be recorded: its attempt was already given back.
--
-- No phase check on purpose: a generation in flight when the host moves on
-- must still be able to finish.
create or replace function public.record_battle_generation(
  p_generation_id uuid,
  p_asset_ids uuid[],
  p_cost_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_generation public.session_battle_generations;
  generation_player_id uuid;
  requested_variants integer;
begin
  select * into active_generation
  from public.session_battle_generations where id = p_generation_id for update;
  if not found then raise exception 'Generation not found'; end if;

  select e.player_id, (q.definition -> 'rounds' -> m.round_index -> 'engine' ->> 'variants')::integer
  into generation_player_id, requested_variants
  from public.session_battle_entries e
  join public.session_battle_matchups m on m.id = e.matchup_id
  join public.sessions s on s.id = m.session_id
  join public.quiz_versions q on q.id = s.quiz_version_id
  where e.id = active_generation.entry_id;

  if active_generation.status = 'complete' then return jsonb_build_object(
      'generationId', active_generation.id,
      'status', active_generation.status,
      'assetIds', to_jsonb(active_generation.asset_ids),
      'costUsd', active_generation.cost_usd,
      'partial', cardinality(active_generation.asset_ids) < requested_variants,
      'recorded', false
    );
  end if;
  if active_generation.status <> 'pending' then raise exception 'This generation was refunded and cannot be recorded'; end if;

  if coalesce(cardinality(p_asset_ids), 0) = 0 then raise exception 'A generation with no images must be refunded, not recorded'; end if;
  if requested_variants is not null and cardinality(p_asset_ids) > requested_variants then
    raise exception 'More images than this round allows';
  end if;
  if p_cost_usd is not null and p_cost_usd < 0 then raise exception 'Generation cost cannot be negative'; end if;

  -- Every asset must be battle media generated by this entry's player, which
  -- is exactly what can_access_live_media (0037) will later check before
  -- serving it to that player.
  if exists (
    select 1 from unnest(p_asset_ids) as requested(asset_id)
    where not exists (
      select 1 from public.media_assets a
      where a.id = requested.asset_id
        and a.source = 'battle' and a.generated_by_player_id = generation_player_id
    )
  ) then
    raise exception 'Generated images do not belong to this player';
  end if;

  update public.session_battle_generations set
    asset_ids = p_asset_ids,
    cost_usd = p_cost_usd,
    status = 'complete'
  where id = active_generation.id and status = 'pending'
  returning * into active_generation;

  return jsonb_build_object(
    'generationId', active_generation.id,
    'status', active_generation.status,
    'assetIds', to_jsonb(active_generation.asset_ids),
    'costUsd', active_generation.cost_usd,
    'partial', cardinality(active_generation.asset_ids) < requested_variants,
    'recorded', true
  );
end;
$$;

-- Called by the Worker (service_role) when an attempt produced no images:
-- 'provider_error' marks the row failed, 'safety_block' marks it blocked.
-- Either way the attempt is given back and no point is deducted (base spec
-- 7.2 steps 4 and 5). The reason is kept in block_reason for both kinds,
-- since 0037 has no separate column for a provider error message.
--
-- IDEMPOTENT. A retry of an already-refunded generation returns the stored
-- row ('refunded': false) and restores nothing, so an attempt can never be
-- given back twice. A completed generation cannot be refunded.
create or replace function public.refund_battle_attempt(
  p_generation_id uuid,
  p_reason_kind text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_generation public.session_battle_generations;
  active_entry public.session_battle_entries;
begin
  if p_reason_kind is null or p_reason_kind not in ('provider_error', 'safety_block') then raise exception 'Unknown refund reason'; end if;

  select * into active_generation
  from public.session_battle_generations where id = p_generation_id for update;
  if not found then raise exception 'Generation not found'; end if;

  if active_generation.status in ('failed', 'blocked') then return jsonb_build_object(
      'generationId', active_generation.id,
      'status', active_generation.status,
      'reason', active_generation.block_reason,
      'refunded', false
    );
  end if;
  if active_generation.status <> 'pending' then raise exception 'A completed generation cannot be refunded'; end if;

  update public.session_battle_generations set
    status = case when p_reason_kind = 'safety_block' then 'blocked' else 'failed' end,
    block_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 500)
  where id = active_generation.id and status = 'pending'
  returning * into active_generation;

  update public.session_battle_entries set attempts_used = greatest(attempts_used - 1, 0)
  where id = active_generation.entry_id
  returning * into active_entry;

  return jsonb_build_object(
    'generationId', active_generation.id,
    'status', active_generation.status,
    'reason', active_generation.block_reason,
    'refunded', true,
    'attemptsUsed', active_entry.attempts_used
  );
end;
$$;

-- Player read of their own battle state (deferred by slice 3a). Returns only
-- the caller's own matchup prompt, attempts remaining, and their own
-- generations' asset IDs. No other player, no opponent, no pairing, no
-- costs, no engine, no submission/veto/vote fields. A player with no entry
-- this round (a late joiner), or any call outside a battle phase, gets
-- 'entry': null. Read-only: it takes no lock and writes nothing.
create or replace function public.get_player_battle_state(
  p_room_code text,
  p_player_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  active_entry public.session_battle_entries;
  own_prompt_text text;
  attempt_budget integer;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token);
  if not found then raise exception 'Player is not in this room'; end if;
  select * into active_player from public.session_players
  where session_id = active_session.id and player_token_hash = public.token_hash(p_player_token);

  if active_session.phase::text not in ('battle_prompt', 'battle_review', 'battle_vote', 'battle_result') then
    return jsonb_build_object('roomCode', active_session.room_code, 'phase', active_session.phase, 'entry', null);
  end if;

  select e.* into active_entry
  from public.session_battle_entries e
  join public.session_battle_matchups m on m.id = e.matchup_id
  where m.session_id = active_session.id
    and m.round_index = active_session.current_round_index
    and e.player_id = active_player.id;
  if not found then return jsonb_build_object('roomCode', active_session.room_code, 'phase', active_session.phase, 'entry', null); end if;

  select m.prompt_text, (q.definition -> 'rounds' -> m.round_index -> 'engine' ->> 'attemptBudget')::integer
  into own_prompt_text, attempt_budget
  from public.session_battle_matchups m
  join public.quiz_versions q on q.id = active_session.quiz_version_id
  where m.id = active_entry.matchup_id;

  return jsonb_build_object(
    'roomCode', active_session.room_code,
    'phase', active_session.phase,
    'entry', jsonb_build_object(
      'promptText', own_prompt_text,
      'attemptsRemaining', greatest(attempt_budget - active_entry.attempts_used, 0),
      'generations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'attemptIndex', g.attempt_index,
          'status', g.status,
          'assetIds', to_jsonb(g.asset_ids)
        ) order by g.attempt_index)
        from public.session_battle_generations g
        where g.entry_id = active_entry.id
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and
-- Supabase's default privileges may also grant it to anon and authenticated.
-- The three Worker RPCs reserve attempts and write costs, so a browser role
-- must not be able to call them: revoke from all three, then grant only
-- service_role (held only by cloudflare-worker.js).
revoke all on function public.authorize_battle_generation(text, text, text) from public, anon, authenticated;
grant execute on function public.authorize_battle_generation(text, text, text) to service_role;
revoke all on function public.record_battle_generation(uuid, uuid[], numeric) from public, anon, authenticated;
grant execute on function public.record_battle_generation(uuid, uuid[], numeric) to service_role;
revoke all on function public.refund_battle_attempt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.refund_battle_attempt(uuid, text, text) to service_role;

-- Player RPC: same grant as get_live_room_state and the other player RPCs.
grant execute on function public.get_player_battle_state(text, text) to anon, authenticated;
