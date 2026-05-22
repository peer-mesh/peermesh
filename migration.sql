-- PeerMesh production hardening migration.
-- Apply this before deploying the API/relay changes that read these columns.

alter table if exists provider_devices
  add column if not exists health_score numeric not null default 1,
  add column if not exists provider_avg_mbps numeric not null default 0,
  add column if not exists provider_last_mbps numeric not null default 0,
  add column if not exists connection_quality jsonb not null default '{}'::jsonb,
  add column if not exists disconnect_count integer not null default 0,
  add column if not exists reconnect_count integer not null default 0,
  add column if not exists last_disconnect_reason text,
  add column if not exists last_session_at timestamptz;

alter table if exists sessions
  add column if not exists reconnect_attempts integer not null default 0,
  add column if not exists reconnect_reason text,
  add column if not exists last_reconnect_at timestamptz,
  add column if not exists provider_avg_mbps numeric not null default 0,
  add column if not exists provider_last_mbps numeric not null default 0,
  add column if not exists connection_quality jsonb not null default '{}'::jsonb;

update provider_devices
set
  health_score = coalesce(health_score, 1),
  provider_avg_mbps = coalesce(provider_avg_mbps, 0),
  provider_last_mbps = coalesce(provider_last_mbps, 0),
  connection_quality = coalesce(connection_quality, '{}'::jsonb),
  disconnect_count = coalesce(disconnect_count, 0),
  reconnect_count = coalesce(reconnect_count, 0);

update sessions
set
  reconnect_attempts = coalesce(reconnect_attempts, 0),
  provider_avg_mbps = coalesce(provider_avg_mbps, 0),
  provider_last_mbps = coalesce(provider_last_mbps, 0),
  connection_quality = coalesce(connection_quality, '{}'::jsonb);

create index if not exists provider_devices_country_health_idx
  on provider_devices (country_code, health_score desc, provider_avg_mbps desc, last_heartbeat desc);

create index if not exists provider_devices_live_idx
  on provider_devices (last_heartbeat desc);

create index if not exists provider_devices_slot_idx
  on provider_devices (user_id, device_id);

create index if not exists sessions_active_provider_device_idx
  on sessions (provider_device_id)
  where status in ('pending', 'active', 'reconnecting');

create index if not exists sessions_reconnect_state_idx
  on sessions (status, last_reconnect_at desc)
  where status = 'reconnecting';

create or replace function cleanup_stale_providers()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from provider_devices
  where last_heartbeat < now() - interval '90 seconds';

  update profiles p
  set is_sharing = exists (
    select 1
    from provider_devices d
    where d.user_id = p.id
      and d.last_heartbeat > now() - interval '90 seconds'
  )
  where p.is_sharing = true
     or exists (select 1 from provider_devices d where d.user_id = p.id);
end;
$$;

create or replace function cleanup_stale_sessions()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update sessions
  set
    status = 'ended',
    ended_at = coalesce(ended_at, now()),
    disconnect_reason = coalesce(disconnect_reason, 'session_setup_timeout')
  where status = 'pending'
    and started_at < now() - interval '10 minutes';

  update sessions
  set
    status = 'ended',
    ended_at = coalesce(ended_at, now()),
    disconnect_reason = coalesce(disconnect_reason, 'reconnect_timeout')
  where status = 'reconnecting'
    and last_reconnect_at < now() - interval '10 minutes';
end;
$$;
