const { app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, shell, Notification, powerSaveBlocker } = require('electron')
const { WebSocket } = require('ws')
const {
  readBatteryStatus,
  scheduleHardwareWake,
  unregisterWindowsHardwareWakeTask,
} = require('./hardware-clock')
const path = require('path')
const http = require('http')
const net = require('net')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')

// Ã¢â€â‚¬Ã¢â€â‚¬ Logger Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const LOG_FILE = path.join(os.homedir(), 'Desktop', 'peermesh-debug.log')

// Structured logger Ã¢â‚¬â€ always writes to file, always to console
// Format: [ISO_TIMESTAMP] [DESKTOP] [LEVEL] [CATEGORY] message | ctx={}
const _IS_NATIVE_HOST = process.argv.some(arg => arg.startsWith('chrome-extension://')) || process.argv.some(arg => arg.startsWith('--parent-window='))

function _write(level, category, message, ctx) {
  const ts = new Date().toISOString()
  const ctxStr = ctx && Object.keys(ctx).length ? ' | ' + Object.entries(ctx).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''
  const line = `[${ts}] [DESKTOP] [${level.padEnd(5)}] [${category.padEnd(12)}] ${message}${ctxStr}`
  if (!_IS_NATIVE_HOST) console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
}

const log = {
  info:  (cat, msg, ctx) => _write('INFO',  cat, msg, ctx),
  warn:  (cat, msg, ctx) => _write('WARN',  cat, msg, ctx),
  error: (cat, msg, ctx) => _write('ERROR', cat, msg, ctx),
  debug: (cat, msg, ctx) => _write('DEBUG', cat, msg, ctx),
  // legacy single-arg form used by older call sites
  plain: (msg, level = 'info') => _write(level.toUpperCase().padEnd(5), 'GENERAL', msg, null),
}

// Named aliases used throughout the file
const logState = (label) => {
  const activeSlots = slotStates.filter(slot => slot.running).length
  _write('DEBUG', 'STATE', `[${label}]`, {
    running: activeSlots > 0,
    shareEnabled: config.shareEnabled,
    peerSharing,
    peerPort,
    configuredSlots: config.connectionSlots ?? 1,
    activeSlots,
    wsStates: slotStates.map(slot => `${slot.index}:${slot.ws ? slot.ws.readyState : 'null'}`).join(','),
    tunnels: activeTunnels.size,
  })
}

const logRequest  = (method, url, body) => _write('INFO',  'HTTP-OUT', `Ã¢â€ â€™ ${method} ${url}`, body ? { body } : undefined)
const logResponse = (method, url, status, body) => _write('INFO',  'HTTP-IN',  `Ã¢â€ Â ${status} ${method} ${url}`, body ? { body } : undefined)
const logRelay    = (direction, type, ctx) => _write('DEBUG', 'RELAY',    `${direction} ${type}`, ctx)
const logTunnel   = (event, tunnelId, ctx) => _write('DEBUG', 'TUNNEL',   `${event} tunnel=${tunnelId?.slice(0,8)}`, ctx)
const logIpc      = (channel, ctx) => _write('DEBUG', 'IPC',      channel, ctx)
const logControl  = (method, path, ctx) => _write('INFO',  'CONTROL',  `${method} ${path}`, ctx)

// Prevent uncaught errors from showing Electron's error dialog
process.on('uncaughtException', (err) => {
  _write('ERROR', 'PROCESS', 'uncaughtException', { message: err.message, stack: err.stack })
  if (err.code === 'EADDRINUSE') return
})


const API_BASE = 'https://peermesh-beta.vercel.app'
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
  log.info('RELAY', 'relay config fetched', { relays: data.relays })
  return _liveRelays
}
const RELAY_PROXY_PORT = 8081
const CONTROL_PORT = 7654
const LOCAL_PROXY_PORT = 7655
const PEER_PORT = 7656
const NATIVE_HOST_NAME = 'com.peermesh.desktop'
const EXTENSION_ID = 'chpkbnnohdiohlejmpmjmnmjgokalllm'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
const DESKTOP_VERSION = require('./package.json').version
const USER_DATA_DIR = app.getPath('userData')
const CONFIG_FILE = path.join(USER_DATA_DIR, 'config.json')
const SHARED_IDENTITY_FILE = path.join(os.homedir(), '.peermesh', 'machine-identity.json')
const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.png')
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray-icon.png')
const IS_NATIVE_HOST_MODE = process.argv.some(arg => arg.startsWith('chrome-extension://')) || process.argv.some(arg => arg.startsWith('--parent-window='))
const IS_BACKGROUND_LAUNCH = process.argv.includes('--background')
const HAS_SINGLE_INSTANCE_LOCK = IS_NATIVE_HOST_MODE ? true : app.requestSingleInstanceLock()
const SHARING_ACTOR = 'desktop'

function withSharingHeaders(headers = {}, actor = SHARING_ACTOR) {
  return { ...headers, 'x-peermesh-actor': actor || SHARING_ACTOR }
}

function withSharingAuthHeaders(contentType = true, actor = SHARING_ACTOR) {
  const headers = { Authorization: `Bearer ${config.token}` }
  if (contentType) headers['Content-Type'] = 'application/json'
  return withSharingHeaders(headers, actor)
}

let peerPort = null
let peerSharing = false
let _sharingToggleBusy = false
let _cliWatchTimer = null
let _shutdownStarted = false
let _quitRequested = false
let _sharingConfigSyncTimer = null
let _sharingConfigSyncBusy = false
let _sharingConfigSyncInterval = 5000
let _sharingConfigConsecutiveFailures = 0
let _providerSleepBlockerId = null
let _sharingScheduleTimer = null
let _sharingScheduleActionBusy = false
let _lastScheduleInWindow = null
let _scheduleWakeSyncBusy = false
let _sharingScheduleCloudSyncBusy = false
let _uptimeJobsTimer = null
let _uptimeJobsBusy = false
let _uptimeJobsInterval = 30_000
let _desktopUpdateState = null
let _desktopUpdateBusy = false
const SHARING_CONFIG_SYNC_MAX = 30000
const UPTIME_JOBS_SYNC_MAX = 120_000
const AUTH_CLEAR_FAILURE_THRESHOLD = 3
const WINDOWS_WAKE_TASK_NAME = 'PeerMesh Scheduled Wake'
const _pendingBytesByDevice = new Map()
let _flushTimer = null

function notifyPeer(p, body) {
  if (!peerPort) return
  log.info('PEER', `notifyPeer Ã¢â€ â€™ ${p}`, { port: peerPort })
  const init = { method: 'POST', signal: AbortSignal.timeout(1500) }
  if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body) }
  fetch(`http://127.0.0.1:${peerPort}${p}`, init)
    .then(() => log.debug('PEER', `notifyPeer OK ${p}`))
    .catch(e => log.warn('PEER', `notifyPeer failed ${p}`, { err: e.message }))
}

let tray = null
let settingsWindow = null
let running = false
let config = {
  token: '',
  refreshToken: '',
  deviceSessionId: '',
  userId: '',
  country: 'RW',
  trust: 50,
  extId: '',
  baseDeviceId: '',
  hasAcceptedProviderTerms: false,
  shareEnabled: false,
  connectionSlots: 1,
  launchOnStartup: false,
  autoShareOnLaunch: false,
  preventSleepWhileSharing: false,
  sharingSchedule: getDefaultSharingSchedule(),
  scheduleWakeEnabled: false,
  allowOnDemandWake: false,
  allowPrivateOnDemandStart: false,
  scheduleWakeStatus: null,
  todaySharedBytes: 0,
  todaySharedBytesDate: null,
  dailyShareLimitMb: null,
  privateShareActive: false,
  privateShare: null,
  privateShareDeviceId: null,
  privateShares: [],
  slotLimits: [],
  profileSync: null,
  connectionSlotsSync: null,
  uptimeScheduleSync: null,
}
let stats = { bytesServed: 0, requestsHandled: 0, connectedAt: null }
const activeTunnels = new Map()
const SLOT_CAP = 32
let slotStates = []
let _userStopped = false
let limitHit = false
let previousLaunchExtId = null

function createDesktopIdentity() {
  return require('crypto').randomUUID()
}

function createSharedBaseDeviceId() {
  return `pm_${require('crypto').randomUUID().replace(/-/g, '')}`
}

function readSharedBaseDeviceId() {
  try {
    if (!fs.existsSync(SHARED_IDENTITY_FILE)) return null
    const raw = JSON.parse(fs.readFileSync(SHARED_IDENTITY_FILE, 'utf-8'))
    const baseDeviceId = typeof raw?.baseDeviceId === 'string' ? raw.baseDeviceId.trim() : ''
    return baseDeviceId || null
  } catch (e) {
    log.warn('CONFIG', 'readSharedBaseDeviceId failed', { err: e.message, path: SHARED_IDENTITY_FILE })
    return null
  }
}

function writeSharedBaseDeviceId(baseDeviceId) {
  if (!baseDeviceId) return
  try {
    fs.mkdirSync(path.dirname(SHARED_IDENTITY_FILE), { recursive: true })
    fs.writeFileSync(SHARED_IDENTITY_FILE, JSON.stringify({
      baseDeviceId,
      updatedAt: new Date().toISOString(),
    }, null, 2))
  } catch (e) {
    log.warn('CONFIG', 'writeSharedBaseDeviceId failed', { err: e.message, path: SHARED_IDENTITY_FILE })
  }
}

function getOrCreateSharedBaseDeviceId(fallback) {
  const existing = readSharedBaseDeviceId()
  if (existing) return existing
  const next = fallback || createSharedBaseDeviceId()
  writeSharedBaseDeviceId(next)
  return next
}

function rotateDesktopIdentity({ rotateBaseDeviceId = false } = {}) {
  config.extId = createDesktopIdentity()
  if (rotateBaseDeviceId) {
    config.baseDeviceId = createSharedBaseDeviceId()
    writeSharedBaseDeviceId(config.baseDeviceId)
  } else if (!config.baseDeviceId) {
    config.baseDeviceId = getOrCreateSharedBaseDeviceId(createSharedBaseDeviceId())
  }
  ensureSlotStates()
}

