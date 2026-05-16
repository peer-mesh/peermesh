import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { randomUUID } from 'crypto'

const PORT        = parseInt(process.env.PORT ?? '8080')
const API_BASE    = process.env.API_BASE ?? ''
const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

const peers = new Map()
const sessions = new Map()
const proxyClients = new Map()


// peerAffinity: requesterUserId → Map(country → providerUserId)
// In-memory cache — seeded from DB via request_session msg, updated on session end.
// Survives within a relay process lifetime. DB is the persistent source of truth.
const peerAffinity = new Map()
const providerShareStatusCache = new Map()

const MAX_RECONNECT_ATTEMPTS = 5

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
    return { can_accept_sessions: false, total_bytes_today: 0, daily_limit_bytes: null }
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
    return { can_accept_sessions: false, total_bytes_today: 0, daily_limit_bytes: null }
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
        if (!status.can_accept_sessions) {
          log('LIMIT', `SKIP preferred provider userId=${preferredUserId.slice(0,8)} daily limit reached`)
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
    if (status.can_accept_sessions) return peer
    log('LIMIT', `SKIP provider peerId=${peer.peerId.slice(0,8)} userId=${peer.userId?.slice(0,8)} daily limit reached`)
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
    dbSessionId: dbSessionId ?? null,
    relayEndpoint: requesterWs.relayUrl ?? null,
    targetHost: null,
    targetHosts: new Set(),   // all hostnames seen — primary is first non-CDN or just first
    agentReady: false,
    notificationMode,
    reconnectAttempt,
    reconnectAttempts: 0,
    privateBaseDeviceId: requesterWs.privateBaseDeviceId ?? null,
    lastActivity: Date.now(),
  })

  send(provider, { type: 'session_request', sessionId })
  if (emitSessionCreated) {
    send(requesterWs, { type: 'session_created', sessionId })
  }
  log(requesterWs.peerId.slice(0,8), `SESSION_CREATED id=${sessionId.slice(0,8)} provider=${provider.peerId.slice(0,8)} country=${country}`)
  syncSessionMetadata(sessions.get(sessionId), 'relay_assign')

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
    attemptReconnect(requesterWs, { ...session, providerId: provider.peerId, reconnectAttempts: 0 })
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

function recordSessionHost(session, hostname, reason = 'target_host') {
  if (!session || !hostname) return
  const normalizedHost = String(hostname).trim().toLowerCase()
  if (!normalizedHost) return

  if (!session.targetHosts) session.targetHosts = new Set()
  const hadHost = session.targetHosts.has(normalizedHost)
  const previousBest = pickBestHost(session.targetHost, session.targetHosts)
  session.targetHosts.add(normalizedHost)
  const nextBest = pickBestHost(previousBest, session.targetHosts)

  if (nextBest !== session.targetHost) {
    session.targetHost = nextBest
    syncSessionMetadata(session, reason)
    return
  }

  if (hadHost) return
  syncSessionMetadata(session, reason)
}

// ── Auto-reconnect — called when provider drops while requester is still live ─

