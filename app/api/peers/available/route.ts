import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import {
  buildOccupiedProviderDeviceSet,
  buildProviderDeviceOccupancyLookupKeys,
  filterAvailableProviderDevices,
} from '@/lib/provider-capacity'

export async function GET(req: Request) {
  // Try cookie-based auth first, then Bearer token - both optional.
  const supabase = await createClient()
  let user = (await supabase.auth.getUser()).data.user
  if (!user) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token) user = (await adminClient.auth.getUser(token)).data.user ?? null
  }

  // Always clean up stale providers before counting - fixes stale is_sharing.
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  const cutoff = new Date(Date.now() - 45_000).toISOString()

  const { data, error } = await adminClient
    .from('provider_devices')
    .select('country_code, user_id, device_id, relay_url')
    .gt('last_heartbeat', cutoff)

  if (error || !data) return NextResponse.json({ peers: [] })

  const candidateDeviceIds = buildProviderDeviceOccupancyLookupKeys(data)
  const { data: activeSessions } = candidateDeviceIds.length > 0
    ? await adminClient
        .from('sessions')
        .select('provider_id, provider_device_id')
        .eq('status', 'active')
        .in('provider_device_id', candidateDeviceIds)
    : { data: [] as Array<{ provider_device_id: string | null }> }
  const occupiedDevices = buildOccupiedProviderDeviceSet(activeSessions)
  const availableDevices = filterAvailableProviderDevices(data, occupiedDevices)

  // New rows are keyed by the exact slot deviceId. Legacy rows keyed by the base
  // device still hide every slot under that base device.
  const { data: privateDevices } = await adminClient
    .from('private_share_devices')
    .select('user_id, base_device_id')
    .eq('enabled', true)

  function isPrivateSlot(userId: string, deviceId: string): boolean {
    for (const entry of privateDevices ?? []) {
      if (entry.user_id !== userId) continue
      if (entry.base_device_id === deviceId) return true
      if (!entry.base_device_id.includes('_slot_') && deviceId.startsWith(`${entry.base_device_id}_slot_`)) {
        return true
      }
    }
    return false
  }

  // Aggregate live devices - exclude the current user's devices and private-only slots.
  // Each provider_devices row is already a slot row for desktop, CLI, and extension providers.
  const counts: Record<string, number> = {}
  const relayUrls: Record<string, Set<string>> = {}
  for (const row of availableDevices) {
    if (user && row.user_id === user.id) continue
    if (isPrivateSlot(row.user_id, row.device_id)) continue
    counts[row.country_code] = (counts[row.country_code] ?? 0) + 1
    if (row.relay_url) {
      if (!relayUrls[row.country_code]) relayUrls[row.country_code] = new Set()
      relayUrls[row.country_code].add(row.relay_url)
    }
  }

  const peers = Object.entries(counts).map(([country, count]) => ({
    country,
    count,
    relay_urls: [...(relayUrls[country] ?? [])],
  }))

  return NextResponse.json({ peers })
}
