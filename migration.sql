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
