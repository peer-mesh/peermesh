#!/usr/bin/env node
/**
 * PeerMesh Provider Agent - self-bootstrapping.
 * Just run: node peermesh-agent.js
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { WebSocket } from 'ws'
import { createServer } from 'http'
import { connect } from 'net'

const __dirname = dirname(fileURLToPath(import.meta.url))

if (!existsSync(join(__dirname, 'node_modules', 'ws'))) {
  console.log('[setup] Installing dependencies...')
  try {
    execSync('npm install ws', { cwd: __dirname, stdio: 'inherit' })
    console.log('[setup] Done!')
  } catch {
    console.error('[setup] npm install failed. Please run: npm install ws')
    process.exit(1)
  }
}

const CONTROL_PORT = 7654
const PROXY_PORT = 7655

let config = {
  relay: 'wss://peermesh-relay.fly.dev',
  apiBase: 'http://localhost:3000',
  token: '',
  userId: '',
  country: 'RW',
  trust: 50,
}

let ws = null
let running = false
let reconnectTimer = null
let reconnectDelay = 2000
let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null, peerId: null }
let heartbeatTimer = null

const DEVICE_ID = 'agent_' + Math.random().toString(36).slice(2, 10)

const activeTunnels = new Map()

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

function sendRelayMessage(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function closeTunnel(tunnelId, notifyRelay = false) {
  const tunnel = activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return

  tunnel.closed = true
  activeTunnels.delete(tunnelId)

  if (notifyRelay) {
    sendRelayMessage({ type: 'tunnel_close', tunnelId })
  }

  if (!tunnel.socket.destroyed) {
    tunnel.socket.destroy()
  }
}

function closeAllTunnels(notifyRelay = false) {
  for (const tunnelId of [...activeTunnels.keys()]) {
    closeTunnel(tunnelId, notifyRelay)
  }
}

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const ALLOWED_TARGET_PORTS = new Set([80, 443, 8080, 8443])
const PRIVATE = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(22[4-9]|23\d)\./, /^255\.255\.255\.255$/,
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
  /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i,
]

function normalizeTargetHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
}

function isAllowedPort(port) {
  return ALLOWED_TARGET_PORTS.has(Number(port))
}

function isAllowed(url) {
  try {
    const parsed = new URL(url)
    const { hostname, protocol } = parsed
    const port = parsed.port ? Number(parsed.port) : (protocol === 'https:' ? 443 : 80)
    if (!['http:', 'https:'].includes(protocol)) return false
    if (!isAllowedPort(port)) return false
    if (BLOCKED.some((p) => p.test(normalizeTargetHost(hostname)))) return false
    if (PRIVATE.some((p) => p.test(normalizeTargetHost(hostname)))) return false
    return true
  } catch {
    return false
  }
}

function isAllowedHost(hostname) {
  if (!hostname) return false
  const host = normalizeTargetHost(hostname)
  return !BLOCKED.some((p) => p.test(host)) && !PRIVATE.some((p) => p.test(host))
}

function sanitizeFetchHeaders(headers = {}) {
  const out = {}
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = String(rawKey).trim().toLowerCase()
    if (!key) continue
    if (['host', 'content-length', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'cookie', 'origin', 'referer'].includes(key)) continue
    if (key.startsWith('sec-')) continue
    if (rawValue == null) continue
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  }
  return out
}

async function handleFetch(request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request

  if (!isAllowed(url)) {
    return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
  }

  try {
    log(`  -> ${method} ${url}`)
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        ...sanitizeFetchHeaders(headers),
      },
      body: body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })

    // Return redirects directly so the requester's browser follows each hop
    // through the proxy independently â€” prevents redirect chains (e.g. email
    // tracking links) from consuming the entire fetch timeout in one shot.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      const responseHeaders = {}
      if (location) responseHeaders['location'] = location
      const cacheControl = res.headers.get('cache-control')
      if (cacheControl) responseHeaders['cache-control'] = cacheControl
      log(`  <- ${res.status} ${url} (redirect -> ${location})`)
      return { requestId, status: res.status, headers: responseHeaders, body: '' }
    }

    const responseBody = await res.text()
    const responseHeaders = {}
    res.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) {
        responseHeaders[k] = v
      }
    })

    stats.bytesServed += responseBody.length
    stats.requestsHandled++
    log(`  <- ${res.status} ${url} (${responseBody.length}b)`)

    return { requestId, status: res.status, headers: responseHeaders, body: responseBody, finalUrl: res.url }
  } catch (err) {
    log(`  x ${url}: ${err.message}`)
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'connected':
      stats.peerId = msg.peerId
      log(`Connected to relay (peerId=${msg.peerId.slice(0, 8)})`)
      ws.send(JSON.stringify({
        type: 'register_provider',
        userId: config.userId,
        authToken: config.token,
        country: config.country,
        trustScore: config.trust,
        agentMode: true,
        providerKind: 'agent',
        supportsHttp: true,
        supportsTunnel: true,
      }))
      break

    case 'registered':
      stats.connectedAt = new Date().toISOString()
      log(`Registered as provider - country=${config.country}`)
      sendHeartbeat()
      break

    case 'session_request':
      log(`Session request: ${msg.sessionId.slice(0, 8)}`)
      ws.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
      break

    case 'proxy_request': {
      const response = await handleFetch(msg.request)
      ws.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
      break
    }

    case 'open_tunnel': {
      const { tunnelId, hostname, port } = msg
      if (!isAllowedHost(hostname) || !isAllowedPort(port || 443)) {
        sendRelayMessage({ type: 'tunnel_close', tunnelId })
        break
      }
      log(`  TUNNEL ${hostname}:${port}`)
      const socket = connect(port, hostname)
      socket.setTimeout(20000, () => { socket.destroy(new Error('connect timeout')) })
      activeTunnels.set(tunnelId, { socket, closed: false, sessionId: msg.sessionId ?? null })

      socket.on('connect', () => {
        socket.setTimeout(0)
        sendRelayMessage({ type: 'tunnel_ready', tunnelId })
      })
      socket.on('data', (data) => {
        sendRelayMessage({ type: 'tunnel_data', tunnelId, data: data.toString('base64') })
        stats.bytesServed += data.length
        stats.requestsHandled++
      })
      socket.on('end', () => closeTunnel(tunnelId, true))
      socket.on('close', () => {
        activeTunnels.delete(tunnelId)
      })
      socket.on('error', (err) => {
        log(`  TUNNEL ERROR ${hostname}: ${err.message}`)
        closeTunnel(tunnelId, true)
      })
      break
    }

    case 'tunnel_data': {
      const tunnel = activeTunnels.get(msg.tunnelId)
      if (tunnel?.socket && !tunnel.socket.destroyed) {
        tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      }
      break
    }

    case 'tunnel_close':
      closeTunnel(msg.tunnelId, false)
      break

    case 'session_ended':
      log('Session ended')
      closeAllTunnels(false)
      break

    case 'error':
      log(`Relay error: ${msg.message}`)
      break
  }
}

function sendHeartbeat() {
  if (!config.token || !config.userId || !config.country) return
  fetch(`${config.apiBase}/api/user/sharing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: DEVICE_ID, country: config.country, user_id: config.userId }),
  }).catch(err => log(`Heartbeat failed: ${err.message}`))
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (!config.token || !config.userId) return
  fetch(`${config.apiBase}/api/user/sharing`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    body: JSON.stringify({ device_id: DEVICE_ID }),
  }).catch(() => {})
}

function connectRelay() {
  if (!config.token || !config.userId) {
    log('Not configured - waiting for dashboard to set token and userId')
    return
  }

  log(`Connecting to relay: ${config.relay}`)
  ws = new WebSocket(config.relay)

  ws.on('open', () => {
    running = true
    reconnectDelay = 2000
    heartbeatTimer = setInterval(sendHeartbeat, 30_000)
  })
  ws.on('ping', () => { try { ws.pong() } catch {} })
  ws.on('message', (data) => {
    try {
      handleMessage(JSON.parse(data.toString()))
    } catch (err) {
      log(`Parse error: ${err.message}`)
    }
  })
  ws.on('close', (code) => {
    running = false
    stats.connectedAt = null
    closeAllTunnels(false)
    log(`Disconnected (code=${code}), reconnecting in ${reconnectDelay / 1000}s...`)
    reconnectTimer = setTimeout(connectRelay, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  })
  ws.on('error', (err) => log(`WS error: ${err.message}`))
}

function stopRelay() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.removeAllListeners('close')
    ws.close()
    ws = null
  }
  running = false
  closeAllTunnels(false)
  stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null, peerId: null }
  log('Agent stopped')
}

const controlServer = createServer((req, res) => {
  const origin = req.headers.origin || ''
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1')

  res.setHeader('Access-Control-Allow-Origin', isLocal ? origin : '')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      running,
      country: config.country,
      userId: config.userId?.slice(0, 8),
      proxyPort: PROXY_PORT,
      stats,
      version: '1.0.0',
    }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        config = { ...config, ...data }
        stopRelay()
        connectRelay()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
        log(`Started via dashboard - userId=${config.userId?.slice(0, 8)} country=${config.country}`)
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/stop') {
    stopRelay()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }

  if (req.method === 'POST' && url.pathname === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    stopRelay()
    setTimeout(() => process.exit(0), 200)
    return
  }

  res.writeHead(404)
  res.end()
})

controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
  log(`PeerMesh Agent control server on http://localhost:${CONTROL_PORT}`)
  log('Dashboard will configure and start the relay connection automatically.')
})

const proxyServer = createServer((req, res) => {
  const urlObj = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
  const hostname = urlObj.hostname
  const port = parseInt(urlObj.port) || 80

  if (!isAllowedHost(hostname) || !isAllowedPort(port)) {
    res.writeHead(403)
    res.end('Blocked')
    return
  }

  const socket = connect(port, hostname, () => {
    const headers = Object.entries(req.headers)
      .filter(([k]) => !['proxy-connection', 'proxy-authorization'].includes(k.toLowerCase()))
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')

    socket.write(`${req.method} ${urlObj.pathname}${urlObj.search} HTTP/1.1\r\n${headers}\r\n\r\n`)
    req.pipe(socket)
    socket.pipe(res)
  })

  socket.on('error', () => {
    res.writeHead(502)
    res.end()
  })
})

proxyServer.on('connect', (req, clientSocket, head) => {
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443

  if (!isAllowedHost(hostname) || !isAllowedPort(port)) {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const serverSocket = connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) serverSocket.write(head)
    serverSocket.pipe(clientSocket)
    clientSocket.pipe(serverSocket)
    stats.requestsHandled++
    stats.bytesServed += head.length
    log(`  TUNNEL ${hostname}:${port}`)
  })

  serverSocket.on('error', () => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    clientSocket.destroy()
  })
  clientSocket.on('error', () => serverSocket.destroy())
})

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  log(`HTTP proxy server on http://127.0.0.1:${PROXY_PORT} (all interfaces)`)
})

proxyServer.on('error', (err) => {
  log(`Proxy server error: ${err.message}`)
})

process.on('SIGINT', () => {
  stopRelay()
  process.exit(0)
})
process.on('SIGTERM', () => {
  stopRelay()
  process.exit(0)
})
