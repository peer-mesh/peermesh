import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import {
  BYTE_TOKEN_GRANULARITY,
  DEFAULT_MANDATE_POLICY,
  advanceHashChain,
  createByteToken,
  createSessionNonce,
  createSessionSigningKey,
  createSignedMandate,
  getReachedTokenIndexes,
  getRelaySigningMaterial,
  verifyCommitmentReveal,
} from './lib/mandate-relay.mjs'

const PORT        = parseInt(process.env.PORT ?? '8080')
const API_BASE    = process.env.API_BASE ?? ''
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''
const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET ?? RELAY_SECRET
const SCHEDULER_TICK_INTERVAL_MS = Math.max(0, parseInt(process.env.SCHEDULER_TICK_INTERVAL_MS ?? '60000', 10) || 0)
const SESSION_DB_TOUCH_MS = Math.max(30_000, parseInt(process.env.SESSION_DB_TOUCH_MS ?? '60000', 10) || 60_000)
const DIRECT_TRANSPORT_ENABLED = process.env.RELAY_DIRECT_TRANSPORT !== '0'

// ICE servers — env-configurable so TURN can be added without code changes.
// RELAY_ICE_SERVERS: comma-separated list of URIs, optionally with credentials
// using the format: turn:host:port?user=U&pass=P
// Example: stun:stun.l.google.com:19302,turn:turn.example.com:3478?user=foo&pass=bar
function parseIceServers(raw) {
  if (!raw) return null
  const servers = []
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    try {
      const url = new URL(entry)
      const user = url.searchParams.get('user')
      const pass = url.searchParams.get('pass')
      // Strip query params from the URI itself
      const uri = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '')
      if (user && pass) {
        servers.push({ urls: uri, username: user, credential: pass })
      } else {
        servers.push(uri)
      }
    } catch {
      servers.push(entry)
    }
  }
  return servers.length > 0 ? servers : null
}

const DIRECT_ICE_SERVERS = parseIceServers(process.env.RELAY_ICE_SERVERS) ?? [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
]

const relaySigningMaterial = getRelaySigningMaterial(process.env)

const peers = new Map()
const sessions = new Map()
const proxyClients = new Map()

const RELAY_BINARY_TUNNEL_DATA = 0x01
const RELAY_PROXY_BUFFER_HIGH_BYTES = 4 * 1024 * 1024
const RELAY_PROXY_BUFFER_LOW_BYTES = 512 * 1024
const RELAY_PROXY_BUFFER_CHECK_MS = 50

const ALLOWED_TARGET_PORTS = new Set([80, 443, 8080, 8443])
const BLOCKED_HOSTS = [/\.onion$/i, /^smtp\./i, /^imap\./i, /^pop3\./i, /torrent/i]
const PRIVATE_HOSTS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(22[4-9]|23\d)\./, /^255\.255\.255\.255$/,
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
  /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i,
]

function normalizeTargetHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
}

function ipv4ToInt(value) {
  const parts = String(value).split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function isPrivateIpv4(value) {
  const ip = ipv4ToInt(value)
  if (ip === null) return false
  const ranges = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ]
  return ranges.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)
    if (baseInt === null) return false
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (ip & mask) === (baseInt & mask)
  }) || value === '255.255.255.255'
}

function isPrivateIp(value) {
  const host = normalizeTargetHost(value)
  const kind = isIP(host)
  if (kind === 4) return isPrivateIpv4(host)
  if (kind === 6) {
    return host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i.test(host)
  }
  return false
}

function isAllowedTargetName(hostname, port) {
  const host = normalizeTargetHost(hostname)
  return ALLOWED_TARGET_PORTS.has(Number(port)) &&
    !BLOCKED_HOSTS.some((pattern) => pattern.test(host)) &&
    !PRIVATE_HOSTS.some((pattern) => pattern.test(host))
}

async function validateTarget(hostname, port) {
  const host = normalizeTargetHost(hostname)
  if (!host) return { ok: false, reason: 'empty_host' }
  if (!isAllowedTargetName(host, port)) return { ok: false, reason: 'blocked_host_or_port' }
  if (isPrivateIp(host)) return { ok: false, reason: 'blocked_ip_literal' }

  try {
    const results = await lookup(host, { all: true, verbatim: false })
    if (!results.length) return { ok: false, reason: 'dns_no_records' }
    const blocked = results.find(result => isPrivateIp(result.address))
    if (blocked) return { ok: false, reason: 'dns_private_ip', address: blocked.address }
    return { ok: true, addresses: results.map(result => result.address) }
  } catch (err) {
    return { ok: false, reason: 'dns_lookup_failed', error: err?.message ?? String(err) }
  }
}

function logSecurityEvent(type, session, details = {}) {
  const context = {
    type,
    sessionId: session?.dbSessionId ?? null,
    relaySessionId: session?.sessionId ?? null,
    requesterUserId: session?.requesterUserId ?? null,
    providerUserId: session?.providerUserId ?? null,
    providerDeviceId: session?.providerDeviceId ?? null,
    country: session?.country ?? null,
    details,
    at: new Date().toISOString(),
  }
  log('SECURITY', `${type} ${JSON.stringify({ ...context, sessionId: context.sessionId?.slice?.(0,8), requesterUserId: context.requesterUserId?.slice?.(0,8), providerUserId: context.providerUserId?.slice?.(0,8) })}`)
  if (!API_BASE || !RELAY_SECRET) return
  fetch(`${API_BASE}/api/security/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify(context),
  }).catch(() => {})
}

function markBlockedTarget(session, details = {}) {
  if (!session) return false
  session.blockedRequests = (session.blockedRequests ?? 0) + 1
  logSecurityEvent('blocked_target', session, { ...details, blockedRequests: session.blockedRequests })
  if (session.blockedRequests < MAX_BLOCKED_TARGETS_PER_SESSION) return false
  session.disconnectReason = 'security_blocked_target_limit'
  logSecurityEvent('session_security_ended', session, { reason: session.disconnectReason })
  endRelaySession(session, session.sessionId ?? null, 'security_blocked_target_limit')
  return true
}


// peerAffinity: requesterUserId → Map(country → providerUserId)
// In-memory cache — seeded from DB via request_session msg, updated on session end.
// Survives within a relay process lifetime. DB is the persistent source of truth.
const peerAffinity = new Map()
const providerShareStatusCache = new Map()

const MAX_RECONNECT_ATTEMPTS = 12
const MAX_BLOCKED_TARGETS_PER_SESSION = 5

// ── Rate limit configuration — all values are env-overridable ────────────────
// RELAY_TUNNEL_WINDOW_MS          : sliding window for tunnel open rate (default 60000ms)
// RELAY_BYTE_BURST_WINDOW_MS      : sliding window for byte burst rate (default 60000ms)
// RELAY_TUNNELS_HIGH_MED_LOW      : max tunnels/window as "high/med/low" (default 300/200/50)
// RELAY_BYTES_HIGH_MED_LOW_MB     : max MB/window as "high/med/low" (default 750/250/60)
// RELAY_SESSIONS_HIGH_MED_LOW     : max concurrent sessions as "high/med/low" (default 8/3/1)

function getEnvInt(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function parseSlashTrio(name, defaults) {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return defaults
  const parts = raw.split('/').map(s => parseInt(s.trim(), 10))
  return [
    Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : defaults[0],
    Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : defaults[1],
    Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : defaults[2],
  ]
}

const TUNNEL_WINDOW_MS     = getEnvInt('RELAY_TUNNEL_WINDOW_MS', 60_000)
const BYTE_BURST_WINDOW_MS = getEnvInt('RELAY_BYTE_BURST_WINDOW_MS', 60_000)

const [TUNNELS_HIGH, TUNNELS_MED, TUNNELS_LOW]   = parseSlashTrio('RELAY_TUNNELS_HIGH_MED_LOW', [1200, 800, 300])
const [BYTES_HIGH_MB, BYTES_MED_MB, BYTES_LOW_MB] = parseSlashTrio('RELAY_BYTES_HIGH_MED_LOW_MB', [750, 250, 60])
const [SESSIONS_HIGH, SESSIONS_MED, SESSIONS_LOW] = parseSlashTrio('RELAY_SESSIONS_HIGH_MED_LOW', [8, 3, 1])

function sessionLimits(trustScore = 50) {
  if (trustScore >= 80) return {
    maxConcurrentSessions: SESSIONS_HIGH,
    maxTunnelsPerMinute:   TUNNELS_HIGH,
    maxBytesPerMinute:     BYTES_HIGH_MB * 1024 * 1024,
  }
  if (trustScore >= 50) return {
    maxConcurrentSessions: SESSIONS_MED,
    maxTunnelsPerMinute:   TUNNELS_MED,
    maxBytesPerMinute:     BYTES_MED_MB * 1024 * 1024,
  }
  return {
    maxConcurrentSessions: SESSIONS_LOW,
    maxTunnelsPerMinute:   TUNNELS_LOW,
    maxBytesPerMinute:     BYTES_LOW_MB * 1024 * 1024,
  }
}

function mandatePolicyForTrust(trustScore = 50) {
  const limits = sessionLimits(trustScore)
  return {
    ...DEFAULT_MANDATE_POLICY,
    maxBytesPerMinute: limits.maxBytesPerMinute,
    maxTunnelsPerMinute: limits.maxTunnelsPerMinute,
  }
}

function canUseDirectTransport(requester, provider) {
  return DIRECT_TRANSPORT_ENABLED &&
    requester?.supportsDirect === true &&
    provider?.supportsDirect === true
}

function buildAuditState(sessionId, sessionNonce, sessionSigningKey) {
  return {
    sessionNonce,
    sessionSigningKey,
    tokenSecret: createSessionSigningKey(),
    bytesForwarded: 0,
    tokenFloorBytes: 0,
    tokenLog: [],
    chainValue: sessionNonce,
    commitments: new Map(),
    receipts: new Map(),
    lastRelaySignalAt: Date.now(),
  }
}

function nextByteToken(audit, sessionId, tokenIndex) {
  return {
    tokenIndex,
    nextTokenAt: tokenIndex * BYTE_TOKEN_GRANULARITY,
    token: createByteToken(audit.tokenSecret, sessionId, tokenIndex),
  }
}

function recordAuditBytes(session, byteCount, direction = 'unknown') {
  if (!session?.audit || byteCount <= 0) return
  const timestampMs = Date.now()
  session.audit.chainValue = advanceHashChain(
    session.audit.chainValue,
    byteCount,
    timestampMs,
    session.audit.sessionSigningKey,
  )

  const countsAsProviderFlow = direction === 'provider_to_requester' || direction === 'proxy_response'
  if (!countsAsProviderFlow) return

  const previous = session.audit.bytesForwarded
  const next = previous + byteCount
  session.audit.bytesForwarded = next

  for (const tokenIndex of getReachedTokenIndexes(previous, next)) {
    const tokenValue = createByteToken(session.audit.tokenSecret, session.sessionId, tokenIndex)
    session.audit.tokenFloorBytes = Math.max(session.audit.tokenFloorBytes, tokenIndex * BYTE_TOKEN_GRANULARITY)
    session.audit.tokenLog.push({
      tokenIndex,
      tokenValue,
      issuedAt: new Date(timestampMs).toISOString(),
      receivedAt: new Date(timestampMs).toISOString(),
      source: 'relay_forwarded',
    })
  }
}

function buildMandatePayload(session, requester, provider) {
  const transportTier = canUseDirectTransport(requester, provider) ? 1 : 0
  const sessionSigningKey = createSessionSigningKey()
  const sessionNonce = createSessionNonce()
  const directChallenge = createSessionNonce()
  const directTransport = transportTier > 0 ? (provider.directTransport ?? 'webrtc') : null
  const iceEnabled = transportTier > 0 && directTransport === 'webrtc'
  const providerDirectEndpoint = transportTier > 0 ? (provider.directEndpoint ?? null) : null
  const mandate = createSignedMandate({
    sessionId: session.sessionId,
    dbSessionId: session.dbSessionId ?? null,
    requesterUserId: session.requesterUserId,
    requesterDeviceId: requester.deviceId ?? requester.userId ?? null,
    providerUserId: session.providerUserId,
    providerDeviceId: session.providerDeviceId,
    policy: mandatePolicyForTrust(session.requesterTrustScore ?? 50),
    sessionSigningKey,
    sessionSigningKeyMode: 'relay_delivered',
    sessionNonce,
    directChallenge,
    hardExpiryOnSignalingLoss: 30,
    directTransport,
    iceEnabled,
    iceServers: iceEnabled ? DIRECT_ICE_SERVERS : [],
    providerDirectEndpoint,
    relayFallback: session.relayEndpoint ?? requester.relayUrl ?? null,
    relayPublicKey: relaySigningMaterial.publicKeyPem,
    transportTier,
    transportPreference: transportTier > 0 ? ['direct', 'relay'] : ['relay'],
    relayFallbackRequired: true,
    binaryHash: null,
  }, relaySigningMaterial)

  return {
    mandate,
    relayPublicKey: relaySigningMaterial.publicKeyPem,
    sessionSigningKey,
    sessionNonce,
    transportTier,
    directTransport,
    iceEnabled,
    iceServers: iceEnabled ? DIRECT_ICE_SERVERS : [],
    providerDirectEndpoint,
    forcedRelay: transportTier === 0,
    directChallenge,
  }
}

function mandateClientPayload(session) {
  return {
    mandate: session.mandate ?? null,
    relayPublicKey: session.relayPublicKey ?? null,
    sessionSigningKey: session.audit?.sessionSigningKey ?? null,
    sessionNonce: session.audit?.sessionNonce ?? null,
    transportTier: session.transportTier ?? 0,
    directTransport: session.directTransport ?? session.mandate?.directTransport ?? null,
    iceEnabled: session.iceEnabled === true || session.mandate?.iceEnabled === true,
    iceServers: session.iceServers ?? session.mandate?.iceServers ?? [],
    directState: session.directState ?? 'relay',
    providerDirectEndpoint: session.providerDirectEndpoint ?? null,
    relayFallback: session.relayEndpoint ?? null,
    transportPreference: session.mandate?.transportPreference ?? ['relay'],
    mandateArchitecture: true,
  }
}

function reportAuditEvent(event, payload) {
  if (!API_BASE || !RELAY_SECRET) return
  fetch(`${API_BASE}/api/relay/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify({ event, ...payload }),
  }).catch(() => {})
}

