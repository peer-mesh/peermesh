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
    assert.match(source, /DC_BINARY_TUNNEL_DATA/)
    assert.match(source, /sendDataChannelBinary/)
    assert.match(source, /encodeDirectTunnelDataBinary|encodeTunnelDataBinary/)
    assert.match(source, /decodeDirectTunnelDataBinary|decodeTunnelDataBinary/)
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
    assert.match(source, /RELAY_WS_BUFFER_HIGH_BYTES = 16 \* 1024 \* 1024/)
    assert.match(source, /RELAY_WS_BUFFER_LOW_BYTES = 8 \* 1024 \* 1024/)
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

test('provider direct tunnel drains queued data before notifying requester close', () => {
  const desktop = readRepoFile('desktop/main.js')
  const queueStart = desktop.indexOf('function queueTunnelDataChannelFrame')
  const pumpStart = desktop.indexOf('function pumpTunnelDataChannel')
  const closeStart = desktop.indexOf('function closeProviderDirectTunnel')
  const providerDirectStart = desktop.indexOf('async function handleProviderDataChannelMessage')
  const socketCloseStart = desktop.indexOf("socket.on('close'", desktop.indexOf("if (msg.type === 'open_tunnel')", providerDirectStart))

  assert.notEqual(queueStart, -1)
  assert.notEqual(pumpStart, -1)
  assert.notEqual(closeStart, -1)
  assert.notEqual(providerDirectStart, -1)
  assert.notEqual(socketCloseStart, -1)

  const queueBlock = desktop.slice(queueStart, pumpStart)
  const pumpBlock = desktop.slice(pumpStart, desktop.indexOf('function closePeerConnection', pumpStart))
  const closeBlock = desktop.slice(closeStart, desktop.indexOf('function closeRequesterDirectSession', closeStart))
  const socketCloseBlock = desktop.slice(socketCloseStart, desktop.indexOf("socket.on('error'", socketCloseStart))

  assert.match(desktop, /function hasPendingDirectFrames/)
  assert.match(desktop, /function finalizeProviderDirectTunnel/)
  assert.match(queueBlock, /closeProviderDirectTunnel\(entry, tunnel\.tunnelId, true, \{ drainPending: false \}\)/)
  assert.match(pumpBlock, /tunnel\.closeAfterPending && !hasPendingDirectFrames\(tunnel\)[\s\S]+finalizeProviderDirectTunnel\(entry, tunnel\.tunnelId, true\)/)
  assert.match(closeBlock, /notifyRequester && drainPending && hasPendingDirectFrames\(tunnel\)[\s\S]+tunnel\.closeAfterPending = true[\s\S]+pumpTunnelDataChannel\(entry, tunnel\)/)
  assert.match(socketCloseBlock, /tunnel\.closeAfterPending && hasPendingDirectFrames\(tunnel\)[\s\S]+return/)
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

test('private code connect wins over stale country selection', () => {
  const popup = readRepoFile('extension/popup/popup.js')

  assert.match(popup, /const isPrivateConnect = !!privateCode/)
  assert.match(popup, /if \(state\.privateCodeInput && state\.selectedCountry\) state\.selectedCountry = null/)
  assert.match(popup, /chrome\.storage\.local\.set\(\{ privateCodeInput: state\.privateCodeInput, selectedCountry: state\.selectedCountry \}\)/)
  assert.doesNotMatch(popup, /state\.privateCodeInput = ''[\s\S]{0,120}chrome\.storage\.local\.set\(\{ privateCodeInput: '' \}\)/)
})

test('CONNECT proxy preserves bytes coalesced after tunnel response', () => {
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const desktop = readRepoFile('desktop/main.js')
  const cli = readRepoFile('cli/index.js')

  assert.doesNotMatch(serviceWorker, /DIRECT_ASSET_BYPASS_HOSTS/)
  for (const source of [desktop, cli]) {
    assert.match(source, /let connectResponse = Buffer\.alloc\(0\)/)
    assert.match(source, /const headerEnd = connectResponse\.indexOf\('\\r\\n\\r\\n'\)/)
    assert.match(source, /const initialPayload = connectResponse\.slice\(headerEnd \+ 4\)/)
    assert.match(source, /if \(initialPayload\.length && !clientSocket\.destroyed\) clientSocket\.write\(initialPayload\)/)
    assert.match(source, /\^HTTP\\\/\\S\+ 200\\b/)
  }
})

test('identity spoofing remains active with connected proxy', () => {
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const manifest = readRepoFile('extension/manifest.json')

  assert.match(serviceWorker, /const HEADER_RESOURCE_TYPES = \['main_frame', 'sub_frame', 'xmlhttprequest', 'script'/)
  assert.match(serviceWorker, /requestHeaders: \[\{ header: 'User-Agent', operation: 'set'/)
  assert.match(serviceWorker, /requestHeaders: \[\{ header: 'Accept-Language', operation: 'set'/)
  assert.match(serviceWorker, /requestHeaders: \[\{ header: 'Sec-CH-UA'/)
  assert.match(serviceWorker, /blockWebRTC\(\)[\s\S]+if \(country\) applyHeaderRules/)
  assert.match(manifest, /"content\/injector\.js"[\s\S]+"content\/identity\.js"/)
})

test('relay enforces requester billing cap across direct and relay bytes', () => {
  const relay = readRepoFile('relay/relay.js')
  const relayAuth = readRepoFile('app/api/relay/auth/route.ts')

  assert.match(relayAuth, /getBrowseBytesCoveredByWalletUsd/)
  assert.match(relayAuth, /billingCapBytes:/)
  assert.match(relay, /billingCapBytes: Number\.isFinite/)
  assert.match(relay, /requesterBillingCapBytes: requesterWs\.billingCapBytes/)
  assert.match(relay, /billing_usage_limit_reached/)
  assert.match(relay, /acceptedBytes = Math\.min\(byteCount, remainingBytes\)/)
  assert.match(relay, /pendingMeteringEndReason/)
  assert.match(relay, /finishMeteredSessionIfNeeded/)
  assert.match(relay, /case 'direct_bytes':[\s\S]+recordSessionBytes\(directSession, byteCount, 'provider_to_requester'\)/)
  assert.match(relay, /case 'tunnel_data':[\s\S]+recordSessionBytes\(tunnelSession, chunk\.length, 'provider_to_requester'\)/)
})

test('provider agent uses binary tunnel frames to avoid base64 relay overhead', () => {
  const agent = readRepoFile('provider-agent/agent.js')

  assert.match(agent, /supportsBinaryTunnel: true/)
  assert.match(agent, /encodeRelayTunnelDataBinary/)
  assert.match(agent, /decodeRelayTunnelDataBinary/)
  assert.match(agent, /sendRelayTunnelData\(tunnelId, data\)/)
  assert.match(agent, /isBinary \|\| buf\[0\] === RELAY_BINARY_TUNNEL_DATA/)
})

test('requester disconnects when the last browser window closes', () => {
  const serviceWorker = readRepoFile('extension/background/service-worker.js')

  assert.match(serviceWorker, /chrome\.windows\?\.onRemoved\?\.addListener/)
  assert.match(serviceWorker, /windows\.length > 0 \|\| !currentSession/)
  assert.match(serviceWorker, /last browser window closed - disconnecting requester session/)
  assert.match(serviceWorker, /disconnect\(\)\.catch/)
  assert.match(serviceWorker, /chrome\.runtime\.onSuspend\?\.addListener/)
  assert.match(serviceWorker, /disconnectForBrowserShutdown\('extension_suspend'\)/)
  assert.match(serviceWorker, /method: 'DELETE', keepalive: true/)
})

test('backpressure thresholds avoid throttling requester below provider speed too early', () => {
  const relay = readRepoFile('relay/relay.js')
  const desktop = readRepoFile('desktop/main.js')
  const cli = readRepoFile('cli/index.js')

  assert.match(relay, /RELAY_PROXY_BUFFER_HIGH_BYTES = 16 \* 1024 \* 1024/)
  assert.match(relay, /RELAY_PROXY_BUFFER_LOW_BYTES = 8 \* 1024 \* 1024/)
  assert.match(relay, /RELAY_PROXY_BUFFER_CHECK_MS = 25/)
  assert.match(desktop, /DIRECT_DC_BUFFER_HIGH_BYTES = 16 \* 1024 \* 1024/)
  assert.match(desktop, /DIRECT_DC_BUFFER_LOW_BYTES = 8 \* 1024 \* 1024/)
  assert.match(desktop, /DIRECT_TUNNEL_PENDING_MAX_BYTES = 32 \* 1024 \* 1024/)
  assert.match(cli, /RELAY_WS_BUFFER_HIGH_BYTES = 16 \* 1024 \* 1024/)
})

test('desktop manual sharing stop is not immediately undone by schedule jobs', () => {
  const desktop = readRepoFile('desktop/main.js')

  assert.match(desktop, /let _manualSharingPaused = false/)
  assert.match(desktop, /markManualSharingPaused\('native_share_stop'\)/)
  assert.match(desktop, /markManualSharingPaused\('ipc_toggle_stop'\)/)
  assert.match(desktop, /start skipped - sharing was manually paused/)
  assert.match(desktop, /uptime start skipped - sharing was manually paused/)
  assert.match(desktop, /const isPrivateOnDemandStart = String\(job\?\.payload\?\.reason/)
  assert.match(desktop, /clearManualSharingPaused\('private_on_demand_start'\)/)
  assert.match(desktop, /clearManualSharingPaused\('ipc_toggle_start'\)/)
})

test('requester speed display can use provider advertised speed', () => {
  const relay = readRepoFile('relay/relay.js')
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const popup = readRepoFile('extension/popup/popup.js')
  const injector = readRepoFile('extension/content/injector.js')

  assert.match(relay, /providerAdvertisedLastMbps/)
  assert.match(relay, /providerAdvertisedAvgMbps/)
  assert.match(serviceWorker, /providerAdvertisedLastMbps: Number\(msg\.providerAdvertisedLastMbps\)/)
  assert.match(popup, /providerAdvertisedLastMbps \|\| session\.quality\.currentMbps/)
  assert.match(injector, /providerAdvertisedLastMbps \|\| quality\.currentMbps/)
})

test('relay assignment considers live provider speed and direct support', () => {
  const relay = readRepoFile('relay/relay.js')

  assert.match(relay, /providerRuntimeQualityScore/)
  assert.match(relay, /providerLastMbps/)
  assert.match(relay, /providerAvgMbps/)
  assert.match(relay, /peer\.supportsDirect && peer\.iceEnabled/)
  assert.match(relay, /eligible\.sort\(\(a, b\) => providerRuntimeQualityScore\(b\) - providerRuntimeQualityScore\(a\)\)/)
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
