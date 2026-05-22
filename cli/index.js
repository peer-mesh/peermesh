#!/usr/bin/env node

import { WebSocket } from 'ws'
import { connect, isIP } from 'net'
import { lookup } from 'dns/promises'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { randomUUID } from 'crypto'

const API_BASE     = 'https://peermesh-beta.vercel.app'

let _liveRelays = null
let _liveRelaysFetchedAt = 0
const RELAY_CONFIG_TTL = 5 * 60 * 1000

async function getLiveRelays() {
  if (_liveRelays && Date.now() - _liveRelaysFetchedAt < RELAY_CONFIG_TTL) return _liveRelays
  const res = await fetch(`${API_BASE}/api/relay/config`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`relay config fetch failed: status=${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data.relays) || data.relays.length === 0) throw new Error('relay config returned empty list')
  _liveRelays = data.relays
  _liveRelaysFetchedAt = Date.now()
  clog.info('RELAY', 'relay config fetched', { relays: data.relays })
  return _liveRelays
}

const CONFIG_DIR = join(homedir(), '.peermesh')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const SHARED_IDENTITY_FILE = join(CONFIG_DIR, 'machine-identity.json')
const VERSION     = '1.0.69'
const DEBUG_LOG = join(homedir(), 'Desktop', 'peermesh-debug.log')

const CONTROL_PORT = 7654
const PEER_PORT = 7656
const LOCAL_PROXY_PORT = 7655
const SLOT_CAP = 32

const BLOCKED = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const ALLOWED_TARGET_PORTS = new Set([80, 443, 8080, 8443])
const PRIVATE = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(22[4-9]|23\d)\./, /^255\.255\.255\.255$/,
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
  /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i,
]

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const limitArg = limitIdx !== -1 ? args[limitIdx + 1] : undefined
const slotsIdx = args.indexOf('--slots') !== -1 ? args.indexOf('--slots') : args.indexOf('--slot')
const slotsArg = slotsIdx !== -1 ? args[slotsIdx + 1] : undefined
const privateExpiryIdx = args.indexOf('--private-expiry')
const privateExpiryArg = privateExpiryIdx !== -1 ? args[privateExpiryIdx + 1] : undefined
const privateSlotIdx = args.indexOf('--private-slot')
const privateSlotArg = privateSlotIdx !== -1 ? args[privateSlotIdx + 1] : undefined
const noLimit = args.includes('--no-limit')
const privateOnFlag = args.includes('--private-on')
const privateOffFlag = args.includes('--private-off')
const privateRefreshFlag = args.includes('--private-refresh')
const privateStatusFlag = args.includes('--private-status')
const resetFlag = args.includes('--reset')
const statusFlag = args.includes('--status')
const serveFlag = args.includes('--serve')
const debugFlag = args.includes('--debug')
const docsFlag  = args.includes('--docs')
const SHARING_ACTOR = 'cli'

function _write(level, category, message, ctx) {
  const ts = new Date().toISOString()
  const ctxStr = ctx && Object.keys(ctx).length
    ? ' | ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : ''
  const line = `[${ts}] [CLI] [${level.padEnd(5)}] [${category.padEnd(12)}] ${message}${ctxStr}`
  try { appendFileSync(DEBUG_LOG, line + '\n') } catch {}
  if (debugFlag) console.log(line)
}

const clog = {
  info: (cat, msg, ctx) => _write('INFO', cat, msg, ctx),
  warn: (cat, msg, ctx) => _write('WARN', cat, msg, ctx),
  error: (cat, msg, ctx) => _write('ERROR', cat, msg, ctx),
  debug: (cat, msg, ctx) => _write('DEBUG', cat, msg, ctx),
}

const clogRequest = (method, url, body) => _write('INFO', 'HTTP-OUT', `-> ${method} ${url}`, body ? { body } : undefined)
const clogResponse = (method, url, status, ctx) => _write('INFO', 'HTTP-IN', `<- ${status} ${method} ${url}`, ctx)
const clogRelay = (dir, type, ctx) => _write('DEBUG', 'RELAY', `${dir} ${type}`, ctx)
const clogTunnel = (event, tunnelId, ctx) => _write('DEBUG', 'TUNNEL', `${event} tunnel=${tunnelId?.slice(0, 8)}`, ctx)
const clogControl = (method, path, ctx) => _write('INFO', 'CONTROL', `${method} ${path}`, ctx)

function withSharingHeaders(token, contentType = true, actor = SHARING_ACTOR) {
  const headers = {}
  if (contentType) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  headers['x-peermesh-actor'] = actor || SHARING_ACTOR
  return headers
}

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch (e) {
    clog.warn('CONFIG', 'loadConfig read error', { err: e.message })
  }
  return {}
}

function saveConfig(cfg) {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch (e) {
    clog.error('CONFIG', 'saveConfig error', { err: e.message })
  }
}

function log(msg, level = 'info') {
  const ts = new Date().toTimeString().slice(0, 8)
  const icon = level === 'error' ? 'x' : level === 'warn' ? '!' : '*'
  console.log(`  ${icon} [${ts}] ${msg}`)
  clog.info('USER', msg)
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes ?? 0}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function getSyncTimestamp(value) {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function preferLatestSync(current, candidate) {
  if (!candidate) return current ?? null
  if (!current) return candidate
  const currentTs = getSyncTimestamp(current.state_changed_at)
  const candidateTs = getSyncTimestamp(candidate.state_changed_at)
  if (candidateTs > currentTs) return candidate
  if (candidateTs < currentTs) return current
  return current
}

function formatSyncStatus(sync) {
  if (!sync?.state_changed_at) return 'n/a'
  const actor = sync.state_actor ? String(sync.state_actor).toUpperCase() : 'SYSTEM'
  return `${actor} @ ${new Date(sync.state_changed_at).toLocaleTimeString()}`
}

function getSignedInLabel() {
  if (config.username) return config.username
  if (config.userId) return config.userId.slice(0, 8)
  return null
}

function banner() {
  console.log('')
  console.log(`  PeerMesh Provider v${VERSION}`)
  console.log('  Share your connection. Stay free.')
  console.log('')
  // Check for updates in background and print if newer version exists
  fetch(`https://registry.npmjs.org/@btcmaster1000/peermesh-provider/latest`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.json())
    .then(d => {
      if (d.version && d.version !== VERSION) {
        console.log(`  ! Update available: v${VERSION} → v${d.version}`)
        console.log(`  ! Run: npm install -g @btcmaster1000/peermesh-provider@latest`)
        console.log('')
      }
    })
    .catch(() => {})
}

function clampSlots(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed)) return 1
  return Math.max(1, Math.min(SLOT_CAP, parsed))
}

function parseSlotsFlag(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SLOT_CAP) {
    throw new Error(`--slots must be an integer between 1 and ${SLOT_CAP}`)
  }
  return parsed
}

function parsePrivateSlotFlag(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SLOT_CAP) {
    throw new Error(`--private-slot must be an integer between 1 and ${SLOT_CAP}`)
  }
  return parsed
}

function currentUsageDay() {
  return new Date().toDateString()
}

function syncUsageDay() {
  const today = currentUsageDay()
  if (config.usageDate !== today) {
    config.usageDate = today
    config.todayRequestsHandled = 0
    saveConfig(config)
  }
}

let config = loadConfig()
if (config.country?.startsWith('--')) {
  config.country = undefined
  saveConfig(config)
}

function createSharedBaseDeviceId() {
  return `pm_${randomUUID().replace(/-/g, '')}`
}

function readSharedBaseDeviceId() {
  try {
    if (!existsSync(SHARED_IDENTITY_FILE)) return null
    const raw = JSON.parse(readFileSync(SHARED_IDENTITY_FILE, 'utf-8'))
    const baseDeviceId = typeof raw?.baseDeviceId === 'string' ? raw.baseDeviceId.trim() : ''
    return baseDeviceId || null
  } catch (e) {
    clog.warn('CONFIG', 'readSharedBaseDeviceId failed', { err: e.message, path: SHARED_IDENTITY_FILE })
    return null
  }
}

function writeSharedBaseDeviceId(baseDeviceId) {
  if (!baseDeviceId) return
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(SHARED_IDENTITY_FILE, JSON.stringify({
      baseDeviceId,
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch (e) {
    clog.warn('CONFIG', 'writeSharedBaseDeviceId failed', { err: e.message, path: SHARED_IDENTITY_FILE })
  }
}

function getOrCreateSharedBaseDeviceId(fallback) {
  const existing = readSharedBaseDeviceId()
  if (existing) return existing
  const next = fallback || createSharedBaseDeviceId()
  writeSharedBaseDeviceId(next)
  return next
}

config.baseDeviceId = getOrCreateSharedBaseDeviceId(config.baseDeviceId || config.deviceId || createSharedBaseDeviceId())
if (!config.deviceId || config.deviceId !== config.baseDeviceId) config.deviceId = config.baseDeviceId
if (!config.connectionSlots) config.connectionSlots = 1
config.privateShare = config.privateShare ?? null
config.privateShareDeviceId = config.privateShareDeviceId ?? config.privateShare?.device_id ?? null
config.privateShares = Array.isArray(config.privateShares) ? config.privateShares.filter(row => row && typeof row === 'object') : []
config.profileSync = config.profileSync ?? null
config.connectionSlotsSync = config.connectionSlotsSync ?? null

let slotStates = []
let limitHit = false
let _userStopped = false
let myPort = null
let peerPort = null
let _controlLimitBytes = null
const _pendingBytesByDevice = new Map()
let _flushTimer = null
let _profileSyncTimer = null
let _profileSyncInterval = 5000
let _profileSyncConsecutiveFailures = 0
const PROFILE_SYNC_MAX = 30000
const CLI_AUTH_CLEAR_THRESHOLD = 3

function getBaseDeviceId() {
  return config.baseDeviceId
}

function rotateCliIdentity() {
  config.baseDeviceId = createSharedBaseDeviceId()
  config.deviceId = config.baseDeviceId
  writeSharedBaseDeviceId(config.baseDeviceId)
  ensureSlotStates()
}

async function clearCliCredentials(reason, { rotateIdentity = false } = {}) {
  stopProfileSync()
  stopRelay()
  config.token = null
  config.refreshToken = null
  config.deviceSessionId = null
  config.userId = null
  config.username = null
  config.country = 'RW'
  config.trust = 50
  config.shareEnabled = false
  config.todaySharedBytes = 0
  config.privateShareActive = false
  config.privateShare = null
  config.privateShareDeviceId = null
  config.privateShares = []
  config.profileSync = null
  config.connectionSlotsSync = null
  if (rotateIdentity) rotateCliIdentity()
  saveConfig(config)
  clog.warn('AUTH', 'credentials cleared', {
    reason,
    rotateIdentity,
    baseDeviceId: config.baseDeviceId,
  })
}

async function tryRefreshCliToken() {
  if (!config.userId || !config.refreshToken || !config.deviceSessionId) return false
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceSessionId: config.deviceSessionId,
        refreshToken: config.refreshToken,
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}))
      // Only clear credentials when server explicitly says device is revoked
      if (body.revoked === true) {
        clog.warn('AUTH', 'cli device revoked - clearing credentials', { userId: config.userId })
        await clearCliCredentials('device_revoked')
      } else {
        clog.warn('AUTH', 'cli token refresh 403 but not revoked - keeping auth alive', { userId: config.userId })
      }
      return false
    }
    if (!res.ok) return false
    const data = await res.json()
    if (data.token && data.refreshToken && data.deviceSessionId) {
      config.token = data.token
      config.refreshToken = data.refreshToken
      config.deviceSessionId = data.deviceSessionId
      saveConfig(config)
      clog.info('AUTH', 'cli token refreshed', { userId: config.userId, deviceSessionId: config.deviceSessionId })
      return true
    }
  } catch {}
  return false
}