async function revokeExtensionAuthToken(extId) {
  if (!extId) return
  try {
    await fetch(`${API_BASE}/api/extension-auth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ext_id: extId }),
      signal: AbortSignal.timeout(4000),
    })
  } catch (e) {
    log.warn('AUTH', 'revokeExtensionAuthToken failed', { extId, err: e.message })
  }
}

async function clearDesktopAuth(reason, { rotateIdentity = false, revoke = true } = {}) {
  const oldExtId = config.extId
  const oldBaseDeviceId = config.baseDeviceId
  stopRelay()
  stopSharingConfigSync()
  stopUptimeJobLoop()
  if (revoke && oldExtId) await revokeExtensionAuthToken(oldExtId)
  config = {
    ...config,
    token: '',
    refreshToken: '',
    deviceSessionId: '',
    userId: '',
    country: 'RW',
    trust: 50,
    shareEnabled: false,
    hasAcceptedProviderTerms: false,
    autoShareOnLaunch: false,
    todaySharedBytes: 0,
    todaySharedBytesDate: null,
    dailyShareLimitMb: null,
    privateShareActive: false,
    privateShare: null,
    privateShareDeviceId: null,
    privateShares: [],
    slotLimits: [],
    profileSync: null,
    connectionSlotsSync: null,
  }
  if (rotateIdentity) rotateDesktopIdentity({ rotateBaseDeviceId: true })
  else ensureSlotStates()
  saveConfig()
  updateTray()
  log.info('AUTH', 'desktop auth cleared', { reason, rotated: rotateIdentity, oldExtId, oldBaseDeviceId, newExtId: config.extId, newBaseDeviceId: config.baseDeviceId })
}

function clampSlots(value) {
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed)) return 1
  return Math.max(1, Math.min(SLOT_CAP, parsed))
}

function slotPrefix(slot) {
  return `[slot-${slot.index}]`
}

function createSlotState(index) {
  return {
    index,
    deviceId: `${config.baseDeviceId}_slot_${index}`,
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
  const desired = clampSlots(config.connectionSlots ?? 1)
  while (slotStates.length < desired) slotStates.push(createSlotState(slotStates.length))
  if (slotStates.length > desired) slotStates = slotStates.slice(0, desired)
  for (const slot of slotStates) slot.deviceId = `${config.baseDeviceId}_slot_${slot.index}`
  return slotStates
}

function activeSlotCount() {
  return slotStates.filter(slot => slot.running).length
}

function getAggregateStats() {
  return slotStates.reduce((acc, slot) => {
    acc.bytesServed += slot.sessionBytes
    acc.requestsHandled += slot.requestsHandled
    return acc
  }, { bytesServed: 0, requestsHandled: 0 })
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

function syncAggregateState() {
  const aggregate = getAggregateStats()
  running = activeSlotCount() > 0
  stats = {
    bytesServed: aggregate.bytesServed,
    requestsHandled: aggregate.requestsHandled,
    connectedAt: slotStates.find(slot => slot.connectedAt)?.connectedAt ?? null,
  }
  updateProviderSleepBlocker()
}

function getSlotWarning(slots) {
  if (slots > 16) return 'Very high resource usage - recommended for servers or dedicated machines only.'
  if (slots > 8) return 'High resource usage - ensure a stable connection.'
  return null
}

function syncTodaySharedBytesDay() {
  const today = new Date().toISOString().slice(0, 10)
  if (config.todaySharedBytesDate !== today) {
    config.todaySharedBytesDate = today
    config.todaySharedBytes = 0
    limitHit = false
  }
}

function getDailyLimitBytes() {
  if (config.dailyShareLimitMb == null) return null
  return config.dailyShareLimitMb * 1024 * 1024
}

function enforceLocalLimit() {
  syncTodaySharedBytesDay()
  const limitBytes = getDailyLimitBytes()
  if (!limitBytes || limitHit || config.todaySharedBytes == null) return
  const totalToday = (config.todaySharedBytes ?? 0) + getAggregateStats().bytesServed
  if (totalToday < limitBytes) return

  limitHit = true
  log.warn('LIMIT', 'daily limit reached', { totalToday, limitBytes })
  showNotification('PeerMesh paused', `Daily share limit reached (${formatBytes(limitBytes)})`)
  stopRelay()
}

function normalizePrivateShareRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.filter(row => row && typeof row === 'object')
}

function getSyncTimestamp(value) {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function preferLatestSyncRow(current, candidate) {
  if (!candidate) return current ?? null
  if (!current) return candidate
  const currentTs = getSyncTimestamp(current.state_changed_at)
  const candidateTs = getSyncTimestamp(candidate.state_changed_at)
  if (candidateTs > currentTs) return candidate
  if (candidateTs < currentTs) return current
  return current
}

function createDisabledPrivateShareRow(deviceId, slotIndex = null) {
  const resolvedBaseDeviceId = config.baseDeviceId || deviceId.replace(/_slot_\d+$/, '')
  return {
    device_id: deviceId,
    base_device_id: resolvedBaseDeviceId,
    slot_index: slotIndex,
    code: '',
    enabled: false,
    expires_at: null,
    active: false,
    state_actor: null,
    state_changed_at: null,
  }
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
      base_device_id: row.base_device_id || config.baseDeviceId || deviceId.replace(/_slot_\d+$/, ''),
      slot_index: Number.isInteger(row.slot_index) ? row.slot_index : null,
      code: typeof row.code === 'string' ? row.code : '',
      enabled: !!row.enabled,
      expires_at: row.expires_at ?? null,
      active: !!row.active,
      state_actor: row.state_actor ?? null,
      state_changed_at: row.state_changed_at ?? null,
    }
    byDeviceId.set(deviceId, preferLatestSyncRow(byDeviceId.get(deviceId), normalizedRow) ?? normalizedRow)
  }

  const hydratedRows = ensureSlotStates().map(slot => {
    // Always use the server row if present; never inherit another slot's data for a new slot
    return byDeviceId.get(slot.deviceId) ?? createDisabledPrivateShareRow(slot.deviceId, slot.index)
  })

  for (const row of byDeviceId.values()) {
    if (!hydratedRows.some(candidate => candidate.device_id === row.device_id)) hydratedRows.push(row)
  }

  return hydratedRows
}

function normalizeSlotLimitRows(rows) {
  if (!Array.isArray(rows)) return []
  const byDeviceId = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.device_id !== 'string') continue
    const normalizedRow = {
      ...row,
      state_actor: row.state_actor ?? null,
      state_changed_at: row.state_changed_at ?? null,
    }
    byDeviceId.set(row.device_id, preferLatestSyncRow(byDeviceId.get(row.device_id), normalizedRow) ?? normalizedRow)
  }
  return [...byDeviceId.values()]
}

function getDefaultPrivateShareDeviceId() {
  if (typeof config.privateShareDeviceId === 'string' && config.privateShareDeviceId.trim()) {
    return config.privateShareDeviceId.trim()
  }
  const rows = hydratePrivateShareRows(config.privateShares)
  return rows[0]?.device_id ?? config.privateShare?.device_id ?? config.baseDeviceId ?? null
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

function applySharingProfileData(data, { source = 'remote' } = {}) {
  const previousPrivateShareEnabled = !!config.privateShare?.enabled
  const previousPrivateShareActive = !!config.privateShareActive
  const previousPrivateShareCode = config.privateShare?.code ?? null
  const previousConnectionSlots = clampSlots(config.connectionSlots ?? 1)
  const previousProfileSync = config.profileSync ?? null
  const previousConnectionSlotsSync = config.connectionSlotsSync ?? null
  const uptimeScheduleChanged = applyUptimeScheduleData(data.uptime_schedule, { source })

  const nextPrivateShare = data.private_share ?? null
  const nextPrivateShares = hydratePrivateShareRows([
    ...(data.private_shares ?? (nextPrivateShare ? [nextPrivateShare] : [])),
    ...config.privateShares,
  ])
  const selectedPrivateShare = selectPrivateShareRow(nextPrivateShares, config.privateShareDeviceId)
  const nextPrivateShareEnabled = !!(selectedPrivateShare ?? nextPrivateShare)?.enabled
  const nextPrivateShareActive = !!(selectedPrivateShare ?? nextPrivateShare)?.active
  const nextPrivateShareCode = (selectedPrivateShare ?? nextPrivateShare)?.code ?? null

  const resolvedProfileSync = preferLatestSyncRow(previousProfileSync, data.profile_sync ?? null)
  const resolvedConnectionSlotsSync = preferLatestSyncRow(previousConnectionSlotsSync, data.connection_slots_sync ?? null)
  const shouldApplyConnectionSlots = (resolvedConnectionSlotsSync
    ? getSyncTimestamp(resolvedConnectionSlotsSync?.state_changed_at) >= getSyncTimestamp(previousConnectionSlotsSync?.state_changed_at)
    : true) && (Date.now() - _localSlotChangeAt > LOCAL_SLOT_CHANGE_GRACE_MS)

  config.profileSync = resolvedProfileSync
  config.connectionSlotsSync = resolvedConnectionSlotsSync
  config.privateShares = nextPrivateShares
  config.privateShare = selectedPrivateShare ?? nextPrivateShare
  config.privateShareDeviceId = config.privateShare?.device_id ?? config.privateShare?.base_device_id ?? config.privateShareDeviceId ?? null
  config.privateShareActive = !!(config.privateShare?.enabled && config.privateShare?.active)
  config.slotLimits = normalizeSlotLimitRows([
    ...config.slotLimits,
    ...(data.slot_limits ?? []),
  ])
  if (data.has_accepted_provider_terms === true) config.hasAcceptedProviderTerms = true
  if (shouldApplyConnectionSlots && Number.isInteger(data.connection_slots)) {
    config.connectionSlots = clampSlots(data.connection_slots)
    ensureSlotStates()
  }
  limitHit = data.daily_limit_bytes == null
    ? false
    : ((config.todaySharedBytes ?? 0) + getAggregateStats().bytesServed) >= data.daily_limit_bytes
  saveConfig()

  if (limitHit && config.shareEnabled) enforceLocalLimit()
  if (uptimeScheduleChanged) {
    _lastScheduleInWindow = null
    void runSharingScheduleTick('schedule_sync')
    void applyScheduleWakeIntegration('schedule_sync')
  }

  // Enforce per-slot daily limits and private share expiry
  if (config.shareEnabled || activeSlotCount() > 0) {
    const slotLimitMap = new Map(config.slotLimits.map(r => [r.device_id, r]))
    for (const slot of slotStates) {
      if (!slot.running) continue
      // Per-slot daily limit
      const slotLimit = slotLimitMap.get(slot.deviceId)
      if (slotLimit?.daily_limit_mb != null) {
        const slotLimitBytes = slotLimit.daily_limit_mb * 1024 * 1024
        const slotBytes = (slot.sessionBytes ?? 0)
        if (slotBytes >= slotLimitBytes) {
          log.warn('LIMIT', 'slot daily limit reached - stopping relay', { slot: slot.index, slotBytes, slotLimitBytes })
          showNotification('PeerMesh paused', `Slot ${slot.index + 1} daily limit reached`)
          stopRelay()
          return data
        }
      }
      // Private share expiry: if slot is private and code has expired, disable and reconnect
      const psRow = nextPrivateShares.find(r => r.device_id === slot.deviceId)
      if (psRow?.enabled && psRow?.expires_at) {
        if (new Date(psRow.expires_at).getTime() <= Date.now()) {
          log.warn('PRIVATE', 'private share expired - reconnecting slot as public', { slot: slot.index, deviceId: slot.deviceId })
          restartRelayForConfigChange('private_share_expired', 'A private share expired. Reconnecting.')
          return data
        }
      }
    }
  }

  const privacyToggleChanged = previousPrivateShareEnabled !== nextPrivateShareEnabled
  const visibilityChanged = previousPrivateShareActive !== nextPrivateShareActive || previousPrivateShareCode !== nextPrivateShareCode

  if (privacyToggleChanged && (config.shareEnabled || activeSlotCount() > 0)) {
    log.info('PRIVATE', 'private sharing mode changed - reconnecting provider', {
      source,
      from: previousPrivateShareEnabled,
      to: nextPrivateShareEnabled,
    })
    restartRelayForConfigChange('private_share_sync', 'Private sharing changed. Reconnecting to apply the new mode.')
  } else if (visibilityChanged) {
    log.info('PRIVATE', 'private sharing state synced', {
      source,
      enabled: nextPrivateShareEnabled,
      active: nextPrivateShareActive,
      codeChanged: previousPrivateShareCode !== nextPrivateShareCode,
    })
    updateTray()
  }

  if (shouldApplyConnectionSlots && config.connectionSlots !== previousConnectionSlots) {
    log.info('SLOTS', 'connection slot count synced from database', {
      source,
      from: previousConnectionSlots,
      to: config.connectionSlots,
    })
    if (config.shareEnabled || activeSlotCount() > 0) {
      // Stop only slots that are no longer needed (scale down) or add new ones (scale up)
      // without a full stop/start cycle that causes a race where only 1 slot reconnects.
      const desired = clampSlots(config.connectionSlots)
      // Stop excess slots
      for (let i = desired; i < slotStates.length; i++) {
        const slot = slotStates[i]
        if (slot.reconnectTimer) { clearTimeout(slot.reconnectTimer); slot.reconnectTimer = null }
        stopHeartbeat(slot)
        if (slot.ws) { slot.ws.removeAllListeners('close'); slot.ws.close(1000); slot.ws = null }
        closeAllTunnels(slot, false)
        slot.running = false
        slot.connectedAt = null
      }
      ensureSlotStates()
      // Connect any new slots
      for (let i = previousConnectionSlots; i < desired; i++) {
        if (slotStates[i]) connectSlot(slotStates[i])
      }
      syncAggregateState()
      updateTray()
    } else {
      updateTray()
    }
  }

  return data
}

async function pollTodayBytes() {
  if (!config.token) return null
  syncTodaySharedBytesDay()
  logRequest('GET', `${API_BASE}/api/user/sharing`)
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing${config.baseDeviceId ? `?baseDeviceId=${encodeURIComponent(config.baseDeviceId)}` : ''}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(4000),
    })
    logResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
    if (res.status === 401 || res.status === 403) {
      await confirmDesktopAuthStillValid('poll_today_bytes', res.status, { preserveWhileSharing: true })
      return null
    }
    if (!res.ok) return null
    const data = await res.json()
    return applySharingProfileData(data, { source: 'pollTodayBytes' })
  } catch (e) {
    log.warn('API', 'pollTodayBytes failed', { err: e.message })
    return null
  }
}

function sendRelayMessage(slot, data) {
  if (slot.ws?.readyState === WebSocket.OPEN) slot.ws.send(JSON.stringify(data))
}

function closeTunnel(slot, tunnelId, notifyRelay = false) {
  const tunnel = slot.activeTunnels.get(tunnelId)
  if (!tunnel || tunnel.closed) return
  tunnel.closed = true
  slot.activeTunnels.delete(tunnelId)
  activeTunnels.delete(tunnelId)
  if (notifyRelay) sendRelayMessage(slot, { type: 'tunnel_close', tunnelId })
  if (!tunnel.socket.destroyed) tunnel.socket.destroy()
  syncAggregateState()
  logTunnel('CLOSED', tunnelId, { notifyRelay, remaining: activeTunnels.size, slot: slot.index })
}

function closeAllTunnels(slot, notifyRelay = false) {
  const count = slot.activeTunnels.size
  for (const tunnelId of [...slot.activeTunnels.keys()]) closeTunnel(slot, tunnelId, notifyRelay)
  if (count > 0) log.info('TUNNEL', `closeAllTunnels Ã¢â‚¬â€ closed ${count} tunnels`)
}

function closeAllSlotTunnels(notifyRelay = false) {
  for (const slot of slotStates) closeAllTunnels(slot, notifyRelay)
}

function getDefaultLaunchOnStartup() {
  try {
    return app.getLoginItemSettings().openAtLogin === true
  } catch {
    return false
  }
}

function applyLaunchOnStartupPreference(enabled = config.launchOnStartup) {
  config.launchOnStartup = !!enabled
  try {
    if (!app.isPackaged) {
      log.debug('CONFIG', 'launch-on-startup preference stored locally (dev mode)', { enabled: config.launchOnStartup })
      return { enabled: config.launchOnStartup, applied: false }
    }
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: config.launchOnStartup,
        openAsHidden: config.launchOnStartup,
        path: process.execPath,
        args: config.launchOnStartup ? ['--background'] : [],
      })
    } else if (process.platform === 'darwin') {
      app.setLoginItemSettings({
        openAtLogin: config.launchOnStartup,
        openAsHidden: config.launchOnStartup,
      })
    }
    log.info('CONFIG', 'launch-on-startup preference applied', { enabled: config.launchOnStartup, platform: process.platform })
    return { enabled: config.launchOnStartup, applied: true }
  } catch (e) {
    log.warn('CONFIG', 'launch-on-startup preference apply failed', { enabled: config.launchOnStartup, err: e.message })
    return { enabled: config.launchOnStartup, applied: false, error: e.message }
  }
}

function isProviderSleepBlockerActive() {
  return _providerSleepBlockerId !== null && powerSaveBlocker.isStarted(_providerSleepBlockerId)
}

function stopProviderSleepBlocker() {
  if (_providerSleepBlockerId === null) return
  try {
    if (powerSaveBlocker.isStarted(_providerSleepBlockerId)) {
      powerSaveBlocker.stop(_providerSleepBlockerId)
    }
    log.info('POWER', 'provider sleep blocker stopped')
  } catch (e) {
    log.warn('POWER', 'provider sleep blocker stop failed', { err: e.message })
  }
  _providerSleepBlockerId = null
}

function updateProviderSleepBlocker() {
  const shouldBlock = !!config.preventSleepWhileSharing && (!!config.shareEnabled || running || peerSharing)
  if (shouldBlock && !isProviderSleepBlockerActive()) {
    try {
      _providerSleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      log.info('POWER', 'provider sleep blocker started', { id: _providerSleepBlockerId })
    } catch (e) {
      _providerSleepBlockerId = null
      log.warn('POWER', 'provider sleep blocker start failed', { err: e.message })
    }
    return
  }

  if (!shouldBlock) stopProviderSleepBlocker()
}

function setPreventSleepWhileSharingPreference(enabled) {
  config.preventSleepWhileSharing = !!enabled
  saveConfig()
  updateProviderSleepBlocker()
  updateTray()
  return { enabled: config.preventSleepWhileSharing, active: isProviderSleepBlockerActive() }
}

function getSystemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}

function getDefaultSharingSchedule() {
  return {
    enabled: false,
    startTime: '00:00',
    endTime: '00:00',
    timezone: getSystemTimeZone(),
  }
}

function normalizeScheduleTime(value, fallback = '00:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return fallback
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function normalizeScheduleTimezone(value) {
  const fallback = getSystemTimeZone()
  const timezone = String(value || fallback).trim()
  if (!timezone || timezone === 'local') return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return fallback
  }
}

function normalizeSharingSchedule(raw = {}) {
  const defaults = getDefaultSharingSchedule()
  return {
    enabled: raw?.enabled === true,
    startTime: normalizeScheduleTime(raw?.startTime, defaults.startTime),
    endTime: normalizeScheduleTime(raw?.endTime, defaults.endTime),
    timezone: normalizeScheduleTimezone(raw?.timezone ?? defaults.timezone),
  }
}

function compareVersions(a, b) {
  const aParts = String(a || '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const bParts = String(b || '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function getDesktopDownloadPlatform() {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'linux') return 'linux'
  return 'win'
}

function getDesktopDownloadUrl(platform = getDesktopDownloadPlatform()) {
  return `${API_BASE}/api/desktop-download?platform=${encodeURIComponent(platform)}`
}

async function checkDesktopUpdate(reason = 'manual') {
  if (_desktopUpdateBusy) return _desktopUpdateState
  _desktopUpdateBusy = true
  const platform = getDesktopDownloadPlatform()
  try {
    const res = await fetch(`${API_BASE}/api/version`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) throw new Error(`status=${res.status}`)
    const data = await res.json().catch(() => ({}))
    const platformInfo = data?.downloads?.desktop?.[platform] ?? null
    const latestVersion = typeof platformInfo?.version === 'string'
      ? platformInfo.version
      : (typeof data.desktop === 'string' ? data.desktop : null)
    const downloadPath = typeof platformInfo?.url === 'string' ? platformInfo.url : `/api/desktop-download?platform=${platform}`
    const downloadUrl = downloadPath.startsWith('http') ? downloadPath : `${API_BASE}${downloadPath}`
    _desktopUpdateState = {
      checkedAt: new Date().toISOString(),
      currentVersion: DESKTOP_VERSION,
      latestVersion,
      updateAvailable: !!latestVersion && compareVersions(latestVersion, DESKTOP_VERSION) > 0,
      downloadUrl,
      platform,
      error: null,
    }
    log.info('UPDATE', 'desktop update check completed', { reason, currentVersion: DESKTOP_VERSION, latestVersion, updateAvailable: _desktopUpdateState.updateAvailable })
    return _desktopUpdateState
  } catch (e) {
    _desktopUpdateState = {
      checkedAt: new Date().toISOString(),
      currentVersion: DESKTOP_VERSION,
      latestVersion: null,
      updateAvailable: false,
      downloadUrl: getDesktopDownloadUrl(platform),
      platform,
      error: e.message,
    }
    log.warn('UPDATE', 'desktop update check failed', { reason, err: e.message })
    return _desktopUpdateState
  } finally {
    _desktopUpdateBusy = false
  }
}

async function openDesktopUpdateDownload() {
  const state = await checkDesktopUpdate('download')
  const url = state?.downloadUrl || getDesktopDownloadUrl()
  await shell.openExternal(url)
  return { success: true, update: _desktopUpdateState }
}

function normalizeRemoteSharingSchedule(raw = {}) {
  return normalizeSharingSchedule({
    enabled: raw?.enabled,
    startTime: raw?.startTime ?? raw?.start_time,
    endTime: raw?.endTime ?? raw?.end_time,
    timezone: raw?.timezone,
  })
}

function applyUptimeScheduleData(raw, { source = 'remote' } = {}) {
  if (!raw || typeof raw !== 'object') return false
  const incomingSync = {
    state_actor: raw.state_actor ?? null,
    state_changed_at: raw.state_changed_at ?? null,
  }
  const currentSync = config.uptimeScheduleSync ?? null
  if (getSyncTimestamp(incomingSync.state_changed_at) < getSyncTimestamp(currentSync?.state_changed_at)) {
    return false
  }

  const previousSchedule = normalizeSharingSchedule(config.sharingSchedule)
  const nextSchedule = normalizeRemoteSharingSchedule(raw)
  const wakeEnabled = raw.wakeEnabled ?? raw.wake_enabled
  const nextWakeEnabled = typeof wakeEnabled === 'boolean' ? wakeEnabled : !!config.scheduleWakeEnabled
  const allowOnDemandWake = raw.allowOnDemandWake ?? raw.allow_on_demand_wake
  const nextAllowOnDemandWake = typeof allowOnDemandWake === 'boolean' ? allowOnDemandWake : !!config.allowOnDemandWake
  const allowPrivateOnDemandStart = raw.allowPrivateOnDemandStart ?? raw.allow_private_on_demand_start
  const nextAllowPrivateOnDemandStart = typeof allowPrivateOnDemandStart === 'boolean' ? allowPrivateOnDemandStart : !!config.allowPrivateOnDemandStart
  const scheduleChanged = JSON.stringify(previousSchedule) !== JSON.stringify(nextSchedule)
  const wakeChanged = !!config.scheduleWakeEnabled !== !!nextWakeEnabled
  const onDemandChanged = !!config.allowOnDemandWake !== !!nextAllowOnDemandWake
  const privateOnDemandChanged = !!config.allowPrivateOnDemandStart !== !!nextAllowPrivateOnDemandStart

  config.sharingSchedule = nextSchedule
  config.scheduleWakeEnabled = !!nextWakeEnabled
  config.allowOnDemandWake = !!nextAllowOnDemandWake
  config.allowPrivateOnDemandStart = !!nextAllowPrivateOnDemandStart
  config.uptimeScheduleSync = preferLatestSyncRow(currentSync, incomingSync)
  if (scheduleChanged || wakeChanged || onDemandChanged || privateOnDemandChanged) {
    log.info('SCHEDULE', 'uptime schedule synced', {
      source,
      enabled: nextSchedule.enabled,
      startTime: nextSchedule.startTime,
      endTime: nextSchedule.endTime,
      timezone: nextSchedule.timezone,
      wakeEnabled: !!config.scheduleWakeEnabled,
      allowOnDemandWake: !!config.allowOnDemandWake,
      allowPrivateOnDemandStart: !!config.allowPrivateOnDemandStart,
    })
  }
  return scheduleChanged || wakeChanged || onDemandChanged || privateOnDemandChanged
}

function quotePowerShellString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

function runProcess(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error(`${command} timed out`))
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error((stderr || stdout || `${command} exited ${code}`).trim()))
      }
    })
  })
}

function scheduleTimeToMinutes(timeValue) {
  const normalized = normalizeScheduleTime(timeValue)
  const [hours, minutes] = normalized.split(':').map(part => Number.parseInt(part, 10))
  return hours * 60 + minutes
}

function getScheduleNowMinutes(schedule, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    const hours = Number.parseInt(parts.find(part => part.type === 'hour')?.value ?? '0', 10)
    const minutes = Number.parseInt(parts.find(part => part.type === 'minute')?.value ?? '0', 10)
    return hours * 60 + minutes
  } catch {
    const local = new Date(now)
    return local.getHours() * 60 + local.getMinutes()
  }
}

function isSharingScheduleAlwaysOn(schedule) {
  return schedule.enabled && schedule.startTime === schedule.endTime
}

function getNextScheduleStartDate(schedule, now = new Date()) {
  const normalized = normalizeSharingSchedule(schedule)
  const [hours, minutes] = normalized.startTime.split(':').map(part => Number.parseInt(part, 10))
  const candidate = new Date(now)
  candidate.setHours(hours, minutes, 0, 0)
  if (candidate.getTime() <= now.getTime() + 120_000) {
    candidate.setDate(candidate.getDate() + 1)
  }
  return candidate
}

function isInsideSharingSchedule(schedule, now = new Date()) {
  if (!schedule.enabled) return false
  if (isSharingScheduleAlwaysOn(schedule)) return true
  const start = scheduleTimeToMinutes(schedule.startTime)
  const end = scheduleTimeToMinutes(schedule.endTime)
  const current = getScheduleNowMinutes(schedule, now)
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}

function getSharingSchedulePublicState() {
  const schedule = normalizeSharingSchedule(config.sharingSchedule)
  const active = isInsideSharingSchedule(schedule)
  return {
    ...schedule,
    active,
    alwaysOn: isSharingScheduleAlwaysOn(schedule),
  }
}

function getWakeLaunchTarget() {
  if (app.isPackaged) {
    return { executable: process.execPath, args: '--background' }
  }
  const appPath = app.getAppPath().replace(/"/g, '\\"')
  return { executable: process.execPath, args: `"${appPath}" --background` }
}

function getScheduleWakePublicState() {
  return {
    enabled: !!config.scheduleWakeEnabled,
    supported: ['win32', 'darwin', 'linux'].includes(process.platform),
    platform: process.platform,
    status: config.scheduleWakeStatus ?? null,
  }
}

async function registerWindowsScheduleWakeTask(schedule) {
  const launch = getWakeLaunchTarget()
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$taskName = ${quotePowerShellString(WINDOWS_WAKE_TASK_NAME)}`,
    `$execute = ${quotePowerShellString(launch.executable)}`,
    `$arguments = ${quotePowerShellString(launch.args)}`,
    '$action = New-ScheduledTaskAction -Execute $execute -Argument $arguments',
    `$trigger = New-ScheduledTaskTrigger -Daily -At ${quotePowerShellString(schedule.startTime)}`,
    '$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    '$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel LeastPrivilege',
    "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Wakes this PC so PeerMesh can start scheduled sharing.' -Force | Out-Null",
  ].join('; ')
  await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
  return {
    supported: true,
    taskName: WINDOWS_WAKE_TASK_NAME,
    message: 'Windows Task Scheduler wake task registered',
  }
}

async function unregisterWindowsScheduleWakeTask() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$taskName = ${quotePowerShellString(WINDOWS_WAKE_TASK_NAME)}`,
    'Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null',
  ].join('; ')
  await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 10000 })
  return {
    supported: true,
    taskName: WINDOWS_WAKE_TASK_NAME,
    message: 'Windows Task Scheduler wake task removed',
  }
}

async function applyScheduleWakeIntegration(reason = 'sync') {
  if (_scheduleWakeSyncBusy) return config.scheduleWakeStatus ?? { platform: process.platform, skipped: true }
  _scheduleWakeSyncBusy = true
  const schedule = normalizeSharingSchedule(config.sharingSchedule)
  config.sharingSchedule = schedule
  const now = new Date().toISOString()

  try {
    if (!config.scheduleWakeEnabled || !schedule.enabled) {
      let disabledResult = { supported: ['win32', 'darwin', 'linux'].includes(process.platform), message: 'OS wake disabled' }
      if (!schedule.enabled) config.scheduleWakeEnabled = false
      if (process.platform === 'win32') {
        try {
          await unregisterWindowsHardwareWakeTask({ runProcess })
          disabledResult = await unregisterWindowsScheduleWakeTask()
        } catch (e) {
          disabledResult = { supported: true, error: e.message, message: 'Could not remove Windows wake task' }
        }
      }
      config.scheduleWakeStatus = {
        ...disabledResult,
        enabled: false,
        platform: process.platform,
        reason,
        updatedAt: now,
      }
      saveConfig()
      return config.scheduleWakeStatus
    }

    if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
      config.scheduleWakeStatus = {
        enabled: false,
        supported: false,
        platform: process.platform,
        reason,
        updatedAt: now,
        error: 'Automatic OS wake registration is not supported on this platform.',
      }
      config.scheduleWakeEnabled = false
      saveConfig()
      return config.scheduleWakeStatus
    }

    const systemTimezone = getSystemTimeZone()
    if (schedule.timezone !== systemTimezone) {
      config.scheduleWakeStatus = {
        enabled: false,
        supported: true,
        platform: process.platform,
        reason,
        updatedAt: now,
        error: `OS wake uses the system timezone. Set the schedule timezone to ${systemTimezone} to enable hardware wake.`,
      }
      config.scheduleWakeEnabled = false
      saveConfig()
      return config.scheduleWakeStatus
    }

    const wakeAt = getNextScheduleStartDate(schedule)
    const battery = await readBatteryStatus({ platform: process.platform, runProcess })
    const result = await scheduleHardwareWake({
      wakeAt,
      battery,
      platform: process.platform,
      launchTarget: getWakeLaunchTarget(),
      runProcess,
    })
    if (!result.success) throw new Error(result.error || 'Could not register OS wake')
    let recurringTaskResult = null
    if (process.platform === 'win32') {
      recurringTaskResult = await registerWindowsScheduleWakeTask(schedule)
    }
    config.scheduleWakeStatus = {
      ...result,
      recurringTask: recurringTaskResult,
      enabled: true,
      platform: process.platform,
      reason,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      timezone: schedule.timezone,
      nextWakeAt: wakeAt.toISOString(),
      updatedAt: now,
    }
    saveConfig()
    return config.scheduleWakeStatus
  } catch (e) {
    config.scheduleWakeStatus = {
      enabled: false,
      supported: ['win32', 'darwin', 'linux'].includes(process.platform),
      platform: process.platform,
      reason,
      updatedAt: now,
      error: e.message,
    }
    config.scheduleWakeEnabled = false
    saveConfig()
    return config.scheduleWakeStatus
  } finally {
    _scheduleWakeSyncBusy = false
  }
}

async function syncSharingScheduleToServer(reason = 'sync') {
  if (_sharingScheduleCloudSyncBusy) return null
  if (!config.token || !config.userId || !config.baseDeviceId) return null
  _sharingScheduleCloudSyncBusy = true
  const schedule = normalizeSharingSchedule(config.sharingSchedule)
  config.sharingSchedule = schedule
  const payload = {
    baseDeviceId: config.baseDeviceId,
    sharingSchedule: {
      ...schedule,
      wakeEnabled: !!config.scheduleWakeEnabled,
      allowOnDemandWake: !!config.allowOnDemandWake,
      allowPrivateOnDemandStart: !!config.allowPrivateOnDemandStart,
      shutdownAfterWindow: false,
    },
  }

  try {
    logRequest('POST', `${API_BASE}/api/user/sharing`, { sharingSchedule: { ...payload.sharingSchedule, reason } })
    const res = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingAuthHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    })
    logResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
    const data = await res.json().catch(() => ({}))
    if (res.status === 401 || res.status === 403) {
      await confirmDesktopAuthStillValid('sync_sharing_schedule', res.status, { preserveWhileSharing: true })
      return null
    }
    if (!res.ok || data.error) throw new Error(data.error || `status=${res.status}`)
    if (data.uptime_schedule) {
      applyUptimeScheduleData(data.uptime_schedule, { source: 'syncSharingScheduleToServer' })
      saveConfig()
    }
    return data
  } catch (e) {
    log.warn('SCHEDULE', 'cloud schedule sync failed', { reason, err: e.message })
    return null
  } finally {
    _sharingScheduleCloudSyncBusy = false
  }
}

function setSharingSchedulePreference(nextSchedule = {}) {
  config.sharingSchedule = normalizeSharingSchedule({ ...config.sharingSchedule, ...nextSchedule })
  saveConfig()
  _lastScheduleInWindow = null
  void runSharingScheduleTick('schedule_changed')
  void applyScheduleWakeIntegration('schedule_changed')
  void syncSharingScheduleToServer('schedule_changed')
  updateTray()
  return { success: true, sharingSchedule: getSharingSchedulePublicState(), state: getPublicState() }
}

async function setScheduleWakeEnabledPreference(enabled) {
  if (enabled && !normalizeSharingSchedule(config.sharingSchedule).enabled) {
    return {
      success: false,
      error: 'Enable scheduled sharing before enabling OS wake.',
      osWake: getScheduleWakePublicState(),
      state: getPublicState(),
    }
  }

  config.scheduleWakeEnabled = !!enabled
  saveConfig()
  const status = await applyScheduleWakeIntegration('preference')
  void syncSharingScheduleToServer('wake_preference')
  updateTray()
  if (enabled && status.error) {
    return { success: false, error: status.error, osWake: getScheduleWakePublicState(), state: getPublicState() }
  }
  return { success: true, osWake: getScheduleWakePublicState(), state: getPublicState() }
}

async function setOnDemandWakeEnabledPreference(enabled) {
  if (enabled && !config.allowPrivateOnDemandStart) {
    return {
      success: false,
      error: 'Enable private on-demand start before enabling on-demand wake.',
      state: getPublicState(),
    }
  }
  config.allowOnDemandWake = !!enabled
  saveConfig()
  void syncSharingScheduleToServer('on_demand_wake_preference')
  updateTray()
  return { success: true, allowOnDemandWake: !!config.allowOnDemandWake, state: getPublicState() }
}

async function setPrivateOnDemandStartPreference(enabled) {
  config.allowPrivateOnDemandStart = !!enabled
  if (!config.allowPrivateOnDemandStart) config.allowOnDemandWake = false
  saveConfig()
  void syncSharingScheduleToServer('private_on_demand_start_preference')
  updateTray()
  return { success: true, allowPrivateOnDemandStart: !!config.allowPrivateOnDemandStart, state: getPublicState() }
}

function shouldScheduleStartSharing() {
  return !!(config.token && config.userId && config.hasAcceptedProviderTerms && !limitHit)
}

async function runSharingScheduleTick(reason = 'interval') {
  if (_sharingScheduleActionBusy) return
  const schedule = normalizeSharingSchedule(config.sharingSchedule)
  config.sharingSchedule = schedule
  if (!schedule.enabled) {
    _lastScheduleInWindow = null
    return
  }

  const inWindow = isInsideSharingSchedule(schedule)
  const alwaysOn = isSharingScheduleAlwaysOn(schedule)
  const enteredWindow = _lastScheduleInWindow !== true && inWindow
  const exitedWindow = _lastScheduleInWindow !== false && !inWindow
  _lastScheduleInWindow = inWindow

  try {
    _sharingScheduleActionBusy = true
    if (inWindow && (enteredWindow || alwaysOn) && !config.shareEnabled && !running && !peerSharing) {
      if (!shouldScheduleStartSharing()) {
        log.warn('SCHEDULE', 'start skipped - provider is not ready', {
          reason,
          hasToken: !!config.token,
          hasUserId: !!config.userId,
          hasAcceptedProviderTerms: !!config.hasAcceptedProviderTerms,
          limitHit,
        })
        return
      }
      log.info('SCHEDULE', 'starting scheduled sharing window', {
        reason,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        timezone: schedule.timezone,
      })
      config.shareEnabled = true
      saveConfig()
      updateTray()
      connectRelay()
      return
    }

    if (!inWindow && exitedWindow && (config.shareEnabled || running)) {
      log.info('SCHEDULE', 'stopping scheduled sharing window', {
        reason,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        timezone: schedule.timezone,
      })
      stopRelay()
    }
  } finally {
    _sharingScheduleActionBusy = false
  }
}

function startSharingScheduleLoop() {
  stopSharingScheduleLoop()
  _lastScheduleInWindow = null
  void runSharingScheduleTick('startup')
  _sharingScheduleTimer = setInterval(() => {
    void runSharingScheduleTick('timer')
  }, 30_000)
}

function stopSharingScheduleLoop() {
  if (!_sharingScheduleTimer) return
  clearInterval(_sharingScheduleTimer)
  _sharingScheduleTimer = null
}

let _savingDailyLimit = false
let _localSlotChangeAt = 0
const LOCAL_SLOT_CHANGE_GRACE_MS = 8000

async function refreshSharingConfig() {
  if (!config.token) return null
  if (_savingDailyLimit) return null
  logRequest('GET', `${API_BASE}/api/user/sharing`)
  const res = await fetch(`${API_BASE}/api/user/sharing${config.baseDeviceId ? `?baseDeviceId=${encodeURIComponent(config.baseDeviceId)}` : ''}`, {
    headers: { 'Authorization': `Bearer ${config.token}` },
    signal: AbortSignal.timeout(4000),
  })
  logResponse('GET', `${API_BASE}/api/user/sharing`, res.status)
  if (res.status === 401 || res.status === 403) {
    _sharingConfigConsecutiveFailures++
    if (_sharingConfigConsecutiveFailures >= AUTH_CLEAR_FAILURE_THRESHOLD) {
      const stillValid = await confirmDesktopAuthStillValid('refresh_sharing_config', res.status, { preserveWhileSharing: true })
      if (stillValid) _sharingConfigConsecutiveFailures = 0
    } else {
      log.warn('API', 'transient auth error - not clearing yet', { status: res.status, count: _sharingConfigConsecutiveFailures })
    }
    return null
  }
  _sharingConfigConsecutiveFailures = 0
  if (!res.ok) throw new Error(`sharing config fetch failed: status=${res.status}`)
  const data = await res.json()
  return applySharingProfileData(data, { source: 'refreshSharingConfig' })
}

async function setDailyShareLimit(limitMb) {
  if (!config.token) throw new Error('Sign in required')

  const normalizedLimit = limitMb == null ? null : parseInt(String(limitMb), 10)
  if (normalizedLimit != null && (!Number.isInteger(normalizedLimit) || normalizedLimit < 1024)) {
    throw new Error('Daily limit must be at least 1024 MB (1 GB), or unset it')
  }

  _savingDailyLimit = true
  try {
  logRequest('POST', `${API_BASE}/api/user/sharing`, { dailyLimitMb: normalizedLimit })
  const res = await fetch(`${API_BASE}/api/user/sharing`, {
    method: 'POST',
    headers: withSharingAuthHeaders(),
    body: JSON.stringify({ dailyLimitMb: normalizedLimit }),
    signal: AbortSignal.timeout(5000),
  })
  logResponse('POST', `${API_BASE}/api/user/sharing`, res.status)

  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) {
    throw new Error('Could not save daily limit - please try again')
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || 'Could not update daily limit')
  }

  config.dailyShareLimitMb = data.daily_share_limit_mb ?? null
  config.profileSync = preferLatestSyncRow(config.profileSync, data.profile_sync ?? null)
  saveConfig()
  limitHit = false
  enforceLocalLimit()
  updateTray()

  return {
    dailyShareLimitMb: config.dailyShareLimitMb,
    state: getPublicState(),
  }
  } finally {
    _savingDailyLimit = false
  }
}

function stopSharingConfigSync() {
  if (!_sharingConfigSyncTimer) return
  clearTimeout(_sharingConfigSyncTimer)
  _sharingConfigSyncTimer = null
}

function startSharingConfigSync() {
  stopSharingConfigSync()
  if (!config.token || !config.userId) return
  _sharingConfigSyncInterval = 5000
  if (!_sharingConfigSyncBusy) {
    _sharingConfigSyncBusy = true
    refreshSharingConfig()
      .catch((e) => log.warn('API', 'sharing config initial sync failed', { err: e.message }))
      .finally(() => { _sharingConfigSyncBusy = false })
  }
  function scheduleTick() {
    _sharingConfigSyncTimer = setTimeout(async () => {
      if (_sharingConfigSyncBusy || !config.token || !config.userId) { scheduleTick(); return }
      _sharingConfigSyncBusy = true
      const prevLimit = config.dailyShareLimitMb
      const prevCode = config.privateShare?.code
      try { await refreshSharingConfig() } catch (e) { log.warn('API', 'sharing config sync tick failed', { err: e.message }) }
      _sharingConfigSyncBusy = false
      const changed = config.dailyShareLimitMb !== prevLimit || config.privateShare?.code !== prevCode
      _sharingConfigSyncInterval = changed ? 5000 : Math.min(_sharingConfigSyncInterval * 2, SHARING_CONFIG_SYNC_MAX)
      scheduleTick()
    }, _sharingConfigSyncInterval)
  }
  scheduleTick()
}

async function completeUptimeJob(job, status, error = null) {
  if (!config.token || !job?.id) return
  try {
    await fetch(`${API_BASE}/api/provider/uptime/jobs`, {
      method: 'POST',
      headers: withSharingAuthHeaders(),
      body: JSON.stringify({
        jobId: job.id,
        baseDeviceId: config.baseDeviceId,
        status,
        error,
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (e) {
    log.warn('SCHEDULE', 'uptime job completion failed', { jobId: job.id, status, err: e.message })
  }
}

async function processUptimeJob(job) {
  const action = job?.action
  if (!['wake', 'start', 'stop'].includes(action)) {
    await completeUptimeJob(job, 'failed', `Unknown action: ${action}`)
    return
  }

  if (action === 'wake') {
    log.info('SCHEDULE', 'wake job observed while app is already running', { jobId: job.id, windowKey: job.windowKey })
    await completeUptimeJob(job, 'completed')
    return
  }

  if (action === 'start') {
    if (config.shareEnabled || running || peerSharing) {
      await completeUptimeJob(job, 'completed')
      return
    }
    if (String(job?.payload?.reason || '').startsWith('on_demand_private')) {
      try { await refreshSharingConfig() } catch (e) { log.warn('SCHEDULE', 'private on-demand refresh failed before start', { jobId: job.id, err: e.message }) }
    }
    if (!shouldScheduleStartSharing()) {
      const err = 'Provider is not ready to start scheduled sharing'
      log.warn('SCHEDULE', err, {
        jobId: job.id,
        hasToken: !!config.token,
        hasUserId: !!config.userId,
        hasAcceptedProviderTerms: !!config.hasAcceptedProviderTerms,
        limitHit,
      })
      await completeUptimeJob(job, 'failed', err)
      return
    }
    log.info('SCHEDULE', 'starting sharing from uptime job', { jobId: job.id, windowKey: job.windowKey })
    config.shareEnabled = true
    saveConfig()
    updateTray()
    connectRelay()
    await completeUptimeJob(job, 'completed')
    return
  }

  log.info('SCHEDULE', 'stopping sharing from uptime job', { jobId: job.id, windowKey: job.windowKey })
  if (config.shareEnabled || running || peerSharing) stopRelay()
  await completeUptimeJob(job, 'completed')
}

async function pollUptimeJobs(reason = 'timer') {
  if (_uptimeJobsBusy || !config.token || !config.userId || !config.baseDeviceId) return 0
  _uptimeJobsBusy = true
  try {
    const res = await fetch(`${API_BASE}/api/provider/uptime/jobs?baseDeviceId=${encodeURIComponent(config.baseDeviceId)}`, {
      headers: {
        ...withSharingAuthHeaders(false),
        'x-peermesh-device': config.baseDeviceId,
      },
      signal: AbortSignal.timeout(6000),
    })
    if (res.status === 401 || res.status === 403) {
      await confirmDesktopAuthStillValid('poll_uptime_jobs', res.status, { preserveWhileSharing: true })
      return 0
    }
    if (!res.ok) throw new Error(`status=${res.status}`)
    const data = await res.json().catch(() => ({}))
    const jobs = Array.isArray(data.jobs) ? data.jobs : []
    if (jobs.length > 0) log.info('SCHEDULE', 'uptime jobs claimed', { reason, count: jobs.length })
    for (const job of jobs) await processUptimeJob(job)
    return jobs.length
  } catch (e) {
    log.warn('SCHEDULE', 'uptime job poll failed', { reason, err: e.message })
    return 0
  } finally {
    _uptimeJobsBusy = false
  }
}

function startUptimeJobLoop() {
  stopUptimeJobLoop()
  _uptimeJobsInterval = 30_000
  if (!config.token || !config.userId) return

  async function tick(reason = 'timer') {
    const claimed = await pollUptimeJobs(reason)
    _uptimeJobsInterval = claimed > 0 ? 30_000 : Math.min(_uptimeJobsInterval * 2, UPTIME_JOBS_SYNC_MAX)
    _uptimeJobsTimer = setTimeout(() => tick('timer'), _uptimeJobsInterval)
  }

  void tick('startup')
}

function stopUptimeJobLoop() {
  if (!_uptimeJobsTimer) return
  clearTimeout(_uptimeJobsTimer)
  _uptimeJobsTimer = null
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Config Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function loadConfig() {
  try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }) } catch {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) }
        log.info('CONFIG', 'loaded', { userId: config.userId || '(none)', shareEnabled: config.shareEnabled, country: config.country, path: CONFIG_FILE })
      } catch (e) {
        const backupPath = path.join(USER_DATA_DIR, `config.corrupt.${Date.now()}.json`)
        try { fs.renameSync(CONFIG_FILE, backupPath) } catch {}
        log.error('CONFIG', 'invalid config reset to defaults', { err: e.message, backupPath })
      }
    } else {
      log.warn('CONFIG', 'no config file found', { path: CONFIG_FILE })
    }
  } catch (e) { log.error('CONFIG', 'loadConfig error', { err: e.message }) }
  const previousExtId = config.extId || null
  const previousBaseDeviceId = config.baseDeviceId || null
  previousLaunchExtId = previousExtId
  config.baseDeviceId = getOrCreateSharedBaseDeviceId(previousBaseDeviceId || previousExtId || createSharedBaseDeviceId())
  config.extId = createDesktopIdentity()
  log.info('CONFIG', 'rotated launch extId', {
    oldExtId: previousExtId,
    extId: config.extId,
    previousBaseDeviceId,
    baseDeviceId: config.baseDeviceId,
    sharedIdentityFile: SHARED_IDENTITY_FILE,
  })
  config.hasAcceptedProviderTerms = !!config.hasAcceptedProviderTerms
  config.refreshToken = config.refreshToken ?? ''
  config.deviceSessionId = config.deviceSessionId ?? ''
  config.connectionSlots = clampSlots(config.connectionSlots ?? 1)
  if (typeof config.launchOnStartup !== 'boolean') config.launchOnStartup = getDefaultLaunchOnStartup()
  // autoShareOnLaunch is an explicit user preference — read it directly from saved config.
  // Never derive it from shareEnabled (which is cleared to false on every shutdown by stopRelay).
  config.autoShareOnLaunch = typeof config.autoShareOnLaunch === 'boolean' ? config.autoShareOnLaunch : false
  config.preventSleepWhileSharing = typeof config.preventSleepWhileSharing === 'boolean' ? config.preventSleepWhileSharing : false
  config.sharingSchedule = normalizeSharingSchedule(config.sharingSchedule)
  config.scheduleWakeEnabled = typeof config.scheduleWakeEnabled === 'boolean' ? config.scheduleWakeEnabled : false
  config.allowOnDemandWake = typeof config.allowOnDemandWake === 'boolean' ? config.allowOnDemandWake : false
  config.allowPrivateOnDemandStart = typeof config.allowPrivateOnDemandStart === 'boolean' ? config.allowPrivateOnDemandStart : false
  config.scheduleWakeStatus = config.scheduleWakeStatus ?? null
  config.privateShareActive = !!config.privateShareActive
  config.privateShare = config.privateShare ?? null
  config.privateShareDeviceId = config.privateShareDeviceId ?? config.privateShare?.device_id ?? null
  config.privateShares = hydratePrivateShareRows(config.privateShares)
  config.slotLimits = normalizeSlotLimitRows(config.slotLimits)
  config.profileSync = config.profileSync ?? null
  config.connectionSlotsSync = config.connectionSlotsSync ?? null
  config.uptimeScheduleSync = config.uptimeScheduleSync ?? null
  config.privateShare = selectPrivateShareRow(config.privateShares, config.privateShareDeviceId) ?? config.privateShare ?? null
  config.privateShareDeviceId = config.privateShare?.device_id ?? config.privateShareDeviceId ?? null
  config.privateShareActive = !!(config.privateShare?.enabled && config.privateShare?.active)
  ensureSlotStates()
  saveConfig()
}

function saveConfig() {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config))
  } catch (e) {
    log.error('CONFIG', 'saveConfig error', { err: e.message, path: CONFIG_FILE })
  }
}

async function verifyStoredDesktopAuth() {
  if (!config.token || !config.userId) return true
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(config.userId)}`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (res.ok) return true
    // Try refresh on 401 before giving up
    if (res.status === 401) {
      const refreshed = await tryRefreshDesktopToken()
      if (refreshed) return true
    }
    // Only clear auth when server explicitly says the device is revoked
    const body = await res.json().catch(() => ({}))
    if (body.revoked === true) {
      log.warn('AUTH', 'stored desktop token revoked', { userId: config.userId })
      await clearDesktopAuth('stored_token_revoked')
      return false
    }
    // Any other error (network blip, 5xx, etc.) — keep credentials, stay signed in
    log.warn('AUTH', 'stored desktop token verify non-ok — keeping auth alive', { status: res.status, userId: config.userId })
    return true
  } catch (e) {
    log.warn('AUTH', 'stored desktop token verify skipped (offline?)', { err: e.message })
    return true
  }
}

