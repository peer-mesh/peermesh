import { NextResponse } from 'next/server'
import { resolveBearerUser } from '@/lib/device-sessions'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type WakeJobRow = {
  id: string
  user_id: string
  base_device_id: string
  action: 'wake' | 'start' | 'stop'
  status: string
  scheduled_for: string
  expires_at: string
  idempotency_key: string
  window_key: string
  attempts: number
  payload: Record<string, unknown> | null
}

async function resolveUserId(req: Request): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user?.id) return user.id

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null

  return (await resolveBearerUser(token)).userId
}

function getDeviceClaimId(req: Request, baseDeviceId: string): string {
  const header = req.headers.get('x-peermesh-device')?.trim()
  return header || baseDeviceId
}

function serializeJob(row: WakeJobRow) {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    scheduledFor: row.scheduled_for,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    windowKey: row.window_key,
    attempts: row.attempts,
    payload: row.payload ?? {},
  }
}

export async function GET(req: Request) {
  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const baseDeviceId = url.searchParams.get('baseDeviceId')?.trim() ?? ''
  if (!baseDeviceId) return NextResponse.json({ error: 'baseDeviceId is required' }, { status: 400 })

  const limit = Math.max(1, Math.min(25, Number.parseInt(url.searchParams.get('limit') ?? '10', 10) || 10))
  const nowIso = new Date().toISOString()
  const claimId = getDeviceClaimId(req, baseDeviceId)

  await adminClient
    .from('provider_wake_jobs')
    .update({ status: 'expired', updated_at: nowIso })
    .eq('user_id', userId)
    .eq('base_device_id', baseDeviceId)
    .eq('status', 'pending')
    .lt('expires_at', nowIso)

  const { data: pendingRows, error } = await adminClient
    .from('provider_wake_jobs')
    .select('id, user_id, base_device_id, action, status, scheduled_for, expires_at, idempotency_key, window_key, attempts, payload')
    .eq('user_id', userId)
    .eq('base_device_id', baseDeviceId)
    .eq('status', 'pending')
    .lte('scheduled_for', nowIso)
    .gt('expires_at', nowIso)
    .lt('attempts', 10)
    .order('scheduled_for', { ascending: true })
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const claimedJobs: WakeJobRow[] = []
  for (const row of (pendingRows ?? []) as WakeJobRow[]) {
    const { data: claimed, error: claimError } = await adminClient
      .from('provider_wake_jobs')
      .update({
        status: 'claimed',
        attempts: (row.attempts ?? 0) + 1,
        claimed_at: nowIso,
        claimed_by: claimId,
        updated_at: nowIso,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id, user_id, base_device_id, action, status, scheduled_for, expires_at, idempotency_key, window_key, attempts, payload')
      .maybeSingle<WakeJobRow>()

    if (claimError || !claimed) continue
    claimedJobs.push(claimed)

    await adminClient.from('provider_uptime_events').insert({
      user_id: userId,
      base_device_id: baseDeviceId,
      job_id: claimed.id,
      event_kind: 'job_claimed',
      payload: { action: claimed.action, claimedBy: claimId },
    })
  }

  return NextResponse.json({
    ok: true,
    jobs: claimedJobs.map(serializeJob),
    claimedAt: nowIso,
  })
}

export async function POST(req: Request) {
  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : ''
  const baseDeviceId = typeof body.baseDeviceId === 'string' ? body.baseDeviceId.trim() : ''
  const status = body.status === 'completed' ? 'completed' : body.status === 'failed' ? 'failed' : null
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
  if (!status) return NextResponse.json({ error: 'status must be completed or failed' }, { status: 400 })

  const nowIso = new Date().toISOString()
  const update = status === 'completed'
    ? { status, completed_at: nowIso, failed_at: null, error: null, updated_at: nowIso }
    : { status, completed_at: null, failed_at: nowIso, error: String(body.error ?? '').slice(0, 1000) || 'Job failed', updated_at: nowIso }

  let query = adminClient
    .from('provider_wake_jobs')
    .update(update)
    .eq('id', jobId)
    .eq('user_id', userId)

  if (baseDeviceId) query = query.eq('base_device_id', baseDeviceId)

  const { data: updatedJob, error } = await query
    .select('id, user_id, base_device_id, action, status, scheduled_for, expires_at, idempotency_key, window_key, attempts, payload')
    .maybeSingle<WakeJobRow>()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updatedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  await adminClient.from('provider_uptime_events').insert({
    user_id: userId,
    base_device_id: updatedJob.base_device_id,
    job_id: updatedJob.id,
    event_kind: status === 'completed' ? 'job_completed' : 'job_failed',
    payload: {
      action: updatedJob.action,
      error: status === 'failed' ? update.error : null,
    },
  })

  return NextResponse.json({
    ok: true,
    job: serializeJob(updatedJob),
  })
}