async function confirmCliAuthStillValid(context, status) {
  if (!config.userId) return false
  // CLI is a persistent sharing agent - never sign out on 401/network errors.
  // Only clearCliCredentials when server returns { revoked: true } via tryRefreshCliToken.
  const refreshed = await tryRefreshCliToken()
  if (refreshed) { clog.info('AUTH', 'cli token refreshed', { context }); return true }
  // Refresh failed but not revoked - keep auth alive (network blip, server down, etc.)
  clog.warn('AUTH', 'token refresh failed - keeping auth alive', { context, status, userId: config.userId })
  return true
}

function getConnectionSlots() {
  return clampSlots(config.connectionSlots ?? 1)
}

function slotPrefix(slot) {
  return `[slot-${slot.index}]`
}

function slotLog(slot, message, level = 'info') {
  log(`${slotPrefix(slot)} ${message}`, level)
}

function createSlotState(index) {
  return {
    index,
    deviceId: `${getBaseDeviceId()}_slot_${index}`,
    ws: null,
    running: false,
    reconnectTimer: null,
    reconnectDelay: 2000,
    heartbeatTimer: null,
    sessionBytes: 0,
    requestsHandled: 0,
    connectedAt: null,
    activeTunnels: new Map(),
    lastRelay: null,
  }
}

function ensureSlotStates() {
  const desired = getConnectionSlots()
  while (slotStates.length < desired) slotStates.push(createSlotState(slotStates.length))
  if (slotStates.length > desired) slotStates = slotStates.slice(0, desired)
  for (const slot of slotStates) slot.deviceId = `${getBaseDeviceId()}_slot_${slot.index}`
  return slotStates
}

function activeSlotCount() {
  return slotStates.filter(slot => slot.running).length
}

function isRunning() {
  return activeSlotCount() > 0
}

function getAggregateStats() {
  return slotStates.reduce((acc, slot) => {
    acc.bytesServed += slot.sessionBytes
    acc.requestsHandled += slot.requestsHandled
    acc.tunnels += slot.activeTunnels.size
    return acc
  }, { bytesServed: 0, requestsHandled: 0, tunnels: 0 })
}

function getSlotSummary() {
  const privateSharesByDeviceId = new Map(
    hydratePrivateShareRows(config.privateShares).map(r => [r.device_id, r])
  )
  return slotStates.map(slot => {
    const ps = privateSharesByDeviceId.get(slot.deviceId)
    return {
      index: slot.index,
      deviceId: slot.deviceId,
      running: slot.running,
      requestsHandled: slot.requestsHandled,
      bytesServed: slot.sessionBytes,
      connectedAt: slot.connectedAt,
      privateEnabled: !!(ps?.enabled),
      privateActive: !!(ps?.enabled && ps?.active),
    }
  })
}

function normalizePrivateShareRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.filter(row => row && typeof row === 'object')
}

function createDisabledPrivateShareRow(deviceId, slotIndex = null) {
  return {
    device_id: deviceId,
    base_device_id: getBaseDeviceId(),
    slot_index: slotIndex,
    code: '',
    enabled: false,
    expires_at: null,
    active: false,
    state_actor: null,
    state_changed_at: null,
  }
}

function getPrivateShareSlotIndex(row) {
  if (!row) return null
  if (Number.isInteger(row.slot_index) && row.slot_index >= 0) return row.slot_index
  const base = getBaseDeviceId()
  const match = typeof row.device_id === 'string'
    ? row.device_id.match(/^(.+)_slot_(\d+)$/)
    : null
  if (!match || match[1] !== base) return null
  const parsed = parseInt(match[2], 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function hydratePrivateShareRows(rows) {
  const normalizedRows = normalizePrivateShareRows(rows)
  const byDeviceId = new Map()
  for (const row of normalizedRows) {
    const deviceId = typeof row.device_id === 'string' && row.device_id.trim()
      ? row.device_id.trim()
      : null
    if (!deviceId) continue
    const normalizedRow = {
      ...row,
      device_id: deviceId,
      base_device_id: row.base_device_id || getBaseDeviceId(),
      slot_index: Number.isInteger(row.slot_index) ? row.slot_index : null,
      code: typeof row.code === 'string' ? row.code : '',
      enabled: !!row.enabled,
      expires_at: row.expires_at ?? null,
      active: !!row.active,
      state_actor: row.state_actor ?? null,
      state_changed_at: row.state_changed_at ?? null,
    }
    byDeviceId.set(deviceId, preferLatestSync(byDeviceId.get(deviceId), normalizedRow) ?? normalizedRow)
  }

  const hydratedRows = ensureSlotStates().map(slot => {
    return byDeviceId.get(slot.deviceId) ?? createDisabledPrivateShareRow(slot.deviceId, slot.index)
  })

  // Only include extra DB rows that belong to this device's _slot_N namespace.
  // Bare baseDeviceId rows (legacy, no _slot_N suffix) are excluded.
  const _base = getBaseDeviceId()
  const configuredSlots = getConnectionSlots()
  for (const row of byDeviceId.values()) {
    if (hydratedRows.some(r => r.device_id === row.device_id)) continue
    if (!row.device_id.startsWith(_base + '_slot_')) continue
    const slotIndex = getPrivateShareSlotIndex(row)
    if (slotIndex === null || slotIndex >= configuredSlots) continue
    hydratedRows.push(row)
  }

  return hydratedRows
}

function getDefaultPrivateShareDeviceId() {
  if (typeof config.privateShareDeviceId === 'string' && config.privateShareDeviceId.trim()) {
    return config.privateShareDeviceId.trim()
  }
  const rows = hydratePrivateShareRows(config.privateShares)
  return rows[0]?.device_id ?? config.privateShare?.device_id ?? `${getBaseDeviceId()}_slot_0`
}

function selectPrivateShareRow(rows, deviceId = null) {
  const normalizedRows = hydratePrivateShareRows(rows)
  if (normalizedRows.length === 0) return null
  if (deviceId) {
    const exact = normalizedRows.find(row => row.device_id === deviceId)
    if (exact) return exact
  }
  const preferredDeviceId = getDefaultPrivateShareDeviceId()
  if (preferredDeviceId) {
    const preferred = normalizedRows.find(row => row.device_id === preferredDeviceId)
    if (preferred) return preferred
  }
  return normalizedRows[0]
}

function getPrivateShareLabel(row, fallbackIndex = 0) {
  if (!row) return `Slot ${fallbackIndex + 1}`
  if (Number.isInteger(row.slot_index) && row.slot_index >= 0) return `Slot ${row.slot_index + 1}`
  if (row.device_id) return row.device_id.slice(0, 8)
  return `Slot ${fallbackIndex + 1}`
}

function clogState(label) {
  const aggregate = getAggregateStats()
  _write('DEBUG', 'STATE', `[${label}]`, {
    running: isRunning(),
    activeSlots: activeSlotCount(),
    configuredSlots: getConnectionSlots(),
    wsStates: slotStates.map(slot => `${slot.index}:${slot.ws ? slot.ws.readyState : 'null'}`).join(','),
    myPort,
    peerPort,
    tunnels: aggregate.tunnels,
    limitHit,
  })
}

function getStatePayload() {
  const privateShares = hydratePrivateShareRows(config.privateShares)
  const privateShare = selectPrivateShareRow(privateShares, config.privateShareDeviceId) ?? config.privateShare ?? null
  return {
    available: true,
    running: isRunning(),
    shareEnabled: !!config.shareEnabled,
    configured: !!(config.token && config.userId),
    userId: config.userId ?? null,
    version: VERSION,
    where: 'cli',
    baseDeviceId: getBaseDeviceId(),
    connectionSlots: getConnectionSlots(),
    connectionSlotsSync: config.connectionSlotsSync ?? null,
    profileSync: config.profileSync ?? null,
    privateShareActive: !!(privateShare?.enabled && privateShare?.active),
    privateShare: privateShare,
    privateShares,
    privateShareDeviceId: privateShare?.device_id ?? config.privateShareDeviceId ?? null,
    slots: {
      configured: getConnectionSlots(),
      active: activeSlotCount(),
      statuses: getSlotSummary(),
      warning: getSlotWarning(getConnectionSlots()),
    },
    stats: {
      bytesServed: getAggregateStats().bytesServed,
      requestsHandled: getAggregateStats().requestsHandled,
      connectedAt: slotStates.find(slot => slot.connectedAt)?.connectedAt ?? null,
      peerId: null,
    },
  }
}

function normalizeTargetHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
}

function getUrlPort(parsed) {
  return parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
}

function isAllowed(hostname, port = 443) {
  const host = normalizeTargetHost(hostname)
  const blocked = BLOCKED.some(pattern => pattern.test(host))
  const private_ = PRIVATE.some(pattern => pattern.test(host))
  const badPort = !ALLOWED_TARGET_PORTS.has(Number(port))
  if (blocked || private_) clog.warn('FILTER', 'hostname blocked', { hostname, reason: blocked ? 'blocklist' : 'private' })
  if (badPort) clog.warn('FILTER', 'port blocked', { hostname, port })
  return !blocked && !private_ && !badPort
}

function ipv4ToInt(value) {
  const parts = String(value).split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function isPrivateIp(value) {
  const host = normalizeTargetHost(value)
  const kind = isIP(host)
  if (kind === 4) {
    const ip = ipv4ToInt(host)
    if (ip === null) return false
    const ranges = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]
    return ranges.some(([base, bits]) => {
      const baseInt = ipv4ToInt(base)
      const mask = (0xffffffff << (32 - bits)) >>> 0
      return baseInt !== null && (ip & mask) === (baseInt & mask)
    }) || host === '255.255.255.255'
  }
  if (kind === 6) return host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host) || /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i.test(host)
  return false
}

