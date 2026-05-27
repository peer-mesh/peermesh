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
  assert.match(serviceWorker, /iceEnabled: true/)
  assert.match(serviceWorker, /connectDesktopSignaling/)
  assert.match(serviceWorker, /providerDirectEndpoint/)
  assert.match(serviceWorker, /sessionSigningKey/)
})

test('desktop and CLI expose STUN direct data channel capability behind relay fallback', () => {
  const cli = readRepoFile('cli/index.js')
  const desktop = readRepoFile('desktop/main.js')

  for (const source of [cli, desktop]) {
    assert.match(source, /node-datachannel/)
    assert.match(source, /DIRECT_ICE_SERVERS/)
    assert.match(source, /registerDirectSession/)
    assert.match(source, /handleProviderIceOffer/)
    assert.match(source, /startRequesterDirectSession/)
    assert.match(source, /webrtc-signaling/)
    assert.match(source, /supportsDirect: !!rtc/)
    assert.match(source, /iceEnabled: !!rtc/)
    assert.match(source, /closeDirectSessionsForSlot\(slot, 'relay_signaling_lost'\)/)
    assert.match(source, /WebRTC direct unavailable, falling back to relay/)
    assert.match(source, /type: 'direct_bytes'/)
    assert.match(source, /type: 'direct_tunnel_open'/)
  }
})

test('relay tunnel path uses binary frames and backpressure on desktop and CLI providers', () => {
  const relay = readRepoFile('relay/relay.js')
  const desktop = readRepoFile('desktop/main.js')
  const cli = readRepoFile('cli/index.js')

  assert.match(relay, /RELAY_BINARY_TUNNEL_DATA/)
  assert.match(relay, /sendTunnelDataToProvider/)
  assert.match(relay, /tunnel_pause/)
  assert.match(relay, /tunnel_resume/)
  assert.match(relay, /applyProxyClientBackpressure/)

  for (const source of [desktop, cli]) {
    assert.match(source, /supportsBinaryTunnel: true/)
    assert.match(source, /sendRelayTunnelData/)
    assert.match(source, /RELAY_WS_BUFFER_HIGH_BYTES/)
    assert.match(source, /scheduleRelayBackpressureCheck/)
    assert.match(source, /tunnel_pause/)
    assert.match(source, /tunnel_resume/)
  }
})

test('provider byte accounting is throttled off hot tunnel chunks', () => {
  const desktop = readRepoFile('desktop/main.js')
  const cli = readRepoFile('cli/index.js')

  for (const source of [desktop, cli]) {
    assert.match(source, /ADD_BYTES_SYNC_INTERVAL_MS = 2000/)
    assert.match(source, /_lastAggregateSync/)
    assert.match(source, /now - _lastAggregateSync >= ADD_BYTES_SYNC_INTERVAL_MS/)
  }
})

test('fail-closed reconnect clears only PeerMesh control path and status panel can disconnect', () => {
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const popup = readRepoFile('extension/popup/popup.js')
  const injector = readRepoFile('extension/content/injector.js')

  assert.match(serviceWorker, /clearProxyProtectionForReconnect/)
  assert.match(serviceWorker, /case 'PREPARE_RECONNECT'/)
  assert.match(serviceWorker, /case 'RESTORE_FAIL_CLOSED'/)
  assert.match(serviceWorker, /lastRequesterSession/)
  assert.match(popup, /PREPARE_RECONNECT/)
  assert.match(popup, /RESTORE_FAIL_CLOSED/)
  assert.match(injector, /peermesh-panel-disconnect/)
  assert.match(injector, /type: 'DISCONNECT'/)
})