let _refreshPromise = null

async function tryRefreshDesktopToken() {
  if (!config.userId || !config.refreshToken || !config.deviceSessionId) return false
  // Deduplicate concurrent refresh calls — all callers share the same in-flight promise
  if (_refreshPromise) return _refreshPromise
  _refreshPromise = (async () => {
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
        if (body.revoked === true) {
          log.warn('AUTH', 'desktop device revoked - clearing auth', { userId: config.userId })
          await clearDesktopAuth('device_revoked')
        }
        return false
      }
      if (!res.ok) return false
      const data = await res.json()
      if (data.token && data.refreshToken && data.deviceSessionId) {
        config.token = data.token
        config.refreshToken = data.refreshToken
        config.deviceSessionId = data.deviceSessionId
        saveConfig()
        log.info('AUTH', 'desktop token refreshed', { userId: config.userId, deviceSessionId: config.deviceSessionId })
        return true
      }
    } catch {}
    return false
  })().finally(() => { _refreshPromise = null })
  return _refreshPromise
}

async function confirmDesktopAuthStillValid(context, status) {
  if (!config.userId) return false
  // Desktop is a persistent sharing agent - never sign out on 401/network errors.
  // Only clearDesktopAuth when server returns { revoked: true } via tryRefreshDesktopToken.
  const refreshed = await tryRefreshDesktopToken()
  if (refreshed) { log.info('AUTH', 'desktop token refreshed', { context }); return true }
  // Refresh failed but not revoked - keep auth alive (network blip, server down, etc.)
  log.warn('AUTH', 'token refresh failed - keeping auth alive', { context, status, userId: config.userId })
  return true
}