async function isAllowedResolved(hostname, port = 443) {
  const host = normalizeTargetHost(hostname)
  if (!isAllowed(host, port) || isPrivateIp(host)) return false
  try {
    const records = await lookup(host, { all: true, verbatim: false })
    return records.length > 0 && !records.some(record => isPrivateIp(record.address))
  } catch {
    return false
  }
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

async function persistSharingState(isSharing) {
  if (!config.token) return
  clogRequest('POST', `${API_BASE}/api/user/sharing`, { isSharing })
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingHeaders(config.token),
      body: JSON.stringify({ isSharing }),
    })
    clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
  } catch (e) {
    clog.warn('API', 'persistSharingState failed', { err: e.message })
  }
}

async function flushPendingBytes() {
  if (_flushTimer) return
  _flushTimer = setTimeout(async () => {
    _flushTimer = null
    if (!config.token || _pendingBytesByDevice.size === 0) return
    const pendingEntries = [..._pendingBytesByDevice.entries()]
    _pendingBytesByDevice.clear()

    for (const [deviceId, toFlush] of pendingEntries) {
      if (!toFlush) continue
      clogRequest('POST', `${API_BASE}/api/user/sharing`, { bytes: toFlush, deviceId })
      try {
        const res = await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: withSharingHeaders(config.token),
          body: JSON.stringify({ bytes: toFlush, deviceId }),
        })
        clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status, { deviceId })
      } catch (e) {
        clog.warn('API', 'flushStats failed', { err: e.message, deviceId })
      }
    }
  }, 5000)
}

function enforceLocalLimit(limitBytes) {
  if (!limitBytes || limitHit || config.todaySharedBytes == null) return
  const totalToday = (config.todaySharedBytes ?? 0) + getAggregateStats().bytesServed
  if (totalToday < limitBytes) return

  limitHit = true
  clog.warn('LIMIT', 'daily limit reached', { totalToday, limitBytes })
  console.log('')
  console.log(`  Daily limit of ${formatBytes(limitBytes)} reached — sharing paused until midnight.`)
  console.log('')
  stopRelay()
  const msUntilMidnight = new Date(new Date().toDateString()).getTime() + 86400000 - Date.now()
  clog.info('LIMIT', 'scheduling resume at midnight', { msUntilMidnight })
  setTimeout(() => {
    limitHit = false
    config.todaySharedBytes = 0
    saveConfig(config)
    clog.info('LIMIT', 'midnight reset — resuming sharing')
    if (config.shareEnabled) connectRelay(_controlLimitBytes)
  }, msUntilMidnight)
}

let _localSlotChangeAt = 0
const LOCAL_SLOT_CHANGE_GRACE_MS = 8000

function applySharingProfileData(data, { source = 'remote' } = {}) {
  const previousPrivateShareEnabled = !!config.privateShare?.enabled
  const previousPrivateShareActive = !!config.privateShareActive
  const previousPrivateShareCode = config.privateShare?.code ?? null
  const previousConnectionSlots = getConnectionSlots()
  const previousProfileSync = config.profileSync ?? null
  const previousConnectionSlotsSync = config.connectionSlotsSync ?? null

  const resolvedProfileSync = preferLatestSync(previousProfileSync, data.profile_sync ?? null)
  const resolvedConnectionSlotsSync = preferLatestSync(previousConnectionSlotsSync, data.connection_slots_sync ?? null)
  const shouldApplyConnectionSlots = (resolvedConnectionSlotsSync
    ? getSyncTimestamp(resolvedConnectionSlotsSync?.state_changed_at) >= getSyncTimestamp(previousConnectionSlotsSync?.state_changed_at)
    : true) && (Date.now() - _localSlotChangeAt > LOCAL_SLOT_CHANGE_GRACE_MS)

  config.profileSync = resolvedProfileSync
  config.connectionSlotsSync = resolvedConnectionSlotsSync
  if (shouldApplyConnectionSlots && Number.isInteger(data.connection_slots)) {
    config.connectionSlots = clampSlots(data.connection_slots)
    ensureSlotStates()
  }

  const nextPrivateShare = data.private_share ?? null
  const nextPrivateShares = hydratePrivateShareRows([
    ...(data.private_shares ?? (nextPrivateShare ? [nextPrivateShare] : [])),
    ...config.privateShares,
  ])
  const selectedPrivateShare = selectPrivateShareRow(nextPrivateShares, config.privateShareDeviceId)
  const nextPrivateShareEnabled = !!(selectedPrivateShare ?? nextPrivateShare)?.enabled
  const nextPrivateShareActive = !!(selectedPrivateShare ?? nextPrivateShare)?.active
  const nextPrivateShareCode = (selectedPrivateShare ?? nextPrivateShare)?.code ?? null

  config.privateShares = nextPrivateShares
  config.privateShare = selectedPrivateShare ?? nextPrivateShare
  config.privateShareDeviceId = config.privateShare?.device_id ?? config.privateShareDeviceId ?? null
  config.privateShareActive = nextPrivateShareActive
  config.slotLimits = normalizePrivateShareRows([
    ...(config.slotLimits ?? []),
    ...(data.slot_limits ?? []),
  ])
  if (data.daily_share_limit_mb !== undefined) config.dailyShareLimitMb = data.daily_share_limit_mb ?? null
  if (Number.isFinite(data.total_bytes_today)) config.todaySharedBytes = data.total_bytes_today
  if (data.has_accepted_provider_terms != null) config.hasAcceptedProviderTerms = !!data.has_accepted_provider_terms
  saveConfig(config)

  const privacyToggleChanged = previousPrivateShareEnabled !== nextPrivateShareEnabled
  const visibilityChanged = previousPrivateShareActive !== nextPrivateShareActive || previousPrivateShareCode !== nextPrivateShareCode

  if (privacyToggleChanged && config.shareEnabled && isRunning()) {
    clog.info('PRIVATE', 'private sharing mode changed - reconnecting provider', {
      source,
      from: previousPrivateShareEnabled,
      to: nextPrivateShareEnabled,
    })
    restartRelayForConfigChange('private_share_sync', _controlLimitBytes, 'Private sharing changed. Reconnecting to apply the new mode.')
  } else if (visibilityChanged) {
    clog.info('PRIVATE', 'private sharing state synced', {
      source,
      enabled: nextPrivateShareEnabled,
      active: nextPrivateShareActive,
      codeChanged: previousPrivateShareCode !== nextPrivateShareCode,
    })
  }

  if (shouldApplyConnectionSlots && getConnectionSlots() !== previousConnectionSlots) {
    clog.info('SLOTS', 'connection slot count synced from database', {
      source,
      from: previousConnectionSlots,
      to: getConnectionSlots(),
    })
    if (config.shareEnabled && isRunning()) {
      stopRelay()
      config.shareEnabled = true
      saveConfig(config)
      connectRelay(_controlLimitBytes)
    }
  }

  // Enforce per-slot daily limits and private share expiry
  if (config.shareEnabled && isRunning()) {
    const slotLimitMap = new Map((config.slotLimits ?? []).map(r => [r.device_id, r]))
    for (const slot of slotStates) {
      if (!slot.running) continue
      const slotLimit = slotLimitMap.get(slot.deviceId)
      if (slotLimit?.daily_limit_mb != null) {
        const slotLimitBytes = slotLimit.daily_limit_mb * 1024 * 1024
        if ((slot.sessionBytes ?? 0) >= slotLimitBytes) {
          clog.warn('LIMIT', 'slot daily limit reached - stopping relay', { slot: slot.index, slotLimitBytes })
          console.log(`\n  Slot ${slot.index + 1} daily limit reached — sharing paused.\n`)
          stopRelay()
          return data
        }
      }
      const psRow = nextPrivateShares.find(r => r.device_id === slot.deviceId)
      if (psRow?.enabled && psRow?.expires_at && new Date(psRow.expires_at).getTime() <= Date.now()) {
        clog.warn('PRIVATE', 'private share expired - reconnecting slot as public', { slot: slot.index })
        restartRelayForConfigChange('private_share_expired', _controlLimitBytes, 'A private share expired. Reconnecting.')
        return data
      }
    }
  }

  return data
}

function stopProfileSync() {
  if (!_profileSyncTimer) return
  clearTimeout(_profileSyncTimer)
  _profileSyncTimer = null
}

function startProfileSync() {
  stopProfileSync()
  if (!config.token || !config.userId) return
  _profileSyncInterval = 5000
  void pollTodayBytes()
  function scheduleTick() {
    _profileSyncTimer = setTimeout(async () => {
      const prevLimit = _controlLimitBytes
      const prevCode = config.privateShare?.code
      await pollTodayBytes().catch(() => {})
      const changed = _controlLimitBytes !== prevLimit || config.privateShare?.code !== prevCode
      _profileSyncInterval = changed ? 5000 : Math.min(_profileSyncInterval * 2, PROFILE_SYNC_MAX)
      scheduleTick()
    }, _profileSyncInterval)
  }
  scheduleTick()
}

