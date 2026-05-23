import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getRelayHealthList } from '@/lib/relay-endpoints'

const OPS_SECRET = process.env.OPS_SECRET ?? process.env.RELAY_SECRET ?? ''

export const dynamic = 'force-dynamic'

type CountQuery = ReturnType<ReturnType<typeof adminClient.from>['select']>

async function countRows(table: string, apply: (query: CountQuery) => CountQuery) {
  const query = adminClient
    .from(table)
    .select('*', { count: 'exact', head: true })

  const { count, error } = await apply(query)
  if (error) throw error
  return count ?? 0
}

export async function GET(req: Request) {
  const secret = req.headers.get('x-ops-secret') ?? req.headers.get('x-relay-secret') ?? ''
  if (OPS_SECRET && secret !== OPS_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = Date.now()
  const providerCutoff = new Date(now - 45_000).toISOString()
  const recentCutoff = new Date(now - 60 * 60_000).toISOString()

  try {
    const [liveProviders, activeSessions, reconnectingSessions, recentEndedSessions, relayHealth] = await Promise.all([
      countRows('provider_devices', (q) => q.gt('last_heartbeat', providerCutoff)),
      countRows('sessions', (q) => q.eq('status', 'active')),
      countRows('sessions', (q) => q.eq('status', 'reconnecting')),
      countRows('sessions', (q) => q.eq('status', 'ended').gt('ended_at', recentCutoff)),
      getRelayHealthList(),
    ])

    const unhealthyRelays = relayHealth.filter(relay => !relay.alive).length

    return NextResponse.json({
      ok: unhealthyRelays === 0,
      checkedAt: new Date(now).toISOString(),
      liveProviders,
      activeSessions,
      reconnectingSessions,
      recentEndedSessions,
      relays: relayHealth,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Health check failed',
      checkedAt: new Date(now).toISOString(),
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
