import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

function forbidden() {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberOrZero(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (!RELAY_SECRET || secret !== RELAY_SECRET) return forbidden()

  const body = await req.json().catch(() => ({}))
  const event = stringOrNull(body.event)

  if (event === 'mandate_issued') {
    const mandate = body.mandate && typeof body.mandate === 'object' ? body.mandate : {}
    const { error } = await adminClient.from('session_mandates').upsert({
      session_id: stringOrNull(body.sessionId),
      requester_device_id: stringOrNull(mandate.requesterDeviceId),
      provider_device_id: stringOrNull(mandate.providerDeviceId),
      issued_at: new Date(numberOrZero(mandate.issuedAt) || Date.now()).toISOString(),
      expires_at: new Date(numberOrZero(mandate.expiresAt) || Date.now()).toISOString(),
      transport_tier: numberOrZero(body.transportTier ?? mandate.transportTier),
      policy_snapshot: mandate.policy ?? {},
      session_nonce: stringOrNull(mandate.sessionNonce),
      forced_relay: body.forcedRelay === true,
      verifier_confirmed: body.verifierConfirmed === true,
      mandate: mandate,
    }, { onConflict: 'session_id' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (event === 'receipt') {
    const { error } = await adminClient.from('session_receipts').insert({
      session_id: stringOrNull(body.sessionId),
      device_id: stringOrNull(body.deviceId),
      role: body.role === 'provider' ? 'provider' : 'requester',
      period_start: stringOrNull(body.periodStart) ?? new Date().toISOString(),
      period_end: stringOrNull(body.periodEnd) ?? new Date().toISOString(),
      bytes_reported: Math.max(0, Math.floor(numberOrZero(body.bytesReported))),
      chain_value: stringOrNull(body.chainValue) ?? '',
      tokens_count: Math.max(0, Math.floor(numberOrZero(body.tokensCount))),
      nonce: stringOrNull(body.nonce),
      device_sig: stringOrNull(body.deviceSig) ?? '',
      session_sig: stringOrNull(body.sessionSig) ?? '',
      transit_intact: typeof body.transitIntact === 'boolean' ? body.transitIntact : null,
      verified: body.verified === true,
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (event === 'byte_token') {
    const { error } = await adminClient.from('byte_tokens').upsert({
      session_id: stringOrNull(body.sessionId),
      token_index: Math.max(1, Math.floor(numberOrZero(body.tokenIndex))),
      token_value: stringOrNull(body.tokenValue) ?? '',
      issued_at: stringOrNull(body.issuedAt) ?? new Date().toISOString(),
      received_at: stringOrNull(body.receivedAt),
      timing_delta_ms: body.timingDeltaMs == null ? null : Math.floor(numberOrZero(body.timingDeltaMs)),
    }, { onConflict: 'session_id,token_index' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (event === 'commitment') {
    const { error } = await adminClient.from('period_commitments').insert({
      session_id: stringOrNull(body.sessionId),
      device_id: stringOrNull(body.deviceId),
      period_nonce: stringOrNull(body.periodNonce) ?? '',
      commitment: stringOrNull(body.commitment) ?? '',
      committed_at: stringOrNull(body.committedAt) ?? new Date().toISOString(),
      revealed_chain: stringOrNull(body.revealedChain),
      revealed_at: stringOrNull(body.revealedAt),
      commitment_valid: typeof body.commitmentValid === 'boolean' ? body.commitmentValid : null,
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (event === 'trust_event') {
    const deviceId = stringOrNull(body.deviceId)
    const delta = numberOrZero(body.delta)
    if (!deviceId) return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })

    const { error } = await adminClient.from('trust_events').insert({
      device_id: deviceId,
      event_type: stringOrNull(body.eventType) ?? 'unknown',
      delta,
      session_id: stringOrNull(body.sessionId),
      details: body.details && typeof body.details === 'object' ? body.details : {},
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await adminClient.rpc('apply_device_trust_delta', {
      p_device_id: deviceId,
      p_delta: delta,
    })

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown audit event' }, { status: 400 })
}
