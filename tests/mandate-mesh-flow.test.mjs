import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { WebSocket } from 'ws'

const repoRoot = resolve(import.meta.dirname, '..')

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host)
  await once(server, 'listening')
  return server.address().port
}

function readJsonBody(req) {
  return new Promise((resolveBody) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString() })
    req.on('end', () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}) } catch { resolveBody({}) }
    })
  })
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const RELAY_BINARY_TUNNEL_DATA = 0x01

function tunnelIdBytes(tunnelId) {
  return Buffer.from(String(tunnelId || '').replace(/-/g, '').padEnd(32, '0').slice(0, 32), 'ascii')
}

function encodeBinaryTunnelData(tunnelId, chunk) {
  const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const idBytes = tunnelIdBytes(tunnelId)
  const frame = Buffer.allocUnsafe(1 + 32 + payload.length)
  frame[0] = RELAY_BINARY_TUNNEL_DATA
  idBytes.copy(frame, 1)
  payload.copy(frame, 33)
  return frame
}

function decodeBinaryTunnelData(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const idHex = buf.slice(1, 33).toString('ascii')
  return {
    type: 'tunnel_data',
    tunnelId: `${idHex.slice(0,8)}-${idHex.slice(8,12)}-${idHex.slice(12,16)}-${idHex.slice(16,20)}-${idHex.slice(20)}`,
    data: buf.slice(33),
    binary: true,
  }
}

function startFakeApi() {
  const requests = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJsonBody(req) : {}
    requests.push({ method: req.method, path: url.pathname, body })

    if (url.pathname === '/api/relay/auth' && req.method === 'POST') {
      if (body.role === 'requester') {
        writeJson(res, 200, {
          ok: true,
          userId: body.userId,
          trustScore: 80,
          country: body.country,
          privateProviderUserId: null,
          privateBaseDeviceId: null,
        })
        return
      }
      writeJson(res, 200, { ok: true, userId: body.userId, trustScore: 80 })
      return
    }

    if (url.pathname === '/api/user/sharing' && req.method === 'GET') {
      writeJson(res, 200, { can_accept_sessions: true, total_bytes_today: 0, daily_limit_bytes: null })
      return
    }

    if (
      url.pathname === '/api/session/end' ||
      url.pathname === '/api/security/events' ||
      url.pathname === '/api/relay/audit' ||
      url.pathname === '/api/session/cleanup'
    ) {
      writeJson(res, 200, { ok: true })
      return
    }

    writeJson(res, 404, { error: 'not found' })
  })

  return { server, requests }
}

async function getFreePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

function waitForRelay(child, port) {
  return new Promise((resolveReady, rejectReady) => {
    let output = ''
    const timer = setTimeout(() => {
      rejectReady(new Error(`relay did not start on ${port}; output=${output}`))
    }, 10_000)
    const onData = (chunk) => {
      output += chunk.toString()
      if (output.includes(`PeerMesh relay on port ${port}`)) {
        clearTimeout(timer)
        resolveReady()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`relay exited before ready code=${code}; output=${output}`))
    })
  })
}

function wrapJsonSocket(ws) {
  const queue = []
  const waiters = []
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const msg = (isBinary || buf[0] === RELAY_BINARY_TUNNEL_DATA)
      ? decodeBinaryTunnelData(buf)
      : JSON.parse(buf.toString())
    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(msg))
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
      return
    }
    queue.push(msg)
  })
  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    sendBinaryTunnelData: (tunnelId, chunk) => ws.send(encodeBinaryTunnelData(tunnelId, chunk), { binary: true }),
    waitFor: (predicate, label, timeoutMs = 10_000) => {
      const queuedIndex = queue.findIndex(predicate)
      if (queuedIndex >= 0) {
        const [msg] = queue.splice(queuedIndex, 1)
        return Promise.resolve(msg)
      }
      return new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(waiter => waiter.resolve === resolveWait)
          if (index >= 0) waiters.splice(index, 1)
          rejectWait(new Error(`timed out waiting for ${label}`))
        }, timeoutMs)
        waiters.push({ predicate, resolve: resolveWait, timer })
      })
    },
  }
}

async function connectJsonSocket(url) {
  const ws = new WebSocket(url)
  await once(ws, 'open')
  return wrapJsonSocket(ws)
}

