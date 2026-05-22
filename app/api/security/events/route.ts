import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

export async function POST(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const eventType = typeof body.type === 'string' ? body.type.slice(0, 120) : 'unknown'
  const details = body.details && typeof body.details === 'object' && !Array.isArray(body.details)
    ? body.details
    : {}

  const { error } = await adminClient
    .from('security_events')
    .insert({
      event_type: eventType,
      session_id: typeof body.sessionId === 'string' ? body.sessionId : null,
      requester_user_id: typeof body.requesterUserId === 'string' ? body.requesterUserId : null,
      provider_user_id: typeof body.providerUserId === 'string' ? body.providerUserId : null,
      provider_device_id: typeof body.providerDeviceId === 'string' ? body.providerDeviceId : null,
      country: typeof body.country === 'string' ? body.country : null,
      details,
    })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
