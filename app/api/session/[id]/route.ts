import { NextResponse } from 'next/server'
import { resolveRequesterAuth } from '@/lib/requester-auth'
import { adminClient } from '@/lib/supabase/admin'

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await resolveRequesterAuth(req)
  if (!auth?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await context.params
  const sessionId = typeof id === 'string' ? id.trim() : ''
  if (!sessionId) return NextResponse.json({ error: 'session id is required' }, { status: 400 })

  const { data: session, error } = await adminClient
    .from('sessions')
    .select('id, user_id, status, target_country, relay_endpoint, request_access_mode, request_auth_kind, api_key_id, provider_kind, provider_device_id, started_at, ended_at, bytes_used, disconnect_reason, provider_avg_mbps, provider_last_mbps, connection_quality, reconnect_attempts, reconnect_reason, last_reconnect_at, signed_receipt')
    .eq('id', sessionId)
    .maybeSingle()

  if (error || !session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (session.user_id !== auth.userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (auth.apiKey?.id && session.api_key_id !== auth.apiKey.id) {
    return NextResponse.json({ error: 'This API key did not create the session' }, { status: 403 })
  }

  return NextResponse.json({
    session: {
      id: session.id,
      status: session.status,
      country: session.target_country,
      relayEndpoint: session.relay_endpoint,
      accessMode: session.request_access_mode,
      authKind: session.request_auth_kind,
      providerKind: session.provider_kind,
      providerDeviceId: session.provider_device_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      bytesUsed: Number(session.bytes_used ?? 0),
      disconnectReason: session.disconnect_reason,
      providerAvgMbps: Number(session.provider_avg_mbps ?? 0),
      providerLastMbps: Number(session.provider_last_mbps ?? 0),
      connectionQuality: session.connection_quality ?? {},
      reconnectAttempts: Number(session.reconnect_attempts ?? 0),
      reconnectReason: session.reconnect_reason,
      lastReconnectAt: session.last_reconnect_at,
      receipt: session.signed_receipt,
    },
  })
}
