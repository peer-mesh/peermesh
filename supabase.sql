-- ================================
-- Cleanup (safe to re-run on fresh or existing DB)
-- ================================
do $$ begin
  drop trigger if exists on_auth_user_created on auth.users;
exception when others then null; end $$;

do $$ begin
  drop trigger if exists profiles_updated_at on profiles;
exception when others then null; end $$;

drop function if exists handle_new_user() cascade;
drop function if exists handle_updated_at() cascade;
drop function if exists update_trust_score(uuid, integer) cascade;
drop function if exists increment_bandwidth(uuid, bigint) cascade;
drop function if exists increment_bytes_shared(uuid, bigint) cascade;
drop function if exists get_provider_share_status(uuid) cascade;
drop function if exists reset_monthly_bandwidth() cascade;
drop function if exists upsert_provider_heartbeat(uuid, text, text) cascade;
drop function if exists upsert_provider_heartbeat(uuid, text, text, text) cascade;
drop function if exists remove_provider_device(uuid, text) cascade;
drop function if exists cleanup_stale_providers() cascade;
drop function if exists cleanup_stale_sessions() cascade;
drop function if exists finalize_session_accountability(uuid, uuid, text, bigint, text) cascade;
drop function if exists set_preferred_provider(uuid, text, uuid) cascade;

drop view if exists peer_availability cascade;

drop table if exists device_sessions cascade;
drop table if exists extension_auth_tokens cascade;
drop table if exists abuse_reports cascade;
drop table if exists session_accountability cascade;
drop table if exists sessions cascade;
drop table if exists provider_uptime_events cascade;
drop table if exists provider_wake_jobs cascade;
drop table if exists provider_uptime_schedules cascade;
drop table if exists provider_devices cascade;
drop table if exists provider_slot_limits cascade;
drop table if exists private_share_devices cascade;
drop table if exists api_usage cascade;
drop table if exists api_keys cascade;
drop table if exists wallet_ledger cascade;
drop table if exists payment_transactions cascade;
drop table if exists provider_payouts cascade;
drop table if exists device_codes cascade;
drop table if exists auth_tokens cascade;
drop table if exists countries cascade;
drop table if exists profiles cascade;

-- ================================
-- Extensions
-- ================================
create extension if not exists "uuid-ossp";

-- Profiles table (extends Supabase auth.users)
create table profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  username text unique,
  role text not null default 'peer' check (role in ('peer','host','client')),
  country_code text not null default 'RW',
  trust_score integer default 50 check (trust_score between 0 and 100),

  -- Verification
  is_verified boolean default false,
  verified_at timestamptz,
  phone_number text,
  gov_id_verified boolean default false,

  -- Subscription
  is_premium boolean default false,
  subscription_id text,
  subscription_status text default 'free',
  stripe_customer_id text,

  -- Network
  is_sharing boolean default false,
  total_bytes_shared bigint default 0,
  share_bytes_today bigint default 0,
  share_bytes_today_date date default current_date,
  total_bytes_used bigint default 0,
  bandwidth_used_month bigint default 0,
  bandwidth_limit bigint default 5368709120, -- 5GB free tier
  preferred_providers jsonb default '{}'::jsonb,
  has_accepted_provider_terms boolean default false,
  daily_share_limit_mb integer default null,
  contribution_credits_bytes bigint not null default 0,
  wallet_balance_usd numeric(14,2) not null default 0,
  wallet_pending_payout_usd numeric(14,2) not null default 0,
  payout_currency text,
  payout_country_code text,
  payout_bank_code text,
  payout_bank_name text,
  payout_account_number text,
  payout_account_name text,
  payout_beneficiary_name text,
  payout_branch_code text,
  payment_provider text not null default 'flutterwave',
  state_actor text,
  state_changed_at timestamptz default now(),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Sessions table — single source of truth for all session data.