async function initializeDesktopRuntime(reason) {
  loadConfig()
  if (previousLaunchExtId && previousLaunchExtId !== config.extId) {
    revokeExtensionAuthToken(previousLaunchExtId).catch(() => {})
  }
  try {
    registerNativeMessagingHost()
  } catch (e) {
    log.warn('NATIVE', 'registerNativeMessagingHost failed during bootstrap', { err: e.message, reason })
  }
  try {
    await verifyStoredDesktopAuth()
  } catch (e) {
    log.warn('AUTH', 'startup auth verify failed', { err: e.message, reason })
  }
  void applyScheduleWakeIntegration('startup')
  startSharingConfigSync()
  void syncSharingScheduleToServer('startup')
  startUptimeJobLoop()
  void checkDesktopUpdate('startup')
}

function shutdownDesktopRuntime(reason = 'quit') {
  if (_shutdownStarted) return
  _shutdownStarted = true
  log.info('PROCESS', 'shutdownDesktopRuntime', { reason })
  logState(`shutdown:${reason}`)
  stopSharingScheduleLoop()
  stopSharingConfigSync()
  stopUptimeJobLoop()
  void flushPendingBytes()
  if (_cliWatchTimer) {
    clearInterval(_cliWatchTimer)
    _cliWatchTimer = null
    log.info('PROCESS', '_cliWatchTimer cleared on shutdown')
  }
  try { suspendRelayForShutdown(reason) } catch (e) { log.warn('PROCESS', 'suspendRelayForShutdown failed', { err: e.message }) }
  try { stopProviderSleepBlocker() } catch (e) { log.warn('PROCESS', 'stopProviderSleepBlocker failed', { err: e.message }) }
  try { closeAllSlotTunnels(false) } catch (e) { log.warn('PROCESS', 'closeAllSlotTunnels during shutdown failed', { err: e.message }) }
  try { controlServer.close(); log.debug('PROCESS', 'controlServer closed') } catch {}
  try { localProxyServer.close(); log.debug('PROCESS', 'localProxyServer closed') } catch {}
}

function getPublicState() {
  syncAggregateState()
  const privateShares = hydratePrivateShareRows(config.privateShares)
  const privateShare = selectPrivateShareRow(privateShares, config.privateShareDeviceId) ?? config.privateShare ?? null
  return {
    running,
    shareEnabled: !!config.shareEnabled,
    config: {
      ...config,
      token: config.token ? '***' : '',
      refreshToken: config.refreshToken ? '***' : '',
    },
    baseDeviceId: config.baseDeviceId || null,
    connectionSlots: clampSlots(config.connectionSlots ?? 1),
    connectionSlotsSync: config.connectionSlotsSync ?? null,
    profileSync: config.profileSync ?? null,
    preventSleepWhileSharing: !!config.preventSleepWhileSharing,
    preventSleepWhileSharingActive: isProviderSleepBlockerActive(),
    sharingSchedule: getSharingSchedulePublicState(),
    osWake: getScheduleWakePublicState(),
    privateShareActive: !!(privateShare?.enabled && privateShare?.active),
    privateShare: privateShare,
    privateShareDeviceId: privateShare?.device_id ?? config.privateShareDeviceId ?? null,
    privateShares: privateShares,
    slots: {
      configured: clampSlots(config.connectionSlots ?? 1),
      active: activeSlotCount(),
      statuses: getSlotSummary(),
      warning: getSlotWarning(clampSlots(config.connectionSlots ?? 1)),
      privateCount: getSlotSummary().filter(s => s.privateActive).length,
    },
    stats,
    version: DESKTOP_VERSION,
    desktopUpdate: _desktopUpdateState,
  }
}