function log(tag, msg, extra = '') {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] [${tag}] ${msg}${extra ? ' | ' + extra : ''}`)
}

function logErr(tag, msg, err) {
  const ts = new Date().toISOString().slice(11, 23)
  console.error(`[${ts}] [${tag}] ERROR ${msg} | ${err?.message ?? err}`)
}

function peersSnapshot() {
  const all = [...peers.values()]
  const providers = all.filter(p => p.role === 'provider')
  const requesters = all.filter(p => p.role === 'requester')
  return `total=${all.length} providers=${providers.length} requesters=${requesters.length} | providers: [${providers.map(p => `${p.peerId.slice(0,8)} userId=${p.userId?.slice(0,8)} country=${p.country} busy=${!!p.sessionId} private=${!!p.privateOnly}`).join(', ')}]`
}

// ── Affinity helpers ──────────────────────────────────────────────────────────

function canProviderAcceptShareStatus(status) {
  return status?.can_accept_sessions !== false
}

function describeProviderShareBlock(status) {
  if (status?.status_unavailable) return 'status_unavailable'
  if (status?.daily_limit_bytes != null && Number(status.total_bytes_today ?? 0) >= Number(status.daily_limit_bytes)) return 'account_daily_limit_reached'
  if (status?.slot_daily_limit_bytes != null && Number(status.slot_total_bytes_today ?? 0) >= Number(status.slot_daily_limit_bytes)) return 'slot_daily_limit_reached'
  return 'share_status_blocked'
}

function getAffinity(requesterUserId, country) {
  return peerAffinity.get(requesterUserId)?.get(country) ?? null
}

function setAffinity(requesterUserId, country, providerUserId) {
  if (!requesterUserId || !providerUserId) return
  if (!peerAffinity.has(requesterUserId)) peerAffinity.set(requesterUserId, new Map())
  peerAffinity.get(requesterUserId).set(country, providerUserId)
}

// ── Provider finder — affinity-aware ─────────────────────────────────────────
// preferredUserId: try this provider first (peer affinity)
// excludePeerIds: skip specific peer connections (e.g. the provider that just dropped)

async function getProviderShareStatus(userId, deviceId = null, baseDeviceId = null) {
  const cacheKey = deviceId ? `${userId}:${deviceId}` : (baseDeviceId ? `${userId}:${baseDeviceId}` : userId)
  const cached = providerShareStatusCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (!userId || !API_BASE || !RELAY_SECRET) {
    if (cached) {
      log('LIMIT', `STATUS_STALE userId=${userId?.slice(0,8) ?? 'unknown'} using cached share status`)
      return cached.value
    }
    return { can_accept_sessions: true, total_bytes_today: 0, daily_limit_bytes: null, status_unavailable: true }
  }

  try {
    const qs = new URLSearchParams({ providerUserId: userId })
    if (deviceId) qs.set('deviceId', deviceId)
    if (baseDeviceId) qs.set('baseDeviceId', baseDeviceId)
    const res = await fetch(`${API_BASE}/api/user/sharing?${qs}`, {
      headers: { 'x-relay-secret': RELAY_SECRET },
    })
    if (!res.ok) throw new Error(`status=${res.status}`)
    const value = await res.json()
    providerShareStatusCache.set(cacheKey, { value, expiresAt: Date.now() + 5000 })
    return value
  } catch (err) {
    logErr('LIMIT', `provider status lookup failed userId=${userId.slice(0,8)}`, err)
    if (cached) {
      log('LIMIT', `STATUS_STALE userId=${userId.slice(0,8)} using cached share status`)
      return cached.value
    }
    return { can_accept_sessions: true, total_bytes_today: 0, daily_limit_bytes: null, status_unavailable: true }
  }
}

async function verifyPeerAuth({
  token,
  userId = null,
  role,
  dbSessionId = null,
  country = null,
  privateProviderUserId = null,
  privateBaseDeviceId = null,
}) {
  if (!API_BASE || !RELAY_SECRET) {
    return { ok: false, error: 'Relay auth is not configured' }
  }
  if (!token || !role) {
    return { ok: false, error: 'Missing relay auth token' }
  }

  try {
    const res = await fetch(`${API_BASE}/api/relay/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-secret': RELAY_SECRET,
      },
      body: JSON.stringify({
        token,
        userId,
        role,
        dbSessionId,
        country,
        privateProviderUserId,
        privateBaseDeviceId,
      }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || `Relay auth failed (${res.status})` }
    }
    return {
      ok: true,
      userId: data.userId ?? null,
      trustScore: data.trustScore ?? 50,
      country: data.country ?? null,
      privateProviderUserId: data.privateProviderUserId ?? null,
      privateBaseDeviceId: data.privateBaseDeviceId ?? null,
    }
  } catch (err) {
    logErr('AUTH', `relay auth failed userId=${userId?.slice?.(0, 8) ?? 'unknown'} role=${role}`, err)
    return { ok: false, error: 'Relay auth request failed' }
  }
}

function normalizeCountryCode(value) {
  const country = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null
}

function isDirectCapabilityFailureReason(reason) {
  const value = String(reason || '').toLowerCase()
  return value === 'ice_not_enabled' || value === 'node_datachannel_unavailable'
}

async function registerProviderHeartbeatFromRelay({ userId, deviceId, relayUrl, country }) {
  if (!API_BASE || !RELAY_SECRET || !userId || !deviceId) return null
  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-relay-secret': RELAY_SECRET,
      'x-peermesh-actor': 'relay',
    }
    const providerCountry = normalizeCountryCode(country)

    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        user_id: userId,
        device_id: deviceId,
        country: providerCountry,
        relay_url: relayUrl || null,
      }),
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      log('HEARTBEAT', `relay provider heartbeat failed userId=${userId.slice(0,8)} status=${res.status} error=${data.error ?? 'unknown'}`)
      return null
    }
    return normalizeCountryCode(data.country)
  } catch (err) {
    logErr('HEARTBEAT', `relay provider heartbeat failed userId=${userId.slice(0,8)}`, err)
    return null
  }
}

async function findProvider(country, requesterId, requestingUserId, {
  requireTunnel = false,
  preferredUserId = null,
  privateBaseDeviceId = null,
  privateOnly = false,
  excludePeerIds = [],
} = {}) {
  const isEligible = (peer) =>
    peer.role === 'provider' &&
    peer.country === country &&
    !peer.sessionId &&
    peer.readyState === WebSocket.OPEN &&
    peer.trustScore >= 30 &&
    peer.peerId !== requesterId &&
    peer.userId !== requestingUserId &&
    !excludePeerIds.includes(peer.peerId) &&
    (!privateBaseDeviceId || peer.deviceId === privateBaseDeviceId || peer.baseDeviceId === privateBaseDeviceId) &&
    // Block public connections from reaching private-only slots
    (!peer.privateOnly || !!privateBaseDeviceId) &&
    peer.supportsHttp !== false &&
    (!requireTunnel || peer.supportsTunnel)

  if (preferredUserId) {
    for (const [, peer] of peers) {
      if (peer.userId === preferredUserId && isEligible(peer)) {
        const status = await getProviderShareStatus(peer.userId, peer.deviceId, peer.baseDeviceId)
        if (!canProviderAcceptShareStatus(status)) {
          log('LIMIT', `SKIP preferred provider userId=${preferredUserId.slice(0,8)} ${describeProviderShareBlock(status)}`)
          continue
        }
        log('AFFINITY', `HIT preferred provider userId=${preferredUserId.slice(0,8)} country=${country}`)
        return peer
      }
    }
    if (privateOnly) {
      log('PRIVATE', `MISS preferred provider userId=${preferredUserId.slice(0,8)} baseDeviceId=${privateBaseDeviceId?.slice(0,12) ?? 'unknown'}`)
      return null
    }
    log('AFFINITY', `MISS preferred provider userId=${preferredUserId.slice(0,8)} offline/busy - falling back`)
  }

  const eligible = []
  for (const [, peer] of peers) {
    if (isEligible(peer)) eligible.push(peer)
  }
  if (eligible.length === 0) return null
  eligible.sort((a, b) => (b.trustScore ?? 50) - (a.trustScore ?? 50))

  for (const peer of eligible) {
    const status = await getProviderShareStatus(peer.userId, peer.deviceId, peer.baseDeviceId)
    if (canProviderAcceptShareStatus(status)) return peer
    log('LIMIT', `SKIP provider peerId=${peer.peerId.slice(0,8)} userId=${peer.userId?.slice(0,8)} ${describeProviderShareBlock(status)}`)
  }

  return null
}

// ── Create a new relay session between an existing requester WS and a provider ─