-- session_accountability has been removed; everything lives here.
create table sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade not null, -- requester
  provider_id    uuid references profiles(id) on delete set null,          -- set on agent_ready
  request_access_mode text not null default 'public' check (request_access_mode in ('public','private')),
  request_auth_kind text not null default 'user' check (request_auth_kind in ('user','desktop','api_key')),
  api_key_id     uuid,
  request_id     text,
  pricing_tier   text check (pricing_tier in ('standard','advanced','enterprise','contributor')),
  requested_bandwidth_gb numeric(10,4),
  requested_rpm  integer,
  requested_period_hours integer,
  requested_session_mode text check (requested_session_mode in ('rotating','sticky')),
  estimated_cost_usd numeric(14,4) not null default 0,
  provider_kind  text,                                                      -- 'desktop'|'cli'|'extension'
  provider_device_id text,
  provider_base_device_id text,
  target_country text not null,
  target_host    text,                                                      -- best representative hostname
  target_hosts   text[] default '{}',                                      -- all hostnames seen in session
  relay_endpoint text,
  status         text default 'pending' check (status in ('pending','active','ended','flagged')),
  bytes_used     bigint default 0,
  provider_avg_mbps numeric(10,3) not null default 0,
  provider_last_mbps numeric(10,3) not null default 0,
  connection_quality jsonb not null default '{}'::jsonb,
  signed_receipt text,                                                      -- HMAC accountability receipt
  disconnect_reason text,
  started_at     timestamptz default now(),
  ended_at       timestamptz
);

create index sessions_status_idx on sessions (status) where status = 'active';
create index sessions_provider_status_idx on sessions (provider_id, status, started_at desc);
create index sessions_provider_device_status_idx on sessions (provider_device_id, status) where status = 'active';

-- Abuse reports
create table abuse_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references profiles(id) on delete set null,
  reported_user_id uuid references profiles(id) on delete set null,
  reported_session_id uuid references sessions(id) on delete set null,
  report_subject text not null default 'provider' check (report_subject in ('provider','requester')),
  reason text not null,
  reviewed boolean default false,
  created_at timestamptz default now()
);

-- Extension auth tokens
create table extension_auth_tokens (
  id uuid primary key default gen_random_uuid(),
  ext_id text not null unique,
  user_id uuid references profiles(id) on delete cascade not null,
  token text not null,
  refresh_token text,
  device_session_id uuid,
  supabase_token text,
  used boolean default false,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz default now()
);

-- Active provider devices (one row per active sharing slot, heartbeat-based)
create table provider_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,
  connection_slots integer not null default 1, -- desired client setting, not live capacity count
  country_code text not null,
  relay_url text default null,         -- relay the device is currently connected to
  last_heartbeat timestamptz not null default now(),
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, device_id)
);

create index on provider_devices (last_heartbeat);
create index on provider_devices (user_id);
create index on provider_devices (country_code, last_heartbeat);

-- Slot-level sharing controls and daily limits
create table provider_slot_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,
  base_device_id text not null,
  slot_index integer,
  daily_limit_mb integer,
  bytes_today bigint not null default 0,
  bytes_today_date date not null default current_date,
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, device_id),
  check (daily_limit_mb is null or daily_limit_mb >= 1024),
  check (slot_index is null or slot_index >= 0)
);

create index on provider_slot_limits (user_id, base_device_id);
create index on provider_slot_limits (user_id, bytes_today_date);

-- Private sharing codes
create table private_share_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  share_code text not null unique,
  enabled boolean default false,
  expires_at timestamptz,
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, base_device_id)
);

create index on private_share_devices (user_id);
create index on private_share_devices (share_code);

-- Durable provider uptime schedules and wake/start/stop jobs
create table provider_uptime_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  enabled boolean not null default false,
  start_time text not null default '00:00',
  end_time text not null default '00:00',
  timezone text not null default 'UTC',
  wake_enabled boolean not null default false,
  allow_on_demand_wake boolean not null default false,
  allow_private_on_demand_start boolean not null default false,
  shutdown_after_window boolean not null default false,
  last_start_window_key text,
  last_stop_window_key text,
  last_wake_window_key text,
  last_tick_at timestamptz,
  last_provider_seen_at timestamptz,
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, base_device_id),
  check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

create index on provider_uptime_schedules (enabled, updated_at);
create index on provider_uptime_schedules (user_id, base_device_id);
create index provider_uptime_schedules_on_demand_idx on provider_uptime_schedules (allow_on_demand_wake, user_id, base_device_id);
create index provider_uptime_schedules_private_on_demand_idx on provider_uptime_schedules (allow_private_on_demand_start, last_provider_seen_at);

create table provider_wake_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  action text not null check (action in ('wake','start','stop')),
  status text not null default 'pending' check (status in ('pending','claimed','sent','completed','failed','expired')),
  scheduled_for timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  idempotency_key text not null unique,
  window_key text not null,
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  claimed_by text,
  sent_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on provider_wake_jobs (status, scheduled_for);
create index on provider_wake_jobs (user_id, base_device_id, status);