async function persistSharingState(isSharing) {
  if (!config.token) return
  logRequest('POST', `${API_BASE}/api/user/sharing`, { isSharing })
  try {
    const r = await fetch(`${API_BASE}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingAuthHeaders(),
      body: JSON.stringify({ isSharing }),
    })
    logResponse('POST', `${API_BASE}/api/user/sharing`, r.status)
  } catch (e) { log.warn('API', 'persistSharingState failed', { err: e.message }) }
}

async function flushPendingBytes() {
  if (_flushTimer) return
  _flushTimer = setTimeout(async () => {
    _flushTimer = null
    if (!config.token || _pendingBytesByDevice.size === 0) return
    const pendingEntries = [..._pendingBytesByDevice.entries()]
    _pendingBytesByDevice.clear()

    for (const [deviceId, bytes] of pendingEntries) {
      if (!bytes) continue
      logRequest('POST', `${API_BASE}/api/user/sharing`, { bytes, deviceId })
      try {
        const res = await fetch(`${API_BASE}/api/user/sharing`, {
          method: 'POST',
          headers: withSharingAuthHeaders(),
          body: JSON.stringify({ bytes, deviceId }),
        })
        logResponse('POST', `${API_BASE}/api/user/sharing`, res.status, { deviceId })
      } catch (e) {
        log.warn('API', 'flushPendingBytes failed', { err: e.message, deviceId })
      }
    }
  }, 5000)
}

function getPrivateShareExpiryPreset(expiresAt) {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

async function getPrivateShareState(forceRefresh = true) {
  if (!config.token || !config.baseDeviceId) return null
  let latest = null
  if (forceRefresh) latest = await pollTodayBytes().catch(() => null)
  const privateShares = hydratePrivateShareRows(config.privateShares)
  const privateShare = selectPrivateShareRow(privateShares, config.privateShareDeviceId) ?? config.privateShare ?? null
  return {
    privateShare,
    privateShares,
    privateShareDeviceId: privateShare?.device_id ?? config.privateShareDeviceId ?? null,
    expiryPreset: getPrivateShareExpiryPreset(privateShare?.expires_at ?? null),
    slotLimits: normalizeSlotLimitRows(latest?.slot_limits ?? config.slotLimits),
  }
}

async function updatePrivateShareState({ enabled, refresh = false, expiryHours, deviceId } = {}) {
  if (!config.token || !config.baseDeviceId) throw new Error('Sign in required')
  const expiryValue = expiryHours === undefined
    ? undefined
    : (expiryHours === 'none' || expiryHours === null ? null : parseInt(expiryHours, 10))
  const targetDeviceId = deviceId || getDefaultPrivateShareDeviceId()
  if (!targetDeviceId) throw new Error('No private sharing slot is available')

  const previousEnabled = !!config.privateShare?.enabled
  logRequest('POST', `${API_BASE}/api/user/sharing`, {
    privateSharing: {
      deviceId: targetDeviceId,
      baseDeviceId: config.baseDeviceId,
      enabled,
      refresh: refresh === true,
      expiryHours: expiryValue,
    },
  })
  const res = await fetch(`${API_BASE}/api/user/sharing`, {
    method: 'POST',
    headers: withSharingAuthHeaders(),
    body: JSON.stringify({
      privateSharing: {
        deviceId: targetDeviceId,
        baseDeviceId: config.baseDeviceId,
        enabled,
        refresh: refresh === true,
        expiryHours: expiryValue,
      },
    }),
    signal: AbortSignal.timeout(5000),
  })
  logResponse('POST', `${API_BASE}/api/user/sharing`, res.status)
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) {
    const stillValid = await confirmDesktopAuthStillValid('private_share', res.status, { preserveWhileSharing: true })
    throw new Error(stillValid ? 'Could not update private sharing - please try again' : 'Session expired - please sign in again')
  }
  if (!res.ok || data.error) throw new Error(data.error || 'Could not update private sharing')

  config.privateShares = hydratePrivateShareRows([
    ...(data.private_shares ?? (data.private_share ? [data.private_share] : [])),
    ...config.privateShares,
  ])
  // Use targetDeviceId (the slot we just saved) not config.privateShareDeviceId (the previously selected slot)
  config.privateShare = config.privateShares.find(r => r.device_id === targetDeviceId) ?? selectPrivateShareRow(config.privateShares, config.privateShareDeviceId) ?? null
  config.privateShareDeviceId = config.privateShare?.device_id ?? config.privateShareDeviceId ?? null
  config.privateShareActive = !!(config.privateShare?.enabled && config.privateShare?.active)
  saveConfig()

  if (previousEnabled !== !!config.privateShare?.enabled) {
    log.info('PRIVATE', 'private sharing mode changed locally - reconnecting provider', {
      from: previousEnabled,
      to: !!config.privateShare?.enabled,
    })
    restartRelayForConfigChange('private_share_local', 'Private sharing changed. Reconnecting to apply the new mode.')
  }

  updateTray()
  return {
    privateShare: config.privateShare,
    privateShares: hydratePrivateShareRows(config.privateShares),
    privateShareDeviceId: config.privateShareDeviceId ?? null,
    expiryPreset: getPrivateShareExpiryPreset(config.privateShare?.expires_at ?? null),
    slotLimits: normalizeSlotLimitRows(config.slotLimits),
  }
}

async function setSlotDailyShareLimit(limitMb, { deviceId, baseDeviceId } = {}) {
  if (!config.token || !config.baseDeviceId) throw new Error('Sign in required')

  const normalizedLimit = limitMb == null ? null : parseInt(String(limitMb), 10)
  if (normalizedLimit != null && (!Number.isInteger(normalizedLimit) || normalizedLimit < 1024)) {
    throw new Error('Slot limit must be at least 1024 MB (1 GB), or unset it')
  }

  const resolvedBaseDeviceId = String(baseDeviceId || config.baseDeviceId || '').trim()
  const resolvedDeviceId = String(deviceId || config.privateShareDeviceId || getDefaultPrivateShareDeviceId() || '').trim()
  if (!resolvedBaseDeviceId || !resolvedDeviceId) {
    throw new Error('Select a slot before setting a slot limit')
  }

  logRequest('POST', `${API_BASE}/api/user/sharing`, {
    slotDailyLimitMb: normalizedLimit,
    slotDeviceId: resolvedDeviceId,
    baseDeviceId: resolvedBaseDeviceId,
  })

  const res = await fetch(`${API_BASE}/api/user/sharing`, {
    method: 'POST',
    headers: withSharingAuthHeaders(),
    body: JSON.stringify({
      slotDailyLimitMb: normalizedLimit,
      slotDeviceId: resolvedDeviceId,
      baseDeviceId: resolvedBaseDeviceId,
    }),
    signal: AbortSignal.timeout(5000),
  })
  logResponse('POST', `${API_BASE}/api/user/sharing`, res.status)

  const data = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) {
    const stillValid = await confirmDesktopAuthStillValid('slot_daily_limit', res.status, { preserveWhileSharing: true })
    throw new Error(stillValid ? 'Could not update slot daily limit - please try again' : 'Session expired - please sign in again')
  }
  if (!res.ok || data.error) throw new Error(data.error || 'Could not update slot daily limit')

  config.slotLimits = normalizeSlotLimitRows([
    ...config.slotLimits,
    ...(data.slot_limits ?? []),
  ])
  saveConfig()

  return {
    slotLimits: normalizeSlotLimitRows(config.slotLimits),
    state: getPublicState(),
  }
}

async function applyConnectionSlots(nextSlots, { syncPeer = true, actor = SHARING_ACTOR } = {}) {
  const normalizedSlots = clampSlots(nextSlots)
  const shouldResumeLocal = !!config.shareEnabled

  _localSlotChangeAt = Date.now()
  config.connectionSlots = normalizedSlots
  ensureSlotStates()
  saveConfig()

  if (config.token && config.baseDeviceId) {
    try {
      logRequest('POST', `${API_BASE}/api/user/sharing`, {
        connectionSlots: normalizedSlots,
        baseDeviceId: config.baseDeviceId,
      })
      const response = await fetch(`${API_BASE}/api/user/sharing`, {
        method: 'POST',
        headers: withSharingAuthHeaders(true, actor),
        body: JSON.stringify({
          connectionSlots: normalizedSlots,
          baseDeviceId: config.baseDeviceId,
        }),
        signal: AbortSignal.timeout(5000),
      })
      logResponse('POST', `${API_BASE}/api/user/sharing`, response.status)
      if (response.ok) {
        const data = await response.json().catch(() => null)
        config.connectionSlotsSync = preferLatestSyncRow(config.connectionSlotsSync, data?.connection_slots_sync ?? null)
        saveConfig()
        await pollTodayBytes().catch(() => {})
      }
    } catch (e) {
      log.warn('SLOTS', 'remote slot cleanup sync failed', { err: e.message, slots: normalizedSlots })
    }
  }

  let peerState = null
  if (syncPeer && peerPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${peerPort}/native/connection-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: normalizedSlots, _fromPeer: true, actor }),
        signal: AbortSignal.timeout(2500),
      })
      if (response.ok) peerState = await response.json().catch(() => null)
    } catch (e) {
      log.warn('CONTROL', 'peer slot sync failed', { err: e.message, peerPort, slots: normalizedSlots })
    }
  }

  if (shouldResumeLocal) {
    stopRelay()
    config.shareEnabled = true
    saveConfig()
    connectRelay()
  } else {
    updateTray()
  }

  const state = getPublicState()
  if (peerState?.slots) {
    state.peerSlots = peerState.slots
    state.peerConnectionSlots = peerState.connectionSlots ?? peerState.slots.configured
    state.peerPrivateShareActive = !!peerState.privateShareActive
  }

  return { success: true, slots: normalizedSlots, state }
}

function getNativeHostManifestPath() {
  if (process.platform === 'win32') return path.join(app.getPath('userData'), 'native-messaging', `${NATIVE_HOST_NAME}.json`)
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
  return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
}

function registerNativeMessagingHost() {
  try {
    const manifestPath = getNativeHostManifestPath()
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: NATIVE_HOST_NAME, description: 'PeerMesh desktop helper',
      path: process.execPath, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN],
    }, null, 2))
    if (process.platform === 'win32') {
      spawnSync('reg', ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' })
    }
    log.info('NATIVE', 'registered native messaging host', { manifestPath })
  } catch (err) { log.error('NATIVE', 'registerNativeMessagingHost failed', { err: err.message }) }
}

function writeNativeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(header)
  process.stdout.write(body)
}

function launchMainApp() {
  const args = app.isPackaged ? ['--background'] : [app.getAppPath(), '--background']
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  log.info('PROCESS', 'launchMainApp Ã¢â‚¬â€ spawned background process')
}

async function waitForControlServer(timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) { log.info('CONTROL', 'control server ready', { elapsed: Date.now() - started }); return true }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  log.warn('CONTROL', 'waitForControlServer timed out', { timeoutMs })
  return false
}

async function callControl(pathname, { method = 'GET', body } = {}) {
  const init = { method, signal: AbortSignal.timeout(4000), headers: {} }
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) }
  logRequest(method, `localhost:${CONTROL_PORT}${pathname}`, body)
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${pathname}`, init)
  const text = await res.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch {}
  logResponse(method, `localhost:${CONTROL_PORT}${pathname}`, res.status, data)
  if (!res.ok) throw new Error(data.error || `Control request failed (${res.status})`)
  return data
}

async function getNativeState() {
  try { return await callControl('/native/state') } catch {
    return { available: true, running: false, shareEnabled: false, configured: false, version: DESKTOP_VERSION }
  }
}

async function ensureDesktopApp() {
  try { await callControl('/native/state'); return true } catch {}
  launchMainApp()
  return waitForControlServer()
}

async function handleNativeHostMessage(message) {
  log.info('NATIVE', `nativeHost message: ${message.type}`, { payload: message.payload ? Object.keys(message.payload) : undefined })
  switch (message.type) {
    case 'status': return { success: true, ...(await getNativeState()) }
    case 'sync_auth': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/auth', { method: 'POST', body: message.payload || {} })) } }
    case 'start_sharing': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/share/start', { method: 'POST', body: message.payload || {} })) } }
    case 'stop_sharing': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/share/stop', { method: 'POST' })) } }
    case 'show_app': { const ok = await ensureDesktopApp(); if (!ok) return { success: false, error: 'Desktop helper did not start' }; return { success: true, ...(await callControl('/native/show', { method: 'POST' })) } }
    default: return { success: false, error: 'Unknown native host command' }
  }
}

function runNativeHostMode() {
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0)
      if (buffer.length < 4 + messageLength) return
      const body = buffer.slice(4, 4 + messageLength).toString('utf8')
      buffer = buffer.slice(4 + messageLength)
      try {
        const message = JSON.parse(body)
        const response = await handleNativeHostMessage(message)
        writeNativeMessage(response)
      } catch (err) { writeNativeMessage({ success: false, error: err.message || 'Native host error' }) }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Abuse filter Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

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

function getUrlPort(parsed) {
  return parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
}

function isAllowed(hostname, port = 443) {
  const host = normalizeTargetHost(hostname)
  return ALLOWED_TARGET_PORTS.has(Number(port)) && !BLOCKED.some(p => p.test(host)) && !PRIVATE.some(p => p.test(host))
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Fetch handler Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function addBytes(slot, bytes) {
  slot.sessionBytes += bytes
  _pendingBytesByDevice.set(slot.deviceId, (_pendingBytesByDevice.get(slot.deviceId) ?? 0) + bytes)
  void flushPendingBytes()
  syncAggregateState()
  enforceLocalLimit()
}

async function handleFetch(slot, request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request
  log.info('PROXY', `${slotPrefix(slot)} fetch request`, { requestId: requestId?.slice(0,8), method, url })
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || !isAllowed(parsed.hostname, getUrlPort(parsed))) {
      log.warn('PROXY', 'blocked URL', { hostname: parsed.hostname, port: getUrlPort(parsed), requestId: requestId?.slice(0,8), slot: slot.index })
      return { requestId, status: 403, headers: {}, body: '', error: 'URL not allowed' }
    }
    // HTTP-only requester traffic must not depend on a local proxy session.
    const outboundHeaders = {}
    for (const [key, value] of Object.entries(headers ?? {})) {
      const normalizedKey = String(key).trim().toLowerCase()
      if (!normalizedKey) continue
      if (['host', 'content-length', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'cookie', 'origin', 'referer'].includes(normalizedKey)) continue
      if (normalizedKey.startsWith('sec-')) continue
      if (value == null) continue
      outboundHeaders[normalizedKey] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    const requestBody = method === 'GET' || method === 'HEAD'
      ? undefined
      : (Buffer.isBuffer(body) ? body : body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        ...outboundHeaders,
      },
      body: requestBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    })

    // Return redirects directly so the browser follows each hop through the
    // proxy independently — prevents redirect chains (e.g. email tracking links)
    // from consuming the entire fetch timeout in one shot.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      const responseHeaders = {}
      if (location) responseHeaders['location'] = location
      const cacheControl = res.headers.get('cache-control')
      if (cacheControl) responseHeaders['cache-control'] = cacheControl
      return { requestId, status: res.status, headers: responseHeaders, body: '', finalUrl: location || res.url }
    }

    const responseBody = method === 'HEAD' ? '' : await res.text()
    const responseHeaders = {}
    res.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'].includes(key)) {
        responseHeaders[key] = value
      }
    })
    addBytes(slot, responseBody.length)
    log.info('PROXY', `${slotPrefix(slot)} fetch response`, { requestId: requestId?.slice(0,8), status: res.status, bytes: responseBody.length, finalUrl: res.url })
    return {
      requestId,
      status: res.status,
      headers: responseHeaders,
      body: responseBody,
      finalUrl: res.url,
    }
  } catch (err) {
    log.error('PROXY', `${slotPrefix(slot)} fetch error`, { requestId: requestId?.slice(0,8), url, err: err.message })
    return { requestId, status: 502, headers: {}, body: '', error: err.message }
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Relay Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function stopHeartbeat(slot) {
  if (slot?.heartbeatTimer) { clearInterval(slot.heartbeatTimer); slot.heartbeatTimer = null }
  if (!slot || !config.token || !config.userId) return
  log.debug('HEARTBEAT', 'heartbeat timer stopped', { slot: slot.index })
  logRequest('DELETE', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'DELETE',
    headers: withSharingAuthHeaders(),
    body: JSON.stringify({ device_id: slot.deviceId }),
  })
    .then(r => logResponse('DELETE', `${API_BASE}/api/user/sharing`, r.status))
    .catch(e => log.warn('API', 'stopHeartbeat DELETE failed', { err: e.message, slot: slot.index }))
}

function sendHeartbeat(slot) {
  if (!slot || !config.token || !config.userId) return
  logRequest('PUT', `${API_BASE}/api/user/sharing`, { device_id: slot.deviceId })
  fetch(`${API_BASE}/api/user/sharing`, {
    method: 'PUT',
    headers: withSharingAuthHeaders(),
    body: JSON.stringify({
      device_id: slot.deviceId,
      user_id: config.userId,
      relay_url: slot.lastRelay ?? null,
      connection_slots: clampSlots(config.connectionSlots ?? 1),
    }),
  })
    .then(async (r) => {
      logResponse('PUT', `${API_BASE}/api/user/sharing`, r.status)
      if (r.status === 401 || r.status === 403) {
        await confirmDesktopAuthStillValid('heartbeat', r.status, { preserveWhileSharing: true })
        return
      }
      if (!r.ok) {
        const body = await r.json().catch(() => null)
        log.warn('HEARTBEAT', 'PUT failed', { status: r.status, body, slot: slot.index })
      }
    })
    .catch(e => log.warn('HEARTBEAT', 'PUT error', { err: e.message, slot: slot.index }))
}