function createSession(requesterWs, provider, country, dbSessionId, {
  notificationMode = 'initial',
  reconnectAttempt = 0,
  emitSessionCreated = notificationMode === 'initial',
} = {}) {
  const sessionId = randomUUID()
  requesterWs.sessionId = sessionId
  provider.sessionId = sessionId
  peers.set(requesterWs.peerId, requesterWs)

  sessions.set(sessionId, {
    sessionId,
    requesterId: requesterWs.peerId,
    providerId: provider.peerId,
    country,
    status: 'active',
    requesterUserId: requesterWs.userId,
    providerUserId: provider.userId ?? null,
    providerKind: provider.providerKind ?? null,
    providerDeviceId: provider.deviceId ?? null,
    providerBaseDeviceId: provider.baseDeviceId ?? null,
    startTime: Date.now(),
    bytesRequester: 0,
    bytesProvider: 0,
    providerAvgMbps: 0,
    providerLastMbps: 0,
    connectionQuality: {},
    lastQualitySentAt: 0,
    lastQualityBytes: 0,
    lastQualityTime: Date.now(),
    dbSessionId: dbSessionId ?? null,
    relayEndpoint: requesterWs.relayUrl ?? null,
    targetHost: null,
    targetHosts: new Set(),   // all hostnames seen — primary is first non-CDN or just first
    agentReady: false,
    notificationMode,
    reconnectAttempt,
    reconnectAttempts: reconnectAttempt,
    reconnectReason: reconnectAttempt > 0 ? 'provider_disconnected' : null,
    requesterTrustScore: requesterWs.trustScore ?? 50,
    blockedRequests: 0,
    tunnelWindowStart: Date.now(),
    tunnelOpenCount: 0,
    byteBurstSamples: [],
    byteBurstSampleStart: 0,
    byteBurstWindowBytes: 0,
    privateBaseDeviceId: requesterWs.privateBaseDeviceId ?? null,
    lastActivity: Date.now(),
    lastDbActivitySyncAt: 0,
    transportTier: 0,
    directTransport: null,
    iceEnabled: false,
    iceServers: [],
    directState: 'relay',
    directOpenedAt: null,
    directFailedAt: null,
    directFailReason: null,
    directSticky: requesterWs.directSticky === true,
    providerDirectEndpoint: null,
    mandate: null,
    relayPublicKey: null,
    audit: null,
  })

  const createdSession = sessions.get(sessionId)
  const mandatePayload = buildMandatePayload(createdSession, requesterWs, provider)
  createdSession.transportTier = mandatePayload.transportTier
  createdSession.directTransport = mandatePayload.directTransport
  createdSession.iceEnabled = mandatePayload.iceEnabled
  createdSession.iceServers = mandatePayload.iceServers
  createdSession.directState = mandatePayload.iceEnabled ? 'attempting_direct' : 'relay'
  createdSession.providerDirectEndpoint = mandatePayload.providerDirectEndpoint
  createdSession.mandate = mandatePayload.mandate
  createdSession.relayPublicKey = mandatePayload.relayPublicKey
  createdSession.audit = buildAuditState(
    sessionId,
    mandatePayload.sessionNonce,
    mandatePayload.sessionSigningKey,
  )
  const firstByteToken = nextByteToken(createdSession.audit, sessionId, 1)

  send(provider, {
    type: 'session_request',
    sessionId,
    ...mandateClientPayload(createdSession),
    nextByteToken: firstByteToken,
  })
  if (emitSessionCreated) {
    send(requesterWs, { type: 'session_created', sessionId, ...mandateClientPayload(createdSession) })
  }
  log(requesterWs.peerId.slice(0,8), `SESSION_CREATED id=${sessionId.slice(0,8)} provider=${provider.peerId.slice(0,8)} country=${country} tier=${createdSession.transportTier}`)
  syncSessionMetadata(createdSession, 'relay_assign')
  touchSessionActivity(createdSession, 'relay_assign', true)
  if (dbSessionId) {
    reportAuditEvent('mandate_issued', {
      sessionId: dbSessionId,
      relaySessionId: sessionId,
      mandate: createdSession.mandate,
      transportTier: createdSession.transportTier,
      forcedRelay: createdSession.transportTier === 0,
    })
  }

  // If the provider doesn't respond with agent_ready within 10s, treat it as
  // unresponsive and attempt reconnect to a different provider.
  setTimeout(() => {
    const session = sessions.get(sessionId)
    if (!session || session.agentReady) return
    if (requesterWs.readyState !== WebSocket.OPEN) return // requester already gone
    log(requesterWs.peerId.slice(0,8), `SESSION_AGENT_READY_TIMEOUT sessionId=${sessionId.slice(0,8)} provider=${provider.peerId.slice(0,8)}`)
    // Evict the unresponsive provider slot and reconnect
    provider.sessionId = null
    requesterWs.sessionId = null
    sessions.delete(sessionId)
    session.status = 'reconnecting'
    session.disconnectReason = 'provider_unresponsive'
    session.reconnectAttempts = 1
    session.reconnectReason = 'provider_unresponsive'
    syncSessionMetadata(session, 'provider_unresponsive')
    send(requesterWs, { type: 'session_reconnecting', reason: 'provider_unresponsive', attempt: 1, maxAttempts: MAX_RECONNECT_ATTEMPTS })
    attemptReconnect(requesterWs, { ...session, sessionId, providerId: provider.peerId, reconnectAttempts: 0 })
  }, 10_000)

  return sessionId
}

function syncSessionMetadata(session, reason = 'update') {
  if (!API_BASE || !RELAY_SECRET || !session?.dbSessionId) return
  // Skip if there's nothing meaningful to write
  if (!session.providerUserId && !session.targetHost && !session.relayEndpoint && !session.status) return

  const payload = {
    dbSessionId:    session.dbSessionId,
    status:         session.status ?? null,
    providerUserId: session.providerUserId ?? null,
    providerKind:   session.providerKind ?? null,
    providerDeviceId: session.providerDeviceId ?? null,
    providerBaseDeviceId: session.providerBaseDeviceId ?? null,
    relayEndpoint:  session.relayEndpoint ?? null,
    targetHost:     session.targetHost ?? null,
    targetHosts:    session.targetHosts ? [...session.targetHosts] : [],
    disconnectReason: session.disconnectReason ?? null,
    providerAvgMbps: session.providerAvgMbps ?? null,
    providerLastMbps: session.providerLastMbps ?? null,
    connectionQuality: session.connectionQuality ?? null,
    reconnectAttempts: session.reconnectAttempts ?? null,
    reconnectReason: session.reconnectReason ?? null,
    directState: session.directState ?? null,
    directOpenedAt: session.directOpenedAt ? new Date(session.directOpenedAt).toISOString() : null,
    directFailReason: session.directFailReason ?? null,
    lastActivityAt: new Date().toISOString(),
  }

  fetch(`${API_BASE}/api/session/end`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        log('RELAY', `SESSION_METADATA_${reason.toUpperCase()} status=${res.status} dbSessionId=${session.dbSessionId?.slice(0,8)} body=${body.slice(0,120)}`)
        return
      }
      log('RELAY', `SESSION_METADATA_${reason.toUpperCase()} dbSessionId=${session.dbSessionId?.slice(0,8)} provider=${session.providerUserId?.slice(0,8) ?? 'none'} host=${session.targetHost ?? 'none'}`)
    })
    .catch((err) => logErr('RELAY', `SESSION_METADATA_${reason.toUpperCase()} failed dbSessionId=${session.dbSessionId?.slice(0,8)}`, err))
}

function touchSessionActivity(session, reason = 'activity', force = false) {
  if (!API_BASE || !RELAY_SECRET || !session?.dbSessionId) return
  const now = Date.now()
  if (!force && now - (session.lastDbActivitySyncAt || 0) < SESSION_DB_TOUCH_MS) return
  session.lastDbActivitySyncAt = now

  fetch(`${API_BASE}/api/session/end`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify({
      dbSessionId: session.dbSessionId,
      lastActivityAt: new Date(now).toISOString(),
    }),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        log('RELAY', `SESSION_TOUCH_${reason.toUpperCase()} status=${res.status} dbSessionId=${session.dbSessionId?.slice(0,8)} body=${body.slice(0,120)}`)
      }
    })
    .catch((err) => logErr('RELAY', `SESSION_TOUCH_${reason.toUpperCase()} failed dbSessionId=${session.dbSessionId?.slice(0,8)}`, err))
}

function recordSessionHost(session, hostname, reason = 'target_host') {
  if (!session || !hostname) return
  const normalizedHost = String(hostname).trim().toLowerCase()
  if (!normalizedHost) return

  if (!session.targetHosts) session.targetHosts = new Set()
  const hadHost = session.targetHosts.has(normalizedHost)
  const previousBest = pickBestHost(session.targetHost, session.targetHosts)
  session.targetHosts.add(normalizedHost)
  if (session.targetHosts.size === 50 || session.targetHosts.size === 100 || session.targetHosts.size > 150) {
    logSecurityEvent('high_target_fanout', session, { targetHostCount: session.targetHosts.size })
  }
  const nextBest = pickBestHost(previousBest, session.targetHosts)

  if (nextBest !== session.targetHost) {
    session.targetHost = nextBest
    syncSessionMetadata(session, reason)
    return
  }

  if (hadHost) return
  syncSessionMetadata(session, reason)
}

function buildSessionQuality(session, now = Date.now()) {
  const totalBytes = Math.max(0, Number(session.bytesProvider) || 0)
  const elapsedMs = Math.max(1, now - (session.startTime || now))
  const previousTime = session.lastQualityTime || session.startTime || now
  const previousBytes = Math.max(0, Number(session.lastQualityBytes) || 0)
  const sampleWindowMs = Math.max(1, now - previousTime)
  const sampleBytes = Math.max(0, totalBytes - previousBytes)
  const avgMbps = (totalBytes * 8) / elapsedMs / 1000
  const currentMbps = (sampleBytes * 8) / sampleWindowMs / 1000
  return {
    avgMbps: Number(avgMbps.toFixed(3)),
    currentMbps: Number(currentMbps.toFixed(3)),
    transferredBytes: totalBytes,
    sampleWindowMs,
    measuredAt: new Date(now).toISOString(),
    providerKind: session.providerKind ?? null,
    providerDeviceId: session.providerDeviceId ?? null,
    country: session.country ?? null,
    directState: session.directState ?? 'relay',
    directOpenedAt: session.directOpenedAt ? new Date(session.directOpenedAt).toISOString() : null,
    directFailReason: session.directFailReason ?? null,
    transportTier: session.transportTier ?? 0,
  }
}

function sendSessionQuality(session, reason = 'traffic', force = false) {
  if (!session) return
  const now = Date.now()
  if (!force && now - (session.lastQualitySentAt || 0) < 3000) return
  const quality = buildSessionQuality(session, now)
  session.providerAvgMbps = quality.avgMbps
  session.providerLastMbps = quality.currentMbps
  session.connectionQuality = quality
  session.lastQualitySentAt = now
  session.lastQualityBytes = quality.transferredBytes
  session.lastQualityTime = now
  touchSessionActivity(session, reason)
  const requester = peers.get(session.requesterId)
  if (!requester || requester.readyState !== WebSocket.OPEN) return
  send(requester, {
    type: 'session_quality',
    sessionId: requester.sessionId,
    reason,
    avgMbps: quality.avgMbps,
    currentMbps: quality.currentMbps,
    transferredBytes: quality.transferredBytes,
    sampleWindowMs: quality.sampleWindowMs,
    providerKind: quality.providerKind,
    providerDeviceId: quality.providerDeviceId,
    country: quality.country,
    directState: quality.directState,
    transportTier: quality.transportTier,
  })
}

// ── Auto-reconnect — called when provider drops while requester is still live ─

function activeSessionCountForRequester(userId) {
  if (!userId) return 0
  let count = 0
  for (const session of sessions.values()) {
    if (session.requesterUserId === userId && ['active', 'reconnecting'].includes(session.status)) count += 1
  }
  return count
}

function canOpenTunnel(session) {
  const now = Date.now()
  const limits = sessionLimits(session.requesterTrustScore ?? 50)
  if (!session.tunnelWindowStart || now - session.tunnelWindowStart > TUNNEL_WINDOW_MS) {
    session.tunnelWindowStart = now
    session.tunnelOpenCount = 0
  }
  session.tunnelOpenCount = (session.tunnelOpenCount ?? 0) + 1
  if (session.tunnelOpenCount <= limits.maxTunnelsPerMinute) return true
  logSecurityEvent('session_tunnel_rate_observed', session, {
    reason: 'security_tunnel_rate_limit',
    tunnelOpenCount: session.tunnelOpenCount,
    maxTunnelsPerMinute: limits.maxTunnelsPerMinute,
  })
  return true
}