async function attemptReconnect(requesterWs, droppedSession) {
  const { country, dbSessionId, reconnectAttempts, providerUserId, requesterUserId, providerId, privateBaseDeviceId } = droppedSession

  if ((reconnectAttempts ?? 0) >= MAX_RECONNECT_ATTEMPTS) {
    log(requesterWs.peerId.slice(0,8), `RECONNECT giving up after ${MAX_RECONNECT_ATTEMPTS} attempts`)
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
    log(requesterWs.peerId.slice(0,8), `RECONNECT no provider available in ${country} attempt=${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`)
    // Retry with backoff: 2s, 4s, 8s, 16s, 30s
    const delay = Math.min(2000 * Math.pow(2, reconnectAttempts ?? 0), 30000)
    setTimeout(() => {
      if (requesterWs.readyState !== WebSocket.OPEN || requesterWs.sessionId) return
      attemptReconnect(requesterWs, { ...droppedSession, reconnectAttempts: (reconnectAttempts ?? 0) + 1 })
    }, delay)
    return
  }

  log(requesterWs.peerId.slice(0,8), `RECONNECT found new provider=${nextProvider.peerId.slice(0,8)} userId=${nextProvider.userId?.slice(0,8)} attempt=${(reconnectAttempts ?? 0) + 1}`)

  createSession(requesterWs, nextProvider, country, dbSessionId, {
    notificationMode: 'reconnect',
    reconnectAttempt: (reconnectAttempts ?? 0) + 1,
    emitSessionCreated: false,
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', peers: peers.size, sessions: sessions.size }))
    return
  }

  // /providers?country=RW&secret=... — returns live free providers for a country.
  // Used by session/create to verify a relay has a matching provider before
  // sending the requester there. Requires relay secret.
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

  // Record hostname
  if (hostname) {
    recordSessionHost(session, hostname, 'target_host')
  }

  // Open a tunnel via the provider
  const tunnelId = randomUUID()
  proxyClients.set(tunnelId, { sessionId, socket: clientSocket, head, ready: false })

  send(provider, { type: 'open_tunnel', tunnelId, sessionId, hostname, port })
  session.lastActivity = Date.now()

  // If tunnel_ready never arrives (provider net.connect timeout or slow destination)
  // clean up after 35s so proxyClients doesn't leak.
  const tunnelReadyTimer = setTimeout(() => {
    if (proxyClients.has(tunnelId)) {
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
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
  })
  clientSocket.on('close', () => {
    clearTimeout(tunnelReadyTimer)
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
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
  proxyClients.set(tunnelId, ws)

  let tunnelOpen = false

  ws.on('message', (data) => {
    if (!tunnelOpen) {
      const text = Buffer.isBuffer(data) ? data.toString() : data
      const match = text.match(/^CONNECT ([^\s]+) HTTP/)
      if (match) {
        const [hostname, portStr] = match[1].split(':')
        const port = parseInt(portStr) || 443
        tunnelOpen = true
        send(provider, { type: 'open_tunnel', tunnelId, sessionId, hostname, port })
        const sess = sessions.get(sessionId)
        if (sess) recordSessionHost(sess, hostname, 'target_host')
        // Clean up if tunnel_ready never arrives
        const wsReadyTimer = setTimeout(() => {
          if (proxyClients.has(tunnelId)) {
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
      const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64')
      send(provider, { type: 'tunnel_data', tunnelId, data: b64 })
    }
  })

  ws.on('close', () => {
    proxyClients.delete(tunnelId)
    send(provider, { type: 'tunnel_close', tunnelId })
  })

  ws.on('error', (err) => {
    logErr('PROXY', `tunnelId=${tunnelId.slice(0,8)}`, err)
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
    baseDeviceId: null,
    supportsHttp: true, supportsTunnel: false,
    privateOnly: false,
    bytesTransferred: 0, isAlive: true,
    relayUrl,
    clientIp: req.headers['fly-client-ip'] || (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || null,
  })

  log(peerId.slice(0,8), `CONNECTED from ${clientIp}`)
  send(ws, { type: 'connected', peerId })

  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', async (data) => {
    try {
      ws.bytesTransferred += data.length
      if (ws.bytesTransferred > 1_073_741_824) {
        send(ws, { type: 'error', message: 'Byte limit reached' })
        ws.terminate()
        return
      }
      const msg = JSON.parse(data.toString())
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
      ws.country = msg.country
      ws.userId = auth.userId
      ws.trustScore = auth.trustScore ?? 50
      ws.agentMode = msg.agentMode ?? false
      ws.providerKind = msg.providerKind ?? 'unknown'
      ws.supportsHttp = msg.supportsHttp ?? true
      ws.supportsTunnel = msg.supportsTunnel ?? false
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
      send(ws, { type: 'registered', peerId: ws.peerId })
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
            if (privateBaseDeviceId && peer.baseDeviceId !== privateBaseDeviceId) reasons.push('wrong_private_device')
            if (!privateBaseDeviceId && peer.privateOnly) reasons.push('private_only_slot')
            if (peer.supportsHttp === false) reasons.push('no_http')
            if (requireTunnel && !peer.supportsTunnel) reasons.push('no_tunnel')
            const shareStatus = await getProviderShareStatus(peer.userId, peer.deviceId ?? null, peer.baseDeviceId ?? null)
            if (!shareStatus.can_accept_sessions) reasons.push('daily_limit_reached')
            log(ws.peerId.slice(0,8), `  PROVIDER_REJECTED ${peer.peerId.slice(0,8)} | ${reasons.join(', ')}`)
          }
        }
        send(ws, { type: 'error', message: privateOnly ? 'Private share is offline or busy' : `No peers available in ${resolvedCountry}` })
        return
      }

      ws.role = 'requester'
      ws.userId = auth.userId
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
          })
        } else if (agentSession.notificationMode === 'reconnect') {
          send(requester, {
            type: 'session_reconnected',
            sessionId: msg.sessionId,
            country: agentSession.country,
            relayEndpoint: requester.relayUrl ?? '',
            attempt: agentSession.reconnectAttempt ?? 1,
          })
        } else {
          send(requester, { type: 'agent_session_ready', sessionId: msg.sessionId })
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
      break
    }

    case 'proxy_request': {
      const proxySession = sessions.get(msg.sessionId)
      if (!proxySession) return
      const provider = peers.get(proxySession.providerId)
      if (!provider || !provider.agentMode) return
      proxySession.lastActivity = Date.now()
      const reqBytes = JSON.stringify(msg.request ?? {}).length
      proxySession.bytesRequester = (proxySession.bytesRequester ?? 0) + reqBytes
      if (msg.request?.url) {
        try {
          recordSessionHost(proxySession, new URL(msg.request.url).hostname, 'target_host')
        } catch {}
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
      respSession.bytesRequester = (respSession.bytesRequester ?? 0) + respBytes
      respSession.bytesProvider = (respSession.bytesProvider ?? 0) + respBytes
      send(requester, { type: 'proxy_response', sessionId: msg.sessionId, response: msg.response })
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
      const chunk = Buffer.from(msg.data, 'base64')
      const tunnelSession = ws.sessionId ? sessions.get(ws.sessionId) : null
      if (tunnelSession) {
        tunnelSession.lastActivity = Date.now()
        tunnelSession.bytesProvider = (tunnelSession.bytesProvider ?? 0) + chunk.length
        tunnelSession.bytesRequester = (tunnelSession.bytesRequester ?? 0) + chunk.length
      }
      if (proxyClient.readyState !== undefined) {
        // WS-based client
        if (proxyClient.readyState === WebSocket.OPEN) proxyClient.send(chunk)
      } else if (proxyClient.socket && !proxyClient.socket.destroyed && proxyClient.ready) {
        // Raw socket client
        proxyClient.socket.write(chunk)
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

  reportSessionEnd(session, sessionId)
  sessions.delete(sessionId)
  log(ws.peerId.slice(0,8), `SESSION_CLEANED id=${sessionId.slice(0,8)} bytes=${session.bytesRequester ?? 0}`)

  if (!other) return
  other.sessionId = null

  // Auto-reconnect — only when provider dropped and requester is still connected
  if (ws.role === 'provider' && other.readyState === WebSocket.OPEN) {
    session.disconnectReason = 'provider_disconnected'
    log(other.peerId.slice(0,8), `PROVIDER_DROPPED — attempting auto-reconnect country=${session.country}`)
    attemptReconnect(other, session)
  } else {
    session.disconnectReason = 'peer_disconnected'
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
    if (now - session.lastActivity < SESSION_IDLE_MS) continue
    const provider = peers.get(session.providerId)
    const requester = peers.get(session.requesterId)
    if (!requester || requester.readyState !== WebSocket.OPEN) continue
    if (!provider || provider.readyState !== WebSocket.OPEN) {
      log(requester.peerId.slice(0,8), `SESSION_WATCHDOG provider gone sessionId=${sessionId.slice(0,8)}`)
      requester.sessionId = null
      sessions.delete(sessionId)
      attemptReconnect(requester, { ...session, reconnectAttempts: 0 })
    }
  }
}, 30_000)

wss.on('close', () => { clearInterval(heartbeat); clearInterval(sessionWatchdog) })

server.listen(PORT, () => {
  log('RELAY', `PeerMesh relay on port ${PORT}`)
})