function getProviderRelay(relays) {
  // All slots must connect to the same relay â€” relay state is process-local.
  // Use lastRelay if it's still live (sticky after first registration).
  // On first connect, use consistent hashing so adding/removing a relay only
  // moves ~1/n providers instead of reshuffling everyone.
  const anchor = slotStates[0]?.lastRelay
  if (anchor && relays.includes(anchor)) return anchor
  const id = config.baseDeviceId || ''
  // For each relay compute hash(baseDeviceId + relayUrl), pick the highest score.
  // This is rendezvous/HRW hashing â€” stable under list growth/shrinkage.
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

function connectSlot(slot) {
  if (!config.token || !config.userId) return
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer)
    slot.reconnectTimer = null
  }
  if (slot.ws && (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING)) return
  getLiveRelays().then(relays => {
    const relay = getProviderRelay(relays)
    log.info('RELAY', `${slotPrefix(slot)} connecting`, { deviceId: slot.deviceId, relay })
    slot.ws = new WebSocket(relay)

    slot.ws.on('open', () => {
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer)
      slot.reconnectTimer = null
    }
    slot.reconnectDelay = 2000
    if (!config.shareEnabled) {
      log.warn('RELAY', `${slotPrefix(slot)} shareEnabled=false after open`)
      slot.ws.close(1000)
      return
    }
    const reg = {
      type: 'register_provider',
      userId: config.userId,
      authToken: config.token,
      country: config.country,
      trustScore: config.trust,
      agentMode: true,
      providerKind: 'desktop',
      supportsHttp: true,
      supportsTunnel: true,
      deviceId: slot.deviceId,
      baseDeviceId: config.baseDeviceId,
    }
    logRelay('SEND', 'register_provider', { slot: slot.index, deviceId: slot.deviceId })
    slot.ws.send(JSON.stringify(reg))
    if (slot.heartbeatTimer) clearInterval(slot.heartbeatTimer)
    slot.heartbeatTimer = setInterval(() => {
      sendHeartbeat(slot)
      if (slot.index === 0) pollTodayBytes()
    }, 30_000)
    sendHeartbeat(slot)
    if (slot.index === 0) pollTodayBytes()
    updateTray()
  })

    slot.ws.on('ping', () => { try { slot.ws.pong() } catch {} })

    slot.ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'tunnel_data' || msg.type === 'proxy_ws_data') {
        log.debug('RELAY', `RECV ${msg.type}`, { slot: slot.index, tunnelId: msg.tunnelId?.slice(0,8), sessionId: msg.sessionId?.slice(0,8), bytes: msg.data?.length })
      } else {
        logRelay('RECV', msg.type, { slot: slot.index, sessionId: msg.sessionId?.slice(0,8), tunnelId: msg.tunnelId?.slice(0,8), message: msg.message, hostname: msg.hostname, port: msg.port })
      }

      if (msg.type === 'registered') {
        slot.running = true
        slot.lastRelay = relay
        slot.connectedAt = new Date().toISOString()
        syncAggregateState()
        if (slot.index === 0) {
          persistSharingState(true)
          showNotification('PeerMesh Active', `Sharing your ${config.country} connection`)
        }
        updateTray()
      } else if (msg.type === 'error') {
        log.error('RELAY', `${slotPrefix(slot)} relay error`, { message: msg.message })
        // Fatal errors that should stop sharing entirely rather than reconnect
        const isFatal = msg.message?.includes('cannot share bandwidth') ||
          msg.message?.includes('Verify your phone') ||
          msg.message?.includes('Accept the provider disclosure') ||
          msg.message?.includes('Profile not found')
        if (isFatal) {
          log.warn('RELAY', `${slotPrefix(slot)} fatal provider error - stopping relay`, { message: msg.message })
          slot.ws.removeAllListeners('close')
          slot.ws.close(1000)
          slot.ws = null
          slot.running = false
          slot.connectedAt = null
          syncAggregateState()
          // Stop all slots
          if (config.shareEnabled) {
            config.shareEnabled = false
            saveConfig()
            showNotification('PeerMesh', msg.message)
            if (settingsWindow) settingsWindow.webContents.send('sharing-error', msg.message)
          }
          updateTray()
          return
        }
        if (msg.message?.includes('Replaced')) {
          slot.ws.removeAllListeners('close')
          slot.ws.close(1000)
          slot.running = false
          slot.connectedAt = null
          syncAggregateState()
          updateTray()
        }
      } else if (msg.type === 'proxy_ws_data') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel?.socket && !tunnel.socket.destroyed) tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      } else if (msg.type === 'proxy_ws_close') {
        const tunnel = activeTunnels.get(`ws_${msg.sessionId}`)
        if (tunnel) { if (!tunnel.socket.destroyed) tunnel.socket.destroy(); activeTunnels.delete(`ws_${msg.sessionId}`) }
      } else if (msg.type === 'session_request') {
        sendRelayMessage(slot, { type: 'agent_ready', sessionId: msg.sessionId })
      } else if (msg.type === 'proxy_request') {
        slot.requestsHandled++
        syncAggregateState()
        const response = await handleFetch(slot, msg.request)
        sendRelayMessage(slot, { type: 'proxy_response', sessionId: msg.sessionId, response })
      } else if (msg.type === 'open_tunnel') {
        slot.requestsHandled++
        syncAggregateState()
        if (!isAllowed(msg.hostname, Number(msg.port) || 443)) {
          log.warn('TUNNEL', 'blocked tunnel target', { hostname: msg.hostname, port: msg.port, slot: slot.index })
          sendRelayMessage(slot, { type: 'tunnel_close', tunnelId: msg.tunnelId })
          return
        }
        const socket = net.connect(msg.port, msg.hostname)
        socket.setTimeout(20000, () => { socket.destroy(new Error('connect timeout')) })
        const tunnel = { socket, closed: false, sessionId: msg.sessionId ?? null, slotIndex: slot.index }
        slot.activeTunnels.set(msg.tunnelId, tunnel)
        activeTunnels.set(msg.tunnelId, tunnel)
        socket.on('connect', () => { socket.setTimeout(0); sendRelayMessage(slot, { type: 'tunnel_ready', tunnelId: msg.tunnelId }) })
        socket.on('data', (chunk) => {
          sendRelayMessage(slot, { type: 'tunnel_data', tunnelId: msg.tunnelId, data: chunk.toString('base64') })
          addBytes(slot, chunk.length)
        })
        socket.on('end', () => closeTunnel(slot, msg.tunnelId, true))
        socket.on('close', () => { slot.activeTunnels.delete(msg.tunnelId); activeTunnels.delete(msg.tunnelId); syncAggregateState() })
        socket.on('error', () => closeTunnel(slot, msg.tunnelId, true))
      } else if (msg.type === 'tunnel_data') {
        const tunnel = slot.activeTunnels.get(msg.tunnelId)
        if (tunnel?.socket && !tunnel.socket.destroyed) tunnel.socket.write(Buffer.from(msg.data, 'base64'))
      } else if (msg.type === 'tunnel_close') {
        closeTunnel(slot, msg.tunnelId, false)
      } else if (msg.type === 'session_ended') {
        closeAllTunnels(slot, false)
        updateTray()
      }
    } catch (e) {
      log.error('RELAY', `${slotPrefix(slot)} message handler exception`, { err: e.message })
    }
  })

    slot.ws.on('close', (code, reason) => {
    slot.running = false
    slot.connectedAt = null
    closeAllTunnels(slot, false)
    slot.ws = null
    syncAggregateState()
    updateTray()
    // Clear proxySession immediately so Chrome gets 503 on new CONNECT requests
    // rather than a tunnel that silently hangs waiting for a provider on the old relay.
    // It will be restored when session_reconnected arrives via the extension.
    if (proxySession) { proxySession = null; log.debug('RELAY', `${slotPrefix(slot)} cleared proxySession on WS close`) }
    if (code !== 1000 && !_userStopped && config.shareEnabled) {
      if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer)
      slot.reconnectTimer = setTimeout(() => connectSlot(slot), slot.reconnectDelay)
      slot.reconnectDelay = Math.min(slot.reconnectDelay * 2, 30000)
    } else {
      log.info('RELAY', `${slotPrefix(slot)} no reconnect`, { code, reason: reason?.toString() || '(none)' })
    }
  })

    slot.ws.on('error', (e) => log.error('RELAY', `${slotPrefix(slot)} WebSocket error`, { code: e.code, err: e.message }))
  }).catch(e => {
    log.error('RELAY', `${slotPrefix(slot)} getLiveRelays failed`, { err: e.message })
    if (!_userStopped && config.shareEnabled && !slot.reconnectTimer) {
      slot.reconnectTimer = setTimeout(() => connectSlot(slot), slot.reconnectDelay)
      slot.reconnectDelay = Math.min(slot.reconnectDelay * 2, 30000)
    }
  })
}

function connectRelay() {
  if (!config.token || !config.userId) { log.warn('RELAY', 'connectRelay skipped - no token/userId'); return }
  syncTodaySharedBytesDay()
  if (limitHit) {
    log.warn('RELAY', 'connectRelay skipped - daily limit already reached')
    config.shareEnabled = false
    saveConfig()
    updateTray()
    return
  }
  _userStopped = false
  ensureSlotStates().forEach(slot => connectSlot(slot))
  syncAggregateState()
  log.info('RELAY', 'connectRelay START', { userId: config.userId, country: config.country, slots: config.connectionSlots })
  logState('pre-connect')
}

function restartRelayForConfigChange(reason, notificationBody = null) {
  const shouldResume = config.shareEnabled || activeSlotCount() > 0
  if (!shouldResume) {
    updateTray()
    return false
  }

  log.info('RELAY', 'restarting provider to apply config change', { reason })
  stopRelay()

  if (!config.token || !config.userId || limitHit) {
    updateTray()
    return false
  }

  config.shareEnabled = true
  saveConfig()
  connectRelay()
  updateTray()
  if (notificationBody) showNotification('PeerMesh updated', notificationBody)
  return true
}

function suspendRelayForShutdown(reason = 'shutdown') {
  log.info('RELAY', 'suspending relay for process shutdown', { reason, shareEnabled: config.shareEnabled })
  _userStopped = true
  for (const slot of slotStates) {
    if (slot.reconnectTimer) { clearTimeout(slot.reconnectTimer); slot.reconnectTimer = null }
    if (slot.heartbeatTimer) { clearInterval(slot.heartbeatTimer); slot.heartbeatTimer = null }
    if (slot.ws) { slot.ws.removeAllListeners('close'); slot.ws.close(1000); slot.ws = null }
    closeAllTunnels(slot, false)
    slot.running = false
    slot.connectedAt = null
  }
  syncAggregateState()
  logState('post-suspend')
  updateTray()
}

function stopRelay() {
  log.info('RELAY', 'stopRelay called')
  logState('pre-stop')
  _userStopped = true
  config.shareEnabled = false
  saveConfig()
  for (const slot of slotStates) {
    if (slot.reconnectTimer) { clearTimeout(slot.reconnectTimer); slot.reconnectTimer = null }
    stopHeartbeat(slot)
    if (slot.ws) { slot.ws.removeAllListeners('close'); slot.ws.close(1000); slot.ws = null }
    closeAllTunnels(slot, false)
    slot.running = false
    slot.connectedAt = null
    slot.sessionBytes = 0
    slot.requestsHandled = 0
  }
  syncAggregateState()
  persistSharingState(false)
  logState('post-stop')
  updateTray()
}

let proxySession = null