function recordSessionBytes(session, byteCount, direction = 'unknown') {
  if (!session || byteCount <= 0) return true
  const now = Date.now()
  const limits = sessionLimits(session.requesterTrustScore ?? 50)

  // Sliding window: keep a ring of (timestamp, bytes) samples so the window
  // always covers exactly the last BYTE_BURST_WINDOW_MS milliseconds.
  // This prevents a tumbling-window reset from allowing a full-quota burst
  // immediately after a reset, which would kill legitimate streaming sessions.
  if (!session.byteBurstSamples) session.byteBurstSamples = []
  if (!Number.isInteger(session.byteBurstSampleStart)) session.byteBurstSampleStart = 0
  if (!Number.isFinite(session.byteBurstWindowBytes)) {
    session.byteBurstWindowBytes = 0
    for (let i = session.byteBurstSampleStart; i < session.byteBurstSamples.length; i++) {
      session.byteBurstWindowBytes += session.byteBurstSamples[i].b
    }
  }
  session.byteBurstSamples.push({ t: now, b: byteCount })
  session.byteBurstWindowBytes += byteCount

  // Evict samples older than the window
  const cutoff = now - BYTE_BURST_WINDOW_MS
  while (
    session.byteBurstSampleStart < session.byteBurstSamples.length &&
    session.byteBurstSamples[session.byteBurstSampleStart].t < cutoff
  ) {
    session.byteBurstWindowBytes -= session.byteBurstSamples[session.byteBurstSampleStart].b
    session.byteBurstSampleStart++
  }
  if (session.byteBurstSampleStart > 1024 && session.byteBurstSampleStart * 2 > session.byteBurstSamples.length) {
    session.byteBurstSamples = session.byteBurstSamples.slice(session.byteBurstSampleStart)
    session.byteBurstSampleStart = 0
  }
  session.byteBurstWindowBytes = Math.max(0, session.byteBurstWindowBytes)

  const windowBytes = session.byteBurstWindowBytes

  if (windowBytes <= limits.maxBytesPerMinute) {
    recordAuditBytes(session, byteCount, direction)
    return true
  }

  session.disconnectReason = 'security_bandwidth_burst_limit'
  logSecurityEvent('session_security_ended', session, {
    reason: session.disconnectReason,
    direction,
    windowBytes,
    maxBytesPerMinute: limits.maxBytesPerMinute,
  })
  endRelaySession(session, session.sessionId ?? null, 'security_bandwidth_burst_limit')
  return false
}

async function attemptReconnect(requesterWs, droppedSession) {
  const { country, dbSessionId, reconnectAttempts, providerUserId, requesterUserId, providerId, privateBaseDeviceId } = droppedSession
  const attempt = (reconnectAttempts ?? 0) + 1

  if ((reconnectAttempts ?? 0) >= MAX_RECONNECT_ATTEMPTS) {
    log(requesterWs.peerId.slice(0,8), `RECONNECT giving up after ${MAX_RECONNECT_ATTEMPTS} attempts`)
    reportSessionEnd(
      { ...droppedSession, disconnectReason: droppedSession.disconnectReason ?? 'provider_disconnected' },
      droppedSession.sessionId ?? droppedSession.dbSessionId ?? 'unknown',
    )
    send(requesterWs, { type: 'session_ended', reason: 'no_peers_available' })
    return
  }

  // Exclude only the exact dropped peer connection. Other slots from the same user can still serve.
  const excludePeerIds = providerId ? [providerId] : []
  const preferred = privateBaseDeviceId ? providerUserId : getAffinity(requesterUserId, country)
  // Don't prefer the one that just dropped
  const preferredUserId = privateBaseDeviceId ? providerUserId : (preferred === providerUserId ? null : preferred)

  const nextProvider = await findProvider(country, requesterWs.peerId, requesterUserId, {
    excludePeerIds,
    preferredUserId,
    privateBaseDeviceId: privateBaseDeviceId ?? null,
    privateOnly: !!privateBaseDeviceId,
  })

  if (!nextProvider) {
    droppedSession.status = 'reconnecting'
    droppedSession.reconnectAttempts = attempt
    droppedSession.reconnectReason = 'provider_disconnected'
    syncSessionMetadata(droppedSession, 'reconnect_wait')
    log(requesterWs.peerId.slice(0,8), `RECONNECT no provider available in ${country} attempt=${attempt}/${MAX_RECONNECT_ATTEMPTS}`)
    send(requesterWs, { type: 'session_reconnecting', reason: 'provider_disconnected', attempt, maxAttempts: MAX_RECONNECT_ATTEMPTS })
    // Retry with backoff: 2s, 4s, 8s, 16s, 30s
    const delay = Math.min(2000 * Math.pow(2, reconnectAttempts ?? 0), 30000)
    setTimeout(() => {
      if (requesterWs.readyState !== WebSocket.OPEN || requesterWs.sessionId) return
      attemptReconnect(requesterWs, { ...droppedSession, reconnectAttempts: attempt })
    }, delay)
    return
  }

  log(requesterWs.peerId.slice(0,8), `RECONNECT found new provider=${nextProvider.peerId.slice(0,8)} userId=${nextProvider.userId?.slice(0,8)} attempt=${attempt}`)

  createSession(requesterWs, nextProvider, country, dbSessionId, {
    notificationMode: 'reconnect',
    reconnectAttempt: attempt,
    emitSessionCreated: false,
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/health') {
    const allPeers = [...peers.values()]
    const providers = allPeers.filter(peer => peer.role === 'provider')
    const requesters = allPeers.filter(peer => peer.role === 'requester')
    const countries = {}
    for (const provider of providers) {
      if (!provider.country) continue
      countries[provider.country] = (countries[provider.country] ?? 0) + 1
    }
    const reconnectingSessions = [...sessions.values()].filter(session => session.status === 'reconnecting').length
    const activeSessions = [...sessions.values()].filter(session => session.status === 'active').length
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      peers: peers.size,
      sessions: sessions.size,
      providers: providers.length,
      requesters: requesters.length,
      countries,
      activeSessions,
      reconnectingSessions,
      uptimeSeconds: Math.floor(process.uptime()),
      loadScore: sessions.size * 10 + peers.size,
    }))
    return
  }

  // /providers?country=RW&secret=... — returns live free providers for a country.
  // Used by session/create to verify a relay has a matching provider before
  // sending the requester there. Requires relay secret.
  if (url.pathname === '/provider-kill' && req.method === 'POST') {
    const secret = req.headers['x-relay-secret'] ?? ''
    if (RELAY_SECRET && secret !== RELAY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString() })
    req.on('end', () => {
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch {}
      const providerUserId = typeof body.providerUserId === 'string' ? body.providerUserId : null
      const providerDeviceId = typeof body.providerDeviceId === 'string' ? body.providerDeviceId : null
      const dbSessionId = typeof body.sessionId === 'string' ? body.sessionId : null
      let closed = 0

      for (const [relaySessionId, session] of [...sessions.entries()]) {
        const sessionMatches = !dbSessionId || session.dbSessionId === dbSessionId || relaySessionId === dbSessionId
        const providerMatches = !providerUserId || session.providerUserId === providerUserId
        const deviceMatches = !providerDeviceId || session.providerDeviceId === providerDeviceId || session.providerBaseDeviceId === providerDeviceId
        if (!sessionMatches || !providerMatches || !deviceMatches) continue
        endRelaySession(session, relaySessionId, 'provider_kill_switch')
        closed += 1
      }

      for (const [, peer] of peers) {
        if (peer.role !== 'provider') continue
        if (providerUserId && peer.userId !== providerUserId) continue
        if (providerDeviceId && peer.deviceId !== providerDeviceId && peer.baseDeviceId !== providerDeviceId) continue
        send(peer, { type: 'error', message: 'Sharing stopped by provider kill switch' })
        peer.close(1000, 'provider_kill_switch')
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, closed }))
    })
    return
  }

  if (url.pathname === '/providers') {
    const secret = req.headers['x-relay-secret'] ?? ''
    if (RELAY_SECRET && secret !== RELAY_SECRET) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const country = url.searchParams.get('country')
    const excludeUserId = url.searchParams.get('excludeUserId') ?? null
    const result = []
    for (const [, peer] of peers) {
      if (peer.role !== 'provider') continue
      if (peer.readyState !== WebSocket.OPEN) continue
      if (country && peer.country !== country) continue
      if (excludeUserId && peer.userId === excludeUserId) continue
      result.push({
        userId: peer.userId,
        baseDeviceId: peer.baseDeviceId,
        country: peer.country,
        free: !peer.sessionId,
        trustScore: peer.trustScore,
        privateOnly: peer.privateOnly,
        supportsDirect: peer.supportsDirect === true,
      })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ providers: result }))
    return
  }

  if (url.pathname === '/check-private') {
    const secret = req.headers['x-relay-secret'] ?? ''
    if (RELAY_SECRET && secret !== RELAY_SECRET) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const deviceId = url.searchParams.get('deviceId')
    const baseDeviceId = url.searchParams.get('baseDeviceId')
    const providerUserId = url.searchParams.get('providerUserId')
    if ((!deviceId && !baseDeviceId) || !providerUserId) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'deviceId/baseDeviceId and providerUserId required' }))
      return
    }
    let online = false
    let country = null
    for (const [, peer] of peers) {
      const deviceMatch = deviceId ? peer.deviceId === deviceId : true
      const baseMatch = baseDeviceId ? peer.baseDeviceId === baseDeviceId : true
      if (
        peer.role === 'provider' &&
        peer.userId === providerUserId &&
        deviceMatch &&
        baseMatch &&
        peer.readyState === WebSocket.OPEN
      ) {
        online = true
        country = peer.country
        break
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ online, country }))
    return
  }

  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ noServer: true })
const proxyWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/proxy') {
    proxyWss.handleUpgrade(req, socket, head, (ws) => proxyWss.emit('connection', ws, req))
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
})