create table provider_uptime_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  base_device_id text,
  job_id uuid references provider_wake_jobs(id) on delete set null,
  event_kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create index on provider_uptime_events (created_at desc);
create index on provider_uptime_events (user_id, base_device_id, created_at desc);

-- Device authorization codes (OAuth 2.0 Device Flow)
create table device_codes (
  id uuid primary key default gen_random_uuid(),
  device_code text not null unique,
  user_code text not null unique,
  user_id uuid references profiles(id) on delete cascade,
  token text,
  refresh_token text,
  device_session_id uuid,
  status text default 'pending' check (status in ('pending','approved','expired','denied','revoked')),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz default now()
);

create table device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_code_id uuid references device_codes(id) on delete set null,
  actor text not null default 'device_flow',
  refresh_token_hash text not null unique,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table extension_auth_tokens
  add constraint extension_auth_tokens_device_session_id_fkey
  foreign key (device_session_id) references device_sessions(id) on delete set null;

alter table device_codes
  add constraint device_codes_device_session_id_fkey
  foreign key (device_session_id) references device_sessions(id) on delete set null;

create index on extension_auth_tokens (ext_id) where used = false;
create index on device_sessions (user_id, created_at desc);
create index on device_codes (device_code) where status = 'pending';
create index on device_codes (user_code) where status = 'pending';

-- Countries
create table countries (
  code       text primary key,
  name       text not null,
  flag       text not null,
  region     text not null default '',
  active     boolean not null default true,
  sort_order integer not null default 999,
  created_at timestamptz default now()
);

create index on countries (active) where active = true;
create index on countries (region);
create index on countries (sort_order, name);

-- Auth tokens
create table auth_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id) on delete cascade not null,
  email      text not null,
  token      text not null,
  type       text not null check (type in ('forgot_password','confirm_email')),
  used       boolean not null default false,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz default now()
);

create index on auth_tokens (email, type) where used = false;
create index on auth_tokens (expires_at);

create table wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  kind text not null check (kind in ('credit','debit','payment','payout','refund','bonus','contribution_credit')),
  amount_usd numeric(14,2) not null,
  currency text not null default 'USD',
  reference text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index on wallet_ledger (user_id, created_at desc);
create unique index wallet_ledger_reference_uidx on wallet_ledger (reference);

create table payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  provider text not null default 'flutterwave',
  tx_ref text not null unique,
  flutterwave_transaction_id text,
  checkout_url text,
  status text not null default 'pending' check (status in ('pending','successful','failed','cancelled')),
  amount_usd numeric(14,2) not null,
  local_amount numeric(14,2),
  local_currency text,
  raw_response jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  verified_at timestamptz
);

create index on payment_transactions (user_id, created_at desc);
create index on payment_transactions (status);

create table provider_payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  amount_usd numeric(14,2) not null,
  destination_currency text not null,
  destination_amount numeric(14,2),
  fx_rate numeric(18,8),
  flutterwave_transfer_id text,
  status text not null default 'pending' check (status in ('pending','processing','successful','failed','cancelled')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  processed_at timestamptz
);

create index on provider_payouts (user_id, created_at desc);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  tier text not null check (tier in ('standard','advanced','enterprise','contributor')),
  rpm_limit integer not null,
  session_mode text not null check (session_mode in ('rotating','sticky')),
  requires_verification boolean not null default false,
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz default now()
);

create index on api_keys (user_id, created_at desc);
create index on api_keys (key_prefix);

create table api_usage (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid references api_keys(id) on delete cascade not null,
  user_id uuid references profiles(id) on delete cascade not null,
  session_id uuid references sessions(id) on delete set null,
  request_id text,
  bandwidth_bytes bigint not null default 0,
  rpm_requested integer not null default 0,
  session_mode text not null default 'rotating' check (session_mode in ('rotating','sticky')),
  duration_minutes integer not null default 0,
  estimated_cost_usd numeric(14,4) not null default 0,
  collected_cost_usd numeric(14,4) not null default 0,
  shortfall_cost_usd numeric(14,4) not null default 0,
  created_at timestamptz default now()
);

create index on api_usage (user_id, created_at desc);
create index on api_usage (api_key_id, created_at desc);