function openTunnelWs(hostname, port, onOpen) {
  if (!proxySession?.sessionId) return null
  const relayRaw = proxySession.relayEndpoint
  const relayHttp = relayRaw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  const relayOrigin = new URL(relayHttp).origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const proxyUrl = `${relayOrigin}/proxy?session=${encodeURIComponent(proxySession.sessionId)}`
  const tunnelWs = new WebSocket(proxyUrl)
  tunnelWs.on('open', () => {
    tunnelWs.send(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
    if (onOpen) onOpen()
  })
  return tunnelWs
}

const localProxyServer = http.createServer((req, res) => {
  if (!proxySession?.sessionId) {
    log.warn('LOCAL-PROXY', 'HTTP rejected Ã¢â‚¬â€ no session', { url: req.url })
    res.writeHead(503); res.end('No PeerMesh session'); return
  }
  const parsed = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`)
  const hostname = parsed.hostname
  const port = parseInt(parsed.port) || 80
  log.info('LOCAL-PROXY', `HTTP ${req.method}`, { target: `${hostname}:${port}`, url: parsed.href.slice(0, 80) })
  if (!isAllowed(hostname, port)) {
    log.warn('LOCAL-PROXY', 'HTTP rejected - blocked target', { target: `${hostname}:${port}` })
    res.writeHead(403); res.end('Target not allowed'); return
  }

  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const tunnelWs = openTunnelWs(hostname, port)
    if (!tunnelWs) { res.writeHead(503); res.end('No PeerMesh session'); return }

    let ready = false
    let responseData = Buffer.alloc(0)

    tunnelWs.on('message', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!ready) {
        responseData = Buffer.concat([responseData, chunk])
        const headerEnd = responseData.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const firstLine = responseData.slice(0, responseData.indexOf('\r\n')).toString()
        if (!firstLine.includes('200')) {
          log.warn('LOCAL-PROXY', 'HTTP tunnel rejected', { firstLine })
          res.writeHead(502); res.end('Bad Gateway'); tunnelWs.close(); return
        }
        ready = true
        const reqLine = `${req.method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`
        const hdrs = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
        tunnelWs.send(Buffer.from(`${reqLine}${hdrs}\r\n\r\n`))
        if (body.length) tunnelWs.send(body)
        responseData = responseData.slice(headerEnd + 4)
        return
      }
      responseData = Buffer.concat([responseData, chunk])
      // Try to send the response as soon as we have a complete HTTP message —
      // don't wait for tunnel close, which may race with data delivery.
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
          // Send immediately if: redirect (no body), or body is complete
          if (hStatus >= 300 && hStatus < 400) {
            res.writeHead(hStatus, hHdrs); res.end(bodyData)
            log.info('LOCAL-PROXY', `HTTP response sent (redirect)`, { status: hStatus, target: `${hostname}:${port}` })
            tunnelWs.close()
          } else if (contentLength > 0 && bodyData.length >= contentLength) {
            res.writeHead(hStatus, hHdrs); res.end(bodyData.slice(0, contentLength))
            log.info('LOCAL-PROXY', `HTTP response sent (complete)`, { status: hStatus, target: `${hostname}:${port}` })
            tunnelWs.close()
          }
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
          log.info('LOCAL-PROXY', `HTTP response sent (on close)`, { status, target: `${hostname}:${port}` })
        } else { res.writeHead(502); res.end('Bad Gateway') }
      } else if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
    })

    tunnelWs.on('error', (e) => {
      log.error('LOCAL-PROXY', 'HTTP tunnel error', { target: `${hostname}:${port}`, err: e.message })
      if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway') }
    })

    setTimeout(() => {
      if (!res.headersSent) {
        log.warn('LOCAL-PROXY', 'HTTP timeout', { target: `${hostname}:${port}` })
        tunnelWs.terminate(); res.writeHead(504); res.end('Timeout')
      }
    }, 30000)
  })
})

localProxyServer.on('connect', (req, clientSocket, head) => {
  const [hostname, portStr] = (req.url || '').split(':')
  const port = parseInt(portStr) || 443
  log.info('LOCAL-PROXY', `CONNECT request`, { target: `${hostname}:${port}`, sessionId: proxySession?.sessionId?.slice(0,8) || 'NONE' })

  if (!proxySession?.sessionId) {
    log.warn('LOCAL-PROXY', 'CONNECT rejected Ã¢â‚¬â€ no proxySession', { target: `${hostname}:${port}` })
    clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n')
    clientSocket.destroy(); return
  }
  if (!isAllowed(hostname, port)) {
    log.warn('LOCAL-PROXY', 'CONNECT rejected - blocked target', { target: `${hostname}:${port}` })
    clientSocket.write('HTTP/1.1 403 Target Not Allowed\r\n\r\n')
    clientSocket.destroy(); return
  }

  let opened = false
  const tunnelWs = openTunnelWs(hostname, port, () => { opened = true })
  if (!tunnelWs) { clientSocket.write('HTTP/1.1 503 No PeerMesh Session\r\n\r\n'); clientSocket.destroy(); return }
  log.debug('LOCAL-PROXY', 'opening tunnel WS', { target: `${hostname}:${port}` })

  tunnelWs.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString() : data
    if (!clientSocket._connectSent && text.startsWith('HTTP/1.1 200')) {
      clientSocket._connectSent = true
      log.info('LOCAL-PROXY', 'tunnel ready Ã¢â‚¬â€ 200 sent to Chrome', { target: `${hostname}:${port}` })
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) tunnelWs.send(head)
      clientSocket.on('data', (chunk) => { if (tunnelWs.readyState === WebSocket.OPEN) tunnelWs.send(chunk) })
      clientSocket.on('end', () => tunnelWs.close())
      clientSocket.on('error', (e) => { log.warn('LOCAL-PROXY', 'clientSocket error', { err: e.message }); tunnelWs.close() })
      return
    }
    if (!clientSocket.destroyed) clientSocket.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
  })

  tunnelWs.on('close', (code, reason) => {
    log.info('LOCAL-PROXY', 'tunnel WS closed', { target: `${hostname}:${port}`, code, reason: reason?.toString() || '' })
    if (!clientSocket.destroyed) clientSocket.destroy()
  })

  tunnelWs.on('error', (e) => {
    log.error('LOCAL-PROXY', 'tunnel WS error', { target: `${hostname}:${port}`, err: e.message })
    if (!opened) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    if (!clientSocket.destroyed) clientSocket.destroy()
  })

  setTimeout(() => {
    if (!opened) {
      log.warn('LOCAL-PROXY', 'tunnel timeout', { target: `${hostname}:${port}` })
      tunnelWs.terminate(); clientSocket.write('HTTP/1.1 504 Tunnel Timeout\r\n\r\n'); clientSocket.destroy()
    }
  }, 30000)
})

// Ã¢â€â‚¬Ã¢â€â‚¬ Control server Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const controlServer = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`)
  logControl(req.method, url.pathname, { origin: origin.slice(0, 40) || undefined })

  if (req.method === 'GET' && url.pathname === '/health') {
    syncAggregateState()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ running, shareEnabled: !!config.shareEnabled, country: config.country, userId: config.userId?.slice(0, 8), proxyPort: RELAY_PROXY_PORT, stats, version: DESKTOP_VERSION }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/native/state') {
    const publicState = getPublicState()
    const state = { available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...publicState }
    log.debug('CONTROL', '/native/state response', { running, shareEnabled: state.shareEnabled, peerSharing })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(state))
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/auth') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}')
        log.info('CONTROL', '/native/auth Ã¢â‚¬â€ verifying token', { userId: data.userId })
        if (config.userId && data.userId && config.userId !== data.userId) {
          log.warn('CONTROL', '/native/auth -- userId mismatch, rejecting', { existing: config.userId, incoming: data.userId })
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'This desktop is signed in as a different user' }))
          return
        }
        if (data.token) {
          try {
            const vRes = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(data.userId || '')}`, { headers: { 'Authorization': `Bearer ${data.token}` }, signal: AbortSignal.timeout(5000) })
            log.info('CONTROL', '/native/auth verify result', { status: vRes.status, userId: data.userId })
            if (!vRes.ok) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Token verification failed' })); return }
          } catch (e) { log.warn('CONTROL', '/native/auth verify error (offline?)', { err: e.message }) }
        }
        config = {
          ...config,
          token: data.token ?? config.token,
          refreshToken: data.refreshToken ?? config.refreshToken,
          deviceSessionId: data.deviceSessionId ?? config.deviceSessionId,
          userId: data.userId ?? config.userId,
          country: data.country ?? config.country,
          trust: data.trust ?? config.trust,
        }
        await pollTodayBytes()
        void syncSharingScheduleToServer('native_auth')
        startUptimeJobLoop()
        saveConfig(); updateTray()
        log.info('CONTROL', '/native/auth Ã¢â‚¬â€ config updated', { userId: config.userId, country: config.country })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
      } catch (e) { log.error('CONTROL', '/native/auth error', { err: e.message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}')
        log.info('CONTROL', '/native/share/start', { userId: data.userId || config.userId, country: data.country || config.country })
        if (config.userId && data.userId && config.userId !== data.userId) {
          log.warn('CONTROL', '/native/share/start -- userId mismatch, rejecting', { existing: config.userId, incoming: data.userId })
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'This desktop is signed in as a different user' }))
          return
        }
        config = {
          ...config,
          token: data.token ?? config.token,
          refreshToken: data.refreshToken ?? config.refreshToken,
          deviceSessionId: data.deviceSessionId ?? config.deviceSessionId,
          userId: data.userId ?? config.userId,
          country: data.country ?? config.country,
          trust: data.trust ?? config.trust,
          connectionSlots: clampSlots(data.slots ?? data.connectionSlots ?? config.connectionSlots),
          shareEnabled: true,
        }
        ensureSlotStates()
        await pollTodayBytes()
        saveConfig()
        logState('share/start')
        if (running) stopRelay()
        config.shareEnabled = true
        saveConfig()
        connectRelay()
        updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
      } catch (e) { log.error('CONTROL', '/native/share/start error', { err: e.message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/share/stop') {
    log.info('CONTROL', '/native/share/stop called')
    stopRelay()
    persistSharingState(false)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/connection-slots') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}')
        const result = await applyConnectionSlots(data.slots, { syncPeer: !data._fromPeer, actor: data.actor || SHARING_ACTOR })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...result.state }))
      } catch (e) {
        log.error('CONTROL', '/native/connection-slots error', { err: e.message })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/peer/register') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        const prevPeerPort = peerPort
        peerPort = parsed.port
        log.info('CONTROL', '/native/peer/register', { peerPort, prevPeerPort, where: parsed.where })

        // If registrant sent their slot count and neither side is sharing, adopt it
        if (parsed.slots && !running && !peerSharing) {
          const incomingSlots = clampSlots(parsed.slots)
          if (incomingSlots !== clampSlots(config.connectionSlots ?? 1)) {
            log.info('SLOTS', 'adopting slot count from registering peer', { incomingSlots, ourSlots: clampSlots(config.connectionSlots ?? 1) })
            config.connectionSlots = incomingSlots
            ensureSlotStates()
            saveConfig()
            updateTray()
          }
        }

        logState('peer-registered')
      } catch (e) { log.warn('CONTROL', '/native/peer/register parse error', { err: e.message }) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/native/show') {
    log.info('CONTROL', '/native/show Ã¢â‚¬â€ opening window')
    showWindow()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ available: true, configured: !!(config.token && config.userId), country: config.country, userId: config.userId, where: 'desktop', ...getPublicState() }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        log.info('CONTROL', '/start called', { userId: data.userId || config.userId })
        config = { ...config, ...data, connectionSlots: clampSlots(data.slots ?? data.connectionSlots ?? config.connectionSlots), shareEnabled: true }
        saveConfig(); stopRelay(); config.shareEnabled = true; saveConfig(); connectRelay()
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
      } catch (e) { log.error('CONTROL', '/start error', { err: e.message }); res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/quit') {
    log.info('CONTROL', '/quit called Ã¢â‚¬â€ requesting app quit')
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
    setTimeout(() => requestAppQuit('control-quit'), 250)
    return
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    log.info('CONTROL', '/stop called')
    stopRelay()
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
    return
  }
  if (req.method === 'POST' && url.pathname === '/proxy-session') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        proxySession = data
        log.info('CONTROL', 'proxy-session SET', { sessionId: data.sessionId?.slice(0,8), relay: data.relayEndpoint })
        logState('proxy-session-set')
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
      } catch (e) { log.error('CONTROL', '/proxy-session error', { err: e.message }); res.writeHead(400); res.end() }
    })
    return
  }
  if (req.method === 'DELETE' && url.pathname === '/proxy-session') {
    log.info('CONTROL', 'proxy-session CLEARED')
    proxySession = null
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true }))
    return
  }
  log.warn('CONTROL', `404 ${req.method} ${url.pathname}`)
  res.writeHead(404); res.end()
})

// Ã¢â€â‚¬Ã¢â€â‚¬ Tray Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function createTrayIcon() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH)
  if (!icon.isEmpty()) return icon.resize({ width: 18, height: 18 })
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEwAACxMBAJqcGAAAABZ0RVh0Q3JlYXRpb24gVGltZQAxMC8yOS8xMiCqmi3JAAAAB3RJTUUH3QodEQkWMFCEAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAMFJREFUeNpi/P//PwMlgImBQjDwBrCgC4SGhjIwMzMzIGMwMzMzoGNkZGQgxoAFY2JiYmBiYmJAYWBgYGBiYmJAZmBgYGBiYmJAZWBgYGBiYmJAYmBgYGBiYmJAYGBgYGBiYmJAX2BgYGBiYmJAXmBgYGBiYmJAXGBgYGBiYmJAWmBgYGBiYmJAWGBgYGBiYmJAVmBgYGBiYmJAVGBgYGBiYmJAUmBgYGBiYmJAUGBgYGBiYmJATmBgYGBiYmIAAQYAoZAD/kexdGUAAAAASUVORK5CYII='
  )
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}


function updateTray() {
  if (!tray) return
  syncAggregateState()
  const configuredSlots = clampSlots(config.connectionSlots ?? 1)
  const activeSlots = activeSlotCount()
  const slotWarning = getSlotWarning(configuredSlots)
  const starting = !!config.shareEnabled && !running && !peerSharing
  const slotSummary = getSlotSummary()
  const privateCount = slotSummary.filter(s => s.privateActive).length
  const publicCount = configuredSlots - privateCount
  const scheduleState = getSharingSchedulePublicState()
  const scheduleLabel = scheduleState.enabled
    ? (scheduleState.alwaysOn
      ? 'Scheduled sharing: Always on'
      : `Scheduled sharing: ${scheduleState.startTime}-${scheduleState.endTime}`)
    : 'Scheduled sharing'
  const osWakeState = getScheduleWakePublicState()
  const privateBadge = running
    ? (privateCount === configuredSlots ? ' [ALL PRIVATE]'
      : privateCount > 0 ? ` [${publicCount} public, ${privateCount} private]`
      : ' [PUBLIC]')
    : (config.privateShareActive ? ' [PRIVATE]' : '')
  const menuItems = [
    { label: 'PeerMesh', enabled: false },
    { type: 'separator' },
    { label: running ? `Sharing - ${config.country} (${configuredSlots} slots)${privateBadge}` : (peerSharing ? 'Sharing (via CLI)' : (starting ? `Starting - ${config.country} (${configuredSlots} slots)` : 'Not sharing')), enabled: false },
    { label: running ? `${activeSlots} / ${configuredSlots} slots active - ${stats.requestsHandled} requests - ${formatBytes(stats.bytesServed)} served` : (peerSharing ? 'CLI is the active provider' : (starting ? `Connecting ${configuredSlots} slot${configuredSlots === 1 ? '' : 's'}...` : 'Click to start sharing')), enabled: false },
  ]
  if (slotWarning) menuItems.push({ label: slotWarning, enabled: false })
  menuItems.push(
    { type: 'separator' },
    {
      label: running ? 'Stop Sharing' : (peerSharing ? 'Stop Sharing (CLI)' : (starting ? 'Starting...' : 'Start Sharing')),
      enabled: !starting,
      click: async () => {
        if (_sharingToggleBusy) { log.warn('TRAY', 'toggle click ignored - busy'); return }
        _sharingToggleBusy = true
        if (peerPort) {
          try {
            const r = await fetch(`http://127.0.0.1:${peerPort}/native/state`, { signal: AbortSignal.timeout(1500) })
            if (r.ok) { const d = await r.json(); peerSharing = !!d.running }
          } catch {}
        }
        const wasRunning = running
        const wasPeerSharing = peerSharing
        if (wasRunning || wasPeerSharing) {
          peerSharing = false
          if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null }
          stopRelay()
          if (peerPort && wasPeerSharing) {
            try { await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) }) } catch {}
          }
          peerPort = null
          updateTray()
        } else if (config.token && config.userId) {
          config.shareEnabled = true
          saveConfig()
          updateTray()
          connectRelay()
        } else {
          shell.openExternal(`${API_BASE}/dashboard`)
          showWindow()
        }
        _sharingToggleBusy = false
        logState('post-toggle')
      },
    },
    {
      type: 'checkbox',
      label: 'Launch on system start',
      checked: !!config.launchOnStartup,
      click: async (item) => {
        await setLaunchOnStartupPreference(item.checked)
      },
    },
    {
      type: 'checkbox',
      label: 'Auto-start sharing on launch',
      checked: !!config.autoShareOnLaunch,
      enabled: !!config.userId,
      click: async (item) => {
        try {
          await setAutoShareOnLaunchPreference(item.checked)
        } catch (e) {
          showNotification('PeerMesh', e.message)
          showWindow()
          updateTray()
        }
      },
    },
    {
      type: 'checkbox',
      label: 'Prevent sleep while sharing',
      checked: !!config.preventSleepWhileSharing,
      enabled: !!config.userId,
      click: (item) => {
        setPreventSleepWhileSharingPreference(item.checked)
      },
    },
    {
      type: 'checkbox',
      label: scheduleLabel,
      checked: !!scheduleState.enabled,
      enabled: !!config.userId,
      click: (item) => {
        setSharingSchedulePreference({ enabled: item.checked })
      },
    },
    {
      type: 'checkbox',
      label: 'Wake PC for schedule',
      checked: !!osWakeState.enabled,
      enabled: !!config.userId && !!scheduleState.enabled && osWakeState.supported,
      click: async (item) => {
        const result = await setScheduleWakeEnabledPreference(item.checked)
        if (!result.success && result.error) showNotification('PeerMesh wake setup', result.error)
      },
    },
    { type: 'separator' },
    { label: 'Settings', click: showWindow },
    { label: 'Open Dashboard', click: () => shell.openExternal(`${API_BASE}/dashboard`) },
    { label: 'Open Debug Log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Quit', click: () => requestAppQuit('tray-quit') },
  )
  tray.setContextMenu(Menu.buildFromTemplate(menuItems))
  tray.setToolTip(
    running
      ? `PeerMesh - Sharing (${config.country}, ${configuredSlots} slots${config.privateShareActive ? ', private' : ''})`
      : (starting ? `PeerMesh - Starting (${config.country}, ${configuredSlots} slots)` : 'PeerMesh - Inactive')
  )
}

function showWindow() {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show(); settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 392, height: 640, resizable: false, title: 'PeerMesh', backgroundColor: '#0a0a0f', icon: APP_ICON_PATH,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.on('close', (e) => {
    if (_quitRequested) return
    e.preventDefault()
    settingsWindow.hide()
    updateTray()
  })
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  log.info('WINDOW', 'settings window created')
}

function showNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
}

function requestAppQuit(reason = 'quit', { forceExitMs = 2000 } = {}) {
  if (_quitRequested) return
  _quitRequested = true
  log.info('PROCESS', 'requestAppQuit', { reason })
  shutdownDesktopRuntime(`request:${reason}`)
  try {
    if (settingsWindow) {
      settingsWindow.removeAllListeners('close')
      settingsWindow.close()
    }
  } catch {}
  try {
    if (tray) {
      tray.destroy()
      tray = null
    }
  } catch {}
  setTimeout(() => {
    try { app.exit(0) } catch {}
  }, forceExitMs)
  app.quit()
}

// Ã¢â€â‚¬Ã¢â€â‚¬ IPC Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

ipcMain.handle('get-ext-id', () => { logIpc('get-ext-id'); return config.extId })

ipcMain.handle('check-website-auth', async () => {
  logIpc('check-website-auth', { extId: config.extId })
  try {
    logRequest('GET', `${API_BASE}/api/extension-auth?ext_id=***`)
    const res = await fetch(`${API_BASE}/api/extension-auth?ext_id=${config.extId}`)
    const data = await res.json()
    logResponse('GET', `${API_BASE}/api/extension-auth`, res.status)
    if (res.status === 403) return { error: data.error || 'Account not verified' }
    if (res.status === 401) return { error: 'Session expired Ã¢â‚¬â€ please sign in again' }
    if (res.status === 404) return { error: 'User not found' }
    if (!data.user) return { pending: true }
    if (!data.user.token || !data.user.id) return { error: 'Invalid auth response' }
    log.info('IPC', 'check-website-auth Ã¢â‚¬â€ user found', { userId: data.user.id })
    return { user: data.user }
  } catch (e) { log.error('IPC', 'check-website-auth error', { err: e.message }); return { error: 'Could not reach server' } }
})

ipcMain.handle('request-device-code', async () => {
  logIpc('request-device-code')
  try {
    logRequest('POST', `${API_BASE}/api/extension-auth`, { device: true })
    const res = await fetch(`${API_BASE}/api/extension-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: true }), signal: AbortSignal.timeout(10000) })
    const data = await res.json()
    logResponse('POST', `${API_BASE}/api/extension-auth`, res.status, { user_code: data.user_code, interval: data.interval })
    if (!res.ok) return { error: 'Could not reach server' }
    return data
  } catch (e) { log.error('IPC', 'request-device-code error', { err: e.message }); return { error: e.name === 'TimeoutError' ? 'Request timed out - check your connection' : 'Could not reach server' } }
})

ipcMain.handle('poll-device-code', async (_, { device_code }) => {
  try {
    const res = await fetch(`${API_BASE}/api/extension-auth?device_code=${encodeURIComponent(device_code)}`)
    const data = await res.json()
    if (data.status !== 'pending') {
      logIpc('poll-device-code result', { status: data.status, userId: data.user?.id })
    }
    return data
  } catch (e) { log.error('IPC', 'poll-device-code error', { err: e.message }); return { status: 'pending' } }
})

ipcMain.handle('open-auth', (_, url) => {
  const safeUrl = url && !url.startsWith('http://localhost') ? url : `${API_BASE}/extension?activate=1`
  logIpc('open-auth', { url: safeUrl })
  shell.openExternal(safeUrl)
  log.info('IPC', 'open-auth opened browser', { url: safeUrl })
})



ipcMain.handle('get-state', () => {
  const publicState = getPublicState()
  const state = { ...publicState, config: { ...publicState.config, hasAcceptedProviderTerms: config.hasAcceptedProviderTerms ?? false } }
  logIpc('get-state', { running: state.running, shareEnabled: state.shareEnabled })
  return state
})

async function setLaunchOnStartupPreference(enabled) {
  config.launchOnStartup = !!enabled
  saveConfig()
  const result = applyLaunchOnStartupPreference(config.launchOnStartup)
  updateTray()
  return {
    success: true,
    enabled: config.launchOnStartup,
    applied: result.applied,
    state: getPublicState(),
  }
}

async function setAutoShareOnLaunchPreference(enabled) {
  if (enabled) {
    if (!config.token || !config.userId) {
      throw new Error('Sign in before enabling auto-start sharing')
    }
    try {
      await refreshSharingConfig()
    } catch (e) {
      log.warn('IPC', 'auto-share-on-launch refresh failed', { err: e.message })
    }
    if (!config.hasAcceptedProviderTerms) {
      throw new Error('Review and accept the sharing disclosure before enabling auto-start sharing')
    }
  }
  config.autoShareOnLaunch = !!enabled
  saveConfig()
  updateTray()
  return {
    success: true,
    enabled: config.autoShareOnLaunch,
    state: getPublicState(),
  }
}

ipcMain.handle('set-launch-on-startup', async (_, enabled) => setLaunchOnStartupPreference(enabled))

ipcMain.handle('set-auto-share-on-launch', async (_, enabled) => {
  try {
    return await setAutoShareOnLaunchPreference(enabled)
  } catch (e) {
    return { success: false, error: e.message, state: getPublicState() }
  }
})

ipcMain.handle('set-prevent-sleep-while-sharing', async (_, enabled) => {
  const result = setPreventSleepWhileSharingPreference(enabled)
  return { success: true, ...result, state: getPublicState() }
})

ipcMain.handle('set-sharing-schedule', async (_, schedule) => setSharingSchedulePreference(schedule))

ipcMain.handle('set-schedule-wake-enabled', async (_, enabled) => setScheduleWakeEnabledPreference(enabled))

ipcMain.handle('set-on-demand-wake-enabled', async (_, enabled) => setOnDemandWakeEnabledPreference(enabled))

ipcMain.handle('set-private-on-demand-start-enabled', async (_, enabled) => setPrivateOnDemandStartPreference(enabled))

ipcMain.handle('set-connection-slots', async (_, slots) => {
  return applyConnectionSlots(slots, { syncPeer: true })
})

ipcMain.handle('set-daily-share-limit', async (_, limitMb) => {
  try {
    const result = await setDailyShareLimit(limitMb)
    return { success: true, ...result }
  } catch (e) {
    return { success: false, error: e.message, state: getPublicState() }
  }
})

ipcMain.handle('set-slot-daily-limit', async (_, payload = {}) => {
  try {
    const result = await setSlotDailyShareLimit(payload.limitMb, {
      deviceId: payload.deviceId,
      baseDeviceId: payload.baseDeviceId,
    })
    return { success: true, ...result }
  } catch (e) {
    return { success: false, error: e.message, state: getPublicState() }
  }
})

ipcMain.handle('get-private-share', async () => {
  const result = await getPrivateShareState(true)
  return {
    success: true,
    baseDeviceId: config.baseDeviceId || null,
    privateShare: result?.privateShare ?? null,
    privateShares: result?.privateShares ?? hydratePrivateShareRows(config.privateShares),
    privateShareDeviceId: result?.privateShareDeviceId ?? config.privateShareDeviceId ?? null,
    expiryPreset: result?.expiryPreset ?? getPrivateShareExpiryPreset(config.privateShare?.expires_at ?? null),
    slotLimits: result?.slotLimits ?? normalizeSlotLimitRows(config.slotLimits),
  }
})

ipcMain.handle('update-private-share', async (_, payload = {}) => {
  try {
    const result = await updatePrivateShareState(payload)
    return {
      success: true,
      baseDeviceId: config.baseDeviceId || null,
      privateShare: result.privateShare,
      privateShares: result.privateShares,
      privateShareDeviceId: result.privateShareDeviceId ?? null,
      expiryPreset: result.expiryPreset,
      slotLimits: result.slotLimits ?? normalizeSlotLimitRows(config.slotLimits),
      state: getPublicState(),
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('sign-in', async (_, { token, refreshToken, deviceSessionId, userId, country, trust }) => {
  logIpc('sign-in attempt', { userId, country })
  try {
    logRequest('GET', `${API_BASE}/api/extension-auth?verify=1&userId=${userId}`)
    const res = await fetch(`${API_BASE}/api/extension-auth?verify=1&userId=${encodeURIComponent(userId)}`, { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
    logResponse('GET', `${API_BASE}/api/extension-auth?verify`, res.status)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn('IPC', 'sign-in verify failed', { status: res.status, body })
      return { success: false, error: 'Token verification failed' }
    }
  } catch (e) { log.warn('IPC', 'sign-in verify error (offline?)', { err: e.message }) }
  config = { ...config, token, refreshToken: refreshToken ?? config.refreshToken, deviceSessionId: deviceSessionId ?? config.deviceSessionId, userId, country, trust }
  try {
    await refreshSharingConfig()
  } catch {}
  startSharingConfigSync()
  void syncSharingScheduleToServer('sign_in')
  startUptimeJobLoop()
  saveConfig(); updateTray(); showWindow()
  log.info('IPC', 'sign-in success', { userId, country })
  return { success: true }
})

ipcMain.handle('toggle-sharing', async () => {
  if (_sharingToggleBusy) { log.warn('IPC', 'toggle-sharing ignored Ã¢â‚¬â€ busy'); return { running, shareEnabled: !!config.shareEnabled } }
  _sharingToggleBusy = true
  // Live-check CLI state to avoid acting on stale peerSharing (up to 3s old)
  if (peerPort) {
    try {
      const r = await fetch(`http://127.0.0.1:${peerPort}/native/state`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { const d = await r.json(); peerSharing = !!d.running }
    } catch {}
  }
  const wasRunning = running
  const wasPeerSharing = peerSharing
  logIpc('toggle-sharing', { wasRunning, wasPeerSharing, peerPort })
  if (wasRunning || wasPeerSharing) {
    peerSharing = false
    if (_cliWatchTimer) { clearInterval(_cliWatchTimer); _cliWatchTimer = null; log.info('IPC', '_cliWatchTimer cleared on toggle-stop') }
    stopRelay()
    if (peerPort && wasPeerSharing) {
      log.info('IPC', 'sending share/stop to CLI peer', { peerPort })
      try {
        const r = await fetch(`http://127.0.0.1:${peerPort}/native/share/stop`, { method: 'POST', signal: AbortSignal.timeout(2000) })
        log.info('IPC', 'CLI share/stop response', { status: r.status })
      } catch (e) { log.warn('IPC', 'CLI share/stop fetch failed', { err: e.message }) }
    }
    peerPort = null
    updateTray()
  } else if (config.token) {
    log.info('IPC', 'toggle-sharing ON Ã¢â‚¬â€ starting sharing')
    config.shareEnabled = true; saveConfig(); updateTray(); connectRelay()
  }
  _sharingToggleBusy = false
  logState('post-toggle-sharing')
  return { running, shareEnabled: !!config.shareEnabled }
})