test('relay assigns direct-first mandated sessions with relay fallback and direct accounting', () => {
  const relay = readRepoFile('relay/relay.js')

  assert.match(relay, /provider\?\.supportsDirect === true/)
  assert.doesNotMatch(relay, /samePublicNetwork/)
  assert.match(relay, /DIRECT_ICE_SERVERS/)
  assert.match(relay, /const transportTier = canUseDirectTransport\(requester, provider\) \? 1 : 0/)
  assert.match(relay, /transportPreference: transportTier > 0 \? \['direct', 'relay'\] : \['relay'\]/)
  assert.match(relay, /case 'ice_offer'/)
  assert.match(relay, /case 'direct_failed'/)
  assert.match(relay, /relayFallbackRequired: true/)
  assert.match(relay, /case 'direct_tunnel_open'/)
  assert.match(relay, /case 'direct_bytes'/)
  assert.match(relay, /recordSessionBytes\(directSession, byteCount, 'provider_to_requester'\)/)
  assert.match(relay, /sendSessionQuality\(directSession, 'direct_failed', true\)/)
  assert.match(relay, /sendSessionQuality\(directSession, 'direct_open', true\)/)
  assert.match(relay, /const tunnelSessionId = proxyClient\.sessionId \?\? ws\.sessionId \?\? msg\.sessionId \?\? null/)
  assert.match(relay, /const tunnelSession = tunnelSessionId \? sessions\.get\(tunnelSessionId\) : null/)
})

test('session metadata patch accepts direct transport state in connection quality', () => {
  const route = readRepoFile('app/api/session/end/route.ts')

  assert.match(route, /directState/)
  assert.match(route, /directOpenedAt/)
  assert.match(route, /directFailReason/)
  assert.match(route, /const directQualityPatch: Record<string, unknown> = {}/)
  assert.match(route, /patch\.connection_quality = mergedConnectionQuality/)
})

test('requester direct path stays sticky after it opens once', () => {
  const desktop = readRepoFile('desktop/main.js')
  const cli = readRepoFile('cli/index.js')
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const relay = readRepoFile('relay/relay.js')

  for (const source of [desktop, cli]) {
    assert.match(source, /function handleRequesterSignalingClosed/)
    assert.match(source, /requester signaling closed after direct open; keeping direct session/)
    assert.match(source, /function hasRequesterStickyDirect/)
    assert.match(source, /function isDirectCapabilityFailureReason/)
    assert.match(source, /const directSticky = session\.directSticky === true/)
    assert.match(source, /requester signaling attached to sticky direct session/)
    assert.match(source, /if \(!entry \|\| hasRequesterStickyDirect\(entry\) \|\| entry\.mode === 'relay'/)
    assert.match(source, /direct_sticky_timeout/)
    assert.match(source, /retryRequesterDirectOnly/)
  }
  assert.doesNotMatch(serviceWorker, /currentSession\.directState === 'direct'\) return/)
  assert.match(serviceWorker, /desktop_signaling_closed/)
  assert.match(serviceWorker, /currentSession\?\.directState !== 'direct'[\s\S]*direct_failed/)
  assert.match(serviceWorker, /const directSticky = previous\.directSticky === true \|\| previous\.directState === 'direct'/)
  assert.match(serviceWorker, /directSticky: directSticky === true/)
  assert.match(serviceWorker, /currentSession\.directSticky !== true/)
  assert.match(serviceWorker, /function isDirectCapabilityFailureReason/)
  assert.match(relay, /ws\.directSticky = msg\.directSticky === true/)
  assert.match(relay, /if \(directSession\.directSticky && !isDirectCapabilityFailureReason\(directFailReason\)\)/)
  assert.match(relay, /STICKY_RETRY/)
})

test('relay provider registration does not geolocate the relay as the provider', () => {
  const route = readRepoFile('app/api/user/sharing/route.ts')
  const relay = readRepoFile('relay/relay.js')

  assert.match(route, /if \(isRelayRequest\(req\)\) \{\s+country = existingCountry \?\? requestedCountry \?\? country/)
  assert.match(route, /Relay-originated heartbeats come from the\s+\/\/ relay server/)
  assert.doesNotMatch(relay, /x-provider-ip/)
  assert.match(relay, /country: providerCountry/)
  assert.match(relay, /ws\.country = detectedCountry \?\? registeredCountry \?\? msg\.country/)
})

test('relay config route computes relay health once per request', () => {
  const route = readRepoFile('app/api/relay/config/route.ts')

  assert.match(route, /const health = await getRelayHealthList\(\)/)
  assert.doesNotMatch(route, /Promise\.all\(\[\s*getRelayFallbackList\(\),\s*getRelayHealthList\(\),\s*\]\)/)
})