// ── Raw HTTP CONNECT — used by PAC proxy mode (no desktop app) ───────────────
// Chrome sends CONNECT hostname:443 directly to the relay when setProxyRelay
// is active. We authenticate via the session ID passed as proxy username,
// then pipe the socket directly to the provider via the existing tunnel mechanism.
server.on('connect', (req, clientSocket, head) => {
  void (async () => {
  const proxyAuth = req.headers['proxy-authorization'] ?? ''
  const sessionId = proxyAuth.startsWith('Basic ')
    ? Buffer.from(proxyAuth.slice(6), 'base64').toString().split(':')[0]
    : null

  const [hostname, portStr] = (req.url ?? '').split(':')
  const port = parseInt(portStr) || 443

  if (!sessionId) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="PeerMesh"\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const session = sessions.get(sessionId)
  if (!session) {
    clientSocket.write('HTTP/1.1 403 Invalid Session\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const provider = peers.get(session.providerId)
  if (!provider || provider.readyState !== WebSocket.OPEN) {
    clientSocket.write('HTTP/1.1 503 Provider Unavailable\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const validation = await validateTarget(hostname, port)
  if (!validation.ok) {
    markBlockedTarget(session, { hostname, port, reason: validation.reason, address: validation.address ?? null })
    clientSocket.write('HTTP/1.1 403 Target Not Allowed\r\n\r\n')
    clientSocket.destroy()
    return
  }
  if (!canOpenTunnel(session)) {
    clientSocket.write('HTTP/1.1 429 Tunnel Rate Limited\r\n\r\n')
    clientSocket.destroy()
    return
  }

  // Record hostname
  if (hostname) {
    recordSessionHost(session, hostname, 'target_host')
  }

  // Open a tunnel via the provider
  const tunnelId = randomUUID()
  proxyClients.set(tunnelId, { sessionId, socket: clientSocket, head, ready: false, providerPaused: false, backpressureTimer: null })

  send(provider, { type: 'open_tunnel', tunnelId, sessionId, hostname, port })
  session.lastActivity = Date.now()

  // If tunnel_ready never arrives (provider net.connect timeout or slow destination)
  // clean up after 35s so proxyClients doesn't leak.
  const tunnelReadyTimer = setTimeout(() => {
    if (proxyClients.has(tunnelId)) {
      const proxyClient = proxyClients.get(tunnelId)
      clearProxyBackpressure(proxyClient)
      proxyClients.delete(tunnelId)
      send(provider, { type: 'tunnel_close', tunnelId })
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 504 Tunnel Timeout\r\n\r\n')
        clientSocket.destroy()
      }
    }
  }, 35_000)

  // tunnel_ready handler will write 200 and start piping
  // Cleanup on client disconnect
  clientSocket.on('error', () => {
    clearTimeout(tunnelReadyTimer)
    const proxyClient = proxyClients.get(tunnelId)
    clearProxyBackpressure(proxyClient)
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
  })
  clientSocket.on('close', () => {
    clearTimeout(tunnelReadyTimer)
    const proxyClient = proxyClients.get(tunnelId)
    clearProxyBackpressure(proxyClient)
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
  })
  })().catch((err) => {
    logErr('PROXY', 'CONNECT handler failed', err)
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 500 PeerMesh Proxy Error\r\n\r\n')
      clientSocket.destroy()
    }
  })
})

proxyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const sessionId = url.searchParams.get('session')
  const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress

  if (!sessionId) { ws.close(1008, 'Missing session'); return }

  const session = sessions.get(sessionId)
  if (!session) { ws.close(1008, 'Invalid session'); return }

  const provider = peers.get(session.providerId)
  if (!provider || provider.readyState !== WebSocket.OPEN) {
    ws.close(1008, 'Provider not available')
    return
  }

  const tunnelId = randomUUID()
  log('PROXY', `WS_OPEN session=${sessionId.slice(0,8)} tunnelId=${tunnelId.slice(0,8)} from ${clientIp}`)
  ws.sessionId = sessionId
  ws.tunnelId = tunnelId
  ws.providerPaused = false
  ws.backpressureTimer = null
  proxyClients.set(tunnelId, ws)

  let tunnelOpen = false

  ws.on('message', async (data) => {
    if (!tunnelOpen) {
      const text = Buffer.isBuffer(data) ? data.toString() : data
      const match = text.match(/^CONNECT ([^\s]+) HTTP/)
      if (match) {
        const [hostname, portStr] = match[1].split(':')
        const port = parseInt(portStr) || 443
        const currentSession = sessions.get(sessionId)
        const validation = await validateTarget(hostname, port)
        if (!validation.ok) {
          markBlockedTarget(currentSession, { hostname, port, reason: validation.reason, address: validation.address ?? null })
          ws.close(1008, 'Target not allowed')
          return
        }
        if (!currentSession || !canOpenTunnel(currentSession)) {
          ws.close(1008, 'Tunnel rate limited')
          return
        }
        tunnelOpen = true
        send(provider, { type: 'open_tunnel', tunnelId, sessionId, hostname, port })
        const sess = sessions.get(sessionId)
        if (sess) recordSessionHost(sess, hostname, 'target_host')
        // Clean up if tunnel_ready never arrives
        const wsReadyTimer = setTimeout(() => {
          if (proxyClients.has(tunnelId)) {
            const proxyClient = proxyClients.get(tunnelId)
            clearProxyBackpressure(proxyClient)
            proxyClients.delete(tunnelId)
            send(provider, { type: 'tunnel_close', tunnelId })
            if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Tunnel timeout')
          }
        }, 35_000)
        ws.once('close', () => clearTimeout(wsReadyTimer))
        return
      }
      return
    }
    if (provider.readyState === WebSocket.OPEN) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const currentSession = sessions.get(sessionId)
      if (!recordSessionBytes(currentSession, chunk.length, 'requester_to_provider')) return
      sendTunnelDataToProvider(provider, tunnelId, chunk)
    }
  })

  ws.on('close', () => {
    clearProxyBackpressure(ws)
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
  })

  ws.on('error', (err) => {
    logErr('PROXY', `tunnelId=${tunnelId.slice(0,8)}`, err)
    clearProxyBackpressure(ws)
    proxyClients.delete(tunnelId)
  })
})

wss.on('connection', (ws, req) => {
  const peerId = randomUUID()
  const clientIp = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress

  const host = req.headers['host'] ?? ''
  const relayUrl = host ? `wss://${host}` : ''

  Object.assign(ws, {
    peerId, role: null, country: null, userId: null,
    trustScore: 50, sessionId: null, providerKind: 'unknown',
    deviceId: null, baseDeviceId: null,
    supportsHttp: true, supportsTunnel: false,
    supportsBinaryTunnel: false,
    supportsDirect: false, directEndpoint: null, directTransport: null, iceEnabled: false,
    directSticky: false,
    privateOnly: false,
    bytesTransferred: 0, isAlive: true,
    relayUrl,
    clientIp: req.headers['fly-client-ip'] || (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || null,
  })

  log(peerId.slice(0,8), `CONNECTED from ${clientIp}`)
  send(ws, { type: 'connected', peerId })

  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', async (data, isBinary) => {
    try {
      ws.bytesTransferred += data.length
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const binaryMsg = (isBinary || buf[0] === RELAY_BINARY_TUNNEL_DATA) ? decodeBinaryTunnelData(buf) : null
      const msg = binaryMsg ?? JSON.parse(buf.toString())
      if (msg.type !== 'ping') log(peerId.slice(0,8), `MSG_IN type=${msg.type}`, msg.userId ? `userId=${msg.userId.slice(0,8)}` : '')
      await handleMessage(ws, msg)
    } catch (e) {
      log(peerId.slice(0,8), `PARSE_ERROR ${e.message}`)
    }
  })

  ws.on('close', (code) => {
    log(peerId.slice(0,8), `DISCONNECTED code=${code} role=${ws.role} userId=${ws.userId?.slice(0,8)}`)
    peers.delete(peerId)
    cleanupSession(ws)
    log(peerId.slice(0,8), `PEERS AFTER DISCONNECT`, peersSnapshot())
  })

  ws.on('error', (err) => log(peerId.slice(0,8), `SOCKET_ERROR ${err.message}`))
})

