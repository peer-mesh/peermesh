alter table sessions add column if not exists provider_avg_mbps numeric(10,3) not null default 0;
alter table sessions add column if not exists provider_last_mbps numeric(10,3) not null default 0;
alter table sessions add column if not exists connection_quality jsonb not null default '{}'::jsonb;

update sessions
set provider_avg_mbps = coalesce(provider_avg_mbps, 0),
    provider_last_mbps = coalesce(provider_last_mbps, 0),
    connection_quality = coalesce(connection_quality, '{}'::jsonb);

alter table sessions alter column provider_avg_mbps set default 0;
alter table sessions alter column provider_last_mbps set default 0;
alter table sessions alter column connection_quality set default '{}'::jsonb;
alter table sessions alter column provider_avg_mbps set not null;
alter table sessions alter column provider_last_mbps set not null;
alter table sessions alter column connection_quality set not null;

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

-- provider_devices rows are the live slot source of truth. connection_slots is
-- only a desired configuration value, so old base-device rows must not inflate
-- availability when slot rows already exist for that same base device.
delete from provider_devices base_pd
where base_pd.device_id !~ '_slot_[0-9]+$'
  and exists (
    select 1
    from provider_devices slot_pd
    where slot_pd.user_id = base_pd.user_id
      and slot_pd.device_id ~ '_slot_[0-9]+$'
      and left(slot_pd.device_id, length(base_pd.device_id) + 6) = base_pd.device_id || '_slot_'
  );

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

create table if not exists provider_uptime_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  base_device_id text not null,
  enabled boolean not null default false,
  start_time text not null default '00:00',
  end_time text not null default '00:00',
  timezone text not null default 'UTC',
  wake_enabled boolean not null default false,
  shutdown_after_window boolean not null default false,
  last_start_window_key text,
  last_stop_window_key text,
  last_wake_window_key text,
  last_tick_at timestamptz,
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