function addBytes(slot, bytes, limitBytes) {
  slot.sessionBytes += bytes
  _pendingBytesByDevice.set(slot.deviceId, (_pendingBytesByDevice.get(slot.deviceId) ?? 0) + bytes)
  flushPendingBytes()
  enforceLocalLimit(limitBytes)
}

async function pollTodayBytes() {
  if (!config.token) return
  syncUsageDay()
  clogRequest('GET', `${API_BASE}/api/user/sharing`)
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing${getBaseDeviceId() ? `?baseDeviceId=${encodeURIComponent(getBaseDeviceId())}` : ''}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    clogResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
    if (res.status === 401 || res.status === 403) {
      _profileSyncConsecutiveFailures++
      if (_profileSyncConsecutiveFailures >= CLI_AUTH_CLEAR_THRESHOLD) {
        const stillValid = await confirmCliAuthStillValid('poll_today_bytes', res.status, { preserveWhileSharing: true })
        if (!stillValid) return
      } else {
        clog.warn('API', 'transient auth error in pollTodayBytes - not clearing yet', { status: res.status, count: _profileSyncConsecutiveFailures })
      }
      return
    }
    _profileSyncConsecutiveFailures = 0
    if (!res.ok) return
    const data = await res.json()
    return applySharingProfileData(data, { source: 'pollTodayBytes' })
  } catch (e) {
    clog.warn('API', 'pollTodayBytes error', { err: e.message })
  }
}

function getPrivateShareExpiryPreset(expiresAt) {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

function parsePrivateExpiryArg(value) {
  if (value === undefined) return undefined
  if (value === 'none' || value === 'null') return 'none'
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 720) {
    throw new Error('--private-expiry must be "none" or an integer between 1 and 720')
  }
  return String(parsed)
}

async function updatePrivateShareState({ enabled, refresh = false, expiryHours, deviceId } = {}) {
  if (!config.token || !config.userId) throw new Error('Sign in required')
  const expiryValue = expiryHours === undefined
    ? undefined
    : (expiryHours === 'none' ? null : parseInt(expiryHours, 10))
  const targetDeviceId = deviceId || getDefaultPrivateShareDeviceId()
  const previousEnabled = !!config.privateShare?.enabled

  clogRequest('POST', `${API_BASE}/api/user/sharing`, {
    privateSharing: {
      deviceId: targetDeviceId,
      baseDeviceId: getBaseDeviceId(),
      enabled,
      refresh: refresh === true,
      expiryHours: expiryValue,
    },
  })

  const res = await fetch(`${API_BASE}/api/user/sharing`, {
    method: 'POST',
    headers: withSharingHeaders(config.token),
    body: JSON.stringify({
      privateSharing: {
        deviceId: targetDeviceId,
        baseDeviceId: getBaseDeviceId(),
        enabled,
        refresh: refresh === true,
        expiryHours: expiryValue,
      },
    }),
    signal: AbortSignal.timeout(5000),
  })
  clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
  if (res.status === 401 || res.status === 403) {
    const stillValid = await confirmCliAuthStillValid('private_share', res.status, { preserveWhileSharing: true })
    throw new Error(stillValid ? 'Could not update private sharing - please try again' : 'Session expired - please sign in again')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || 'Could not update private sharing')

  config.privateShares = hydratePrivateShareRows([
    ...(data.private_shares ?? (data.private_share ? [data.private_share] : [])),
    ...config.privateShares,
  ])
  // Use targetDeviceId (the slot we just saved) not config.privateShareDeviceId (the previously selected slot)
  config.privateShare = config.privateShares.find(r => r.device_id === targetDeviceId) ?? selectPrivateShareRow(config.privateShares, config.privateShareDeviceId) ?? null
  config.privateShareDeviceId = config.privateShare?.device_id ?? config.privateShareDeviceId ?? null
  config.privateShareActive = !!(config.privateShare?.enabled && config.privateShare?.active)
  saveConfig(config)

  if (previousEnabled !== !!config.privateShare?.enabled) {
    clog.info('PRIVATE', 'private sharing mode changed locally - reconnecting provider', {
      from: previousEnabled,
      to: !!config.privateShare?.enabled,
    })
    restartRelayForConfigChange('private_share_local', _controlLimitBytes, 'Private sharing changed. Reconnecting to apply the new mode.')
  }

  return config.privateShare
}

function printPrivateShareState(privateShare, rows = config.privateShares) {
  const code = privateShare?.code ?? '---------'
  const mode = privateShare?.enabled
    ? (privateShare?.active ? 'ACTIVE' : 'ENABLED (inactive/expired)')
    : 'DISABLED'
  const expires = privateShare?.expires_at ? new Date(privateShare.expires_at).toLocaleString() : 'none'
  console.log(`  Private sharing: ${getPrivateShareLabel(privateShare)} - ${mode}`)
  console.log(`  Private code:    ${code}`)
  console.log(`  Private expiry:  ${expires}`)
  console.log(`  Private sync:    ${formatSyncStatus(privateShare)}`)
  const privateRows = hydratePrivateShareRows(rows)
  if (privateRows.length > 1) {
    console.log('  Slots:')
    privateRows.forEach((row, index) => {
      const rowMode = row.enabled ? (row.active ? 'ACTIVE' : 'ENABLED') : 'DISABLED'
      const rowCode = row.code || '---------'
      console.log(`    - ${getPrivateShareLabel(row, index)}: ${rowMode} (${rowCode}) sync=${formatSyncStatus(row)}`)
    })
  }
}

async function getLiveStatusState() {
  const ports = [CONTROL_PORT, PEER_PORT]
  const states = []
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) continue
      states.push(await res.json())
    } catch {}
  }
  const cliState = states.find(state => state?.where === 'cli')
  if (cliState) return cliState
  return states.find(state => state?.running) ?? states[0] ?? null
}

function sendMsg(slot, data) {
  if (slot.ws?.readyState === WebSocket.OPEN) slot.ws.send(JSON.stringify(data))
}

function closeTunnel(slot, tunnelId, notify = false) {
  const tunnel = slot.activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return
  tunnel.closed = true
  slot.activeTunnels.delete(tunnelId)
  if (notify) sendMsg(slot, { type: 'tunnel_close', tunnelId })
  if (!tunnel.socket.destroyed) tunnel.socket.destroy()
  clogTunnel('CLOSED', tunnelId, { slot: slot.index, notify, remaining: slot.activeTunnels.size })
}

function closeAllTunnels(slot) {
  const count = slot.activeTunnels.size
  for (const tunnelId of [...slot.activeTunnels.keys()]) closeTunnel(slot, tunnelId, false)
  if (count > 0) clog.info('TUNNEL', `${slotPrefix(slot)} closeAllTunnels closed ${count}`, { slot: slot.index })
}

function sendHeartbeat(slot) {
  if (!config.token || !config.userId) return
  clogRequest('PUT', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: withSharingHeaders(config.token),
    body: JSON.stringify({
      device_id: slot.deviceId,
      user_id: config.userId,
      relay_url: slot.lastRelay ?? null,
      connection_slots: getConnectionSlots(),
    }),
  })
    .then(async (res) => {
      clogResponse('PUT', `${API_BASE}/api/user/sharing`, res.status)
      if (res.status === 401 || res.status === 403) {
        await confirmCliAuthStillValid('heartbeat', res.status, { preserveWhileSharing: true })
      } else if (res.ok) {
        return res.json().then(data => { if (data) clog.debug('HEARTBEAT', 'PUT ok', { slot: slot.index, data: JSON.stringify(data).slice(0, 80) }) })
      }
    })
    .catch(e => clog.warn('HEARTBEAT', 'PUT error', { slot: slot.index, err: e.message }))
}

function stopHeartbeat(slot) {
  if (slot.heartbeatTimer) {
    clearInterval(slot.heartbeatTimer)
    slot.heartbeatTimer = null
  }
  if (!config.token) return
  clogRequest('DELETE', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: withSharingHeaders(config.token),
    body: JSON.stringify({ device_id: slot.deviceId }),
  })
    .then(res => clogResponse('DELETE', `${API_BASE}/api/user/sharing`, res.status))
    .catch(e => clog.warn('HEARTBEAT', 'DELETE error', { slot: slot.index, err: e.message }))
}