async function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'register_provider': {
      log(ws.peerId.slice(0,8), `REGISTER_PROVIDER userId=${msg.userId?.slice(0,8)} country=${msg.country} deviceId=${msg.deviceId?.slice(0,8)}`)
      const auth = await verifyPeerAuth({
        token: msg.authToken ?? '',
        userId: msg.userId ?? null,
        role: 'provider',
      })
      if (!auth.ok || !auth.userId) {
        send(ws, { type: 'error', message: auth.error ?? 'Unauthorized provider' })
        ws.close(1008, 'Unauthorized provider')
        return
      }
      ws.deviceId = msg.deviceId ?? null
      ws.baseDeviceId = msg.baseDeviceId ?? msg.deviceId ?? null
      const registeredCountry = normalizeCountryCode(msg.country)
      const detectedCountry = await registerProviderHeartbeatFromRelay({
        userId: auth.userId,
        deviceId: ws.deviceId,
        relayUrl: ws.relayUrl,
        country: registeredCountry,
      })
      for (const [id, peer] of peers) {
        if (peer.userId === auth.userId && peer.role === 'provider' && id !== ws.peerId) {
          // Only evict if same device reconnecting — different devices are allowed
          if (msg.deviceId && peer.deviceId && peer.deviceId !== msg.deviceId) continue
          if (peer.sessionId) {
            const oldSession = sessions.get(peer.sessionId)
            if (oldSession) {
              // Transfer session ownership to the new WS before terminating the old one
              // so cleanupSession on the old peer's close event is a no-op and does not
              // trigger a spurious attemptReconnect that would drop the requester.
              oldSession.providerId = ws.peerId
              ws.sessionId = peer.sessionId
              peer.sessionId = null  // ← prevent cleanupSession from firing on old peer close
            }
          }
          send(peer, { type: 'error', message: 'Replaced by new connection' })
          peer.terminate()
          peers.delete(id)
        }
      }
      ws.role = 'provider'
      ws.country = detectedCountry ?? registeredCountry ?? msg.country
      ws.userId = auth.userId
      ws.trustScore = auth.trustScore ?? 50
      ws.agentMode = msg.agentMode ?? false
      ws.providerKind = msg.providerKind ?? 'unknown'
      ws.supportsHttp = msg.supportsHttp ?? true
      ws.supportsTunnel = msg.supportsTunnel ?? false
      ws.supportsBinaryTunnel = msg.supportsBinaryTunnel === true
      ws.iceEnabled = msg.iceEnabled === true || msg.directTransport === 'webrtc'
      ws.directTransport = ws.iceEnabled ? 'webrtc' : null
      ws.supportsDirect = msg.supportsDirect === true && (ws.iceEnabled || (typeof msg.directEndpoint === 'string' && /^wss?:\/\//i.test(msg.directEndpoint)))
      ws.directEndpoint = ws.supportsDirect && typeof msg.directEndpoint === 'string' && /^wss?:\/\//i.test(msg.directEndpoint) ? msg.directEndpoint : null
      if (ws.supportsDirect && !ws.directTransport) ws.directTransport = 'websocket'
      ws.privateOnly = false
      // Fetch private share status BEFORE adding to pool to avoid race window
      if (ws.userId && (ws.deviceId || ws.baseDeviceId) && API_BASE && RELAY_SECRET) {
        try {
          const data = await getProviderShareStatus(ws.userId, ws.deviceId ?? null, ws.baseDeviceId ?? null)
          if (data?.private_share?.enabled && data.private_share.active) {
            ws.privateOnly = true
            log(ws.peerId.slice(0,8), `PRIVATE_ONLY set for userId=${ws.userId?.slice(0,8)} deviceId=${ws.deviceId?.slice(0,12) ?? ws.baseDeviceId?.slice(0,12)}`)
          }
        } catch {}
      }
      peers.set(ws.peerId, ws)
      send(ws, { type: 'registered', peerId: ws.peerId, binaryTunnel: true })
      log(ws.peerId.slice(0,8), `REGISTERED_PROVIDER country=${ws.country} userId=${ws.userId?.slice(0,8)}`)
      log(ws.peerId.slice(0,8), `PEERS AFTER REGISTER`, peersSnapshot())
      break
    }

    case 'request_session': {
      const auth = await verifyPeerAuth({
        token: msg.authToken ?? '',
        userId: msg.userId ?? null,
        role: 'requester',
        dbSessionId: msg.dbSessionId ?? null,
        country: msg.country ?? null,
        privateProviderUserId: msg.privateProviderUserId ?? null,
        privateBaseDeviceId: msg.privateBaseDeviceId ?? null,
      })
      if (!auth.ok || !auth.userId || !auth.country) {
        send(ws, { type: 'error', message: auth.error ?? 'Unauthorized requester' })
        ws.close(1008, 'Unauthorized requester')
        return
      }

      const requireTunnel = !!msg.requireTunnel
      const resolvedCountry = auth.country
      const privateBaseDeviceId = auth.privateBaseDeviceId ?? null
      const privateProviderUserId = auth.privateProviderUserId ?? null
      const privateOnly = !!privateBaseDeviceId
      ws.trustScore = auth.trustScore ?? 50
      ws.supportsDirect = msg.supportsDirect === true
      ws.deviceId = msg.requesterDeviceId ?? msg.deviceId ?? null
      const limits = sessionLimits(ws.trustScore)
      const activeRequesterSessions = activeSessionCountForRequester(auth.userId)
      if (activeRequesterSessions >= limits.maxConcurrentSessions) {
        logSecurityEvent('requester_concurrency_blocked', { requesterUserId: auth.userId, country: resolvedCountry }, {
          activeRequesterSessions,
          maxConcurrentSessions: limits.maxConcurrentSessions,
          trustScore: ws.trustScore,
        })
        send(ws, { type: 'error', message: 'Too many active PeerMesh sessions for this account.' })
        return
      }
      log(ws.peerId.slice(0,8), `REQUEST_SESSION country=${resolvedCountry} userId=${auth.userId?.slice(0,8)}`)
      log(ws.peerId.slice(0,8), `PEERS AT REQUEST TIME`, peersSnapshot())

      // Seed in-memory affinity from DB value passed by client on connect
      if (!privateOnly && msg.preferredProviderUserId && auth.userId && resolvedCountry) {
        setAffinity(auth.userId, resolvedCountry, msg.preferredProviderUserId)
        log('AFFINITY', `SEEDED from DB requester=${auth.userId.slice(0,8)} → provider=${msg.preferredProviderUserId.slice(0,8)} country=${resolvedCountry}`)
      }

      const preferredUserId = privateOnly
        ? (privateProviderUserId ?? msg.preferredProviderUserId ?? null)
        : getAffinity(auth.userId, resolvedCountry)

      ws.privateBaseDeviceId = privateBaseDeviceId

      const provider = await findProvider(resolvedCountry, ws.peerId, auth.userId, {
        requireTunnel,
        preferredUserId,
        privateBaseDeviceId,
        privateOnly,
      })

      if (!provider) {
        log(ws.peerId.slice(0,8), `NO_PROVIDER_FOUND country=${resolvedCountry}`)
        for (const [, peer] of peers) {
          if (peer.role === 'provider') {
            const reasons = []
            if (peer.country !== resolvedCountry) reasons.push(`wrong_country(${peer.country})`)
            if (peer.sessionId) reasons.push('busy')
            if (peer.readyState !== WebSocket.OPEN) reasons.push(`ws_state=${peer.readyState}`)
            if (peer.trustScore < 30) reasons.push(`low_trust(${peer.trustScore})`)
            if (peer.peerId === ws.peerId) reasons.push('same_peer')
            if (peer.userId === auth.userId) reasons.push('same_user')
            if (privateBaseDeviceId && peer.deviceId !== privateBaseDeviceId && peer.baseDeviceId !== privateBaseDeviceId) reasons.push('wrong_private_device')
            if (!privateBaseDeviceId && peer.privateOnly) reasons.push('private_only_slot')
            if (peer.supportsHttp === false) reasons.push('no_http')
            if (requireTunnel && !peer.supportsTunnel) reasons.push('no_tunnel')
            const shareStatus = await getProviderShareStatus(peer.userId, peer.deviceId ?? null, peer.baseDeviceId ?? null)
            if (!canProviderAcceptShareStatus(shareStatus)) reasons.push(describeProviderShareBlock(shareStatus))
            log(ws.peerId.slice(0,8), `  PROVIDER_REJECTED ${peer.peerId.slice(0,8)} | ${reasons.join(', ')}`)
          }
        }
        send(ws, { type: 'error', message: privateOnly ? 'Private share is offline or busy' : `No peers available in ${resolvedCountry}` })
        return
      }

      ws.role = 'requester'
      ws.userId = auth.userId
      ws.iceEnabled = msg.iceEnabled !== false && msg.supportsDirect === true
      ws.directSticky = msg.directSticky === true
      peers.set(ws.peerId, ws)

      createSession(ws, provider, resolvedCountry, msg.dbSessionId ?? null)
      break
    }

    case 'agent_ready': {
      const agentSession = sessions.get(msg.sessionId)
      if (!agentSession) break
      const requester = peers.get(agentSession.requesterId)
      if (requester) {
        if (agentSession.agentReady) {
          send(requester, {
            type: 'session_reconnected',
            sessionId: msg.sessionId,
            country: agentSession.country,
            relayEndpoint: requester.relayUrl ?? '',
            attempt: 1,
            ...mandateClientPayload(agentSession),
          })
        } else if (agentSession.notificationMode === 'reconnect') {
          send(requester, {
            type: 'session_reconnected',
            sessionId: msg.sessionId,
            country: agentSession.country,
            relayEndpoint: requester.relayUrl ?? '',
            attempt: agentSession.reconnectAttempt ?? 1,
            ...mandateClientPayload(agentSession),
          })
        } else {
          send(requester, { type: 'agent_session_ready', sessionId: msg.sessionId, ...mandateClientPayload(agentSession) })
        }
        log(ws.peerId.slice(0,8), `AGENT_READY session=${msg.sessionId.slice(0,8)} → requester notified`)
      }
      agentSession.agentReady = true
      agentSession.providerUserId = ws.userId
      agentSession.providerKind = ws.providerKind ?? agentSession.providerKind ?? null
      agentSession.providerDeviceId = ws.deviceId ?? agentSession.providerDeviceId ?? null
      agentSession.providerBaseDeviceId = ws.baseDeviceId ?? agentSession.providerBaseDeviceId ?? null
      agentSession.relayEndpoint = requester?.relayUrl ?? agentSession.relayEndpoint ?? null
      agentSession.disconnectReason = null
      syncSessionMetadata(agentSession, 'provider_assign')
      sendSessionQuality(agentSession, 'provider_assign', true)
      break
    }

    case 'ice_offer':
      forwardSessionSignal(ws, msg, 'ice_offer', ['sdp', 'sdpType', 'candidates'])
      break

    case 'ice_answer':
      forwardSessionSignal(ws, msg, 'ice_answer', ['sdp', 'sdpType', 'candidates'])
      break

    case 'ice_candidate':
      forwardSessionSignal(ws, msg, 'ice_candidate', ['candidate'])
      break

    case 'direct_failed': {
      const directSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!isSessionParticipant(directSession, ws)) break
      if (directSession.directState === 'direct' || directSession.directOpenedAt) {
        directSession.lastActivity = Date.now()
        if (directSession.audit) directSession.audit.lastRelaySignalAt = Date.now()
        log('DIRECT', `IGNORED late direct_failed session=${directSession.sessionId.slice(0,8)} reason=${String(msg.reason ?? 'ice_failed').slice(0, 120)}`)
        break
      }
      const directFailReason = String(msg.reason ?? 'ice_failed').slice(0, 120)
      if (directSession.directSticky && !isDirectCapabilityFailureReason(directFailReason)) {
        directSession.directFailedAt = Date.now()
        directSession.directFailReason = directFailReason
        directSession.lastActivity = Date.now()
        if (directSession.audit) directSession.audit.lastRelaySignalAt = Date.now()
        forwardSessionSignal(ws, msg, 'direct_failed', ['reason'])
        sendSessionQuality(directSession, 'direct_sticky_retry', true)
        syncSessionMetadata(directSession, 'direct_sticky_retry')
        log('DIRECT', `STICKY_RETRY session=${directSession.sessionId.slice(0,8)} reason=${directSession.directFailReason} fallback=blocked`)
        break
      }
      directSession.directState = 'relay'
      directSession.directFailedAt = Date.now()
      directSession.directFailReason = directFailReason
      directSession.lastActivity = Date.now()
      if (directSession.audit) directSession.audit.lastRelaySignalAt = Date.now()
      forwardSessionSignal(ws, msg, 'direct_failed', ['reason'])
      sendSessionQuality(directSession, 'direct_failed', true)
      syncSessionMetadata(directSession, 'direct_failed')
      log('DIRECT', `FAILED session=${directSession.sessionId.slice(0,8)} reason=${directSession.directFailReason} fallback=relay`)
      break
    }

    case 'direct_open': {
      const directSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!isSessionParticipant(directSession, ws)) break
      directSession.directState = 'direct'
      directSession.directOpenedAt = Date.now()
      directSession.directFailReason = null
      directSession.directSticky = true
      directSession.lastActivity = Date.now()
      if (directSession.audit) directSession.audit.lastRelaySignalAt = Date.now()
      forwardSessionSignal(ws, msg, 'direct_open', [])
      sendSessionQuality(directSession, 'direct_open', true)
      syncSessionMetadata(directSession, 'direct_open')
      log('DIRECT', `OPEN session=${directSession.sessionId.slice(0,8)} transport=${directSession.directTransport ?? 'unknown'}`)
      break
    }

    case 'direct_tunnel_open': {
      const directSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!directSession || directSession.providerId !== ws.peerId) return
      const hostname = String(msg.hostname ?? '').trim()
      const port = Number.parseInt(msg.port ?? '443', 10) || 443
      directSession.lastActivity = Date.now()
      if (directSession.audit) directSession.audit.lastRelaySignalAt = Date.now()
      const validation = await validateTarget(hostname, port)
      if (!validation.ok) {
        markBlockedTarget(directSession, { hostname, port, reason: validation.reason, address: validation.address ?? null, transport: 'direct' })
        return
      }
      if (!canOpenTunnel(directSession)) return
      recordSessionHost(directSession, hostname, 'direct_target_host')
      break
    }

    case 'direct_bytes': {
      const directSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!directSession || directSession.providerId !== ws.peerId) return
      const byteCount = Math.max(0, Math.min(Number(msg.bytes) || 0, 128 * 1024 * 1024))
      if (byteCount <= 0) return
      directSession.lastActivity = Date.now()
      if (!recordSessionBytes(directSession, byteCount, 'provider_to_requester')) return
      directSession.bytesProvider = (directSession.bytesProvider ?? 0) + byteCount
      directSession.bytesRequester = (directSession.bytesRequester ?? 0) + byteCount
      sendSessionQuality(directSession, 'direct_bytes')
      break
    }

    case 'proxy_request': {
      const proxySession = sessions.get(msg.sessionId)
      if (!proxySession) return
      const provider = peers.get(proxySession.providerId)
      if (!provider || !provider.agentMode) return
      proxySession.lastActivity = Date.now()
      const reqBytes = JSON.stringify(msg.request ?? {}).length
      if (!recordSessionBytes(proxySession, reqBytes, 'proxy_request')) return
      proxySession.bytesRequester = (proxySession.bytesRequester ?? 0) + reqBytes
      if (msg.request?.url) {
        try {
          const targetUrl = new URL(msg.request.url)
          const port = Number.parseInt(targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'), 10)
          const validation = await validateTarget(targetUrl.hostname, port)
          if (!validation.ok) {
            markBlockedTarget(proxySession, { hostname: targetUrl.hostname, port, reason: validation.reason, address: validation.address ?? null })
            send(ws, { type: 'proxy_response', sessionId: msg.sessionId, response: { status: 403, headers: {}, body: '' } })
            return
          }
          if (!canOpenTunnel(proxySession)) return
          recordSessionHost(proxySession, targetUrl.hostname, 'target_host')
        } catch {
          markBlockedTarget(proxySession, { reason: 'invalid_url', url: String(msg.request.url).slice(0, 120) })
          return
        }
      }
      log(ws.peerId.slice(0,8), `PROXY_REQUEST → provider=${provider.peerId.slice(0,8)} url=${msg.request?.url?.slice(0,60)}`)
      send(provider, { type: 'proxy_request', sessionId: msg.sessionId, request: msg.request })
      break
    }

    case 'proxy_response': {
      const respSession = sessions.get(msg.sessionId)
      if (!respSession) return
      const requester = peers.get(respSession.requesterId)
      if (!requester) return
      const respBytes = msg.response?.body?.length ?? 0
      if (!recordSessionBytes(respSession, respBytes, 'proxy_response')) return
      respSession.bytesRequester = (respSession.bytesRequester ?? 0) + respBytes
      respSession.bytesProvider = (respSession.bytesProvider ?? 0) + respBytes
      send(requester, { type: 'proxy_response', sessionId: msg.sessionId, response: msg.response })
      sendSessionQuality(respSession, 'proxy_response')
      break
    }

    case 'tunnel_ready': {
      const proxyClient = proxyClients.get(msg.tunnelId)
      if (!proxyClient) break
      if (proxyClient.readyState !== undefined) {
        // WS-based client (desktop proxy path)
        if (proxyClient.readyState === WebSocket.OPEN) {
          proxyClient.send('HTTP/1.1 200 Connection Established\r\n\r\n')
        }
      } else if (proxyClient.socket && !proxyClient.socket.destroyed) {
        // Raw socket client (PAC proxy path)
        proxyClient.socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (proxyClient.head?.length) proxyClient.socket.write(proxyClient.head)
        proxyClient.ready = true
      }
      break
    }

    case 'tunnel_data': {
      const proxyClient = proxyClients.get(msg.tunnelId)
      if (!proxyClient) return
      const chunk = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data || '', 'base64')
      const tunnelSessionId = proxyClient.sessionId ?? ws.sessionId ?? msg.sessionId ?? null
      const tunnelSession = tunnelSessionId ? sessions.get(tunnelSessionId) : null
      if (!recordSessionBytes(tunnelSession, chunk.length, 'provider_to_requester')) return
      if (tunnelSession) {
        tunnelSession.lastActivity = Date.now()
        tunnelSession.bytesProvider = (tunnelSession.bytesProvider ?? 0) + chunk.length
        tunnelSession.bytesRequester = (tunnelSession.bytesRequester ?? 0) + chunk.length
        // Only compute and send quality metrics every 3s — avoid running buildSessionQuality
        // on every chunk for high-throughput streams (thousands of chunks/minute).
        const now = Date.now()
        if (now - (tunnelSession.lastQualitySentAt || 0) >= 3000) {
          sendSessionQuality(tunnelSession, 'tunnel_data')
        }
      }
      if (proxyClient.readyState !== undefined) {
        // WS-based client
        if (proxyClient.readyState === WebSocket.OPEN) {
          proxyClient.send(chunk)
          applyProxyClientBackpressure(ws, msg.tunnelId, proxyClient)
        }
      } else if (proxyClient.socket && !proxyClient.socket.destroyed && proxyClient.ready) {
        // Raw socket client
        const flushed = proxyClient.socket.write(chunk)
        if (!flushed) {
          pauseProviderForProxyBackpressure(ws, msg.tunnelId, proxyClient, 'requester_socket_backpressure')
          proxyClient.socket.once('drain', () => resumeProviderAfterProxyBackpressure(ws, msg.tunnelId, proxyClient))
        } else {
          applyProxyClientBackpressure(ws, msg.tunnelId, proxyClient)
        }
      }
      break
    }

    case 'tunnel_close': {
      const proxyClient = proxyClients.get(msg.tunnelId)
      if (proxyClient) {
        closeProxyClient(proxyClient)
        proxyClients.delete(msg.tunnelId)
      }
      break
    }

    case 'relay_keepalive': {
      const keepaliveSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (keepaliveSession?.audit) keepaliveSession.audit.lastRelaySignalAt = Date.now()
      send(ws, { type: 'relay_keepalive_ack', sessionId: msg.sessionId ?? ws.sessionId ?? null, at: Date.now() })
      break
    }

    case 'byte_token_return': {
      const tokenSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!tokenSession?.audit) break
      const tokenIndex = Math.max(1, Number.parseInt(msg.tokenIndex ?? '0', 10) || 0)
      const tokenValue = String(msg.tokenValue ?? msg.token ?? '')
      const expected = tokenIndex > 0
        ? createByteToken(tokenSession.audit.tokenSecret, tokenSession.sessionId, tokenIndex)
        : null
      if (!expected || expected !== tokenValue) {
        logSecurityEvent('byte_token_invalid', tokenSession, { tokenIndex, role: ws.role })
        break
      }
      const receivedAt = new Date().toISOString()
      tokenSession.audit.tokenFloorBytes = Math.max(tokenSession.audit.tokenFloorBytes, tokenIndex * BYTE_TOKEN_GRANULARITY)
      tokenSession.audit.tokenLog.push({ tokenIndex, tokenValue, receivedAt, source: 'direct_return' })
      reportAuditEvent('byte_token', {
        sessionId: tokenSession.dbSessionId,
        tokenIndex,
        tokenValue,
        receivedAt,
      })
      const provider = peers.get(tokenSession.providerId)
      if (provider) send(provider, { type: 'next_byte_token', sessionId: tokenSession.sessionId, ...nextByteToken(tokenSession.audit, tokenSession.sessionId, tokenIndex + 1) })
      break
    }

    case 'audit_commit': {
      const commitSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!commitSession?.audit) break
      const periodNonce = String(msg.periodNonce ?? '')
      const commitment = String(msg.commitment ?? '')
      if (!periodNonce || !commitment) break
      const key = `${periodNonce}:${ws.peerId}`
      commitSession.audit.commitments.set(key, {
        deviceId: ws.deviceId ?? ws.userId ?? ws.peerId,
        role: ws.role,
        periodNonce,
        commitment,
        committedAt: new Date().toISOString(),
      })
      reportAuditEvent('commitment', {
        sessionId: commitSession.dbSessionId,
        deviceId: ws.deviceId ?? ws.userId ?? ws.peerId,
        periodNonce,
        commitment,
        committedAt: new Date().toISOString(),
      })
      break
    }

    case 'audit_reveal': {
      const revealSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!revealSession?.audit) break
      const periodNonce = String(msg.periodNonce ?? '')
      const chainValue = String(msg.chainValue ?? '')
      const key = `${periodNonce}:${ws.peerId}`
      const record = revealSession.audit.commitments.get(key)
      if (!record || !chainValue) {
        logSecurityEvent('commitment_timeout', revealSession, { role: ws.role, periodNonce })
        break
      }
      const valid = verifyCommitmentReveal(record.commitment, chainValue, periodNonce, revealSession.audit.sessionSigningKey)
      record.revealedChain = chainValue
      record.revealedAt = new Date().toISOString()
      record.commitmentValid = valid
      if (!valid) logSecurityEvent('commitment_mismatch', revealSession, { role: ws.role, periodNonce })
      reportAuditEvent('commitment', {
        sessionId: revealSession.dbSessionId,
        deviceId: record.deviceId,
        periodNonce,
        commitment: record.commitment,
        committedAt: record.committedAt,
        revealedChain: chainValue,
        revealedAt: record.revealedAt,
        commitmentValid: valid,
      })
      break
    }

    case 'provider_receipt': {
      const receiptSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!receiptSession?.audit) break
      receiptSession.audit.receipts.set(`provider:${msg.nonce ?? Date.now()}`, msg.receipt ?? msg)
      reportAuditEvent('receipt', {
        sessionId: receiptSession.dbSessionId,
        role: 'provider',
        deviceId: ws.deviceId ?? receiptSession.providerDeviceId,
        periodStart: msg.periodStart,
        periodEnd: msg.periodEnd,
        bytesReported: msg.bytesForwarded ?? msg.bytesReported ?? 0,
        chainValue: msg.chainValue,
        tokensCount: msg.tokensIssued ?? msg.tokensCount ?? 0,
        nonce: msg.nonce ?? randomUUID(),
        deviceSig: msg.device_sig ?? msg.deviceSig ?? '',
        sessionSig: msg.session_sig ?? msg.sessionSig ?? '',
        verified: false,
      })
      break
    }

    case 'requester_wrapped_receipt': {
      const wrappedSession = sessions.get(msg.sessionId ?? ws.sessionId)
      if (!wrappedSession?.audit) break
      wrappedSession.audit.receipts.set(`requester:${msg.nonce ?? Date.now()}`, msg.receipt ?? msg)
      reportAuditEvent('receipt', {
        sessionId: wrappedSession.dbSessionId,
        role: 'requester',
        deviceId: ws.deviceId ?? wrappedSession.requesterUserId,
        periodStart: msg.periodStart,
        periodEnd: msg.periodEnd,
        bytesReported: msg.bytesReceived ?? msg.bytesReported ?? 0,
        chainValue: msg.chainValue,
        tokensCount: msg.tokensReceived ?? msg.tokensCount ?? 0,
        nonce: msg.nonce ?? randomUUID(),
        deviceSig: msg.device_sig ?? msg.deviceSig ?? '',
        sessionSig: msg.session_sig ?? msg.sessionSig ?? '',
        transitIntact: msg.transitIntact === true,
        verified: false,
      })
      break
    }

    case 'security_event': {
      const securitySession = sessions.get(msg.sessionId ?? ws.sessionId)
      logSecurityEvent(String(msg.eventType ?? 'client_security_event'), securitySession, {
        hostname: msg.hostname ?? null,
        port: msg.port ?? null,
        role: ws.role,
      })
      break
    }

    case 'end_session':
      cleanupSession(ws)
      break

    case 'ping':
      ws.isAlive = true
      break

    default:
      log(ws.peerId.slice(0,8), `UNKNOWN_MSG type=${msg.type}`)
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
}