-- Peer availability view
create view peer_availability as
  select
    pd.country_code as country,
    count(*)::int as count
  from provider_devices pd
  join profiles p on p.id = pd.user_id
  left join sessions s on s.status = 'active' and s.provider_id = pd.user_id and (
    s.provider_device_id = pd.device_id
    or (
      s.provider_device_id !~ '_slot_[0-9]+$'
      and pd.device_id ~ '_slot_[0-9]+$'
      and left(pd.device_id, length(s.provider_device_id) + 6) = s.provider_device_id || '_slot_'
    )
  )
  where pd.last_heartbeat > now() - interval '45 seconds'
    and p.is_verified = true
    and s.id is null
    and not exists (
      select 1
      from provider_devices slot_pd
      where slot_pd.user_id = pd.user_id
        and pd.device_id !~ '_slot_[0-9]+$'
        and slot_pd.device_id ~ '_slot_[0-9]+$'
        and left(slot_pd.device_id, length(pd.device_id) + 6) = pd.device_id || '_slot_'
        and slot_pd.last_heartbeat > now() - interval '45 seconds'
    )
  group by pd.country_code;

-- ================================
-- Functions
-- ================================

create or replace function update_trust_score(p_user_id uuid, delta integer)
returns void as $$
  update profiles
  set trust_score = greatest(0, least(100, trust_score + delta)), updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

create or replace function increment_bandwidth(p_user_id uuid, p_bytes bigint)
returns void as $$
  update profiles
  set total_bytes_used = total_bytes_used + p_bytes,
      bandwidth_used_month = bandwidth_used_month + p_bytes,
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

create or replace function increment_bytes_shared(p_user_id uuid, p_bytes bigint)
returns void as $$
begin
  update profiles set
    total_bytes_shared = total_bytes_shared + p_bytes,
    contribution_credits_bytes = contribution_credits_bytes + greatest(p_bytes, 0),
    share_bytes_today = case
      when share_bytes_today_date = current_date then coalesce(share_bytes_today, 0) + p_bytes
      else p_bytes
    end,
    share_bytes_today_date = current_date,
    updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

create or replace function get_provider_share_status(p_user_id uuid)
returns table (
  user_id uuid,
  total_bytes_today bigint,
  daily_share_limit_mb integer,
  can_accept boolean
) as $$
  select
    p.id,
    case when p.share_bytes_today_date = current_date then coalesce(p.share_bytes_today, 0) else 0 end,
    p.daily_share_limit_mb,
    case
      when p.daily_share_limit_mb is null then true
      else (case when p.share_bytes_today_date = current_date then coalesce(p.share_bytes_today, 0) else 0 end)
           < (p.daily_share_limit_mb::bigint * 1024 * 1024)
    end
  from profiles p where p.id = p_user_id;
$$ language sql security definer;

create or replace function upsert_provider_heartbeat(
  p_user_id   uuid,
  p_device_id text,
  p_country   text,
  p_relay_url text default null
) returns void as $$
begin
  insert into provider_devices (user_id, device_id, country_code, last_heartbeat, relay_url)
  values (p_user_id, p_device_id, p_country, now(), p_relay_url)
  on conflict (user_id, device_id)
  do update set
    last_heartbeat = now(),
    country_code   = p_country,
    relay_url      = coalesce(p_relay_url, provider_devices.relay_url),
    updated_at     = now();

  update profiles set is_sharing = true, updated_at = now() where id = p_user_id;
end;
$$ language plpgsql security definer;

create or replace function remove_provider_device(p_user_id uuid, p_device_id text)
returns void as $$
begin
  delete from provider_devices where user_id = p_user_id and device_id = p_device_id;
  update profiles
  set is_sharing = exists(
    select 1 from provider_devices
    where user_id = p_user_id and last_heartbeat > now() - interval '45 seconds'
  ), updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

create or replace function cleanup_stale_providers() returns void as $$
begin
  update profiles
  set is_sharing = exists(
    select 1 from provider_devices pd
    where pd.user_id = profiles.id and pd.last_heartbeat > now() - interval '45 seconds'
  ), updated_at = now()
  where id in (
    select distinct user_id from provider_devices
    where last_heartbeat <= now() - interval '45 seconds'
  );
  delete from provider_devices where last_heartbeat <= now() - interval '45 seconds';
end;
$$ language plpgsql security definer;

create or replace function cleanup_stale_sessions() returns void as $$
  update sessions set status = 'ended', ended_at = now()
  where status in ('pending', 'active') and started_at < now() - interval '2 hours';
$$ language sql security definer;

create or replace function reset_monthly_bandwidth() returns void as $$
  update profiles set bandwidth_used_month = 0 where subscription_status = 'free';
$$ language sql security definer;