async function handleFetch(slot, request, limitBytes) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  clog.info('PROXY', `${slotPrefix(slot)} fetch request`, { requestId: requestId?.slice(0, 8), method, url })
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || !(await isAllowedResolved(parsed.hostname, getUrlPort(parsed)))) return { requestId, status: 403, headers: {}, body: '', error: 'Blocked' }
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...sanitizeFetchHeaders(headers),
      },
      body: body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    })
    const responseBody = await res.text()
    const responseHeaders = {}
    res.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(key)) {
        responseHeaders[key] = value
      }
    })
    addBytes(slot, responseBody.length, limitBytes)
    return {
      requestId,
      status: res.status,
      headers: responseHeaders,
      body: responseBody,
      finalUrl: res.url,
    }
  } catch (err) {
    clog.error('PROXY', `${slotPrefix(slot)} fetch error`, { requestId: requestId?.slice(0, 8), url, err: err.message })
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

function attachSlotSocketHandlers(slot, limitBytes, ws, relay) {
  ws.on('open', () => {
    // Stale socket: stopRelay ran or a newer socket replaced this one
    if (!config.shareEnabled || slot.ws !== ws) {
      ws.close(1000)
      return
    }
    slot.running = true
    slot.reconnectDelay = 2000
    slot.connectedAt = new Date().toISOString()
    slotLog(slot, `connected to relay (${slot.deviceId})`)
    const reg = {
      type: 'register_provider',
      userId: config.userId,
      authToken: config.token,
      country: config.country,
      trustScore: config.trust ?? 50,
      agentMode: true,
      providerKind: 'cli',
      supportsHttp: true,
      supportsTunnel: true,
      deviceId: slot.deviceId,
      baseDeviceId: getBaseDeviceId(),
    }
    clogRelay('SEND', 'register_provider', { slot: slot.index, deviceId: slot.deviceId })
    ws.send(JSON.stringify(reg))
    if (slot.heartbeatTimer) clearInterval(slot.heartbeatTimer)
    slot.heartbeatTimer = setInterval(() => {
      sendHeartbeat(slot)
      if (slot.index === 0) pollTodayBytes()
    }, 30_000)
    sendHeartbeat(slot)
  })

  ws.on('ping', () => {
    try { ws.pong() } catch {}
  })

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'tunnel_data') {
        clog.debug('RELAY', 'RECV tunnel_data', { slot: slot.index, tunnelId: msg.tunnelId?.slice(0, 8), bytes: msg.data?.length })
      } else {
        clogRelay('RECV', msg.type, { slot: slot.index, sessionId: msg.sessionId?.slice(0, 8), tunnelId: msg.tunnelId?.slice(0, 8) })
      }

      switch (msg.type) {
        case 'registered':
          slot.lastRelay = relay
          if (config.token) persistSharingState(true)
          // Only print status once — when the last expected slot connects
          if (activeSlotCount() === getConnectionSlots()) printStatus(limitBytes)
          break

        case 'error':
          clog.error('RELAY', `${slotPrefix(slot)} relay error`, { message: msg.message })
          if (msg.message?.includes('Replaced')) {
            slot.ws.removeAllListeners('close')
            slot.ws.close(1000)
            slot.running = false
            break
          }
          // Fatal errors — stop sharing entirely instead of reconnecting
          if (
            msg.message?.includes('cannot share bandwidth') ||
            msg.message?.includes('Verify your phone') ||
            msg.message?.includes('Accept the provider disclosure') ||
            msg.message?.includes('Profile not found')
          ) {
            clog.warn('RELAY', `${slotPrefix(slot)} fatal provider error - stopping`, { message: msg.message })
            console.log(`\n  x ${msg.message}\n`)
            stopRelay()
          }
          break

        case 'session_request':
          sendMsg(slot, { type: 'agent_ready', sessionId: msg.sessionId })
          break

        case 'proxy_request': {
          syncUsageDay()
          slot.requestsHandled++
          config.todayRequestsHandled = (config.todayRequestsHandled ?? 0) + 1
          saveConfig(config)
          const response = await handleFetch(slot, msg.request, limitBytes)
          sendMsg(slot, { type: 'proxy_response', sessionId: msg.sessionId, response })
          break
        }

        case 'open_tunnel': {
          const { tunnelId, hostname, port } = msg
          if (!(await isAllowedResolved(hostname, Number(port) || 443))) {
            sendMsg(slot, { type: 'tunnel_close', tunnelId })
            break
          }
          syncUsageDay()
          slot.requestsHandled++
          config.todayRequestsHandled = (config.todayRequestsHandled ?? 0) + 1
          saveConfig(config)
          const socket = connect(port, hostname)
          slot.activeTunnels.set(tunnelId, { socket, closed: false })
          socket.on('connect', () => sendMsg(slot, { type: 'tunnel_ready', tunnelId }))
          socket.on('data', chunk => {
            sendMsg(slot, { type: 'tunnel_data', tunnelId, data: chunk.toString('base64') })
            addBytes(slot, chunk.length, limitBytes)
          })
          socket.on('end', () => closeTunnel(slot, tunnelId, true))
          socket.on('close', () => slot.activeTunnels.delete(tunnelId))
          socket.on('error', () => closeTunnel(slot, tunnelId, true))
          break
        }

        case 'tunnel_data': {
          const tunnel = slot.activeTunnels.get(msg.tunnelId)
          if (tunnel?.socket && !tunnel.socket.destroyed) {
            tunnel.socket.write(Buffer.from(msg.data, 'base64'))
          }
          break
        }

        case 'tunnel_close':
          closeTunnel(slot, msg.tunnelId, false)
          break

        case 'session_ended':
          closeAllTunnels(slot)
          break
      }

    } catch (e) {
      clog.error('RELAY', `${slotPrefix(slot)} message handler exception`, { err: e.message })
    }
  })

  ws.on('close', (code, reason) => {
    if (slot.ws !== ws) return // stale socket, ignore
    clog.info('RELAY', `${slotPrefix(slot)} closed`, { code, reason: reason?.toString() || '(none)' })
    slot.running = false
    slot.connectedAt = null
    closeAllTunnels(slot)
    slot.ws = null
    if (code !== 1000 && !limitHit && !_userStopped && config.shareEnabled) {
      slot.reconnectTimer = setTimeout(() => connectSlot(slot, limitBytes), slot.reconnectDelay)
      slot.reconnectDelay = Math.min(slot.reconnectDelay * 2, 30000)
    }
  })

  ws.on('error', e => {
    clog.error('RELAY', `${slotPrefix(slot)} websocket error`, { err: e.message })
  })
}

function getProviderRelay(relays) {
  // All slots must connect to the same relay — relay state is process-local.
  // Use lastRelay if it's still live (sticky after first registration).
  // Rendezvous/HRW consistent hashing: adding/removing a relay only moves ~1/n
  // providers instead of reshuffling all of them (vs simple modulo).
  const anchor = slotStates[0]?.lastRelay
  if (anchor && relays.includes(anchor)) return anchor
  const id = getBaseDeviceId() || ''
  let best = null, bestScore = -1
  for (const relay of relays) {
    let h = 0
    const s = id + relay
    for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0 }
    const score = h >>> 0
    if (score > bestScore) { bestScore = score; best = relay }
  }
  return best ?? relays[0]
}

function connectSlot(slot, limitBytes) {
  if (!config.token || !config.userId) return
  if (slot.ws && (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING)) return
  getLiveRelays().then(relays => {
    // If stopRelay ran while awaiting, or another call already created a socket, bail
    if (!config.shareEnabled) return
    if (slot.ws && (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING)) return
    const relay = getProviderRelay(relays)
    slotLog(slot, `connecting to relay ${relay}`)
    const ws = new WebSocket(relay)
    slot.ws = ws
    attachSlotSocketHandlers(slot, limitBytes, ws, relay)
  }).catch(e => {
    clog.warn('RELAY', `connectSlot getLiveRelays error`, { slot: slot.index, err: e.message })
    if (config.shareEnabled && !_userStopped) {
      slot.reconnectTimer = setTimeout(() => connectSlot(slot, limitBytes), slot.reconnectDelay)
      slot.reconnectDelay = Math.min(slot.reconnectDelay * 2, 30000)
    }
  })
}

function connectRelay(limitBytes) {
  if (!config.token || !config.userId) {
    clog.warn('RELAY', 'connectRelay skipped — no token/userId')
    return
  }
  _userStopped = false
  ensureSlotStates().forEach(slot => connectSlot(slot, limitBytes))
  clogState('connectRelay')
}

function restartRelayForConfigChange(reason, limitBytes, message = null) {
  const shouldResume = !!config.shareEnabled || isRunning()
  if (!shouldResume) return false

  clog.info('RELAY', 'restarting provider to apply config change', { reason })
  stopRelay()

  if (!config.token || !config.userId || limitHit) return false

  config.shareEnabled = true
  saveConfig(config)
  connectRelay(limitBytes)
  if (message) {
    console.log('')
    console.log(`  ${message}`)
    console.log('')
  }
  return true
}

function stopRelay() {
  _userStopped = true
  config.shareEnabled = false
  saveConfig(config)

  for (const slot of slotStates) {
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer)
      slot.reconnectTimer = null
    }
    stopHeartbeat(slot)
    if (slot.ws) {
      slot.ws.removeAllListeners('close')
      slot.ws.close(1000)
      slot.ws = null
    }
    slot.running = false
    slot.connectedAt = null
    closeAllTunnels(slot)
  }

  if (config.token) persistSharingState(false)
}

let _proxySession = null

function openTunnelWs(hostname, port, onOpen) {
  if (!_proxySession?.sessionId) return null
  const relayRaw = _proxySession.relayEndpoint
  const relayHttp = relayRaw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const relayOrigin = new URL(relayHttp).origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const proxyUrl = `${relayOrigin}/proxy?session=${encodeURIComponent(_proxySession.sessionId)}`
  const tunnelWs = new WebSocket(proxyUrl)
  tunnelWs.on('open', () => {
    tunnelWs.send(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
    if (onOpen) onOpen()
  })
  return tunnelWs
}

const localProxyServer = http.createServer(async (req, res) => {
  if (!_proxySession?.sessionId) {
    res.writeHead(503); res.end('No PeerMesh session'); return
  }
  const parsed = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
  const hostname = parsed.hostname
  const port = parseInt(parsed.port) || 80
  if (!(await isAllowedResolved(hostname, port))) {
    res.writeHead(403); res.end('Target not allowed'); return
  }

  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const relayRaw = _proxySession.relayEndpoint
    const relayHttp = relayRaw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const relayOrigin = new URL(relayHttp).origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
    const proxyUrl = `${relayOrigin}/proxy?session=${encodeURIComponent(_proxySession.sessionId)}`
    const tunnelWs = new WebSocket(proxyUrl)
    let ready = false
    let responseData = Buffer.alloc(0)

    tunnelWs.on('open', () => {
      tunnelWs.send(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
    })
    tunnelWs.on('message', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!ready) {
        responseData = Buffer.concat([responseData, chunk])
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const firstLine = responseData.slice(0, responseData.indexOf('\r\n')).toString()
        if (!firstLine.includes('200')) { res.writeHead(502); res.end('Bad Gateway'); tunnelWs.close(); return }
        ready = true
        const reqLine = `${req.method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`
        const hdrs = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
        tunnelWs.send(Buffer.from(`${reqLine}${hdrs}\r\n\r\n`))
        if (body.length) tunnelWs.send(body)
        responseData = responseData.slice(headerEnd + 4)
        return
      }
      responseData = Buffer.concat([responseData, chunk])
      if (!res.headersSent) {
        const hEnd = responseData.indexOf('\r\n\r\n')
        if (hEnd !== -1) {
          const hStr = responseData.slice(0, hEnd).toString()
          const hLines = hStr.split('\r\n')
          const hMatch = hLines[0].match(/HTTP\/\S+ (\d+)/)
          const hStatus = hMatch ? parseInt(hMatch[1]) : 200
          const hHdrs = {}
          for (const line of hLines.slice(1)) { const idx = line.indexOf(':'); if (idx > 0) hHdrs[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim() }
          delete hHdrs['transfer-encoding']; delete hHdrs['content-encoding']
          const contentLength = parseInt(hHdrs['content-length'] || '0')
          const bodyData = responseData.slice(hEnd + 4)
          if (hStatus >= 300 && hStatus < 400) { res.writeHead(hStatus, hHdrs); res.end(bodyData); tunnelWs.close() }
          else if (contentLength > 0 && bodyData.length >= contentLength) { res.writeHead(hStatus, hHdrs); res.end(bodyData.slice(0, contentLength)); tunnelWs.close() }
        }
      }
    })
    tunnelWs.on('close', () => {
      if (!res.headersSent && responseData.length) {
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd !== -1) {
          const headerStr = responseData.slice(0, headerEnd).toString()
          const lines = headerStr.split('\r\n')
          const statusMatch = lines[0].match(/HTTP\/\S+ (\d+)/)
          const status = statusMatch ? parseInt(statusMatch[1]) : 200
          const hdrs = {}
          for (const line of lines.slice(1)) { const idx = line.indexOf(':'); if (idx > 0) hdrs[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim() }
          delete hdrs['transfer-encoding']; delete hdrs['content-encoding']
          res.writeHead(status, hdrs); res.end(responseData.slice(headerEnd + 4))
        } else { res.writeHead(502); res.end('Bad Gateway') }
      } else if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
    })
    tunnelWs.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') } })
    setTimeout(() => { if (!res.headersSent) { tunnelWs.terminate(); res.writeHead(504); res.end('Timeout') } }, 30000)
  })
})