function getTunnelIdBytes(tunnelId) {
  return Buffer.from(String(tunnelId || '').replace(/-/g, '').padEnd(32, '0').slice(0, 32), 'ascii')
}

function encodeBinaryTunnelData(tunnelId, chunk, idBytes = null) {
  const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const tunnelIdBytes = idBytes || getTunnelIdBytes(tunnelId)
  const frame = Buffer.allocUnsafe(1 + 32 + payload.length)
  frame[0] = RELAY_BINARY_TUNNEL_DATA
  tunnelIdBytes.copy(frame, 1)
  payload.copy(frame, 33)
  return frame
}

function decodeBinaryTunnelData(buf) {
  if (!buf || buf.length <= 33 || buf[0] !== RELAY_BINARY_TUNNEL_DATA) return null
  const idHex = buf.slice(1, 33).toString('ascii')
  return {
    type: 'tunnel_data',
    tunnelId: `${idHex.slice(0,8)}-${idHex.slice(8,12)}-${idHex.slice(12,16)}-${idHex.slice(16,20)}-${idHex.slice(20)}`,
    data: buf.slice(33),
    binary: true,
  }
}

function sendTunnelDataToProvider(provider, tunnelId, chunk) {
  if (!provider || provider.readyState !== WebSocket.OPEN) return false
  if (provider.supportsBinaryTunnel) {
    provider.send(encodeBinaryTunnelData(tunnelId, chunk), { binary: true })
  } else {
    send(provider, { type: 'tunnel_data', tunnelId, data: chunk.toString('base64') })
  }
  return true
}

function clearProxyBackpressure(proxyClient) {
  if (proxyClient?.backpressureTimer) {
    clearInterval(proxyClient.backpressureTimer)
    proxyClient.backpressureTimer = null
  }
  if (proxyClient) proxyClient.providerPaused = false
}

function pauseProviderForProxyBackpressure(provider, tunnelId, proxyClient, reason = 'proxy_backpressure') {
  if (!provider || provider.readyState !== WebSocket.OPEN || !proxyClient || proxyClient.providerPaused) return
  proxyClient.providerPaused = true
  send(provider, { type: 'tunnel_pause', tunnelId, reason })
}

function resumeProviderAfterProxyBackpressure(provider, tunnelId, proxyClient) {
  if (!proxyClient?.providerPaused) return
  clearProxyBackpressure(proxyClient)
  if (provider?.readyState === WebSocket.OPEN) send(provider, { type: 'tunnel_resume', tunnelId })
}

function applyProxyClientBackpressure(provider, tunnelId, proxyClient) {
  if (!proxyClient || proxyClient.backpressureTimer) return

  if (proxyClient.readyState !== undefined) {
    if (proxyClient.bufferedAmount <= RELAY_PROXY_BUFFER_HIGH_BYTES) return
    pauseProviderForProxyBackpressure(provider, tunnelId, proxyClient, 'requester_ws_backpressure')
    proxyClient.backpressureTimer = setInterval(() => {
      if (proxyClient.readyState !== WebSocket.OPEN || proxyClient.bufferedAmount <= RELAY_PROXY_BUFFER_LOW_BYTES) {
        resumeProviderAfterProxyBackpressure(provider, tunnelId, proxyClient)
      }
    }, RELAY_PROXY_BUFFER_CHECK_MS)
    return
  }

  if (proxyClient.socket && proxyClient.socket.writableLength > RELAY_PROXY_BUFFER_HIGH_BYTES) {
    pauseProviderForProxyBackpressure(provider, tunnelId, proxyClient, 'requester_socket_backpressure')
    proxyClient.backpressureTimer = setInterval(() => {
      if (proxyClient.socket.destroyed || proxyClient.socket.writableLength <= RELAY_PROXY_BUFFER_LOW_BYTES) {
        resumeProviderAfterProxyBackpressure(provider, tunnelId, proxyClient)
      }
    }, RELAY_PROXY_BUFFER_CHECK_MS)
  }
}