-- Update peer affinity — set preferred provider for a country
create or replace function set_preferred_provider(
  p_user_id          uuid,
  p_country          text,
  p_provider_user_id uuid
) returns void as $$
  update profiles
  set preferred_providers = preferred_providers || jsonb_build_object(p_country, p_provider_user_id::text),
      updated_at = now()
  where id = p_user_id;
$$ language sql security definer;

-- Auto-create profile on signup
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, country_code, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'country_code', 'RW'),
    nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), ''),
    'peer'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

create or replace function handle_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute procedure handle_updated_at();

-- ================================
-- Row Level Security
-- ================================

alter table profiles enable row level security;
alter table sessions enable row level security;
alter table abuse_reports enable row level security;

create policy "Users can view own profile"   on profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Anyone can view peer counts"  on profiles for select using (true);

create policy "Users can view own sessions"   on sessions for select using (auth.uid() = user_id);
create policy "Users can create sessions"     on sessions for insert with check (auth.uid() = user_id);
create policy "Users can update own sessions" on sessions for update using (auth.uid() = user_id);

create policy "Authenticated users can report"
  on abuse_reports for insert with check (auth.uid() = reporter_id);

alter table extension_auth_tokens enable row level security;
create policy "Service role only ext tokens" on extension_auth_tokens for all using (false);

alter table provider_devices enable row level security;
create policy "Service role only provider devices" on provider_devices for all using (false);

alter table device_codes enable row level security;
create policy "Service role only device codes" on device_codes for all using (false);

alter table device_sessions enable row level security;
create policy "Service role only device sessions" on device_sessions for all using (false);

alter table countries enable row level security;
create policy "Anyone can read active countries" on countries for select using (active = true);

alter table auth_tokens enable row level security;
create policy "Service role only auth tokens" on auth_tokens for all using (false);

alter table private_share_devices enable row level security;
create policy "Service role only private share devices" on private_share_devices for all using (false);

alter table provider_slot_limits enable row level security;
create policy "Service role only provider slot limits" on provider_slot_limits for all using (false);

alter table provider_uptime_schedules enable row level security;
create policy "Service role only uptime schedules" on provider_uptime_schedules for all using (false);

alter table provider_wake_jobs enable row level security;
create policy "Service role only wake jobs" on provider_wake_jobs for all using (false);

alter table provider_uptime_events enable row level security;
create policy "Service role only uptime events" on provider_uptime_events for all using (false);

alter table wallet_ledger enable row level security;
create policy "Users can view own wallet ledger" on wallet_ledger for select using (auth.uid() = user_id);

alter table payment_transactions enable row level security;
create policy "Users can view own payment transactions" on payment_transactions for select using (auth.uid() = user_id);

alter table provider_payouts enable row level security;
create policy "Users can view own provider payouts" on provider_payouts for select using (auth.uid() = user_id);

alter table api_keys enable row level security;
create policy "Users can view own api keys" on api_keys for select using (auth.uid() = user_id);
create policy "Users can insert own api keys" on api_keys for insert with check (auth.uid() = user_id);
create policy "Users can update own api keys" on api_keys for update using (auth.uid() = user_id);

alter table api_usage enable row level security;
create policy "Users can view own api usage" on api_usage for select using (auth.uid() = user_id);

-- ================================
-- Migrations (safe to run on existing DBs)
-- ================================
alter table profiles add column if not exists role text not null default 'peer';
update profiles set role = 'peer' where role = 'client';
alter table profiles add column if not exists contribution_credits_bytes bigint not null default 0;
alter table profiles add column if not exists wallet_balance_usd numeric(14,2) not null default 0;
alter table profiles add column if not exists wallet_pending_payout_usd numeric(14,2) not null default 0;
alter table profiles add column if not exists payout_currency text;
alter table profiles add column if not exists payout_country_code text;
alter table profiles add column if not exists payout_bank_code text;
alter table profiles add column if not exists payout_bank_name text;
alter table profiles add column if not exists payout_account_number text;
alter table profiles add column if not exists payout_account_name text;
alter table profiles add column if not exists payout_beneficiary_name text;
alter table profiles add column if not exists payout_branch_code text;
alter table profiles add column if not exists payment_provider text not null default 'flutterwave';
alter table profiles add column if not exists state_actor text;
alter table profiles add column if not exists state_changed_at timestamptz default now();
alter table profiles add column if not exists has_accepted_provider_terms boolean default false;
alter table profiles add column if not exists daily_share_limit_mb integer default null;
alter table profiles add column if not exists share_bytes_today bigint default 0;
alter table profiles add column if not exists share_bytes_today_date date default current_date;

