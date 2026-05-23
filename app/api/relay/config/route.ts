import { NextResponse } from 'next/server'
import { getRelayFallbackList, getRelayHealthList } from '@/lib/relay-endpoints'

// Public endpoint — no auth required.
// Clients call this on startup to get the current relay pool.
// Cached at the CDN edge for 30s so it's fast but stays fresh.

export const revalidate = 30

export async function GET() {
  const health = await getRelayHealthList()
  const relays = health.map(relay => relay.url)
  const fallbackRelays = relays.length > 0 ? relays : await getRelayFallbackList()
  return NextResponse.json(
    { relays: fallbackRelays, health, updatedAt: Date.now() },
    { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' } }
  )
}