function isSessionParticipant(session, ws) {
  return !!session && !!ws && (session.requesterId === ws.peerId || session.providerId === ws.peerId)
}

function getOtherSessionSocket(session, ws) {
  if (!isSessionParticipant(session, ws)) return null
  const otherPeerId = session.requesterId === ws.peerId ? session.providerId : session.requesterId
  const other = peers.get(otherPeerId)
  return other?.readyState === WebSocket.OPEN ? other : null
}

function pickForwardFields(msg, keys) {
  const payload = {}
  for (const key of keys) {
    if (msg[key] !== undefined) payload[key] = msg[key]
  }
  return payload
}

function forwardSessionSignal(ws, msg, type, keys = []) {
  const session = sessions.get(msg.sessionId ?? ws.sessionId)
  if (!isSessionParticipant(session, ws)) return false
  const other = getOtherSessionSocket(session, ws)
  if (!other) return false
  if (session.audit) session.audit.lastRelaySignalAt = Date.now()
  session.lastActivity = Date.now()
  send(other, {
    type,
    sessionId: session.sessionId,
    fromRole: ws.role ?? null,
    ...pickForwardFields(msg, keys),
  })
  return true
}

function pickBestHost(targetHost, targetHosts) {
  // CDN/tracking patterns that are not meaningful as the primary site
  const CDN = /googlevideo\.com|ytimg\.com|gstatic\.com|googleapis\.com|doubleclick\.net|google-analytics\.com|googletagmanager\.com|cloudfront\.net|akamaized\.net|fastly\.net|cdn\.|static\.|assets\./i
  const all = targetHosts ? [...targetHosts] : []
  if (targetHost && !all.includes(targetHost)) all.unshift(targetHost)
  if (all.length === 0) return null
  // Prefer first non-CDN host
  const primary = all.find(h => !CDN.test(h))
  return primary ?? all[0]
}

function closeProxyClient(proxyClient) {
  if (!proxyClient) return
  clearProxyBackpressure(proxyClient)
  if (typeof proxyClient.close === 'function') {
    proxyClient.close()
  } else if (proxyClient.socket && !proxyClient.socket.destroyed) {
    proxyClient.socket.destroy()
  }
}

function reportSessionEnd(session, sessionId) {
  const bytesUsed = session.bytesRequester ?? 0
  const dbSessionId = session.dbSessionId ?? null
  if (!API_BASE || !dbSessionId) return

  const providerKind = session.providerKind ?? null
  const targetHost = pickBestHost(session.targetHost, session.targetHosts)
  const targetHosts = session.targetHosts ? [...session.targetHosts] : []

  fetch(`${API_BASE}/api/session/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
    body: JSON.stringify({
      sessionId:       dbSessionId,
      bytesUsed,
      providerUserId:  session.providerUserId ?? null,
      requesterUserId: session.requesterUserId ?? null,
      country:         session.country,
      targetHost,
      targetHosts,
      providerKind,
      providerDeviceId: session.providerDeviceId ?? null,
      providerBaseDeviceId: session.providerBaseDeviceId ?? null,
      relayEndpoint:   session.relayEndpoint ?? null,
      disconnectReason: session.disconnectReason ?? null,
      providerAvgMbps: session.providerAvgMbps ?? null,
      providerLastMbps: session.providerLastMbps ?? null,
      connectionQuality: {
        ...(session.connectionQuality && typeof session.connectionQuality === 'object' ? session.connectionQuality : {}),
        mandateArchitecture: true,
        transportTier: session.transportTier ?? 0,
        directState: session.directState ?? 'relay',
        directOpenedAt: session.directOpenedAt ? new Date(session.directOpenedAt).toISOString() : null,
        directFailReason: session.directFailReason ?? null,
        tokenFloorBytes: session.audit?.tokenFloorBytes ?? 0,
        auditBytesForwarded: session.audit?.bytesForwarded ?? 0,
      },
    }),
  })
    .then(async (r) => {
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        log('RELAY', `SESSION_END_REPORT relaySession=${sessionId.slice(0,8)} dbSession=${dbSessionId.slice(0,8)} status=${r.status} bytes=${bytesUsed} body=${body.slice(0,120)}`)
        return
      }
      log('RELAY', `SESSION_END_REPORT relaySession=${sessionId.slice(0,8)} dbSession=${dbSessionId.slice(0,8)} status=${r.status} bytes=${bytesUsed} provider=${session.providerUserId?.slice(0,8) ?? 'none'} host=${session.targetHost ?? 'none'}`)
    })
    .catch(err => logErr('RELAY', 'SESSION_END_REPORT failed', err))
}

function endRelaySession(session, sessionId, reason = 'session_ended') {
  const relaySessionId = sessionId ?? session?.sessionId
  if (!session || !relaySessionId) return
  session.disconnectReason = reason
  reportSessionEnd(session, relaySessionId)

  const requester = peers.get(session.requesterId)
  const provider = peers.get(session.providerId)

  for (const [tunnelId, proxyClient] of proxyClients) {
    if (proxyClient.sessionId !== relaySessionId) continue
    closeProxyClient(proxyClient)
    proxyClients.delete(tunnelId)
    if (provider) send(provider, { type: 'tunnel_close', tunnelId })
  }

  if (requester) {
    requester.sessionId = null
    send(requester, { type: 'session_ended', reason })
  }
  if (provider) {
    provider.sessionId = null
    send(provider, { type: 'session_ended', reason })
  }
  sessions.delete(relaySessionId)
}

function cleanupSession(ws) {
  if (!ws.sessionId) return
  const sessionId = ws.sessionId
  const session = sessions.get(sessionId)
  ws.sessionId = null

  if (!session) return

  const otherId = ws.role === 'provider' ? session.requesterId : session.providerId
  const other = peers.get(otherId)

  // Close every proxy tunnel attached to this session. proxyClients is keyed by
  // tunnelId, not sessionId, so scan the active tunnels and close matching ones.
  for (const [tunnelId, proxyClient] of proxyClients) {
    if (proxyClient.sessionId !== sessionId) continue
    closeProxyClient(proxyClient)
    proxyClients.delete(tunnelId)
  }

  // Save affinity — remember which provider this requester used
  if (session.requesterUserId && session.providerUserId && session.country) {
    setAffinity(session.requesterUserId, session.country, session.providerUserId)
    log('AFFINITY', `SAVED requester=${session.requesterUserId.slice(0,8)} → provider=${session.providerUserId.slice(0,8)} country=${session.country}`)
  }

  if (!session.disconnectReason) {
    session.disconnectReason = ws.role === 'provider' ? 'provider_disconnected' : 'peer_disconnected'
  }

  if (!other) {
    reportSessionEnd(session, sessionId)
    sessions.delete(sessionId)
    log(ws.peerId.slice(0,8), `SESSION_CLEANED id=${sessionId.slice(0,8)} bytes=${session.bytesRequester ?? 0}`)
    return
  }
  other.sessionId = null

  // Auto-reconnect — only when provider dropped and requester is still connected
  if (ws.role === 'provider' && other.readyState === WebSocket.OPEN) {
    log(other.peerId.slice(0,8), `PROVIDER_DROPPED — attempting auto-reconnect country=${session.country}`)
    sessions.delete(sessionId)
    session.status = 'reconnecting'
    session.reconnectAttempts = 1
    session.reconnectReason = 'provider_disconnected'
    syncSessionMetadata(session, 'provider_dropped')
    log(ws.peerId.slice(0,8), `SESSION_RECONNECT_PENDING id=${sessionId.slice(0,8)} bytes=${session.bytesRequester ?? 0}`)
    send(other, { type: 'session_reconnecting', reason: 'provider_disconnected', attempt: 1, maxAttempts: MAX_RECONNECT_ATTEMPTS })
    attemptReconnect(other, { ...session, sessionId, reconnectAttempts: 0 })
    return
  } else {
    reportSessionEnd(session, sessionId)
    sessions.delete(sessionId)
    log(ws.peerId.slice(0,8), `SESSION_CLEANED id=${sessionId.slice(0,8)} bytes=${session.bytesRequester ?? 0}`)
    send(other, { type: 'session_ended', reason: 'peer_disconnected' })
  }
}

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return }
    ws.isAlive = false
    ws.ping()
  })
}, 30_000)

// ── Session idle watchdog ─────────────────────────────────────────────────────
// If a session has had no activity for 90s, check the provider is still alive.
// If the provider WS is gone or unresponsive, trigger auto-reconnect immediately
// rather than waiting up to 60s for the heartbeat to catch it.
const SESSION_IDLE_MS = 90_000
const sessionWatchdog = setInterval(() => {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    touchSessionActivity(session, 'watchdog')
    if (now - session.lastActivity < SESSION_IDLE_MS) continue
    const provider = peers.get(session.providerId)
    const requester = peers.get(session.requesterId)
    if (!requester || requester.readyState !== WebSocket.OPEN) continue
    if (!provider || provider.readyState !== WebSocket.OPEN) {
      log(requester.peerId.slice(0,8), `SESSION_WATCHDOG provider gone sessionId=${sessionId.slice(0,8)}`)
      requester.sessionId = null
      sessions.delete(sessionId)
      session.status = 'reconnecting'
      session.disconnectReason = 'provider_disconnected'
      session.reconnectAttempts = 1
      session.reconnectReason = 'provider_disconnected'
      syncSessionMetadata(session, 'watchdog_reconnect')
      send(requester, { type: 'session_reconnecting', reason: 'provider_disconnected', attempt: 1, maxAttempts: MAX_RECONNECT_ATTEMPTS })
      attemptReconnect(requester, { ...session, sessionId, reconnectAttempts: 0 })
    }
  }
}, 30_000)

let schedulerTickTimer = null
let schedulerTickInFlight = false

async function runSchedulerTick(reason = 'relay') {
  if (!API_BASE || !SCHEDULER_SECRET || schedulerTickInFlight) return
  schedulerTickInFlight = true
  try {
    // Clean up stale DB sessions on every tick so stuck pending/reconnecting
    // sessions don't accumulate and block requesters from creating new ones.
    if (API_BASE && RELAY_SECRET) {
      fetch(`${API_BASE}/api/session/cleanup`, {
        method: 'POST',
        headers: { 'x-relay-secret': RELAY_SECRET },
      }).catch(() => {})
    }
    const res = await fetch(`${API_BASE}/api/scheduler/tick?source=relay`, {
      method: 'POST',
      headers: {
        'x-scheduler-secret': SCHEDULER_SECRET,
        'x-relay-secret': RELAY_SECRET,
      },
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `status=${res.status}`)
    if ((data.created ?? 0) > 0 || (data.failed ?? 0) > 0) {
      log('SCHEDULER', `tick reason=${reason} scanned=${data.scanned ?? 0} created=${data.created ?? 0} failed=${data.failed ?? 0}`)
    }
  } catch (err) {
    logErr('SCHEDULER', `tick failed reason=${reason}`, err)
  } finally {
    schedulerTickInFlight = false
  }
}

function startSchedulerTickLoop() {
  if (!API_BASE || !SCHEDULER_SECRET || SCHEDULER_TICK_INTERVAL_MS <= 0) return
  const tick = async (reason = 'timer') => {
    await runSchedulerTick(reason)
    schedulerTickTimer = setTimeout(() => tick('timer'), SCHEDULER_TICK_INTERVAL_MS)
  }
  schedulerTickTimer = setTimeout(() => tick('startup'), 5000)
  log('SCHEDULER', `enabled intervalMs=${SCHEDULER_TICK_INTERVAL_MS}`)
}

wss.on('close', () => {
  clearInterval(heartbeat)
  clearInterval(sessionWatchdog)
  if (schedulerTickTimer) clearTimeout(schedulerTickTimer)
})

server.listen(PORT, () => {
  log('RELAY', `PeerMesh relay on port ${PORT}`)
  startSchedulerTickLoop()
})
