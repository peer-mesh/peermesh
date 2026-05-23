import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

test('stale session cleanup uses relay activity, not fixed active-session age', () => {
  const sql = readRepoFile('supabase.sql')

  assert.match(sql, /last_activity_at timestamptz default now\(\)/)
  assert.match(sql, /status = 'active'[\s\S]+coalesce\(last_activity_at, started_at\) < now\(\) - interval '5 minutes'/)
  assert.doesNotMatch(sql, /status in \('pending', 'active', 'reconnecting'\)[\s\S]+started_at < now\(\) - interval '30 minutes'/)
})

test('relay heartbeats active DB sessions so healthy sessions persist', () => {
  const relay = readRepoFile('relay/relay.js')

  assert.match(relay, /function touchSessionActivity\(/)
  assert.match(relay, /lastActivityAt: new Date\(now\)\.toISOString\(\)/)
  assert.match(relay, /touchSessionActivity\(session, 'watchdog'\)/)
})

test('requester refresh remains reachable while relay socket is open', () => {
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const openBranchIndex = serviceWorker.indexOf('relayWs && relayWs.readyState === WebSocket.OPEN')
  const refreshIndex = serviceWorker.indexOf('REQUESTER_SESSION_REFRESH_MS', openBranchIndex)
  const healthIndex = serviceWorker.indexOf('${CONTROL_PORT}/health', openBranchIndex)

  assert.notEqual(openBranchIndex, -1)
  assert.notEqual(refreshIndex, -1)
  assert.notEqual(healthIndex, -1)
  assert.ok(refreshIndex < healthIndex)
})

test('mandate relay schema and relay assignment path are present', () => {
  const sql = readRepoFile('supabase.sql')
  const relay = readRepoFile('relay/relay.js')
  const serviceWorker = readRepoFile('extension/background/service-worker.js')

  assert.match(sql, /create table if not exists device_keys/)
  assert.match(sql, /create table if not exists session_mandates/)
  assert.match(sql, /create table if not exists session_receipts/)
  assert.match(sql, /create table if not exists byte_tokens/)
  assert.match(sql, /create table if not exists period_commitments/)
  assert.match(sql, /create table if not exists trust_scores/)
  assert.match(sql, /create table if not exists trust_events/)

  assert.match(relay, /createSignedMandate/)
  assert.match(relay, /mandateClientPayload/)
  assert.match(relay, /nextByteToken/)
  assert.match(relay, /case 'audit_commit'/)
  assert.match(relay, /case 'requester_wrapped_receipt'/)
  assert.match(relay, /supportsDirect/)
  assert.match(relay, /providerDirectEndpoint/)

  assert.match(serviceWorker, /supportsDirect: true/)
  assert.match(serviceWorker, /providerDirectEndpoint/)
  assert.match(serviceWorker, /sessionSigningKey/)
})

test('desktop and CLI expose mandated direct tunnel capability behind relay fallback', () => {
  const cli = readRepoFile('cli/index.js')
  const desktop = readRepoFile('desktop/main.js')

  for (const source of [cli, desktop]) {
    assert.match(source, /new WebSocketServer\(\{ noServer: true \}\)/)
    assert.match(source, /registerDirectSession/)
    assert.match(source, /X-Mandate/)
    assert.match(source, /X-Direct-Proof/)
    assert.match(source, /supportsDirect: !!endpoint/)
    assert.match(source, /closeDirectSessionsForSlot\(slot, 'relay_signaling_lost'\)/)
    assert.match(source, /direct tunnel unavailable, falling back to relay/)
    assert.match(source, /type: 'direct_bytes'/)
    assert.match(source, /type: 'direct_tunnel_open'/)
  }
})

test('relay assigns direct-first mandated sessions with relay fallback and direct accounting', () => {
  const relay = readRepoFile('relay/relay.js')

  assert.match(relay, /provider\?\.supportsDirect === true/)
  assert.doesNotMatch(relay, /samePublicNetwork/)
  assert.match(relay, /transportPreference: transportTier > 0 \? \['direct', 'relay'\] : \['relay'\]/)
  assert.match(relay, /relayFallbackRequired: true/)
  assert.match(relay, /case 'direct_tunnel_open'/)
  assert.match(relay, /case 'direct_bytes'/)
  assert.match(relay, /recordSessionBytes\(directSession, byteCount, 'provider_to_requester'\)/)
})

test('relay config route computes relay health once per request', () => {
  const route = readRepoFile('app/api/relay/config/route.ts')

  assert.match(route, /const health = await getRelayHealthList\(\)/)
  assert.doesNotMatch(route, /Promise\.all\(\[\s*getRelayFallbackList\(\),\s*getRelayHealthList\(\),\s*\]\)/)
})