create or replace function increment_bytes_shared(p_user_id uuid, p_bytes bigint)
returns void as $$
begin
  update profiles set
    total_bytes_shared = total_bytes_shared + p_bytes,
    contribution_credits_bytes = contribution_credits_bytes + greatest(p_bytes, 0),
    share_bytes_today = case
      when share_bytes_today_date = current_date then coalesce(share_bytes_today, 0) + p_bytes
      else p_bytes
    end,
    share_bytes_today_date = current_date,
    updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

alter table provider_devices add column if not exists relay_url text default null;
alter table provider_devices add column if not exists connection_slots integer not null default 1;
alter table provider_devices add column if not exists state_actor text;
alter table provider_devices add column if not exists state_changed_at timestamptz default now();
alter table provider_devices add column if not exists updated_at timestamptz default now();

alter table sessions add column if not exists provider_kind text;
alter table sessions add column if not exists provider_device_id text;
alter table sessions add column if not exists provider_base_device_id text;
alter table sessions add column if not exists target_host text;
alter table sessions add column if not exists target_hosts text[] default '{}';
alter table sessions add column if not exists provider_avg_mbps numeric(10,3) not null default 0;
alter table sessions add column if not exists provider_last_mbps numeric(10,3) not null default 0;
alter table sessions add column if not exists connection_quality jsonb not null default '{}'::jsonb;
alter table sessions add column if not exists signed_receipt text;
alter table sessions add column if not exists disconnect_reason text;
alter table sessions add column if not exists request_access_mode text not null default 'public';
alter table sessions add column if not exists request_auth_kind text not null default 'user';
alter table sessions add column if not exists api_key_id uuid;
alter table sessions add column if not exists request_id text;
alter table sessions add column if not exists pricing_tier text;
alter table sessions add column if not exists requested_bandwidth_gb numeric(10,4);
alter table sessions add column if not exists requested_rpm integer;
alter table sessions add column if not exists requested_period_hours integer;
alter table sessions add column if not exists requested_session_mode text;
alter table sessions add column if not exists estimated_cost_usd numeric(14,4) not null default 0;

alter table abuse_reports add column if not exists reported_user_id uuid references profiles(id) on delete set null;
alter table abuse_reports add column if not exists report_subject text not null default 'provider';

alter table extension_auth_tokens add column if not exists refresh_token text;
alter table extension_auth_tokens add column if not exists device_session_id uuid;

alter table device_codes add column if not exists refresh_token text;
alter table device_codes add column if not exists device_session_id uuid;

create table if not exists device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_code_id uuid references device_codes(id) on delete set null,
  actor text not null default 'device_flow',
  refresh_token_hash text not null unique,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists device_sessions_user_created_idx on device_sessions (user_id, created_at desc);
alter table device_sessions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'extension_auth_tokens_device_session_id_fkey'
  ) then
    alter table extension_auth_tokens
      add constraint extension_auth_tokens_device_session_id_fkey
      foreign key (device_session_id) references device_sessions(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'device_codes_device_session_id_fkey'
  ) then
    alter table device_codes
      add constraint device_codes_device_session_id_fkey
      foreign key (device_session_id) references device_sessions(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'device_sessions'
      and policyname = 'Service role only device sessions'
  ) then
    create policy "Service role only device sessions" on device_sessions for all using (false);
  end if;
end $$;

create table if not exists provider_slot_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  device_id text not null,
  base_device_id text not null,
  slot_index integer,
  daily_limit_mb integer,
  bytes_today bigint not null default 0,
  bytes_today_date date not null default current_date,
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, device_id),
  check (daily_limit_mb is null or daily_limit_mb >= 1024),
  check (slot_index is null or slot_index >= 0)
);
create index if not exists provider_slot_limits_user_base_idx on provider_slot_limits (user_id, base_device_id);
create index if not exists provider_slot_limits_user_date_idx on provider_slot_limits (user_id, bytes_today_date);
alter table provider_slot_limits enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_slot_limits'
      and policyname = 'Service role only provider slot limits'
  ) then
    create policy "Service role only provider slot limits" on provider_slot_limits for all using (false);
  end if;
end $$;

create table if not exists private_share_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  share_code text not null unique,
  enabled boolean default false,
  expires_at timestamptz,
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, base_device_id)
);
create index if not exists private_share_devices_user_idx on private_share_devices (user_id);
create index if not exists private_share_devices_share_code_idx on private_share_devices (share_code);
alter table private_share_devices enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'private_share_devices'
      and policyname = 'Service role only private share devices'
  ) then
    create policy "Service role only private share devices" on private_share_devices for all using (false);
  end if;