test('mandated direct-first session stays alive and can relay-fallback a tunnel', async () => {
  const fakeApi = startFakeApi()
  const apiPort = await listen(fakeApi.server)
  const relayPort = await getFreePort()
  const relay = spawn(process.execPath, ['relay/relay.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(relayPort),
      API_BASE: `http://127.0.0.1:${apiPort}`,
      RELAY_SECRET: 'test-relay-secret',
      SCHEDULER_TICK_INTERVAL_MS: '0',
      RELAY_DIRECT_TRANSPORT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const sockets = []
  try {
    await waitForRelay(relay, relayPort)
    const relayUrl = `ws://127.0.0.1:${relayPort}`

    const provider = await connectJsonSocket(relayUrl)
    sockets.push(provider.ws)
    await provider.waitFor(msg => msg.type === 'connected', 'provider connected')
    provider.send({
      type: 'register_provider',
      userId: 'provider-user',
      authToken: 'provider-token',
      country: 'NG',
      agentMode: true,
      providerKind: 'test',
      supportsHttp: true,
      supportsTunnel: true,
      supportsBinaryTunnel: true,
      supportsDirect: true,
      directTransport: 'webrtc',
      iceEnabled: true,
      deviceId: 'provider-device-1',
      baseDeviceId: 'provider-device-1',
    })
    const registered = await provider.waitFor(msg => msg.type === 'registered', 'provider registered')
    assert.equal(registered.binaryTunnel, true)

    const requester = await connectJsonSocket(relayUrl)
    sockets.push(requester.ws)
    await requester.waitFor(msg => msg.type === 'connected', 'requester connected')
    requester.send({
      type: 'request_session',
      country: 'NG',
      userId: 'requester-user',
      authToken: 'requester-token',
      dbSessionId: 'db-session-1',
      requireTunnel: true,
      supportsDirect: true,
      iceEnabled: true,
      requesterDeviceId: 'requester-device-1',
    })

    const created = await requester.waitFor(msg => msg.type === 'session_created', 'session_created')
    const providerRequest = await provider.waitFor(msg => msg.type === 'session_request', 'session_request')
    assert.equal(created.sessionId, providerRequest.sessionId)
    assert.equal(created.transportTier, 1)
    assert.equal(created.directTransport, 'webrtc')
    assert.equal(created.iceEnabled, true)
    assert.equal(created.providerDirectEndpoint, null)
    assert.deepEqual(created.transportPreference, ['direct', 'relay'])
    assert.equal(providerRequest.mandate.relayFallbackRequired, true)
    assert.deepEqual(created.iceServers, ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'])

    provider.send({ type: 'agent_ready', sessionId: created.sessionId })
    const ready = await requester.waitFor(msg => msg.type === 'agent_session_ready', 'agent_session_ready')
    assert.equal(ready.sessionId, created.sessionId)
    assert.equal(ready.iceEnabled, true)

    requester.send({
      type: 'ice_offer',
      sessionId: created.sessionId,
      sdp: 'offer-sdp',
      sdpType: 'offer',
      candidates: [{ candidate: 'candidate:requester', sdpMid: '0' }],
    })
    const offer = await provider.waitFor(msg => msg.type === 'ice_offer', 'ice_offer')
    assert.equal(offer.sessionId, created.sessionId)
    assert.equal(offer.sdp, 'offer-sdp')

    provider.send({
      type: 'ice_answer',
      sessionId: created.sessionId,
      sdp: 'answer-sdp',
      sdpType: 'answer',
      candidates: [{ candidate: 'candidate:provider', sdpMid: '0' }],
    })
    const answer = await requester.waitFor(msg => msg.type === 'ice_answer', 'ice_answer')
    assert.equal(answer.sdp, 'answer-sdp')

    provider.send({ type: 'direct_failed', sessionId: created.sessionId, reason: 'ice_failed' })
    const directFailed = await requester.waitFor(msg => msg.type === 'direct_failed', 'direct_failed')
    assert.equal(directFailed.reason, 'ice_failed')
    const failedQuality = await requester.waitFor(msg => msg.type === 'session_quality' && msg.reason === 'direct_failed', 'direct_failed quality')
    assert.equal(failedQuality.directState, 'relay')

    const noEarlyEnd = await requester
      .waitFor(msg => msg.type === 'session_ended', 'unexpected session end', 500)
      .then(() => false)
      .catch(() => true)
    assert.equal(noEarlyEnd, true)

    const proxy = new WebSocket(`${relayUrl}/proxy?session=${encodeURIComponent(created.sessionId)}`)
    sockets.push(proxy)
    await once(proxy, 'open')
    proxy.send('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')

    const openTunnel = await provider.waitFor(msg => msg.type === 'open_tunnel', 'relay fallback open_tunnel')
    assert.equal(openTunnel.sessionId, created.sessionId)
    assert.equal(openTunnel.hostname, 'example.com')
    provider.send({ type: 'tunnel_ready', tunnelId: openTunnel.tunnelId })

    const established = (await once(proxy, 'message'))[0].toString()
    assert.match(established, /200 Connection Established/)

    proxy.send(Buffer.from('ping'))
    const tunnelData = await provider.waitFor(msg => msg.type === 'tunnel_data', 'relay fallback tunnel_data')
    assert.equal(tunnelData.binary, true)
    assert.equal(Buffer.from(tunnelData.data).toString(), 'ping')
    provider.sendBinaryTunnelData(openTunnel.tunnelId, Buffer.from('pong'))

    const pong = (await once(proxy, 'message'))[0]
    assert.equal(Buffer.from(pong).toString(), 'pong')
  } finally {
    for (const socket of sockets) {
      try { socket.close() } catch {}
    }
    relay.kill()
    fakeApi.server.close()
  }
})