localProxyServer.on('connect', async (req, clientSocket, head) => {
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443
  if (!_proxySession?.sessionId) {
    clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
    clientSocket.destroy(); return
  }
  if (!(await isAllowedResolved(hostname, port))) {
    clientSocket.write('HTTP/1.1 403 Target Not Allowed\r\n\r\n')
    clientSocket.destroy(); return
  }
  const relayRaw = _proxySession.relayEndpoint
  const relayHttp = relayRaw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const relayOrigin = new URL(relayHttp).origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const proxyUrl = `${relayOrigin}/proxy?session=${encodeURIComponent(_proxySession.sessionId)}`
  let opened = false
  const tunnelWs = new WebSocket(proxyUrl)
  tunnelWs.on('open', () => {
    tunnelWs.send(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
  })
  tunnelWs.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString() : data
    if (!clientSocket._connectSent && text.startsWith('HTTP/1.1 200')) {
      clientSocket._connectSent = true
      opened = true
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) tunnelWs.send(head)
      clientSocket.on('data', (chunk) => { if (tunnelWs.readyState === WebSocket.OPEN) tunnelWs.send(chunk) })
      clientSocket.on('end', () => tunnelWs.close())
      clientSocket.on('error', () => tunnelWs.close())
      return
    }
    if (!clientSocket.destroyed) clientSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
  })
  tunnelWs.on('close', () => { if (!clientSocket.destroyed) clientSocket.destroy() })
  tunnelWs.on('error', () => { if (!opened) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); if (!clientSocket.destroyed) clientSocket.destroy() })
  setTimeout(() => { if (!opened) { tunnelWs.terminate(); clientSocket.write('HTTP/1.1 504 Tunnel Timeout\r\n\r\n'); clientSocket.destroy() } }, 30000)
})

let localProxyListenStarted = false

function startLocalProxyServer() {
  if (localProxyListenStarted || localProxyServer.listening) return
  localProxyListenStarted = true
  localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1', () => {
    clog.info('CONTROL', `local proxy server on ${LOCAL_PROXY_PORT}`)
  })
}

localProxyServer.on('error', (err) => {
  localProxyListenStarted = false
  if (err.code === 'EADDRINUSE') {
    clog.warn('CONTROL', `local proxy port ${LOCAL_PROXY_PORT} already in use`)
    return
  }
  clog.error('CONTROL', 'local proxy server error', { err: err.message })
})

function applyConnectionSlots(nextSlots, { syncPeer = true, actor = SHARING_ACTOR } = {}) {
  const normalizedSlots = clampSlots(nextSlots)
  const shouldResume = !!config.shareEnabled

  _localSlotChangeAt = Date.now()
  config.connectionSlots = normalizedSlots
  ensureSlotStates()
  config.privateShares = hydratePrivateShareRows(config.privateShares)
  config.privateShare = selectPrivateShareRow(config.privateShares, config.privateShareDeviceId) ?? config.privateShare ?? null
  config.privateShareDeviceId = config.privateShare?.device_id ?? config.privateShareDeviceId ?? `${getBaseDeviceId()}_slot_0`
  config.privateShareActive = !!(config.privateShare?.enabled && config.privateShare?.active)
  saveConfig(config)

  // Notify server to clean up stale private share slots
  if (config.token && config.userId) {
    fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingHeaders(config.token, true, actor),
      body: JSON.stringify({ connectionSlots: normalizedSlots, baseDeviceId: getBaseDeviceId() }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {})
  }

  if (shouldResume) {
    stopRelay()
    config.shareEnabled = true
    saveConfig(config)
    connectRelay(_controlLimitBytes)
  }

  // Only notify peer if we weren't called by the peer — prevents ping-pong loop
  if (syncPeer && peerPort) {
    fetch(`http://127.0.0.1:${peerPort}/native/connection-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: normalizedSlots, _fromPeer: true, actor }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
  }

  return { success: true, slots: normalizedSlots, state: getStatePayload() }
}

function getSlotWarning(slots) {
  if (slots > 16) return 'Very high resource usage — recommended for servers or dedicated machines only.'
  if (slots > 8) return 'High resource usage — ensure a stable connection.'
  return null
}

function printStatus(limitBytes) {
  const aggregate = getAggregateStats()
  const totalToday = (config.todaySharedBytes ?? 0) + aggregate.bytesServed
  const active = activeSlotCount()
  const configured = getConnectionSlots()
  const limitStr = limitBytes
    ? `${formatBytes(totalToday)} / ${formatBytes(limitBytes)} today`
    : `${formatBytes(totalToday)} today (no limit)`
  const slotSummary = getSlotSummary()
  const privateCount = slotSummary.filter(s => s.privateActive).length
  const privBadge = privateCount === configured
    ? '\uD83D\uDD12 ALL PRIVATE'
    : privateCount > 0
      ? `\uD83D\uDD12 ${configured - privateCount} public, ${privateCount} private`
      : '\uD83C\uDF10 PUBLIC'
  console.log('')
  console.log(`  Sharing active [${privBadge}] — ${active} / ${configured} slots active`)
  console.log(`  ${aggregate.requestsHandled} requests — ${formatBytes(aggregate.bytesServed)} served`)
  console.log(`  ${limitStr}`)
  if (config.privateShare?.code) console.log(`  Private code: ${config.privateShare.code}`)
  const warning = getSlotWarning(configured)
  if (warning) console.log(`  ${warning}`)
  console.log('')
}

function notifyPeer(path, body) {
  if (!peerPort) return
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  fetch(`http://127.0.0.1:${peerPort}${path}`, init).catch(() => {})
}

function buildHandler(port) {
  return http.createServer((req, res) => {
    const origin = req.headers.origin || ''
    res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, `http://localhost:${port}`)
    clogControl(req.method, url.pathname, { port })

    if (req.method === 'GET' && url.pathname === '/native/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getStatePayload()))
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/start') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          if (config.userId && data.userId && config.userId !== data.userId) {
            clog.warn('CONTROL', '/native/share/start -- userId mismatch, rejecting', { existing: config.userId, incoming: data.userId })
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'This CLI is signed in as a different user' }))
            return
          }
          if (data.token) config.token = data.token
          if (data.refreshToken) config.refreshToken = data.refreshToken
          if (data.deviceSessionId) config.deviceSessionId = data.deviceSessionId
          if (data.userId) config.userId = data.userId
          if (data.trust) config.trust = data.trust
          if (data.country) config.country = data.country
          if (data.slots != null) config.connectionSlots = clampSlots(data.slots)
          config.shareEnabled = true
          saveConfig(config)
          stopRelay()
          config.shareEnabled = true
          saveConfig(config)
          connectRelay(_controlLimitBytes)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(getStatePayload()))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/share/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getStatePayload()))
      stopRelay()
      setTimeout(() => process.exit(0), 300)
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/connection-slots') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          // _fromPeer=true means desktop sent this; don't echo back (breaks ping-pong loop)
          const fromPeer = !!data._fromPeer
          clog.info('SLOTS', `/native/connection-slots`, { slots: data.slots, fromPeer, peerPort })
          const result = applyConnectionSlots(data.slots, { syncPeer: !fromPeer, actor: data.actor || SHARING_ACTOR })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.state))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/native/peer/register') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}')
          peerPort = data.port
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      stopRelay()
      setTimeout(() => process.exit(0), 300)
      return
    }

    if (req.method === 'POST' && url.pathname === '/proxy-session') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          _proxySession = data
          clog.info('CONTROL', 'proxy-session SET', { sessionId: data.sessionId?.slice(0,8), relay: data.relayEndpoint })
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
        } catch (e) { res.writeHead(400); res.end() }
      })
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/proxy-session') {
      _proxySession = null
      clog.info('CONTROL', 'proxy-session CLEARED')
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
      return
    }

    res.writeHead(404)
    res.end()
  })
}

function registerWithPeer(targetPort) {
  clogRequest('POST', `http://127.0.0.1:${targetPort}/native/peer/register`, { port: myPort, where: 'cli', slots: getConnectionSlots() })
  fetch(`http://127.0.0.1:${targetPort}/native/peer/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: myPort, where: 'cli', slots: getConnectionSlots() }),
    signal: AbortSignal.timeout(1500),
  })
    .then(async res => {
      clogResponse('POST', `http://127.0.0.1:${targetPort}/native/peer/register`, res.status)
      peerPort = targetPort
      // Sync slots with peer on registration
      await syncSlotsWithPeer(targetPort)
    })
    .catch(() => {})
}

