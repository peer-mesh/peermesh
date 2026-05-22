import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getRequestUser } from '@/lib/request-auth'
import { relayHttpUrl } from '@/lib/relay-endpoints'

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim().toLowerCase()
  const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get('limit') ?? (q ? '500' : '100'), 10) || 100))

  const { data: sessions, error } = await adminClient
    .from('sessions')
    .select('id, user_id, request_auth_kind, provider_id, provider_kind, provider_device_id, provider_base_device_id, target_country, target_host, target_hosts, relay_endpoint, status, bytes_used, disconnect_reason, started_at, ended_at, provider_avg_mbps, provider_last_mbps, connection_quality')
    .eq('provider_id', user.id)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const filteredSessions = q
    ? (sessions ?? []).filter((session) => {
        const hosts = [session.target_host, ...((session.target_hosts ?? []) as string[])]
          .filter(Boolean)
          .map((host) => String(host).toLowerCase())
        return hosts
          .filter(Boolean)
          .some((host) => host.includes(q))
      })
    : (sessions ?? [])

  return NextResponse.json({
    sessions: filteredSessions.map((session) => ({
      ...session,
      target_hosts: [...new Set([...(session.target_hosts ?? []), session.target_host].filter(Boolean))],
    })),
  })
}

export async function DELETE(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  const { data: session, error: lookupError } = await adminClient
    .from('sessions')
    .select('id, provider_id, provider_device_id, relay_endpoint, status')
    .eq('id', sessionId)
    .maybeSingle()

  if (lookupError || !session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (session.provider_id !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const relaySecret = process.env.RELAY_SECRET ?? ''
  let relayClosed = false
  if (session.relay_endpoint && relaySecret) {
    try {
      const res = await fetch(`${relayHttpUrl(session.relay_endpoint)}/provider-kill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-secret': relaySecret,
        },
        body: JSON.stringify({
          sessionId,
          providerUserId: user.id,
          providerDeviceId: session.provider_device_id,
        }),
        signal: AbortSignal.timeout(5000),
      })
      relayClosed = res.ok
    } catch {}
  }

  const now = new Date().toISOString()
  await adminClient
    .from('sessions')
    .update({
      status: 'ended',
      ended_at: now,
      disconnect_reason: 'provider_kill_switch',
    })
    .eq('id', sessionId)
    .eq('provider_id', user.id)
    .in('status', ['pending', 'active', 'reconnecting'])

  return NextResponse.json({ ok: true, relayClosed })
}
