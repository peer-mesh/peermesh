#!/usr/bin/env node
/**
 * build-save-relays.mjs
 * Reads RELAY_ENDPOINTS (for the active PEERMESH_ENV) from .env.local
 * and updates lib/relay-endpoints.ts.
 *
 * Usage:
 *   node build-save-relays.mjs
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { RELAY_ENDPOINTS, ENV } from './lib/env.mjs'

const __dirname      = dirname(fileURLToPath(import.meta.url))
const RELAY_LIB_PATH = join(__dirname, 'lib', 'relay-endpoints.ts')
const RELAY_MANDATE_SRC  = join(__dirname, 'lib', 'mandate-relay.mjs')
const RELAY_MANDATE_DEST = join(__dirname, 'relay', 'lib', 'mandate-relay.mjs')

if (RELAY_ENDPOINTS.length === 0) {
  console.error(`\n  ERROR: No relay endpoints resolved for PEERMESH_ENV=${ENV}\n`)
  process.exit(1)
}

console.log(`\n  PEERMESH_ENV=${ENV} — ${RELAY_ENDPOINTS.length} relay(s):`)
RELAY_ENDPOINTS.forEach((r, i) => console.log(`    ${i + 1}. ${r}`))

const relayEndpointsStr = RELAY_ENDPOINTS.join(',')

writeFileSync(RELAY_LIB_PATH, `// ── Relay pool ────────────────────────────────────────────────────────────────
// Managed by build-save-relays.mjs — edit RELAY_ENDPOINTS in .env.local instead.

export const RELAY_ENDPOINTS: string[] = (
  process.env.RELAY_ENDPOINTS ?? '${RELAY_ENDPOINTS[0]}'
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
  latencyMs: number
  checkedAt: number
}

const HEALTH_TTL = 15_000
const HEALTH_TIMEOUT = 4_000

const healthCache = new Map<string, RelayHealth>()

async function checkRelay(wsUrl: string): Promise<RelayHealth> {
  const httpUrl = wsUrl.replace(/^wss:\\/\\//, 'https://').replace(/^ws:\\/\\//, 'http://')
  const start = Date.now()
  try {
    const res = await fetch(\`\${httpUrl}/health\`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) })
    const latencyMs = Date.now() - start
    if (!res.ok) throw new Error(\`status=\${res.status}\`)
    const data = await res.json()
    return { url: wsUrl, alive: true, peers: data.peers ?? 0, sessions: data.sessions ?? 0, latencyMs, checkedAt: Date.now() }
  } catch {
    return { url: wsUrl, alive: false, peers: 0, sessions: 0, latencyMs: 9999, checkedAt: Date.now() }
  }
}

async function getHealth(wsUrl: string): Promise<RelayHealth> {
  const cached = healthCache.get(wsUrl)
  if (cached && Date.now() - cached.checkedAt < HEALTH_TTL) return cached
  const health = await checkRelay(wsUrl)
  healthCache.set(wsUrl, health)
  return health
}

function score(h: RelayHealth): number {
  return h.sessions * 10 + h.peers * 1 + h.latencyMs * 0.01
}

export async function pickRelay(): Promise<string> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))
  const alive = results.filter(h => h.alive)
  const pool = alive.length > 0 ? alive : results
  pool.sort((a, b) => score(a) - score(b))
  return pool[0].url
}

export async function getRelayFallbackList(): Promise<string[]> {
  const results = await Promise.all(RELAY_ENDPOINTS.map(getHealth))
  const alive = results.filter(h => h.alive)
  const pool = alive.length > 0 ? alive : results
  pool.sort((a, b) => score(a) - score(b))
  return pool.map(h => h.url)
}

export function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:\\/\\//, 'https://').replace(/^ws:\\/\\//, 'http://')
}
`)

console.log('  ✓ Updated lib/relay-endpoints.ts')
console.log(`
  ✓ Done

  Next steps:
  1. Commit lib/relay-endpoints.ts
  2. Update Render env var RELAY_ENDPOINTS=${relayEndpointsStr}
  3. Deploy: git push origin main
`)

// Sync mandate-relay.mjs into relay/lib for Docker build
copyFileSync(RELAY_MANDATE_SRC, RELAY_MANDATE_DEST)
console.log('  ✓ Synced lib/mandate-relay.mjs → relay/lib/mandate-relay.mjs')