// Push our slot count to peer, or adopt peer's if they are actively sharing
async function syncSlotsWithPeer(targetPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${targetPort}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return
    const state = await r.json()
    const peerSlots = state.connectionSlots ?? state.slots?.configured ?? null
    const peerRunning = !!state.running
    if (peerRunning && peerSlots && peerSlots !== getConnectionSlots()) {
      // Peer is actively sharing — adopt their slot count
      clog.info('SLOTS', 'adopting slot count from running peer', { peerSlots, ourSlots: getConnectionSlots() })
      config.connectionSlots = peerSlots
      ensureSlotStates()
      saveConfig(config)
    } else {
      // Neither is sharing — we are the registrant so we win; push with _fromPeer=true so peer doesn't echo back
      fetch(`http://127.0.0.1:${targetPort}/native/connection-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: getConnectionSlots(), _fromPeer: true }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {})
    }
  } catch {}
}

function startControlServer() {
  const primary = buildHandler(CONTROL_PORT)
  primary.listen(CONTROL_PORT, '127.0.0.1', () => {
    myPort = CONTROL_PORT
    registerWithPeer(PEER_PORT)
    startLocalProxyServer()
  })
  primary.on('error', err => {
    if (err.code !== 'EADDRINUSE') {
      log(`Control server error: ${err.message}`, 'error')
      return
    }

    const secondary = buildHandler(PEER_PORT)
    secondary.listen(PEER_PORT, '127.0.0.1', async () => {
      myPort = PEER_PORT
      registerWithPeer(CONTROL_PORT)
      startLocalProxyServer()
      try {
        const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          const state = await res.json()
          if (state.running) log('Desktop is sharing — CLI standing by')
        }
      } catch {}
    })
  })
}

async function authenticate() {
  console.log('  Requesting sign-in code...')
  console.log('')

  let result
  try {
    clogRequest('POST', `${API_BASE}/api/extension-auth`, { device: true })
    const res = await fetch(`${API_BASE}/api/extension-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: true }),
    })
    result = await res.json()
    clogResponse('POST', `${API_BASE}/api/extension-auth`, res.status, { user_code: result.user_code, interval: result.interval })
  } catch (e) {
    throw new Error('Could not reach server. Check your internet connection.')
  }

  if (result.error) throw new Error(result.error)

  const { device_code, user_code, interval = 3 } = result
  const verificationUri = `${API_BASE}/extension?activate=1`

  console.log(`  Open: ${verificationUri}`)
  console.log(`  Enter code: ${user_code}`)
  console.log('  Waiting for approval...')
  console.log('')

  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
        const data = await res.json()
        if (data.status === 'approved' && data.user) {
          clearInterval(poll)
          resolve(data.user)
        } else if (data.status === 'denied') {
          clearInterval(poll)
          reject(new Error('Sign-in was denied'))
        } else if (data.status === 'expired') {
          clearInterval(poll)
          reject(new Error('Code expired — run again to get a new code'))
        }
      } catch {}
    }, interval * 1000)

    setTimeout(() => {
      clearInterval(poll)
      reject(new Error('Timed out waiting for sign-in'))
    }, 10 * 60 * 1000)
  })
}

function promptYesNo(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt)
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.once('data', input => {
      process.stdin.pause()
      const answer = input.toString().trim().toLowerCase()
      resolve(answer === '' || answer === 'y')
    })
  })
}


