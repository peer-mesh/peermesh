import { NextResponse } from 'next/server'
import { queueOnDemandPrivateWake } from '@/lib/on-demand-wake-server'
import { resolveRequesterAuth } from '@/lib/requester-auth'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const auth = await resolveRequesterAuth(req)
  if (!auth?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const result = await queueOnDemandPrivateWake({
    privateCode: body.privateCode ?? body.privateShareCode ?? body.shareCode,
    requesterUserId: auth.userId,
    source: auth.kind,
    includeWake: body.includeWake === true || body.wake === true,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
  }

  return NextResponse.json({
    ok: true,
    status: result.inserted > 0 ? 'queued' : 'already_queued',
    startQueued: true,
    wakeQueued: result.wakeIncluded,
    providerReachable: result.providerReachable,
    providerUserId: result.providerUserId,
    baseDeviceId: result.baseDeviceId,
    inserted: result.inserted,
    duplicates: result.duplicates,
    expiresAt: result.expiresAt,
    retryAfterSeconds: result.providerReachable ? 8 : 30,
  }, { status: 202 })
}