ipcMain.handle('sign-out', async () => {
  logIpc('sign-out', { userId: config.userId })
  // Revoke device_codes on the server so CLI and other clients are also signed out
  if (config.userId && config.token) {
    try {
      await fetch(`${API_BASE}/api/extension-auth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({ userId: config.userId, deviceSessionId: config.deviceSessionId || null }),
        signal: AbortSignal.timeout(4000),
      })
    } catch (e) {
      log.warn('AUTH', 'sign-out revoke failed', { err: e.message })
    }
  }
  await clearDesktopAuth('ipc_sign_out', { revoke: true })
  log.info('IPC', 'signed out')
  return { success: true }
})

ipcMain.handle('open-dashboard', () => { logIpc('open-dashboard'); shell.openExternal(`${API_BASE}/dashboard`) })

ipcMain.handle('check-desktop-update', async () => {
  logIpc('check-desktop-update')
  return { success: true, update: await checkDesktopUpdate('ipc') }
})

ipcMain.handle('download-desktop-update', async () => {
  logIpc('download-desktop-update')
  return openDesktopUpdateDownload()
})

ipcMain.handle('accept-provider-terms', async (_, { checkOnly } = {}) => {
  logIpc('accept-provider-terms', { checkOnly })
  if (!config.token) return { success: false }
  if (checkOnly) {
    try {
      const data = await refreshSharingConfig()
      log.info('IPC', 'accept-provider-terms checkOnly result', { accepted: data?.has_accepted_provider_terms })
      return { success: true, accepted: data?.has_accepted_provider_terms === true }
    } catch {}
    // If refresh failed, fall back to local config — also treat currently sharing as accepted
    const localAccepted = !!(config.hasAcceptedProviderTerms || config.shareEnabled || activeSlotCount() > 0)
    return { success: true, accepted: localAccepted }
  }
  try {
    const res = await fetch(`${API_BASE}/api/user/sharing`, { method: 'POST', headers: withSharingAuthHeaders(), body: JSON.stringify({ acceptProviderTerms: true }) })
    if (res.ok) { config.hasAcceptedProviderTerms = true; saveConfig(); log.info('IPC', 'provider terms accepted and saved') }
  } catch (e) { log.warn('IPC', 'accept-provider-terms save failed', { err: e.message }) }
  return { success: true }
})

// Ã¢â€â‚¬Ã¢â€â‚¬ App lifecycle Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async function bootstrapNativeHostMode() {
  await app.whenReady()
  log.info('PROCESS', '=== NATIVE HOST START ===', { argv: process.argv.slice(1).join(' ') })
  await initializeDesktopRuntime('native_host')
  runNativeHostMode()
}

async function bootstrapDesktopApp() {
  await app.whenReady()
  app.on('second-instance', () => { log.info('PROCESS', 'second-instance event Ã¢â‚¬â€ showing window'); showWindow() })

  log.info('PROCESS', '=== APP START ===', { version: DESKTOP_VERSION, background: IS_BACKGROUND_LAUNCH, argv: process.argv.slice(1).join(' '), userDataDir: USER_DATA_DIR })
  app.on('window-all-closed', (e) => {
    if (_quitRequested) return
    e.preventDefault()
  })
  if (process.platform === 'win32') app.setAppUserModelId('com.peermesh.desktop')
  await initializeDesktopRuntime('desktop_app')
  applyLaunchOnStartupPreference(config.launchOnStartup)
  startSharingScheduleLoop()
  app.on('resume', () => {
    void runSharingScheduleTick('resume')
  })

  tray = new Tray(createTrayIcon())
  tray.setToolTip('PeerMesh')
  tray.on('click', showWindow)
  updateTray()

  const tester = net.createServer()
  tester.once('error', () => {
    log.warn('PORT', `port ${CONTROL_PORT} in use Ã¢â‚¬â€ CLI owns it, desktop binding to PEER_PORT ${PEER_PORT}`)
    logRequest('POST', `http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, { port: PEER_PORT, where: 'desktop' })
    fetch(`http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: PEER_PORT, where: 'desktop' }), signal: AbortSignal.timeout(1500),
    })
      .then(r => { logResponse('POST', `http://127.0.0.1:${CONTROL_PORT}/native/peer/register`, r.status)
        peerPort = CONTROL_PORT
        // Sync slots with CLI on registration
        fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          .then(async sr => {
            if (!sr.ok) return
            const cliState = await sr.json()
            const cliSlots = cliState.connectionSlots ?? cliState.slots?.configured ?? null
            if (cliState.running && cliSlots && cliSlots !== clampSlots(config.connectionSlots ?? 1)) {
              log.info('PORT', 'secondary desktop adopting slot count from running CLI', { cliSlots, ourSlots: clampSlots(config.connectionSlots ?? 1) })
              config.connectionSlots = cliSlots
              ensureSlotStates()
              saveConfig()
              updateTray()
            } else if (!cliState.running && cliSlots !== clampSlots(config.connectionSlots ?? 1)) {
              fetch(`http://127.0.0.1:${CONTROL_PORT}/native/connection-slots`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ slots: clampSlots(config.connectionSlots ?? 1) }),
                signal: AbortSignal.timeout(1500),
              }).catch(() => {})
            }
          }).catch(() => {})
      })
      .catch(e => log.warn('PORT', 'peer register failed', { err: e.message }))

    const peerServer = http.createServer((req, res) => {
      const origin = req.headers.origin || ''
      res.setHeader('Access-Control-Allow-Origin', origin.includes('peermesh') || origin.includes('localhost') || origin.startsWith('chrome-extension://') ? origin : '')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const url = new URL(req.url, `http://localhost:${PEER_PORT}`)
      log.debug('PEER-SERVER', `${req.method} ${url.pathname}`)

      if (req.method === 'GET' && url.pathname === '/native/state') {
        fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          .then(r => r.json())
          .then(d => { peerSharing = !!d.running; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...d, where: 'desktop', peerWhere: 'cli' })) })
          .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: true, running: false, shareEnabled: false, where: 'desktop' })) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/native/share/stop') {
        log.info('PEER-SERVER', '/native/share/stop Ã¢â‚¬â€ desktop peer received stop signal (not forwarding back to CLI)')
        // Do NOT forward to CLI Ã¢â‚¬â€ they sent this to us; forwarding would cause a loop
        peerSharing = false
        config.shareEnabled = false
        saveConfig()
        if (running) stopRelay(); else updateTray()
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ available: true, running: false, shareEnabled: false }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/native/peer/register') {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
          try { const p = JSON.parse(body); peerPort = p.port; log.info('PEER-SERVER', '/native/peer/register', { peerPort, where: p.where }) } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404); res.end()
    })

    peerServer.listen(PEER_PORT, '127.0.0.1', async () => {
      log.info('PORT', `PORT RACE RESULT: desktop peer server on ${PEER_PORT} (CLI owns ${CONTROL_PORT})`)
      try {
        const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
        if (r.ok) { const d = await r.json(); peerSharing = !!d.running; log.info('PORT', 'CLI state at desktop startup', { cliRunning: d.running, cliVersion: d.version }) }
      } catch (e) { log.warn('PORT', 'CLI state check failed', { err: e.message }) }
      updateTray()

      function reclaimPrimary() {
        log.info('PORT', 'CLI gone Ã¢â‚¬â€ reclaiming port ' + CONTROL_PORT)
        logState('pre-reclaim')
        peerSharing = false; peerPort = null; config.shareEnabled = false; saveConfig(); updateTray()
        peerServer.close(() => {
          controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
            localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')
            log.info('PORT', 'PORT RECLAIMED: desktop now owns ' + CONTROL_PORT)
            logState('post-reclaim')
          })
        })
      }

      const cliWatcher = setInterval(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          if (r.ok) {
            const d = await r.json()
            if (!_sharingToggleBusy) {
              const prev = peerSharing
              peerSharing = !!d.running
              if (peerSharing !== prev) { log.info('PORT', 'cliWatcher peerSharing changed', { from: prev, to: peerSharing }); updateTray() }
            }
          } else {
            log.warn('PORT', 'cliWatcher non-ok response Ã¢â‚¬â€ reclaiming', { status: r.status })
            clearInterval(cliWatcher); reclaimPrimary()
          }
        } catch (e) {
          log.info('PORT', 'cliWatcher Ã¢â‚¬â€ CLI gone (unreachable)', { err: e.message })
          clearInterval(cliWatcher); reclaimPrimary()
        }
      }, 3000)
    })
    peerServer.on('error', e => log.error('PORT', 'Desktop peer server error', { err: e.message }))
  })

  tester.once('listening', () => {
    tester.close(() => {
      controlServer.listen(CONTROL_PORT, '127.0.0.1', async () => {
        log.info('PORT', `PORT RACE RESULT: desktop owns ${CONTROL_PORT} (primary)`)
        localProxyServer.listen(LOCAL_PROXY_PORT, '127.0.0.1')

        let cliAlreadySharing = false
        try {
          const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
          if (r.ok) {
            const cliState = await r.json()
            log.info('PORT', 'CLI detected on PEER_PORT at startup', { where: cliState.where, running: cliState.running, version: cliState.version })
            if (cliState.where === 'cli') {
              await fetch(`http://127.0.0.1:${PEER_PORT}/native/peer/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port: CONTROL_PORT, where: 'desktop' }), signal: AbortSignal.timeout(1500),
              })
              peerPort = PEER_PORT
              cliAlreadySharing = !!cliState.running
              peerSharing = cliAlreadySharing
              log.info('PORT', 'registered with CLI peer', { peerPort, cliAlreadySharing })
              // Sync slots: adopt running peer's count, else push ours
              const cliSlots = cliState.connectionSlots ?? cliState.slots?.configured ?? null
              if (cliAlreadySharing && cliSlots && cliSlots !== clampSlots(config.connectionSlots ?? 1)) {
                log.info('PORT', 'adopting slot count from running CLI', { cliSlots, ourSlots: clampSlots(config.connectionSlots ?? 1) })
                config.connectionSlots = cliSlots
                ensureSlotStates()
                saveConfig()
                updateTray()
              } else if (!cliAlreadySharing && cliSlots !== clampSlots(config.connectionSlots ?? 1)) {
                fetch(`http://127.0.0.1:${PEER_PORT}/native/connection-slots`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ slots: clampSlots(config.connectionSlots ?? 1) }),
                  signal: AbortSignal.timeout(1500),
                }).catch(() => {})
              }
              if (cliAlreadySharing) log.info('PORT', 'CLI is sharing Ã¢â‚¬â€ desktop standing by')

              _cliWatchTimer = setInterval(async () => {
                try {
                  const r = await fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(1500) })
                  if (r.ok) {
                    const d = await r.json()
                    if (!_sharingToggleBusy) {
                      const prev = peerSharing
                      peerSharing = !!d.running
                      if (peerSharing !== prev) { log.info('PORT', '_cliWatchTimer peerSharing changed', { from: prev, to: peerSharing }); updateTray() }
                    }
                  } else {
                    log.warn('PORT', '_cliWatchTimer non-ok Ã¢â‚¬â€ clearing peer state', { status: r.status })
                    clearInterval(_cliWatchTimer); _cliWatchTimer = null; peerSharing = false; peerPort = null; updateTray()
                  }
                } catch (e) {
                  log.info('PORT', '_cliWatchTimer Ã¢â‚¬â€ CLI gone (unreachable)', { err: e.message })
                  clearInterval(_cliWatchTimer); _cliWatchTimer = null; peerSharing = false; peerPort = null; updateTray()
                }
              }, 3000)
            }
          }
        } catch (e) { log.debug('PORT', 'no CLI on PEER_PORT at startup', { err: e.message }) }

        const shouldAutoShare = !cliAlreadySharing && !!(config.token && config.userId && (config.autoShareOnLaunch || config.shareEnabled) && config.hasAcceptedProviderTerms)
        log.info('PORT', 'startup check complete', {
          cliAlreadySharing,
          hasToken: !!config.token,
          hasUserId: !!config.userId,
          shareEnabled: config.shareEnabled,
          autoShareOnLaunch: config.autoShareOnLaunch,
          hasAcceptedProviderTerms: config.hasAcceptedProviderTerms,
          shouldAutoShare,
        })
        logState('startup')
        if (shouldAutoShare) {
          config.shareEnabled = true
          saveConfig()
          updateTray()
          log.info('PORT', 'auto-connecting relay on startup')
          connectRelay()
        }
      })
    })
  })
  tester.listen(CONTROL_PORT, '127.0.0.1')

  if (!IS_BACKGROUND_LAUNCH) showWindow()
}

if (!HAS_SINGLE_INSTANCE_LOCK) {
  log.warn('PROCESS', 'Another instance is already running - quitting')
  app.quit()
} else if (IS_NATIVE_HOST_MODE) {
  void bootstrapNativeHostMode().catch((e) => {
    log.error('PROCESS', 'native host bootstrap failed', { err: e.message, stack: e.stack })
    app.quit()
  })
} else {
  void bootstrapDesktopApp().catch((e) => {
    log.error('PROCESS', 'desktop bootstrap failed', { err: e.message, stack: e.stack })
    app.quit()
  })
}

app.on('before-quit', () => {
  _quitRequested = true
  log.info('PROCESS', '=== APP QUIT ===')
  shutdownDesktopRuntime('before-quit')
})
