// ── Relay config client ───────────────────────────────────────────────────────
// Used by extension, desktop, and CLI to fetch the live relay list from the
// server on startup. Falls back to hardcoded URLs if the server is unreachable.
// Managed by build-save-relays.js — edit RELAY_ENDPOINTS in .env.local instead.

const API_BASE = 'https://peermesh-0unl.onrender.com'
const CONFIG_URL = `${API_BASE}/api/relay/config`
const CACHE_TTL = 5 * 60 * 1000 // re-fetch every 5 minutes

// ── Hardcoded fallback — updated by build-save-relays.js ─────────────────────
const FALLBACK_RELAYS = [
  'wss://peermesh-relay.fly.dev',
  'wss://peermesh-2ma4.onrender.com',
]

let _cached: string[] | null = null
let _cachedAt = 0

async function fetchRelayConfig(): Promise<string[]> {
  try {
    const res = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`status=${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data.relays) || data.relays.length === 0) throw new Error('empty relay list')
    _cached = data.relays
    _cachedAt = Date.now()
    return data.relays as string[]
  } catch {
    // Server unreachable — use cache or hardcoded fallback
    if (_cached) return _cached
    return FALLBACK_RELAYS
  }
}

// Returns the relay list, fetching fresh if cache is stale
export async function getRelays(): Promise<string[]> {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL) return _cached
  return fetchRelayConfig()
}

// Returns the best relay (first in the server-ordered list)
export async function pickRelay() {
  const relays = await getRelays()
  return relays[0]
}

// Refresh in background without blocking — call on startup
export function prefetchRelays() {
  fetchRelayConfig().catch(() => {})
}
