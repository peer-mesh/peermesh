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
