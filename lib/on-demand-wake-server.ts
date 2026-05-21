import { isPrivateShareActive, normalizePrivateShareCode } from '@/lib/private-sharing'
import { adminClient } from '@/lib/supabase/admin'
import {
  buildOnDemandWakeJobRows,
  normalizeProviderBaseDeviceId,
  type OnDemandWakeJobRow,
} from '@/lib/on-demand-wake'

type PrivateShareWakeRow = {
  user_id: string
  base_device_id: string
  enabled: boolean
  expires_at: string | null
}

type ProviderWakeScheduleRow = {
  allow_on_demand_wake: boolean | null
}

export type QueueOnDemandWakeResult =
  | {
      ok: true
      providerUserId: string
      baseDeviceId: string
      inserted: number
      duplicates: number
      expiresAt: string
    }
  | {
      ok: false
      status: number
      error: string
      code:
        | 'invalid_code'
        | 'private_share_unavailable'
        | 'self_request'
        | 'on_demand_wake_disabled'
        | 'insert_failed'
    }

function isDuplicateError(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505' || /duplicate key/i.test(error?.message ?? '')
}

async function insertOnDemandWakeJob(row: OnDemandWakeJobRow): Promise<'inserted' | 'duplicate' | 'failed'> {
  const { data, error } = await adminClient
    .from('provider_wake_jobs')
    .insert(row)
    .select('id')
    .single<{ id: string }>()

  if (error) {
    if (isDuplicateError(error)) return 'duplicate'
    await recordOnDemandWakeEvent(row.user_id, row.base_device_id, null, 'on_demand_wake_insert_failed', {
      action: row.action,
      error: error.message,
      requesterUserId: row.payload.requesterUserId,
    })
    return 'failed'
  }

  await recordOnDemandWakeEvent(row.user_id, row.base_device_id, data?.id ?? null, 'on_demand_wake_queued', {
    action: row.action,
    requesterUserId: row.payload.requesterUserId,
    source: row.payload.source,
  })
  return 'inserted'
}

async function recordOnDemandWakeEvent(
  userId: string,
  baseDeviceId: string,
  jobId: string | null,
  eventKind: string,
  payload: Record<string, unknown>,
) {
  try {
    await adminClient.from('provider_uptime_events').insert({
      user_id: userId,
      base_device_id: baseDeviceId,
      job_id: jobId,
      event_kind: eventKind,
      payload,
    })
  } catch (error) {
    console.warn('provider_uptime_events insert failed:', error)
  }
}

export async function queueOnDemandPrivateWake(input: {
  privateCode: unknown
  requesterUserId: string
  source?: string
  now?: Date
}): Promise<QueueOnDemandWakeResult> {
  const privateCode = normalizePrivateShareCode(input.privateCode)
  if (!privateCode) {
    return { ok: false, status: 400, code: 'invalid_code', error: 'privateCode must be a 9 digit private share code' }
  }

  const { data: privateShare, error: privateShareError } = await adminClient
    .from('private_share_devices')
    .select('user_id, base_device_id, enabled, expires_at')
    .eq('share_code', privateCode)
    .maybeSingle<PrivateShareWakeRow>()

  if (privateShareError) {
    return { ok: false, status: 500, code: 'private_share_unavailable', error: 'Could not validate private share code' }
  }
  if (!privateShare || !isPrivateShareActive(privateShare.enabled, privateShare.expires_at)) {
    return { ok: false, status: 404, code: 'private_share_unavailable', error: 'Private share code is invalid or expired' }
  }
  if (privateShare.user_id === input.requesterUserId) {
    return { ok: false, status: 400, code: 'self_request', error: 'You cannot request wake for your own private share code' }
  }

  const baseDeviceId = normalizeProviderBaseDeviceId(privateShare.base_device_id)
  const { data: schedule, error: scheduleError } = await adminClient
    .from('provider_uptime_schedules')
    .select('allow_on_demand_wake')
    .eq('user_id', privateShare.user_id)
    .eq('base_device_id', baseDeviceId)
    .maybeSingle<ProviderWakeScheduleRow>()

  if (scheduleError) {
    return { ok: false, status: 500, code: 'on_demand_wake_disabled', error: 'Could not validate provider wake settings' }
  }
  if (schedule?.allow_on_demand_wake !== true) {
    return { ok: false, status: 403, code: 'on_demand_wake_disabled', error: 'Provider has not enabled on-demand wake requests' }
  }

  const rows = buildOnDemandWakeJobRows({
    providerUserId: privateShare.user_id,
    baseDeviceId,
    requesterUserId: input.requesterUserId,
    now: input.now,
    source: input.source,
  })

  let inserted = 0
  let duplicates = 0
  for (const row of rows) {
    const result = await insertOnDemandWakeJob(row)
    if (result === 'failed') {
      return { ok: false, status: 500, code: 'insert_failed', error: 'Could not queue on-demand wake request' }
    }
    if (result === 'inserted') inserted++
    if (result === 'duplicate') duplicates++
  }

  return {
    ok: true,
    providerUserId: privateShare.user_id,
    baseDeviceId,
    inserted,
    duplicates,
    expiresAt: rows[0]?.expires_at ?? new Date().toISOString(),
  }
}