end $$;

create table if not exists provider_uptime_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  enabled boolean not null default false,
  start_time text not null default '00:00',
  end_time text not null default '00:00',
  timezone text not null default 'UTC',
  wake_enabled boolean not null default false,
  allow_on_demand_wake boolean not null default false,
  allow_private_on_demand_start boolean not null default false,
  shutdown_after_window boolean not null default false,
  last_start_window_key text,
  last_stop_window_key text,
  last_wake_window_key text,
  last_tick_at timestamptz,
  last_provider_seen_at timestamptz,
  state_actor text,
  state_changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, base_device_id),
  check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
create index if not exists provider_uptime_schedules_enabled_idx on provider_uptime_schedules (enabled, updated_at);
create index if not exists provider_uptime_schedules_user_base_idx on provider_uptime_schedules (user_id, base_device_id);
alter table provider_uptime_schedules enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_uptime_schedules'
      and policyname = 'Service role only uptime schedules'
  ) then
    create policy "Service role only uptime schedules" on provider_uptime_schedules for all using (false);
  end if;
end $$;

alter table provider_uptime_schedules
  add column if not exists allow_on_demand_wake boolean not null default false;
alter table provider_uptime_schedules
  add column if not exists allow_private_on_demand_start boolean not null default false;
alter table provider_uptime_schedules
  add column if not exists last_provider_seen_at timestamptz;
create index if not exists provider_uptime_schedules_on_demand_idx on provider_uptime_schedules (allow_on_demand_wake, user_id, base_device_id);
create index if not exists provider_uptime_schedules_private_on_demand_idx on provider_uptime_schedules (allow_private_on_demand_start, last_provider_seen_at);

create table if not exists provider_wake_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  action text not null check (action in ('wake','start','stop')),
  status text not null default 'pending' check (status in ('pending','claimed','sent','completed','failed','expired')),
  scheduled_for timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  idempotency_key text not null unique,
  window_key text not null,
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  claimed_by text,
  sent_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists provider_wake_jobs_status_scheduled_idx on provider_wake_jobs (status, scheduled_for);
create index if not exists provider_wake_jobs_user_base_status_idx on provider_wake_jobs (user_id, base_device_id, status);
alter table provider_wake_jobs enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_wake_jobs'
      and policyname = 'Service role only wake jobs'
  ) then
    create policy "Service role only wake jobs" on provider_wake_jobs for all using (false);
  end if;
end $$;

create table if not exists provider_uptime_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  base_device_id text,
  job_id uuid references provider_wake_jobs(id) on delete set null,
  event_kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists provider_uptime_events_created_idx on provider_uptime_events (created_at desc);
create index if not exists provider_uptime_events_user_base_created_idx on provider_uptime_events (user_id, base_device_id, created_at desc);
alter table provider_uptime_events enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_uptime_events'
      and policyname = 'Service role only uptime events'
  ) then
    create policy "Service role only uptime events" on provider_uptime_events for all using (false);
  end if;
end $$;

create table if not exists wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  kind text not null check (kind in ('credit','debit','payment','payout','refund','bonus','contribution_credit')),
  amount_usd numeric(14,2) not null,
  currency text not null default 'USD',
  reference text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists wallet_ledger_user_created_idx on wallet_ledger (user_id, created_at desc);
create unique index if not exists wallet_ledger_reference_uidx on wallet_ledger (reference);
alter table wallet_ledger enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'wallet_ledger'
      and policyname = 'Users can view own wallet ledger'
  ) then
    create policy "Users can view own wallet ledger" on wallet_ledger for select using (auth.uid() = user_id);
  end if;
end $$;

create table if not exists payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  provider text not null default 'flutterwave',
  tx_ref text not null unique,
  flutterwave_transaction_id text,
  checkout_url text,
  status text not null default 'pending' check (status in ('pending','successful','failed','cancelled')),
  amount_usd numeric(14,2) not null,
  local_amount numeric(14,2),
  local_currency text,
  raw_response jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  verified_at timestamptz
);
create index if not exists payment_transactions_user_created_idx on payment_transactions (user_id, created_at desc);
create index if not exists payment_transactions_status_idx on payment_transactions (status);
alter table payment_transactions enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'payment_transactions'
      and policyname = 'Users can view own payment transactions'
  ) then
    create policy "Users can view own payment transactions" on payment_transactions for select using (auth.uid() = user_id);
  end if;
