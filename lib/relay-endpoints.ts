// ── Relay pool ────────────────────────────────────────────────────────────────
// Managed by build-save-relays.js — edit RELAY_ENDPOINTS in .env.local instead.

export const RELAY_ENDPOINTS: string[] = (
  process.env.RELAY_ENDPOINTS ?? 'wss://peermesh-2ma4.onrender.com'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// ── Health cache ──────────────────────────────────────────────────────────────

interface RelayHealth {
  url: string
  alive: boolean
  peers: number
  sessions: number
  providers: number
  requesters: number
  activeSessions: number
  reconnectingSessions: number
  countries: Record<string, number>
  loadScore: number
  uptimeSeconds: number
  latencyMs: number
  checkedAt: number
}

const HEALTH_TTL = 15_000 // re-check every 15s
const HEALTH_TIMEOUT = 4_000

const healthCache = new Map<string, RelayHealth>()

async function checkRelay(wsUrl: string): Promise<RelayHealth> {
  const httpUrl = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
  const start = Date.now()
  try {
    const res = await fetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) throw new Error(`status=${res.status}`)
    const data = await res.json()
    return {
      url: wsUrl,
      alive: true,
      peers: data.peers ?? 0,
      sessions: data.sessions ?? 0,
      providers: data.providers ?? 0,
      requesters: data.requesters ?? 0,
      activeSessions: data.activeSessions ?? data.sessions ?? 0,
      reconnectingSessions: data.reconnectingSessions ?? 0,
      countries: data.countries && typeof data.countries === 'object' ? data.countries : {},
      loadScore: data.loadScore ?? ((data.sessions ?? 0) * 10 + (data.peers ?? 0)),
      uptimeSeconds: data.uptimeSeconds ?? 0,
      latencyMs,
      checkedAt: Date.now(),
    }
  } catch {
    return {
      url: wsUrl,
      alive: false,
      peers: 0,
      sessions: 0,
      providers: 0,
      requesters: 0,
      activeSessions: 0,
      reconnectingSessions: 0,
      countries: {},
      loadScore: 9999,
      uptimeSeconds: 0,
      latencyMs: 9999,
      checkedAt: Date.now(),
    }
  }
}

async function getHealth(wsUrl: string): Promise<RelayHealth> {
  const cached = healthCache.get(wsUrl)
  if (cached && Date.now() - cached.checkedAt < HEALTH_TTL) return cached
  const health = await checkRelay(wsUrl)
  healthCache.set(wsUrl, health)
  return health
}

// ── Score a relay — lower is better ──────────────────────────────────────────
// Weight sessions heavily (each active session = real load),
// peers lightly (connected but idle), latency as tiebreaker.

function score(h: RelayHealth): number {
  return h.loadScore + h.latencyMs * 0.01
}

// ── Pick best relay ───────────────────────────────────────────────────────────
// Returns the healthy relay with the lowest score.
// Falls back to least-bad if all are unhealthy.

export async function pickRelay(): Promise<string> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))

  const alive = results.filter(h => h.alive)
  const pool = alive.length > 0 ? alive : results // fallback to all if all dead

  pool.sort((a, b) => score(a) - score(b))
  return pool[0].url
}

// ── Ordered fallback list ─────────────────────────────────────────────────────
// Returns all relays sorted best→worst for the client to try in order.

export async function getRelayFallbackList(): Promise<string[]> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))
  const alive = results.filter(h => h.alive)
  const pool = alive.length > 0 ? alive : results
  pool.sort((a, b) => score(a) - score(b))
  return pool.map(h => h.url)
}

export async function getRelayHealthList(): Promise<RelayHealth[]> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))
  return [...results].sort((a, b) => score(a) - score(b))
}

// ── Best HTTP base URL for a specific relay (for check-private etc.) ──────────

export function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
}
