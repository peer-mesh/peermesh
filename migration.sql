-- PeerMesh mandate relay foundation.
-- device_id is text to preserve existing extension/desktop/CLI IDs.

create table if not exists device_keys (
  device_id text primary key,
  user_id uuid references profiles(id) on delete cascade,
  public_key text not null,
  role text not null check (role in ('provider', 'requester')),
  registered_at timestamptz not null default now(),
  binary_hash text,
  binary_version text,
  revoked boolean default false,
  revoked_at timestamptz,
  revocation_reason text
);

create index if not exists idx_device_keys_user on device_keys(user_id, role);

create table if not exists session_mandates (
  session_id uuid primary key references sessions(id) on delete cascade,
  requester_device_id text,
  provider_device_id text,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  transport_tier int not null,
  policy_snapshot jsonb not null,
  session_nonce text not null,
  forced_relay boolean default false,
  verifier_confirmed boolean default false,
  mandate jsonb not null default '{}'::jsonb
);

create table if not exists session_receipts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  device_id text,
  role text not null check (role in ('provider', 'requester')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  bytes_reported bigint not null,
  chain_value text not null,
  tokens_count int not null default 0,
  nonce text not null unique,
  device_sig text not null,
  session_sig text not null,
  transit_intact boolean,
  verified boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists byte_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  token_index int not null,
  token_value text not null,
  issued_at timestamptz not null,
  received_at timestamptz,
  timing_delta_ms int,
  unique(session_id, token_index)
);

create table if not exists period_commitments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  device_id text,
  period_nonce text not null,
  commitment text not null,
  committed_at timestamptz not null,
  revealed_chain text,
  revealed_at timestamptz,
  commitment_valid boolean
);

create table if not exists trust_scores (
  device_id text primary key,
  score numeric not null default 1.0,
  session_count int not null default 0,
  clean_sessions int not null default 0,
  flagged_sessions int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists trust_events (
  id uuid primary key default gen_random_uuid(),
  device_id text,
  event_type text not null,
  delta numeric not null,
  session_id uuid references sessions(id) on delete set null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_receipts_session on session_receipts(session_id, period_start);
create index if not exists idx_receipts_device on session_receipts(device_id, created_at);
create index if not exists idx_tokens_session on byte_tokens(session_id, token_index);
create index if not exists idx_commitments_session on period_commitments(session_id, period_nonce);
create index if not exists idx_trust_events_device on trust_events(device_id, created_at);

create or replace function apply_device_trust_delta(p_device_id text, p_delta numeric)
returns void as $$
begin
  insert into trust_scores(device_id, score, updated_at)
  values (p_device_id, greatest(0, least(1, 1.0 + p_delta)), now())
  on conflict (device_id) do update set
    score = greatest(0, least(1, trust_scores.score + p_delta)),
    flagged_sessions = trust_scores.flagged_sessions + case when p_delta < 0 then 1 else 0 end,
    clean_sessions = trust_scores.clean_sessions + case when p_delta > 0 then 1 else 0 end,
    session_count = trust_scores.session_count + 1,
    updated_at = now();
end;
$$ language plpgsql security definer;