end $$;

create table if not exists provider_payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  amount_usd numeric(14,2) not null,
  destination_currency text not null,
  destination_amount numeric(14,2),
  fx_rate numeric(18,8),
  flutterwave_transfer_id text,
  status text not null default 'pending' check (status in ('pending','processing','successful','failed','cancelled')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  processed_at timestamptz
);
create index if not exists provider_payouts_user_created_idx on provider_payouts (user_id, created_at desc);
alter table provider_payouts enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provider_payouts'
      and policyname = 'Users can view own provider payouts'
  ) then
    create policy "Users can view own provider payouts" on provider_payouts for select using (auth.uid() = user_id);
  end if;
end $$;

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  tier text not null check (tier in ('standard','advanced','enterprise','contributor')),
  rpm_limit integer not null,
  session_mode text not null check (session_mode in ('rotating','sticky')),
  requires_verification boolean not null default false,
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists api_keys_user_created_idx on api_keys (user_id, created_at desc);
create index if not exists api_keys_key_prefix_idx on api_keys (key_prefix);
alter table api_keys enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_keys'
      and policyname = 'Users can view own api keys'
  ) then
    create policy "Users can view own api keys" on api_keys for select using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_keys'
      and policyname = 'Users can insert own api keys'
  ) then
    create policy "Users can insert own api keys" on api_keys for insert with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_keys'
      and policyname = 'Users can update own api keys'
  ) then
    create policy "Users can update own api keys" on api_keys for update using (auth.uid() = user_id);
  end if;
end $$;

create table if not exists api_usage (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid references api_keys(id) on delete cascade not null,
  user_id uuid references profiles(id) on delete cascade not null,
  session_id uuid references sessions(id) on delete set null,
  request_id text,
  bandwidth_bytes bigint not null default 0,
  rpm_requested integer not null default 0,
  session_mode text not null default 'rotating' check (session_mode in ('rotating','sticky')),
  duration_minutes integer not null default 0,
  estimated_cost_usd numeric(14,4) not null default 0,
  collected_cost_usd numeric(14,4) not null default 0,
  shortfall_cost_usd numeric(14,4) not null default 0,
  created_at timestamptz default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_api_key_id_fkey'
  ) then
    alter table sessions
      add constraint sessions_api_key_id_fkey
      foreign key (api_key_id) references api_keys(id) on delete set null;
  end if;
end $$;
create index if not exists api_usage_user_created_idx on api_usage (user_id, created_at desc);
create index if not exists api_usage_key_created_idx on api_usage (api_key_id, created_at desc);
alter table api_usage enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'api_usage'
      and policyname = 'Users can view own api usage'
  ) then
    create policy "Users can view own api usage" on api_usage for select using (auth.uid() = user_id);
  end if;
end $$;

update sessions
set target_hosts = array[target_host]
where target_host is not null
  and (target_hosts is null or target_hosts = '{}');

create index if not exists sessions_status_idx on sessions (status) where status = 'active';
create index if not exists provider_devices_country_hb_idx on provider_devices (country_code, last_heartbeat);
create index if not exists sessions_provider_status_idx on sessions (provider_id, status, started_at desc);
create index if not exists sessions_provider_device_status_idx on sessions (provider_device_id, status) where status = 'active';

create or replace view peer_availability as
  select
    pd.country_code as country,
    count(*)::int as count
  from provider_devices pd
  join profiles p on p.id = pd.user_id
  left join sessions s on s.status = 'active' and s.provider_id = pd.user_id and (
    s.provider_device_id = pd.device_id
    or (
      s.provider_device_id !~ '_slot_[0-9]+$'
      and pd.device_id ~ '_slot_[0-9]+$'
      and left(pd.device_id, length(s.provider_device_id) + 6) = s.provider_device_id || '_slot_'
    )
  )
  where pd.last_heartbeat > now() - interval '45 seconds'
    and p.is_verified = true
    and s.id is null
    and not exists (
      select 1
      from provider_devices slot_pd
      where slot_pd.user_id = pd.user_id
        and pd.device_id !~ '_slot_[0-9]+$'
        and slot_pd.device_id ~ '_slot_[0-9]+$'
        and left(slot_pd.device_id, length(pd.device_id) + 6) = pd.device_id || '_slot_'
        and slot_pd.last_heartbeat > now() - interval '45 seconds'
    )
  group by pd.country_code;
