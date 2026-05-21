import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { evaluateUptimeSchedule, type UptimeScheduleRow } from '@/lib/uptime-scheduler'

export const dynamic = 'force-dynamic'

const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET ?? process.env.CRON_SECRET ?? process.env.RELAY_SECRET ?? ''
const SCHEDULE_SELECT = [
  'user_id',
  'base_device_id',
  'enabled',
  'start_time',
  'end_time',
  'timezone',
  'wake_enabled',
  'shutdown_after_window',
  'last_start_window_key',
  'last_stop_window_key',
  'last_wake_window_key',
].join(', ')

type UptimeScheduleDbRow = UptimeScheduleRow & {
  wake_enabled: boolean | null
  shutdown_after_window: boolean | null
}

type WakeJobInsertResult = 'created' | 'duplicate' | 'failed'

function isAuthorized(req: Request): boolean {
  if (!SCHEDULER_SECRET) return false
  const authorization = req.headers.get('authorization') ?? ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const headerSecret = req.headers.get('x-scheduler-secret') ?? req.headers.get('x-cron-secret') ?? req.headers.get('x-relay-secret') ?? ''
  return bearer === SCHEDULER_SECRET || headerSecret === SCHEDULER_SECRET
}

function isDuplicateError(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === '23505' || /duplicate key/i.test(error?.message ?? '')
}

async function recordUptimeEvent(input: {
  userId: string
  baseDeviceId: string
  jobId?: string | null
  eventKind: string
  payload?: Record<string, unknown>
}) {
  try {
    await adminClient.from('provider_uptime_events').insert({
      user_id: input.userId,
      base_device_id: input.baseDeviceId,
      job_id: input.jobId ?? null,
      event_kind: input.eventKind,
      payload: input.payload ?? {},
    })
  } catch (error) {
    console.warn('provider_uptime_events insert failed:', error)
  }
}

async function insertWakeJob(schedule: UptimeScheduleDbRow, action: ReturnType<typeof evaluateUptimeSchedule>[number]): Promise<WakeJobInsertResult> {
  const { data, error } = await adminClient
    .from('provider_wake_jobs')
    .insert({
      user_id: schedule.user_id,
      base_device_id: schedule.base_device_id,
      action: action.action,
      scheduled_for: action.scheduledFor,
      idempotency_key: action.idempotencyKey,
      window_key: action.windowKey,
      payload: {
        reason: action.reason,
        schedule: {
          startTime: schedule.start_time,
          endTime: schedule.end_time,
          timezone: schedule.timezone,
          wakeEnabled: schedule.wake_enabled === true,
          shutdownAfterWindow: schedule.shutdown_after_window === true,
        },
      },
    })
    .select('id')
    .single<{ id: string }>()

  if (error) {
    if (isDuplicateError(error)) return 'duplicate'
    await recordUptimeEvent({
      userId: schedule.user_id,
      baseDeviceId: schedule.base_device_id,
      eventKind: 'job_insert_failed',
      payload: { action: action.action, idempotencyKey: action.idempotencyKey, error: error.message },
    })
    return 'failed'
  }

  await recordUptimeEvent({
    userId: schedule.user_id,
    baseDeviceId: schedule.base_device_id,
    jobId: data?.id ?? null,
    eventKind: 'job_created',
    payload: { action: action.action, idempotencyKey: action.idempotencyKey, windowKey: action.windowKey },
  })
  return 'created'
}

async function runSchedulerTick(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const limit = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500))
  const now = new Date()
  const nowIso = now.toISOString()

  const { data: schedules, error } = await adminClient
    .from('provider_uptime_schedules')
    .select(SCHEDULE_SELECT)
    .eq('enabled', true)
    .order('updated_at', { ascending: true })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let created = 0
  let duplicates = 0
  let failed = 0
  let accepted = 0

  const scheduleRows = (schedules ?? []) as unknown as UptimeScheduleDbRow[]
  for (const schedule of scheduleRows) {
    const actions = evaluateUptimeSchedule(schedule, now)
    const scheduleUpdate: Record<string, string | null> = { last_tick_at: nowIso, updated_at: nowIso }

    for (const action of actions) {
      const result = await insertWakeJob(schedule, action)
      if (result === 'created') created++
      if (result === 'duplicate') duplicates++
      if (result === 'failed') {
        failed++
        continue
      }

      accepted++
      if (action.action === 'wake') scheduleUpdate.last_wake_window_key = action.windowKey
      if (action.action === 'start') scheduleUpdate.last_start_window_key = action.windowKey
      if (action.action === 'stop') scheduleUpdate.last_stop_window_key = action.windowKey
    }

    const { error: updateError } = await adminClient
      .from('provider_uptime_schedules')
      .update(scheduleUpdate)
      .eq('user_id', schedule.user_id)
      .eq('base_device_id', schedule.base_device_id)

    if (updateError) {
      failed++
      await recordUptimeEvent({
        userId: schedule.user_id,
        baseDeviceId: schedule.base_device_id,
        eventKind: 'schedule_tick_update_failed',
        payload: { error: updateError.message },
      })
    }
  }

  await adminClient
    .from('provider_wake_jobs')
    .update({ status: 'expired', updated_at: nowIso })
    .eq('status', 'pending')
    .lt('expires_at', nowIso)

  return NextResponse.json({
    ok: true,
    scanned: schedules?.length ?? 0,
    accepted,
    created,
    duplicates,
    failed,
    tickedAt: nowIso,
  })
}

export async function GET(req: Request) {
  return runSchedulerTick(req)
}

export async function POST(req: Request) {
  return runSchedulerTick(req)
}