function printDocs() {
  const G = '\x1b[32m', C = '\x1b[36m', R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[90m'
  const h = (t) => console.log(`\n${B}${C}  ${t}${R}`)
  const row = (lbl, cmd) => { console.log(`  ${D}${lbl}${R}`); console.log(`  ${G}${cmd}${R}`) }
  console.log(`\n${B}  PeerMesh Provider v${VERSION} -- CLI Reference${R}`)
  h('INSTALL')
  row('Run once (no install)',           'npx @btcmaster1000/peermesh-provider')
  row('Install globally',                'npm install -g @btcmaster1000/peermesh-provider')
  row('Update to latest',                'npm install -g @btcmaster1000/peermesh-provider@latest')
  h('BASIC')
  row('Start sharing',                   'peermesh-provider')
  row('Show status and exit',            'peermesh-provider --status')
  row('Show this reference',             'peermesh-provider --docs')
  row('Skip terms prompt (CI/scripts)',  'peermesh-provider --serve')
  row('Verbose debug logs to console',   'peermesh-provider --debug')
  row('Sign out and revoke device',      'peermesh-provider --reset')
  h('CONNECTION SLOTS  (1-32, default 1)')
  row('Run with 4 concurrent slots',     'peermesh-provider --slots 4')
  row('Run with 16 slots',               'peermesh-provider --slots 16')
  row('--slot is an alias for --slots',  'peermesh-provider --slot 4')
  h('DAILY BANDWIDTH LIMIT')
  row('Cap at 500 MB/day',               'peermesh-provider --limit 500')
  row('Cap at 2 GB/day',                 'peermesh-provider --limit 2048')
  row('Remove the daily cap',            'peermesh-provider --no-limit')
  h('PRIVATE SHARING PER SLOT')
  row('Show all slots + codes',          'peermesh-provider --private-status')
  row('Enable slot 1 (default)',         'peermesh-provider --private-on')
  row('Enable slot 2',                   'peermesh-provider --private-on --private-slot 2')
  row('Enable slot 3',                   'peermesh-provider --private-on --private-slot 3')
  row('Disable slot 1',                  'peermesh-provider --private-off')
  row('Disable slot 2',                  'peermesh-provider --private-off --private-slot 2')
  row('Rotate code on slot 1',           'peermesh-provider --private-refresh')
  row('Rotate code on slot 2',           'peermesh-provider --private-refresh --private-slot 2')
  row('Enable slot 1, expire in 1h',     'peermesh-provider --private-on --private-expiry 1')
  row('Enable slot 2, expire in 24h',    'peermesh-provider --private-on --private-slot 2 --private-expiry 24')
  row('Enable slot 1, expire in 7d',     'peermesh-provider --private-on --private-expiry 168')
  row('Enable slot 1, no expiry',        'peermesh-provider --private-on --private-expiry none')
  h('COMBINING FLAGS')
  row('4 slots, 1 GB/day, debug',        'peermesh-provider --slots 4 --limit 1024 --debug')
  row('8 slots, slot 2 private 24h',     'peermesh-provider --slots 8 --private-on --private-slot 2 --private-expiry 24 --serve')
  row('Status check only',               'peermesh-provider --status')
  h('RUN AT STARTUP')
  row('Windows -- PowerShell (as admin)', 'See: peermesh-provider --docs  (startup section)')
  row('macOS -- launchd',                 'See: peermesh-provider --docs  (startup section)')
  row('Linux -- systemd',                 'See: peermesh-provider --docs  (startup section)')
  h('UNINSTALL')
  row('Remove CLI',                      'npm uninstall -g @btcmaster1000/peermesh-provider')
  row('Remove saved credentials',        'rm -rf ~/.peermesh')
  console.log('')
}

async function main() {
  const installedVersion = config.installedVersion ?? null
  const isNewInstall = !installedVersion
  const isUpgrade = installedVersion && installedVersion !== VERSION
  const showInstallMsg = (isNewInstall || isUpgrade) && !statusFlag && !docsFlag

  if (showInstallMsg) {
    config.installedVersion = VERSION
    saveConfig(config)
  }

  banner()

  if (showInstallMsg) {
    if (isUpgrade) {
      console.log(`  ✓ PeerMesh Provider updated to v${VERSION}!`)
    } else {
      console.log('  ✓ PeerMesh Provider installed successfully!')
    }
    console.log('')
    console.log('  Get started:')
    console.log('    peermesh-provider              Start sharing')
    console.log('    peermesh-provider --docs       View full documentation')
    console.log('    peermesh-provider --status     Check current status')
    console.log('')
    console.log('  Share your connection. Stay free.')
    console.log('')
  }

  console.log(`  Logging to ${DEBUG_LOG}`)

  if (docsFlag) { printDocs(); process.exit(0) }
  console.log('')

  if (resetFlag) {
    // Revoke device_codes on server so desktop/extension are also signed out
    if (config.token && config.userId) {
      try {
        await fetch(`${API_BASE}/api/extension-auth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
          body: JSON.stringify({ userId: config.userId, deviceSessionId: config.deviceSessionId ?? null }),
          signal: AbortSignal.timeout(4000),
        })
        clog.info('AUTH', 'cli --reset: device revoked on server', { userId: config.userId })
      } catch (e) {
        clog.warn('AUTH', 'cli --reset: revoke failed (offline?)', { err: e.message })
      }
    }
    const keep = { connectionSlots: config.connectionSlots ?? 1 }
    config = keep
    rotateCliIdentity()
    saveConfig(config)
    log('Credentials cleared and device revoked - please sign in again')
    console.log('')
    console.log('  To completely remove PeerMesh:')
    console.log('  npm uninstall -g @btcmaster1000/peermesh-provider')
    console.log('  rm -rf ~/.peermesh')
    console.log('')
  }

  if (slotsArg !== undefined) {
    try {
      config.connectionSlots = parseSlotsFlag(slotsArg)
      saveConfig(config)
    } catch (e) {
      console.error(`  x ${e.message}`)
      process.exit(1)
    }
  } else {
    // Don't blindly persist stale saved slot count — let server profile sync win on next poll
    // Just ensure the in-memory value is valid
    config.connectionSlots = getConnectionSlots()
  }

  if (privateSlotArg !== undefined) {
    let privateSlotNumber
    try {
      privateSlotNumber = parsePrivateSlotFlag(privateSlotArg)
    } catch (e) {
      console.error(`  x ${e.message}`)
      process.exit(1)
    }
    if (privateSlotNumber > getConnectionSlots()) {
      console.error(`  x --private-slot ${privateSlotNumber} exceeds the configured slot count (${getConnectionSlots()})`)
      process.exit(1)
    }
    config.privateShareDeviceId = `${getBaseDeviceId()}_slot_${privateSlotNumber - 1}`
  } else if (!config.privateShareDeviceId) {
    config.privateShareDeviceId = `${getBaseDeviceId()}_slot_0`
  }
  config.privateShares = hydratePrivateShareRows(config.privateShares)
  config.privateShare = selectPrivateShareRow(config.privateShares, config.privateShareDeviceId) ?? config.privateShare ?? null
  config.privateShareActive = !!(config.privateShare?.enabled && config.privateShare?.active)
  config.refreshToken = config.refreshToken ?? null
  config.deviceSessionId = config.deviceSessionId ?? null
  saveConfig(config)

  clog.info('PROCESS', '=== CLI START ===', {
    version: VERSION,
    argv: process.argv.slice(2).join(' '),
    baseDeviceId: getBaseDeviceId(),
    connectionSlots: getConnectionSlots(),
    logFile: DEBUG_LOG,
  })

  if (!config.token || !config.userId) {
    try {
      const user = await authenticate()
      config.token = user.token
      config.refreshToken = user.refreshToken ?? null
      config.deviceSessionId = user.deviceSessionId ?? null
      config.userId = user.id
      config.username = user.username
      config.country = user.country ?? 'RW'
      config.trust = user.trustScore ?? 50
      saveConfig(config)
      const label = getSignedInLabel()
      if (!label) throw new Error('Sign-in did not return a user id')
      console.log(`  Signed in as ${label}`)
      console.log('')
    } catch (e) {
      console.error(`  x ${e.message}`)
      process.exit(1)
    }
  } else {
    try {
      // Refresh token on startup - if device is revoked, tryRefreshCliToken clears credentials.
      await tryRefreshCliToken()
    } catch {
      log('Could not refresh token (offline?) - continuing with saved credentials', 'warn')
    }
    const label = getSignedInLabel()
    if (!config.token || !config.userId || !label) {
      console.error('  x Sign in required. Run peermesh-provider to authenticate again.')
      process.exitCode = 1
      return
    }
    log(`Signed in as ${label}`)
  }

  console.log('')
  console.log('  Welcome to PeerMesh Provider!')
  console.log('  Documentation: peermesh-provider --docs')
  console.log('  Status check:  peermesh-provider --status')
  console.log('  Update:        npm install -g @btcmaster1000/peermesh-provider@latest')
  console.log('  Uninstall:     npm uninstall -g @btcmaster1000/peermesh-provider')
  console.log('')

  syncUsageDay()
  const profile = await pollTodayBytes()
  startProfileSync()

  if (privateStatusFlag || privateOnFlag || privateOffFlag || privateRefreshFlag || privateExpiryArg !== undefined) {
    try {
      const expiryHours = parsePrivateExpiryArg(privateExpiryArg)
      const targetEnabled = privateOnFlag ? true : privateOffFlag ? false : (privateRefreshFlag ? true : undefined)
      const updated = (privateOnFlag || privateOffFlag || privateRefreshFlag || expiryHours !== undefined)
        ? await updatePrivateShareState({ enabled: targetEnabled, refresh: privateRefreshFlag, expiryHours, deviceId: config.privateShareDeviceId })
        : (profile?.private_share ?? config.privateShare ?? null)
      config.privateShare = updated ?? null
      config.privateShareActive = !!(updated?.enabled && updated?.active)
      saveConfig(config)
      console.log('')
      printPrivateShareState(config.privateShare)
      console.log('')
    } catch (e) {
      console.error(`  x ${e.message}`)
      process.exit(1)
    }
  }

  if (noLimit || limitArg !== undefined) {
    const newLimit = noLimit ? null : parseInt(limitArg, 10)
    if (limitArg !== undefined && (!Number.isInteger(newLimit) || newLimit < 0)) {
      console.error('  x --limit must be a positive number in MB (e.g. --limit 500)')
      process.exit(1)
    }
    try {
      clogRequest('POST', `${API_BASE}/api/user/sharing`, { dailyLimitMb: newLimit })
      const res = await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: withSharingHeaders(config.token),
        body: JSON.stringify({ dailyLimitMb: newLimit }),
      })
      clogResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
      const data = await res.json().catch(() => ({}))
      config.profileSync = preferLatestSync(config.profileSync, data.profile_sync ?? null)
      if (data.daily_share_limit_mb !== undefined) config.dailyShareLimitMb = data.daily_share_limit_mb ?? null
      saveConfig(config)
    } catch {
      log('Could not save limit to server — using local value', 'warn')
    }
  }

  let limitMb = null
  if (limitArg !== undefined && !noLimit) limitMb = parseInt(limitArg, 10)
  else if (!noLimit && profile?.daily_share_limit_mb) limitMb = profile.daily_share_limit_mb
  const limitBytes = limitMb ? limitMb * 1024 * 1024 : null
  _controlLimitBytes = limitBytes

    if (statusFlag) {
    const liveState = await getLiveStatusState()
    const slots = liveState?.connectionSlots ?? liveState?.slots?.configured ?? getConnectionSlots()
    const privateRows = Array.isArray(liveState?.privateShares)
      ? hydratePrivateShareRows(liveState.privateShares)
      : hydratePrivateShareRows(config.privateShares)
    const slotStatuses = Array.isArray(liveState?.slots?.statuses) ? liveState.slots.statuses : getSlotSummary()
    console.log('')
    console.log(`  User:          ${config.username ?? '-'}`)
    console.log(`  Country:       ${config.country ?? '-'}`)
    console.log(`  Slots:         ${slots}`)
    console.log(`  Sharing:       ${liveState?.running ? 'active' : (config.shareEnabled ? 'enabled' : 'idle')}`)
    console.log(`  Shared today:  ${formatBytes(config.todaySharedBytes ?? 0)}`)
    console.log(`  Requests today:${String(config.todayRequestsHandled ?? 0).padStart(2)}`)
    console.log(`  Daily limit:   ${limitMb ? `${limitMb} MB` : 'none'}`)
    console.log(`  Profile sync:  ${formatSyncStatus(liveState?.profileSync ?? config.profileSync ?? null)}`)
    console.log(`  Slot sync:     ${formatSyncStatus(liveState?.connectionSlotsSync ?? config.connectionSlotsSync ?? null)}`)
    console.log('')
    console.log('  Slot state:')
    for (let index = 0; index < slots; index += 1) {
      const slotStatus = slotStatuses[index] ?? null
      const deviceId = slotStatus?.deviceId ?? `${getBaseDeviceId()}_slot_${index}`
      const share = privateRows.find(row => row.device_id === deviceId) ?? createDisabledPrivateShareRow(deviceId, index)
      const label = getPrivateShareLabel(share, index)
      const relayState = slotStatus?.running ? 'RUNNING' : 'IDLE'
      const visibility = share.enabled ? (share.active ? 'PRIVATE' : 'PRIVATE (expired)') : 'PUBLIC'
      const code = share.code || '---------'
      const exp = share.expires_at ? new Date(share.expires_at).toLocaleString() : 'no expiry'
      const requests = slotStatus?.requestsHandled ?? 0
      const served = slotStatus?.bytesServed ?? 0
      console.log(`    ${label}: ${relayState}  req=${requests}  served=${formatBytes(served)}  mode=${visibility}  code=${code}  expiry=${exp}  sync=${formatSyncStatus(share)}`)
    }
    console.log('')
    process.exit(0)
  }

  if (limitBytes && (config.todaySharedBytes ?? 0) >= limitBytes) {
    console.log('')
    console.log(`  Daily limit of ${formatBytes(limitBytes)} already reached for today.`)
    console.log('')
    process.exit(0)
  }

  const slots = getConnectionSlots()
  const slotWarning = getSlotWarning(slots)
  console.log(`  Daily limit: ${limitMb ? `${limitMb}MB` : 'none (set with --limit <MB>)'}`)
  console.log(`  Connection slots: ${slots}`)
  if (slotWarning) console.log(`  ${slotWarning}`)
  if ((config.todaySharedBytes ?? 0) > 0) console.log(`  Used today: ${formatBytes(config.todaySharedBytes)}`)
  console.log('')

  if (!serveFlag) {
    const accepted = profile?.has_accepted_provider_terms === true
    if (!accepted) {
      console.log('  Before you share:')
      console.log('  - Your IP will be used by other PeerMesh users to browse the web.')
      console.log('  - All sessions are logged with signed receipts.')
      console.log('  - Blocked: .onion, SMTP/mail, torrents, private IPs.')
      console.log('  - You can stop sharing at any time.')
      console.log('')
      const confirmed = await promptYesNo('  Start sharing? [Y/n]: ')
      if (!confirmed) process.exit(0)
      try {
        await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: withSharingHeaders(config.token),
          body: JSON.stringify({ acceptProviderTerms: true }),
        })
      } catch {}
    }
  }

  ensureSlotStates()
  startControlServer()

  let desktopAlreadySharing = false
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) {
      const state = await res.json()
      desktopAlreadySharing = !!state.running
    }
  } catch {}

  if (desktopAlreadySharing) {
    // Adopt desktop's slot count since it's the running provider
    try {
      const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) {
        const state = await r.json()
        const desktopSlots = state.connectionSlots ?? state.slots?.configured ?? null
        if (desktopSlots && desktopSlots !== getConnectionSlots()) {
          clog.info('SLOTS', 'adopting slot count from running desktop', { desktopSlots, ourSlots: getConnectionSlots() })
          config.connectionSlots = desktopSlots
          ensureSlotStates()
          saveConfig(config)
        }
      }
    } catch {}
    log('Desktop is sharing — CLI standing by (press Ctrl+C to stop both)')
  } else {
    config.shareEnabled = true
    saveConfig(config)
    connectRelay(limitBytes)
  }

  async function shutdown(calledByPeer = false) {
    console.log('')
    log('Stopping...')
    stopProfileSync()
    if (peerPort && !calledByPeer) {
      try {
        await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      } catch {}
    }
    stopRelay()
    const aggregate = getAggregateStats()
    const todayTotal = (config.todaySharedBytes ?? 0) + aggregate.bytesServed
    console.log(`  Session: ${formatBytes(aggregate.bytesServed)} served`)
    console.log(`  Today:   ${formatBytes(todayTotal)} total`)
    console.log('')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown())
  process.on('SIGTERM', () => {
    stopProfileSync()
    stopRelay()
    process.exit(0)
  })
}

main()
