// background/service-worker.js - PeerMesh Extension Service Worker
const APP_URL = 'https://peermesh-0unl.onrender.com'
const APP_HOST = new URL(APP_URL).hostname

const EXTENSION_VERSION = chrome.runtime.getManifest().version
const BLOCKED_HOSTS = [/\.onion$/i, /^smtp\./i, /^mail\./i, /torrent/i]
const ALLOWED_TARGET_PORTS = new Set([80, 443, 8080, 8443])
const PRIVATE_HOSTS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(22[4-9]|23\d)\./, /^255\.255\.255\.255$/,
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe[89ab][0-9a-f]:/i,
  /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i,
]
const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding'])
const SHARING_ACTOR = 'extension'
const MIN_CHROME_MAJOR = 148
const CHROME_FULL_VERSION = '148.0.7778.179'
const COUNTRY_DATA_MAP = globalThis.__PEERMESH_COUNTRY_DATA__ || {
  XX: { tz: 'UTC', lang: 'en-US', lat: 51.5074, lon: -0.1278, persona: 'desktop' },
}
const PERSONA_POOL_MAP = globalThis.__PEERMESH_PERSONA_POOLS__ || {
  desktop: [
    {
      mobile: false,
      platform: 'Win32',
      platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 25, rtt: 25, saveData: false },
      sampleRate: 48000,
      colorDepth: 24,
    },
  ],
}
const DEFAULT_COUNTRY = COUNTRY_DATA_MAP.XX || {
  tz: 'UTC',
  lang: 'en-US',
  lat: 51.5074,
  lon: -0.1278,
  persona: 'desktop',
}

function withSharingHeaders(headers = {}) {
  return { ...headers, 'x-peermesh-actor': SHARING_ACTOR }
}

let _liveRelays = null
let _liveRelaysFetchedAt = 0
const RELAY_CONFIG_TTL = 5 * 60 * 1000

async function getLiveRelays() {
  if (_liveRelays && Date.now() - _liveRelaysFetchedAt < RELAY_CONFIG_TTL) return _liveRelays
  const res = await fetch(`${APP_URL}/api/relay/config`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`relay config fetch failed: status=${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data.relays) || data.relays.length === 0) throw new Error('relay config returned empty list')
  _liveRelays = data.relays
  _liveRelaysFetchedAt = Date.now()
  log('info', `[RELAY-CONFIG] fetched ${data.relays.length} relays: ${data.relays.join(', ')}`)
  return _liveRelays
}
const NATIVE_HOST = 'com.peermesh.desktop'
const CONTROL_PORT = 7654
const REQUESTER_SESSION_REFRESH_MS = 45 * 60 * 1000
const DESKTOP_PROXY_SYNC_MS = 60 * 1000
const PRIVATE_ON_DEMAND_MAX_ATTEMPTS = 4
const DESKTOP_LAUNCH_WAIT_MS = 8000

let relayWs = null
let desktopSignalWs = null
let desktopSignalSessionId = null
let currentSession = null
let agentSessionId = null
let proxyFailClosed = false
let supabaseToken = null
let desktopToken = null
let sharingUserId = null
let sharingCountry = null
let sharingMode = null
let heartbeatInterval = null
let providerWs = null
let providerShareEnabled = false
let providerRegistered = false
let providerReconnectDelay = 2000
let providerReconnectTimer = null
let providerPeerId = null
let providerStats = { bytesServed: 0, requestsHandled: 0, connectedAt: null, peerId: null }
let providerPrivateShare = null
let providerPrivateShares = []
let providerAuthFailureCount = 0
const PROVIDER_AUTH_FAILURE_THRESHOLD = 3
let _sessionRefreshing = false

const pendingRequests = new Map()

async function getExtensionIdentity() {
  const stored = await chrome.storage.local.get(['extId'])
  const extId = stored.extId ?? null
  if (!extId) return { extId: null, baseDeviceId: null, deviceId: null }
  const baseDeviceId = `ext_${extId}`
  return {
    extId,
    baseDeviceId,
    deviceId: `${baseDeviceId}_slot_0`,
  }
}

function hashString(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function normalizeCountry(country) {
  const requested = String(country || '').trim().toUpperCase()
  if (requested && COUNTRY_DATA_MAP[requested]) {
    return { code: requested, meta: COUNTRY_DATA_MAP[requested] }
  }

  const shortCode = requested.slice(0, 2)
  if (shortCode && COUNTRY_DATA_MAP[shortCode]) {
    return { code: shortCode, meta: COUNTRY_DATA_MAP[shortCode] }
  }

  return { code: requested || 'XX', meta: DEFAULT_COUNTRY }
}

function getChromeFullVersion(userAgent, fallbackVersion) {
  const match = /Chrome\/([\d.]+)/.exec(userAgent || '')
  return match?.[1] || (fallbackVersion ? getModernChromeFullVersion(fallbackVersion) : CHROME_FULL_VERSION)
}

function clampChromeMajor(version) {
  const major = Number.parseInt(String(version || '').split('.')[0], 10)
  return String(Number.isFinite(major) ? Math.max(major, MIN_CHROME_MAJOR) : MIN_CHROME_MAJOR)
}

function getModernChromeFullVersion(version) {
  const major = clampChromeMajor(version)
  return major === String(MIN_CHROME_MAJOR) ? CHROME_FULL_VERSION : `${major}.0.0.0`
}

function modernizeChromeUserAgent(userAgent, majorVersion) {
  const fullVersion = getModernChromeFullVersion(majorVersion)
  return String(userAgent || '').replace(/Chrome\/[\d.]+/g, `Chrome/${fullVersion}`)
}

function getDeviceModel(variant) {
  if (!variant?.mobile) return ''
  const match = /Android [^;]+; ([^)]+)\)/.exec(variant.userAgent || '')
  return match?.[1] || 'Android'
}

function getPlatformVersion(variant) {
  const userAgent = variant?.userAgent || ''

  if (variant?.platformLabel === 'Android') {
    const match = /Android ([\d.]+)/.exec(userAgent)
    return match?.[1]
      ? match[1].split('.').concat(['0', '0']).slice(0, 3).join('.')
      : '14.0.0'
  }

  if (variant?.platformLabel === 'Windows') {
    const match = /Windows NT ([\d.]+)/.exec(userAgent)
    return match?.[1] ? `${match[1]}.0` : '10.0.0'
  }

  if (variant?.platformLabel === 'macOS') {
    const match = /Mac OS X ([\d_]+)/.exec(userAgent)
    return match?.[1]?.replace(/_/g, '.') || '10.15.7'
  }

  return '0.0.0'
}

function normalizePersona(personaName, variant, variantIndex) {
  const uaVersion = clampChromeMajor(variant.uaVersion || getChromeFullVersion(variant.userAgent).split('.')[0])
  const uaFullVersion = getModernChromeFullVersion(uaVersion)
  const platformLabel = variant.platformLabel || (variant.mobile ? 'Android' : 'Windows')
  const userAgent = modernizeChromeUserAgent(variant.userAgent, uaVersion)

  return {
    name: personaName,
    persona: personaName,
    variant: variantIndex,
    mobile: !!variant.mobile,
    userAgent,
    uaVersion,
    uaFullVersion,
    deviceModel: getDeviceModel(variant),
    platform: variant.platform || (variant.mobile ? 'Linux armv8l' : 'Win32'),
    platformLabel,
    platformVersion: getPlatformVersion(variant),
    architecture: variant.mobile || String(variant.platform || '').toLowerCase().includes('arm') ? 'arm' : 'x86',
    bitness: variant.mobile || /(?:x64|win64|x86_64|armv8|aarch64)/i.test(`${variant.userAgent || ''} ${variant.platform || ''}`) ? '64' : '32',
    hardwareConcurrency: variant.hardwareConcurrency ?? (variant.mobile ? 6 : 8),
    deviceMemory: variant.deviceMemory ?? (variant.mobile ? 4 : 8),
    maxTouchPoints: variant.maxTouchPoints ?? (variant.mobile ? 5 : 0),
    connection: {
      effectiveType: variant.connection?.effectiveType || '4g',
      downlink: variant.connection?.downlink ?? 10,
      rtt: variant.connection?.rtt ?? 50,
      saveData: !!variant.connection?.saveData,
    },
    sampleRate: variant.sampleRate ?? 48000,
    colorDepth: variant.colorDepth ?? 24,
    pixelDepth: variant.pixelDepth ?? variant.colorDepth ?? 24,
  }
}

function selectPersonaVariant(country, personaName, pool, session) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return { variant: PERSONA_POOL_MAP.desktop[0], variantIndex: 0 }
  }

  const stableSeed = [session?.userId, country].filter(Boolean).join('|') || `${country}|${personaName}`
  const variantIndex = hashString(stableSeed) % pool.length
  return { variant: pool[variantIndex], variantIndex }
}

function buildSpoofProfile(session) {
  const { code: country, meta } = normalizeCountry(session?.country)
  const personaName = PERSONA_POOL_MAP[meta.persona] ? meta.persona : DEFAULT_COUNTRY.persona || 'desktop'
  const pool = PERSONA_POOL_MAP[personaName] || PERSONA_POOL_MAP.desktop
  const { variant, variantIndex } = selectPersonaVariant(country, personaName, pool, session)
  const persona = normalizePersona(personaName, variant, variantIndex)

  return {
    country,
    userId: session?.userId || '',
    tz: meta.tz,
    lang: meta.lang,
    lat: meta.lat,
    lon: meta.lon,
    ...persona,
  }
}

function buildAcceptLanguage(profile) {
  const primary = String(profile?.lang || 'en-US')
  const base = primary.split('-')[0]
  if (!base || base === primary) {
    return primary.toLowerCase().startsWith('en') ? `${primary},en;q=0.9` : `${primary},en;q=0.8`
  }
  return primary.toLowerCase().startsWith('en')
    ? `${primary},${base};q=0.9`
    : `${primary},${base};q=0.9,en;q=0.8`
}

function buildSecChUa(profile) {
  const version = clampChromeMajor(profile?.uaVersion || MIN_CHROME_MAJOR)
  return `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not-A.Brand";v="99"`
}

function isAllowedHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return !BLOCKED_HOSTS.some((pattern) => pattern.test(host)) &&
    !PRIVATE_HOSTS.some((pattern) => pattern.test(host))
}

function getUrlPort(parsed) {
  return parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80)
}

function isAllowedPort(port) {
  return ALLOWED_TARGET_PORTS.has(Number(port))
}

function getStandalonePrivateShares(baseDeviceId, deviceId) {
  if (!deviceId) return []
  // Use the full synced array if available, fall back to single share
  if (Array.isArray(providerPrivateShares) && providerPrivateShares.length > 0) return providerPrivateShares
  if (providerPrivateShare?.device_id === deviceId) return [providerPrivateShare]
  return [{
    device_id: deviceId,
    base_device_id: baseDeviceId ?? deviceId.replace(/_slot_\d+$/, ''),
    slot_index: 0,
    code: '',
    enabled: false,
    expires_at: null,
    active: false,
  }]
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Logger Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const MAX_LOGS = 200
const _logs = []

function log(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23)
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  const entry = { ts, level, msg }
  _logs.push(entry)
  if (_logs.length > MAX_LOGS) _logs.shift()
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${ts}] [SW] ${msg}`)
  chrome.runtime.sendMessage({ type: 'LOG', entry }).catch(() => {})
}

function getLogs() { return [..._logs] }

function getPublicRequesterSession() {
  if (!currentSession) return null
  return {
    id: currentSession.sessionId,
    sessionId: currentSession.sessionId,
    country: currentSession.country,
    relayEndpoint: currentSession.relayEndpoint,
    quality: currentSession.quality || null,
    connectionType: currentSession.connectionType || 'public',
    refreshedAt: currentSession.refreshedAt || null,
  }
}

async function broadcastSessionEnded(reason = 'Peer connection dropped') {
  await chrome.runtime.sendMessage({ type: 'SESSION_ENDED', reason }).catch(() => {})
  try {
    const tabs = await chrome.tabs.query({})
    await Promise.all(
      tabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'PEERMESH_SESSION_ENDED', reason }).catch(() => {})),
    )
  } catch {}
}

async function broadcastBrowsingStatus(status) {
  try {
    const tabs = await chrome.tabs.query({})
    await Promise.all(
      tabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'PEERMESH_BROWSING_STATUS', ...status }).catch(() => {})),
    )
  } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    try {
      switch (msg.type) {
        case 'GET_LOGS':
          sendResponse({ logs: getLogs() })
          break
        case 'CONNECT':
          log('info', 'CONNECT country=' + msg.country + ' userId=' + msg.userId?.slice(0,8))
          await connectToRelay(msg)
          sendResponse({ success: true })
          break
        case 'DISCONNECT':
          log('info', 'DISCONNECT requested')
          await disconnect()
          sendResponse({ success: true })
          break
        case 'UNBLOCK_BROWSER':
          log('warn', 'UNBLOCK_BROWSER requested - clearing PeerMesh proxy protection')
          await manualUnblockBrowser()
          sendResponse({ success: true })
          break
        case 'START_SHARING': {
          if (msg.supabaseToken) {
            supabaseToken = msg.supabaseToken
            desktopToken = msg.desktopToken || null
            sharingUserId = msg.userId
            sharingCountry = msg.country
            await chrome.storage.local.set({ supabaseToken, desktopToken, sharingCountry, sharingUserId })
          }
          const result = await startSharingTransport(msg)
          sendResponse(result)
          break
        }
        case 'STOP_SHARING': {
          const result = await stopSharingTransport()
          sendResponse(result)
          break
        }
        case 'SET_CONNECTION_SLOTS': {
          const result = await setHelperConnectionSlots(msg.slots)
          sendResponse(result)
          break
        }
        case 'GET_STATUS': {
          const helper = await persistSharingState()
          const isSharing = helper.available && !helper.ownerMismatch && (helper.running || helper.shareEnabled)
          const failClosedState = await chrome.storage.session.get(['proxyFailClosedReason']).catch(() => ({}))
          log('info', 'GET_STATUS helper.available=' + helper.available + ' running=' + helper.running + ' isSharing=' + isSharing)
          sendResponse({
            connected: !!currentSession,
            session: getPublicRequesterSession(),
            isSharing,
            helper,
            failClosed: proxyFailClosed,
            failClosedReason: failClosedState.proxyFailClosedReason ?? null,
          })
          break
        }
        case 'GET_DESKTOP_REQUIRED_STATUS': {
          const helper = await waitForDesktopHelperHttp()
          sendResponse({
            available: !!helper?.available,
            helper,
            error: helper?.available ? null : 'PeerMesh Desktop required',
          })
          break
        }
        case 'PROXY_FETCH': {
          const result = await proxyFetch(msg.url, msg.options ?? {})
          sendResponse(result)
          break
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' })
      }
    } catch (error) {
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true
})

// Ã¢â€â‚¬Ã¢â€â‚¬ Proxy fetch Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function proxyFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN || !agentSessionId) {
      resolve({ ok: false, status: 503, body: '', error: 'Not connected to peer' })
      return
    }
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve({ ok: false, status: 504, body: '', error: 'Request timed out' })
    }, 30000)
    pendingRequests.set(requestId, { resolve, timer })
    relayWs.send(JSON.stringify({
      type: 'proxy_request',
      sessionId: agentSessionId,
      request: { requestId, url, method, headers, body },
    }))
  })
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Extension heartbeat Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function getShareAuthToken() {
  return desktopToken || supabaseToken || null
}

async function loadSharingContext() {
  const stored = await chrome.storage.local.get(['user', 'supabaseToken', 'desktopToken', 'sharingCountry', 'sharingUserId', 'sharingMode', 'providerPrivateShare'])
  if (!supabaseToken) supabaseToken = stored.supabaseToken ?? stored.user?.supabaseToken ?? null
  if (!desktopToken) desktopToken = stored.desktopToken ?? stored.user?.token ?? null
  if (!sharingCountry) sharingCountry = stored.sharingCountry ?? stored.user?.country_code ?? stored.user?.country ?? null
  if (!sharingUserId) sharingUserId = stored.sharingUserId ?? stored.user?.id ?? null
  if (stored.sharingMode !== undefined) sharingMode = stored.sharingMode ?? null
  if (stored.providerPrivateShare !== undefined) providerPrivateShare = stored.providerPrivateShare ?? null
  if (stored.providerPrivateShares !== undefined) providerPrivateShares = Array.isArray(stored.providerPrivateShares) ? stored.providerPrivateShares : []
  return stored
}

function isHelperOwnedByUser(helper, userId) {
  return !(helper?.available && helper.userId && userId && helper.userId !== userId)
}

function syncActionBadge() {
  if (proxyFailClosed) {
    chrome.action.setBadgeText({ text: 'ERR' })
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
    return
  }
  if (currentSession) {
    chrome.action.setBadgeText({ text: 'ON' })
    chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
    return
  }
  if (sharingMode) {
    chrome.action.setBadgeText({ text: 'SHR' })
    chrome.action.setBadgeBackgroundColor({ color: '#00ff88' })
    return
  }
  chrome.action.setBadgeText({ text: '' })
}

function clearProviderReconnect() {
  if (!providerReconnectTimer) return
  clearTimeout(providerReconnectTimer)
  providerReconnectTimer = null
}

function sanitizeFetchHeaders(headers = {}) {
  const out = {}
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = String(rawKey).trim().toLowerCase()
    if (!key) continue
    if (FORBIDDEN_REQUEST_HEADERS.has(key)) continue
    if (key === 'cookie' || key === 'origin' || key === 'referer') continue
    if (key.startsWith('sec-')) continue
    if (rawValue == null) continue
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  }
  return out
}

async function handleProviderFetch(sessionId, request) {
  const { requestId, url, method = 'GET', headers = {}, body = null } = request ?? {}
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { requestId, status: 400, headers: {}, body: '', error: 'Unsupported protocol' }
    }
    if (!isAllowedHost(parsed.hostname) || !isAllowedPort(getUrlPort(parsed))) {
      return { requestId, status: 403, headers: {}, body: '', error: 'Blocked host' }
    }

    providerStats.requestsHandled += 1
    const response = await fetch(url, {
      method,
      headers: sanitizeFetchHeaders(headers),
      body: method === 'GET' || method === 'HEAD' ? undefined : body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })

    // For redirect responses, return the Location header directly so the
    // requester's browser follows each hop through the proxy independently.
    // This prevents the provider from chasing a full redirect chain (e.g.
    // email tracking links) within a single fetch timeout.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      const responseHeaders = {}
      if (location) responseHeaders['location'] = location
      const cacheControl = response.headers.get('cache-control')
      if (cacheControl) responseHeaders['cache-control'] = cacheControl
      return { requestId, status: response.status, headers: responseHeaders, body: '' }
    }
    const responseBody = method === 'HEAD' ? '' : await response.text()
    const responseHeaders = {}
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'connection', 'keep-alive', 'transfer-encoding'].includes(key)) {
        responseHeaders[key] = value
      }
    })
    providerStats.bytesServed += responseBody.length
    log('info', `[PROVIDER] session=${sessionId?.slice(0, 8) ?? 'unknown'} ${method} ${parsed.hostname} status=${response.status} bytes=${responseBody.length}`)
    return {
      requestId,
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
      finalUrl: response.url,
    }
  } catch (error) {
    log('error', `[PROVIDER] fetch failed session=${sessionId?.slice(0, 8) ?? 'unknown'} url=${url} err=${error.message}`)
    return { requestId, status: 502, headers: {}, body: '', error: error.message }
  }
}

async function getStandaloneProviderStatus() {
  await loadSharingContext()
  const { baseDeviceId, deviceId } = await getExtensionIdentity()
  const configured = !!(sharingUserId && sharingCountry && baseDeviceId)
  const active = providerRegistered ? 1 : 0
  const privateShares = getStandalonePrivateShares(baseDeviceId, deviceId)
  const privateShare = privateShares[0] ?? null
  return {
    available: !!baseDeviceId,
    source: 'extension',
    running: providerRegistered,
    shareEnabled: providerShareEnabled,
    configured,
    country: sharingCountry ?? null,
    userId: sharingUserId ?? null,
    version: EXTENSION_VERSION,
    baseDeviceId,
    deviceId,
    connectionSlots: 1,
    privateShareActive: !!(privateShare?.enabled && privateShare?.active),
    privateShare,
    privateShares,
    privateShareDeviceId: deviceId ?? null,
    slots: {
      configured: 1,
      active,
      warning: providerShareEnabled ? 'Standalone extension mode: single slot, web requests only.' : null,
    },
    stats: {
      ...providerStats,
      activeSlots: active,
      configuredSlots: 1,
      warning: providerShareEnabled ? 'Standalone extension mode: single slot, web requests only.' : null,
    },
  }
}

async function persistSharingState(helperOverride = null) {
  const stored = await loadSharingContext()
  const currentUserId = stored.user?.id ?? sharingUserId ?? null
  const helper = helperOverride ?? await getSharingStatus()
  const helperOwned = isHelperOwnedByUser(helper, currentUserId)
  const normalizedHelper = helper ? { ...helper, ownerMismatch: !helperOwned } : helper
  const isSharing = !!(normalizedHelper?.available && helperOwned && (normalizedHelper.running || normalizedHelper.shareEnabled))
  await chrome.storage.local.set({
    isSharing,
    helper: normalizedHelper,
    sharingMode,
    sharingCountry,
    sharingUserId,
  })
  syncActionBadge()
  return normalizedHelper
}

function startExtensionHeartbeat() {
  stopExtensionHeartbeat(false)
  void sendExtensionHeartbeat()
  heartbeatInterval = setInterval(() => {
    void sendExtensionHeartbeat()
  }, 30_000)
}

function stopExtensionHeartbeat(removeDevice = true) {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
  if (!removeDevice) return
  const token = getShareAuthToken()
  if (!token || !sharingUserId) return
  void getExtensionIdentity().then(({ deviceId }) => {
    if (!deviceId) return
    fetch(`${APP_URL}/api/user/sharing`, {
      method: 'DELETE',
      headers: withSharingHeaders({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
      body: JSON.stringify({ device_id: deviceId }),
    }).catch(() => {})
  })
}

async function tryRefreshExtensionToken() {
  const stored = await chrome.storage.local.get(['user'])
  const userId = stored.user?.id ?? sharingUserId ?? null
  const refreshToken = stored.user?.refreshToken ?? null
  const deviceSessionId = stored.user?.deviceSessionId ?? null
  if (!userId || !refreshToken || !deviceSessionId) return false
  try {
    const res = await fetch(`${APP_URL}/api/extension-auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSessionId, refreshToken }),
      signal: AbortSignal.timeout(5000),
    })
    // 5xx or network errors — keep existing token, do not treat as revoked
    if (res.status >= 500) {
      log('warn', `[AUTH] token refresh server error status=${res.status} — keeping existing token`)
      return false
    }
    // 403 with revoked=true — session was explicitly revoked, clear auth
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}))
      if (body.revoked === true) {
        log('warn', `[AUTH] device session revoked userId=${userId.slice(0,8)}`)
        // Clear stored tokens but keep user object so UI shows signed-out state
        const clearedUser = { ...stored.user, token: '', refreshToken: '', deviceSessionId: '' }
        await chrome.storage.local.set({ user: clearedUser, supabaseToken: '', desktopToken: '' })
        supabaseToken = null
        desktopToken = null
      }
      return false
    }
    if (!res.ok) return false
    const data = await res.json()
    if (data.token && data.refreshToken && data.deviceSessionId) {
      supabaseToken = data.token
      desktopToken = data.token
      const updatedUser = { ...stored.user, token: data.token, refreshToken: data.refreshToken, deviceSessionId: data.deviceSessionId }
      await chrome.storage.local.set({ supabaseToken: data.token, desktopToken: data.token, user: updatedUser })
      log('info', `[AUTH] extension token refreshed userId=${userId.slice(0,8)}`)
      return true
    }
  } catch (err) {
    log('warn', `[AUTH] token refresh failed (network?) — keeping existing token: ${err.message}`)
  }
  return false
}
async function sendExtensionHeartbeat() {
  if (sharingMode !== 'extension' || !providerShareEnabled) return
  await loadSharingContext()
  const token = getShareAuthToken()
  if (!token || !sharingCountry) return
  const { deviceId } = await getExtensionIdentity()
  if (!deviceId) return
  try {
    const response = await fetch(`${APP_URL}/api/user/sharing`, {
      method: 'PUT',
      headers: withSharingHeaders({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
      body: JSON.stringify({ device_id: deviceId, country: sharingCountry }),
    })
    if (response.ok) providerAuthFailureCount = 0
    if (response.status === 401 || response.status === 403) {
      providerAuthFailureCount += 1
      log('warn', `[HEARTBEAT] auth rejected status=${response.status} count=${providerAuthFailureCount}`)
      if (providerAuthFailureCount < PROVIDER_AUTH_FAILURE_THRESHOLD) return
      const refreshed = await tryRefreshExtensionToken()
      if (refreshed) {
        providerAuthFailureCount = 0
        log('info', '[HEARTBEAT] token refreshed - continuing')
        return
      }
      log('warn', '[HEARTBEAT] token refresh failed - preserving standalone provider and retrying later')
      return
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      log('warn', `[HEARTBEAT] PUT failed status=${response.status} body=${JSON.stringify(body)}`)
    }
  } catch (error) {
    log('error', `[HEARTBEAT] PUT error: ${error.message}`)
  }
}

async function syncProviderPrivateShareState({ source = 'sync' } = {}) {
  await loadSharingContext()
  const token = getShareAuthToken()
  const { baseDeviceId } = await getExtensionIdentity()
  if (!token || !baseDeviceId) {
    providerPrivateShare = null
    return null
  }
  try {
    const response = await fetch(`${APP_URL}/api/user/sharing?baseDeviceId=${encodeURIComponent(baseDeviceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) providerAuthFailureCount = 0
    if (response.status === 401 || response.status === 403) {
      providerAuthFailureCount += 1
      log('warn', `[PRIVATE] state sync rejected status=${response.status} count=${providerAuthFailureCount}`)
      if (providerAuthFailureCount >= PROVIDER_AUTH_FAILURE_THRESHOLD) {
        const refreshed = await tryRefreshExtensionToken()
        if (refreshed) {
          providerAuthFailureCount = 0
          return providerPrivateShare
        }
      }
      return providerPrivateShare
    }
    if (!response.ok) {
      log('warn', `[PRIVATE] state sync failed status=${response.status}`)
      return providerPrivateShare
    }

    const data = await response.json()
    const nextPrivateShare = data.private_share ?? null
    const nextPrivateShares = Array.isArray(data.private_shares) ? data.private_shares : (nextPrivateShare ? [nextPrivateShare] : [])
    providerPrivateShare = nextPrivateShare
    await chrome.storage.local.set({ providerPrivateShare, providerPrivateShares: nextPrivateShares })
    log('info', `[PRIVATE] state synced via ${source} enabled=${!!nextPrivateShare?.enabled} active=${!!nextPrivateShare?.active} slots=${nextPrivateShares.length}`)

    return providerPrivateShare
  } catch (error) {
    log('warn', `[PRIVATE] state sync error via ${source}: ${error.message}`)
    return providerPrivateShare
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Native messaging / desktop detection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async function sendNativeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return }
      resolve(response ?? {})
    })
  })
}

const PEER_PORT = 7656

async function getDesktopHelperStatusHttp() {
  const [primaryData, peerState] = await Promise.all([
    fetch(`http://127.0.0.1:${CONTROL_PORT}/native/state`, { signal: AbortSignal.timeout(800) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`http://127.0.0.1:${PEER_PORT}/native/state`, { signal: AbortSignal.timeout(800) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
  ])

  if (!primaryData) { log('warn', 'desktop HTTP unreachable') }
  if (!primaryData) return null

  const primary = {
    available: true,
    source: primaryData.where ?? 'desktop',
    running: !!primaryData.running,
    shareEnabled: !!primaryData.shareEnabled,
    configured: !!primaryData.configured,
    country: primaryData.country ?? null,
    userId: primaryData.userId ?? null,
    version: primaryData.version ?? null,
    baseDeviceId: primaryData.baseDeviceId ?? null,
    privateShareActive: !!primaryData.privateShareActive,
    privateShare: primaryData.privateShare ?? null,
    privateShares: Array.isArray(primaryData.privateShares) ? primaryData.privateShares : [],
    privateShareDeviceId: primaryData.privateShareDeviceId ?? null,
    connectionSlots: primaryData.connectionSlots ?? null,
    connectionSlotsSync: primaryData.connectionSlotsSync ?? null,
    slots: primaryData.slots ?? null,
    stats: primaryData.stats ?? null,
  }

  const peerRunning = !!peerState?.running
  const eitherRunning = primary.running || peerRunning
  const stats = (peerRunning && peerState?.stats) ? peerState.stats : (primary.stats ?? null)
  const activeUserId = peerRunning ? (peerState?.userId ?? primary.userId ?? null) : primary.userId
  const activeCountry = peerRunning ? (peerState?.country ?? primary.country ?? null) : primary.country
  const activeBaseDeviceId = peerRunning ? (peerState?.baseDeviceId ?? primary.baseDeviceId ?? null) : primary.baseDeviceId
  const activeSource = peerRunning ? (peerState?.where ?? peerState?.source ?? primary.source ?? 'desktop') : (primary.source ?? 'desktop')
  const activeSlots = peerRunning ? (peerState?.slots ?? primary.slots ?? null) : primary.slots
  const activeConnectionSlots = peerRunning ? (peerState?.connectionSlots ?? primary.connectionSlots ?? null) : primary.connectionSlots
  const activeConnectionSlotsSync = peerRunning ? (peerState?.connectionSlotsSync ?? primary.connectionSlotsSync ?? null) : (primary.connectionSlotsSync ?? null)
  const activePrivateShare = peerRunning ? (peerState?.privateShare ?? primary.privateShare ?? null) : (primary.privateShare ?? null)
  const activePrivateShares = peerRunning
    ? (Array.isArray(peerState?.privateShares) ? peerState.privateShares : (primary.privateShares ?? []))
    : (primary.privateShares ?? [])
  const activePrivateShareDeviceId = peerRunning
    ? (peerState?.privateShareDeviceId ?? primary.privateShareDeviceId ?? null)
    : (primary.privateShareDeviceId ?? null)
  const activePrivateShareActive = peerRunning ? !!(peerState?.privateShareActive ?? primary.privateShareActive) : !!primary.privateShareActive
  return {
    ...primary,
    source: activeSource,
    userId: activeUserId,
    country: activeCountry,
    running: eitherRunning,
    shareEnabled: eitherRunning || primary.shareEnabled,
    baseDeviceId: activeBaseDeviceId,
    privateShareActive: activePrivateShareActive,
    privateShare: activePrivateShare,
    privateShares: activePrivateShares,
    privateShareDeviceId: activePrivateShareDeviceId,
    slots: activeSlots,
    connectionSlots: activeConnectionSlots,
    connectionSlotsSync: activeConnectionSlotsSync,
    stats,
  }
}

async function getDesktopHelperStatus() {
  const http = await getDesktopHelperStatusHttp()
  if (http) return http
  try {
    const response = await sendNativeMessage({ type: 'status' })
    return {
      available: !!response.success,
      source: response.where ?? 'desktop',
      running: !!response.running,
      shareEnabled: !!response.shareEnabled,
      configured: !!response.configured,
      country: response.country ?? null,
      userId: response.userId ?? null,
      version: response.version ?? null,
      baseDeviceId: response.baseDeviceId ?? null,
      privateShareActive: !!response.privateShareActive,
      privateShare: response.privateShare ?? null,
      privateShares: Array.isArray(response.privateShares) ? response.privateShares : [],
      privateShareDeviceId: response.privateShareDeviceId ?? null,
      connectionSlots: response.connectionSlots ?? null,
      connectionSlotsSync: response.connectionSlotsSync ?? null,
      slots: response.slots ?? null,
      stats: response.stats ?? null,
    }
  } catch {
    return { available: false, source: 'desktop', running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null }
  }
}

async function waitForDesktopHelperHttp(timeoutMs = DESKTOP_LAUNCH_WAIT_MS) {
  const first = await getDesktopHelperStatusHttp()
  if (first?.available) return first

  let nativeStatus = null
  try {
    const response = await sendNativeMessage({ type: 'launch_app' })
    if (response?.success) nativeStatus = response
  } catch (error) {
    log('warn', `[DESKTOP] native launch unavailable: ${error.message}`)
    try {
      const response = await sendNativeMessage({ type: 'status' })
      if (response?.success) nativeStatus = response
    } catch {}
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const helper = await getDesktopHelperStatusHttp()
    if (helper?.available) return helper
  }

  return nativeStatus
    ? {
        available: true,
        source: nativeStatus.where ?? 'desktop',
        running: !!nativeStatus.running,
        shareEnabled: !!nativeStatus.shareEnabled,
        configured: !!nativeStatus.configured,
        country: nativeStatus.country ?? null,
        userId: nativeStatus.userId ?? null,
        version: nativeStatus.version ?? null,
        baseDeviceId: nativeStatus.baseDeviceId ?? null,
      }
    : { available: false, source: 'desktop', running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null }
}

async function startDesktopSharing({ token, userId, country, trust }) {
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}/native/share/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, userId, country, trust }),
      signal: AbortSignal.timeout(4000),
    })
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}))
      return { success: false, error: data.error ?? 'This desktop is signed in as a different user' }
    }
    if (res.ok) {
      const data = await res.json()
      const helper = {
        available: true,
        source: data.where ?? 'desktop',
        running: !!data.running,
        shareEnabled: !!data.shareEnabled,
        configured: !!data.configured,
        country: data.country ?? country ?? null,
        userId: data.userId ?? userId ?? null,
        version: data.version ?? null,
        baseDeviceId: data.baseDeviceId ?? null,
        privateShareActive: !!data.privateShareActive,
        privateShare: data.privateShare ?? null,
        privateShares: Array.isArray(data.privateShares) ? data.privateShares : [],
        privateShareDeviceId: data.privateShareDeviceId ?? null,
        connectionSlots: data.connectionSlots ?? null,
        connectionSlotsSync: data.connectionSlotsSync ?? null,
        slots: data.slots ?? null,
        stats: data.stats ?? null,
      }
      const isSharing = helper.running || helper.shareEnabled
      await chrome.storage.local.set({ isSharing, helper })
      return { success: isSharing, helper }
    }
  } catch {}

  try {
    const response = await sendNativeMessage({ type: 'start_sharing', payload: { token, userId, country, trust } })
    if (!response.success) {
      return {
        success: false,
        error: `Desktop helper required. Download from: ${APP_URL}/api/desktop-download`,
        helper: { available: false, source: 'desktop', running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null },
      }
    }
    const helper = {
      available: true,
      source: response.where ?? 'desktop',
      running: !!response.running,
      shareEnabled: !!response.shareEnabled,
      configured: !!response.configured,
      country: response.country ?? country ?? null,
      userId: response.userId ?? userId ?? null,
      version: response.version ?? null,
      baseDeviceId: response.baseDeviceId ?? null,
      privateShareActive: !!response.privateShareActive,
      privateShare: response.privateShare ?? null,
      privateShares: Array.isArray(response.privateShares) ? response.privateShares : [],
      privateShareDeviceId: response.privateShareDeviceId ?? null,
      connectionSlots: response.connectionSlots ?? null,
      connectionSlotsSync: response.connectionSlotsSync ?? null,
      slots: response.slots ?? null,
      stats: response.stats ?? null,
    }
    const isSharing = helper.running || helper.shareEnabled
    await chrome.storage.local.set({ isSharing, helper })
    return { success: isSharing, helper }
  } catch {
    return {
      success: false,
      error: `Desktop helper required for full-browser sharing. Download: ${APP_URL}/api/desktop-download`,
      helper: { available: false, source: 'desktop', running: false, shareEnabled: false, configured: false, country: null, userId: null, version: null },
    }
  }
}

async function stopDesktopSharing() {
  const stopPrimary = fetch(`http://127.0.0.1:${CONTROL_PORT}/native/share/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  }).then(async (res) => {
    if (!res.ok) return null
    return await res.json().catch(() => null)
  }).catch(() => null)

  const stopPeer = fetch(`http://127.0.0.1:${PEER_PORT}/native/share/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  }).then(async (res) => {
    if (!res.ok) return null
    return await res.json().catch(() => null)
  }).catch(() => null)

  try {
    const [primaryData, peerData] = await Promise.all([stopPrimary, stopPeer])
    const data = primaryData ?? peerData
    if (data) {
      const helper = {
        available: true, source: data.where ?? 'desktop', running: !!data.running, shareEnabled: false,
        configured: !!data.configured, country: data.country ?? null,
        userId: data.userId ?? null, version: data.version ?? null,
        baseDeviceId: data.baseDeviceId ?? null,
        privateShareActive: !!data.privateShareActive,
        privateShare: data.privateShare ?? null,
        privateShares: Array.isArray(data.privateShares) ? data.privateShares : [],
        privateShareDeviceId: data.privateShareDeviceId ?? null,
        connectionSlots: data.connectionSlots ?? null,
        connectionSlotsSync: data.connectionSlotsSync ?? null,
        slots: data.slots ?? null,
        stats: data.stats ?? null,
      }
      await chrome.storage.local.set({ isSharing: false, helper })
      return { success: true, helper }
    }
  } catch {}

  try {
    const response = await sendNativeMessage({ type: 'stop_sharing' })
    const helper = {
      available: true, source: response.where ?? 'desktop', running: !!response.running, shareEnabled: false,
      configured: !!response.configured, country: response.country ?? null,
      userId: response.userId ?? null, version: response.version ?? null,
      baseDeviceId: response.baseDeviceId ?? null,
      privateShareActive: !!response.privateShareActive,
      privateShare: response.privateShare ?? null,
      privateShares: Array.isArray(response.privateShares) ? response.privateShares : [],
      privateShareDeviceId: response.privateShareDeviceId ?? null,
      connectionSlots: response.connectionSlots ?? null,
      connectionSlotsSync: response.connectionSlotsSync ?? null,
      slots: response.slots ?? null,
      stats: response.stats ?? null,
    }
    await chrome.storage.local.set({ isSharing: false, helper })
    return { success: true, helper }
  } catch {
    await chrome.storage.local.set({ isSharing: false })
    return { success: false, error: 'Could not reach desktop helper', helper: await getDesktopHelperStatus() }
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Relay connection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function scheduleProviderReconnect(reason) {
  if (sharingMode !== 'extension' || !providerShareEnabled) return
  clearProviderReconnect()
  const delay = providerReconnectDelay
  providerReconnectTimer = setTimeout(() => {
    providerReconnectTimer = null
    void connectStandaloneProvider().catch((error) => {
      log('warn', `[PROVIDER] reconnect failed reason=${reason} err=${error.message}`)
      scheduleProviderReconnect('retry')
    })
  }, delay)
  providerReconnectDelay = Math.min(providerReconnectDelay * 2, 30_000)
  log('warn', `[PROVIDER] reconnect scheduled in ${delay}ms (${reason})`)
}

function isProviderAuthError(message = '') {
  return /auth|token|unauthorized|forbidden|client accounts cannot share|verify your phone|accept the provider disclosure|api keys cannot register/i.test(String(message))
}

async function connectStandaloneProvider() {
  await loadSharingContext()
  if (sharingMode !== 'extension' || !providerShareEnabled) return
  const token = getShareAuthToken()
  if (!token || !sharingUserId || !sharingCountry) {
    throw new Error('Missing sharing credentials for standalone mode')
  }
  if (providerWs && (providerWs.readyState === WebSocket.OPEN || providerWs.readyState === WebSocket.CONNECTING)) {
    return
  }

  const { baseDeviceId, deviceId } = await getExtensionIdentity()
  if (!baseDeviceId || !deviceId) throw new Error('Extension identity is missing')

  const relays = await getLiveRelays()
  // Hash baseDeviceId to pick a relay deterministically Ã¢â‚¬â€ same logic as desktop/CLI
  // so the extension provider lands on the same relay consistently across restarts.
  // Persist lastRelay to storage so it survives service worker termination.
  const stored = await chrome.storage.local.get(['providerLastRelay'])
  const lastRelay = stored.providerLastRelay ?? null
  let relay
  if (lastRelay && relays.includes(lastRelay)) {
    relay = lastRelay
  } else {
    // Rendezvous/HRW consistent hashing Ã¢â‚¬â€ same algorithm as desktop/CLI.
    // Adding/removing a relay only moves ~1/n providers, not all of them.
    let best = null, bestScore = -1
    for (const r of relays) {
      let h = 0
      const s = baseDeviceId + r
      for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0 }
      const score = h >>> 0
      if (score > bestScore) { bestScore = score; best = r }
    }
    relay = best ?? relays[0]
  }
  clearProviderReconnect()
  providerWs = new WebSocket(relay)
  providerRegistered = false

  return await new Promise((resolve, reject) => {
    let settled = false

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    providerWs.onopen = () => {
      log('info', `[PROVIDER] standalone WS open relay=${relay}`)
      providerWs.send(JSON.stringify({
        type: 'register_provider',
        userId: sharingUserId,
        country: sharingCountry,
        trustScore: 50,
        agentMode: true,
        providerKind: 'extension',
        supportsHttp: true,
        supportsTunnel: false,
        deviceId,
        baseDeviceId,
        authToken: token,
      }))
    }

    providerWs.onmessage = async (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'pong') log('info', `[PROVIDER] msg=${msg.type}${msg.sessionId ? ' session=' + msg.sessionId.slice(0, 8) : ''}`)

      if (msg.type === 'registered') {
        providerRegistered = true
        providerPeerId = msg.peerId ?? null
        providerReconnectDelay = 2000
        providerStats.connectedAt = new Date().toISOString()
        providerStats.peerId = providerPeerId
        await chrome.storage.local.set({ providerLastRelay: relay })
        startExtensionHeartbeat()
        await persistSharingState()
        settle(resolve, undefined)
        return
      }

      if (msg.type === 'session_request') {
        providerWs?.send(JSON.stringify({ type: 'agent_ready', sessionId: msg.sessionId }))
        return
      }

      if (msg.type === 'proxy_request') {
        const response = await handleProviderFetch(msg.sessionId, msg.request)
        if (providerWs?.readyState === WebSocket.OPEN) {
          providerWs.send(JSON.stringify({ type: 'proxy_response', sessionId: msg.sessionId, response }))
        }
        await persistSharingState()
        return
      }

      if (msg.type === 'error') {
        log('warn', `[PROVIDER] relay error: ${msg.message}`)
        settle(reject, new Error(msg.message || 'Relay rejected provider registration'))
        providerWs?.close(1000)
      }
    }

    providerWs.onerror = () => {
      settle(reject, new Error('Standalone provider websocket failed'))
    }

    providerWs.onclose = async (event) => {
      log('warn', `[PROVIDER] standalone WS closed code=${event.code} reason=${event.reason || 'none'}`)
      providerWs = null
      providerRegistered = false
      providerPeerId = null
      providerStats.connectedAt = null
      providerStats.peerId = null
      stopExtensionHeartbeat(false)
      await persistSharingState()
      if (sharingMode === 'extension' && providerShareEnabled) {
        scheduleProviderReconnect(`close:${event.code}`)
      }
      settle(reject, new Error('Standalone provider websocket closed'))
    }
  })
}

async function startStandaloneProvider() {
  await loadSharingContext()
  await syncProviderPrivateShareState({ source: 'start' })
  providerShareEnabled = true
  sharingMode = 'extension'
  providerStats = {
    bytesServed: providerStats.bytesServed ?? 0,
    requestsHandled: providerStats.requestsHandled ?? 0,
    connectedAt: null,
    peerId: providerPeerId,
  }
  await chrome.storage.local.set({ sharingMode, sharingCountry, sharingUserId })
  try {
    await connectStandaloneProvider()
    const helper = await persistSharingState()
    return { success: true, helper }
  } catch (error) {
    if (isProviderAuthError(error.message)) {
      providerShareEnabled = false
      const helper = await persistSharingState(await getStandaloneProviderStatus())
      return { success: false, error: error.message, helper }
    }
    scheduleProviderReconnect(error.message)
    const helper = await persistSharingState(await getStandaloneProviderStatus())
    return { success: true, helper }
  }
}

async function stopStandaloneProvider({ clearMode = true, removeDevice = true } = {}) {
  clearProviderReconnect()
  providerShareEnabled = false
  providerRegistered = false
  providerPeerId = null
  providerStats.connectedAt = null
  providerStats.peerId = null
  if (providerWs) {
    const ws = providerWs
    providerWs = null
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close(1000)
  }
  stopExtensionHeartbeat(removeDevice)
  if (clearMode) sharingMode = null
  const helper = await persistSharingState(await getStandaloneProviderStatus())
  return { success: true, helper }
}

async function startSharingTransport({ token, userId, country, trust }) {
  await loadSharingContext()
  if (token) desktopToken = token
  if (userId) sharingUserId = userId
  if (country) sharingCountry = country

  const helper = await getDesktopHelperStatus()
  if (helper.available && !isHelperOwnedByUser(helper, userId ?? sharingUserId ?? null)) {
    const mismatchHelper = await persistSharingState({ ...helper, ownerMismatch: true })
    return {
      success: false,
      error: 'This desktop app is signed in as a different user. Sign out of the desktop app first.',
      helper: mismatchHelper,
    }
  }
  if (helper.available) {
    if (providerShareEnabled) await stopStandaloneProvider({ clearMode: false, removeDevice: true })
    const result = await startDesktopSharing({ token, userId, country, trust })
    if (result.success) {
      sharingMode = 'desktop'
      result.helper = await persistSharingState(result.helper ?? null)
      return result
    }
    log('warn', `[SHARE] helper start failed, falling back to standalone mode: ${result.error || 'unknown error'}`)
  }

  return startStandaloneProvider()
}

async function stopSharingTransport() {
  await loadSharingContext()
  if (providerShareEnabled || sharingMode === 'extension') {
    return stopStandaloneProvider()
  }
  const helper = await getSharingStatus()
  if (helper?.ownerMismatch) {
    return {
      success: false,
      error: 'This desktop app is signed in as a different user. Sign out of the desktop app first.',
      helper,
    }
  }
  const result = await stopDesktopSharing()
  sharingMode = null
  result.helper = await persistSharingState(result.helper ?? null)
  return result
}

async function setHelperConnectionSlots(slots) {
  const nextSlots = Math.max(1, Math.min(32, parseInt(String(slots), 10) || 1))
  const helper = await getSharingStatus()

  if (!helper?.available) {
    return { success: false, error: 'No local sharing helper is available', helper }
  }
  if (helper.ownerMismatch) {
    return {
      success: false,
      error: 'This desktop app is signed in as a different user. Sign out of the desktop app first.',
      helper,
    }
  }

  if (helper.source === 'extension') {
    const standaloneHelper = await getStandaloneProviderStatus()
    await chrome.storage.local.set({ helper: standaloneHelper })
    return { success: true, helper: standaloneHelper }
  }

  const updatePort = async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/native/connection-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: nextSlots }),
        signal: AbortSignal.timeout(2500),
      })
      return response.ok
    } catch {
      return false
    }
  }

  const [primary, peer] = await Promise.all([updatePort(CONTROL_PORT), updatePort(PEER_PORT)])
  if (!primary && !peer) {
    return { success: false, error: 'Could not reach desktop or CLI helper', helper: await getSharingStatus() }
  }

  const updatedHelper = await persistSharingState(await getSharingStatus())
  return { success: true, helper: updatedHelper }
}

async function getSharingStatus() {
  const stored = await loadSharingContext()
  const currentUserId = stored.user?.id ?? sharingUserId ?? null
  const desktopStatus = await getDesktopHelperStatus()
  const standaloneStatus = await getStandaloneProviderStatus()
  const desktopOwned = isHelperOwnedByUser(desktopStatus, currentUserId)
  const desktopActive = desktopStatus.available && desktopOwned && (desktopStatus.running || desktopStatus.shareEnabled)
  const standaloneActive = standaloneStatus.available && (standaloneStatus.running || standaloneStatus.shareEnabled)

  if (desktopActive && providerShareEnabled) {
    log('info', '[SHARE] helper became active - stopping standalone provider and syncing to local helper')
    await stopStandaloneProvider({ clearMode: false, removeDevice: true })
  }

  if (desktopActive) {
    sharingMode = 'desktop'
    return { ...desktopStatus, source: desktopStatus.source ?? 'desktop', ownerMismatch: false }
  }

  if (standaloneActive) {
    sharingMode = 'extension'
    return { ...standaloneStatus, ownerMismatch: false }
  }

  if (desktopStatus.available) {
    return { ...desktopStatus, source: desktopStatus.source ?? 'desktop', ownerMismatch: !desktopOwned }
  }

  return { ...standaloneStatus, ownerMismatch: false }
}

async function connectToRelay(opts, attempt, retries) {
  if (attempt === undefined) attempt = 0
  if (retries === undefined) retries = 0
  const serverFallbackList = opts.relayFallbackList || []
  const liveFallbackList = await getLiveRelays()
  const fallbackList = Array.from(new Set([opts.relayEndpoint, ...serverFallbackList, ...liveFallbackList].filter(Boolean)))
  if (attempt >= fallbackList.length) {
    if (retries < 3) {
      log("warn", "[CONNECT] all relays exhausted, retry " + (retries + 1) + "/3 in 3s")
      await new Promise(function(resolve) { setTimeout(resolve, 3000) })
      return connectToRelay(opts, 0, retries + 1)
    }
    throw new Error("No peer available in " + opts.country + " - try again shortly")
  }
  const relay = fallbackList[attempt]
  try {
    return await connectOnce(Object.assign({}, opts, { relayEndpoint: relay }))
  } catch (error) {
    if (attempt < fallbackList.length - 1) {
      log("warn", "[CONNECT] relay " + relay + " failed (" + error.message + "), trying next fallback")
      await new Promise(function(resolve) { setTimeout(resolve, 500) })
      return connectToRelay(opts, attempt + 1, retries)
    }
    return connectToRelay(opts, fallbackList.length, retries)
  }
}

function closeDesktopSignaling(reason = 'closed') {
  if (!desktopSignalWs) return
  const ws = desktopSignalWs
  desktopSignalWs = null
  desktopSignalSessionId = null
  ws.onopen = null
  ws.onmessage = null
  ws.onerror = null
  ws.onclose = null
  try { ws.close(1000, reason) } catch {}
}

function connectDesktopSignaling(session) {
  if (!session?.sessionId || session.iceEnabled !== true || session.directTransport !== 'webrtc') {
    closeDesktopSignaling('ice_disabled')
    return
  }
  if (desktopSignalWs && desktopSignalSessionId === session.sessionId && desktopSignalWs.readyState <= WebSocket.OPEN) return
  closeDesktopSignaling('session_replaced')

  const ws = new WebSocket(`ws://127.0.0.1:${CONTROL_PORT}/webrtc-signaling?session=${encodeURIComponent(session.sessionId)}`)
  desktopSignalWs = ws
  desktopSignalSessionId = session.sessionId
  let openTimer = setTimeout(() => {
    openTimer = null
    if (ws.readyState === WebSocket.CONNECTING && relayWs?.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify({ type: 'direct_failed', sessionId: session.sessionId, reason: 'desktop_signaling_timeout' }))
      try { ws.close(1000, 'desktop_signaling_timeout') } catch {}
    }
  }, 1500)
  ws.onopen = () => {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
    log('info', `[DIRECT] desktop signaling open session=${session.sessionId.slice(0,8)}`)
  }
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
      relayWs.send(JSON.stringify({ ...msg, sessionId: session.sessionId }))
    } catch (error) {
      log('warn', `[DIRECT] desktop signaling parse failed: ${error.message}`)
    }
  }
  ws.onerror = () => {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
    if (relayWs?.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify({ type: 'direct_failed', sessionId: session.sessionId, reason: 'desktop_signaling_error' }))
    }
  }
  ws.onclose = () => {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
    if (desktopSignalWs === ws) {
      desktopSignalWs = null
      desktopSignalSessionId = null
    }
  }
}

function forwardRelaySignalToDesktop(msg) {
  if (!msg?.sessionId || msg.sessionId !== desktopSignalSessionId) return false
  if (!desktopSignalWs || desktopSignalWs.readyState !== WebSocket.OPEN) return false
  desktopSignalWs.send(JSON.stringify(msg))
  return true
}

async function connectOnce({ relayEndpoint, country, userId, dbSessionId, preferredProviderUserId, privateProviderUserId, privateBaseDeviceId, token, privateCode, connectionType }) {
  const requesterIdentity = await getExtensionIdentity().catch(() => ({ deviceId: null }))
  return new Promise((resolve, reject) => {
    const wsUrl = relayEndpoint
    log('info', `[CONNECT] WS connecting to ${wsUrl} country=${country} userId=${userId?.slice(0,8)}`)
    const ws = new WebSocket(wsUrl)
    let keepaliveTimer = null
    let settled = false

    function settle(fn, val) {
      if (settled) return
      settled = true
      clearInterval(keepaliveTimer)
      fn(val)
    }

    ws.onopen = () => {
      log('info', `[CONNECT] WS open Ã¢â€ â€™ sending request_session country=${country}`)
      ws.send(JSON.stringify({
        type: 'request_session',
        country,
        userId,
        authToken: token || supabaseToken || desktopToken || null,
        dbSessionId: dbSessionId ?? null,
        preferredProviderUserId: preferredProviderUserId ?? null,
        privateProviderUserId: privateProviderUserId ?? null,
        privateBaseDeviceId: privateBaseDeviceId ?? null,
        requireTunnel: true,
        supportsDirect: true,
        iceEnabled: true,
        requesterDeviceId: requesterIdentity.deviceId ?? null,
      }))
      keepaliveTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 20000)
    }

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'pong') log('info', `[CONNECT] msg=${msg.type}${msg.sessionId ? ' session=' + msg.sessionId.slice(0,8) : ''}`)

      if (msg.type === 'session_created') {
        agentSessionId = msg.sessionId
      }

      if (msg.type === 'agent_session_ready') {
        relayWs = ws
        agentSessionId = msg.sessionId || agentSessionId
        currentSession = {
          ws,
          sessionId: agentSessionId,
          country,
          relayEndpoint,
          userId,
          dbSessionId,
          token,
          privateCode: privateCode || null,
          connectionType: connectionType || (privateCode ? 'private' : 'public'),
          mandate: msg.mandate ?? null,
          relayPublicKey: msg.relayPublicKey ?? null,
          sessionSigningKey: msg.sessionSigningKey ?? null,
          sessionNonce: msg.sessionNonce ?? null,
          transportTier: msg.transportTier ?? 0,
          directTransport: msg.directTransport ?? null,
          iceEnabled: msg.iceEnabled === true,
          iceServers: msg.iceServers ?? [],
          directState: msg.directState ?? (msg.iceEnabled ? 'attempting_direct' : 'relay'),
          providerDirectEndpoint: msg.providerDirectEndpoint ?? null,
          createdAt: Date.now(),
          reconnecting: false,
          lastDesktopSyncAt: 0,
        }

        const desktopStatus = await getDesktopHelperStatusHttp()
        let desktopProxyReady = false
        if (!desktopStatus?.available) {
          ws.close(1000)
          currentSession = null
          relayWs = null
          agentSessionId = null
          settle(reject, new Error('PeerMesh Desktop required. Open the desktop app, then retry.'))
          return
        }
        try {
          const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: agentSessionId,
              relayEndpoint,
              country,
              mandate: msg.mandate ?? null,
              relayPublicKey: msg.relayPublicKey ?? null,
              sessionSigningKey: msg.sessionSigningKey ?? null,
              sessionNonce: msg.sessionNonce ?? null,
              transportTier: msg.transportTier ?? 0,
              directTransport: msg.directTransport ?? null,
              iceEnabled: msg.iceEnabled === true,
              iceServers: msg.iceServers ?? [],
              providerDirectEndpoint: msg.providerDirectEndpoint ?? null,
            }),
            signal: AbortSignal.timeout(4000),
          })
          desktopProxyReady = response.ok
          log(desktopProxyReady ? 'info' : 'warn', `[CONNECT] proxy-session desktop status=${response.status}`)
        } catch (e) {
          log('error', `[CONNECT] proxy-session failed: ${e.message}`)
        }
        if (!desktopProxyReady) {
          setProxyFailClosed('Desktop proxy unavailable')
          ws.close(1000)
          currentSession = null
          relayWs = null
          agentSessionId = null
          settle(reject, new Error('PeerMesh Desktop proxy is not ready. Open the desktop app and retry.'))
          return
        }
        connectDesktopSignaling(currentSession)
        setProxyDesktop(agentSessionId, country)
        settle(resolve, undefined)
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ Auto-reconnect: relay found a new provider transparently Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      if (msg.type === 'session_reconnected') {
        agentSessionId = msg.sessionId
        // Use the relayEndpoint from the message if provided Ã¢â‚¬â€ it's the relay the
        // requester is already on, so the desktop proxy-session must point there.
        const reconnectRelay = msg.relayEndpoint || relayEndpoint
        if (currentSession) {
          currentSession = {
            ...currentSession,
            sessionId: msg.sessionId,
            country: msg.country || currentSession.country,
            relayEndpoint: reconnectRelay,
            mandate: msg.mandate ?? currentSession.mandate ?? null,
            relayPublicKey: msg.relayPublicKey ?? currentSession.relayPublicKey ?? null,
            sessionSigningKey: msg.sessionSigningKey ?? currentSession.sessionSigningKey ?? null,
            sessionNonce: msg.sessionNonce ?? currentSession.sessionNonce ?? null,
            transportTier: msg.transportTier ?? currentSession.transportTier ?? 0,
            directTransport: msg.directTransport ?? currentSession.directTransport ?? null,
            iceEnabled: msg.iceEnabled === true || currentSession.iceEnabled === true,
            iceServers: msg.iceServers ?? currentSession.iceServers ?? [],
            directState: msg.directState ?? (msg.iceEnabled ? 'attempting_direct' : currentSession.directState ?? 'relay'),
            providerDirectEndpoint: msg.providerDirectEndpoint ?? currentSession.providerDirectEndpoint ?? null,
            createdAt: Date.now(),
            reconnecting: false,
            lastDesktopSyncAt: 0,
          }
        }
        log('info', `[CONNECT] session_reconnected attempt=${msg.attempt} newSession=${msg.sessionId?.slice(0,8)} relay=${reconnectRelay}`)

        // Update desktop local proxy with new sessionId and correct relayEndpoint
        try {
          const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: msg.sessionId,
              relayEndpoint: reconnectRelay,
              country: msg.country,
              mandate: msg.mandate ?? currentSession?.mandate ?? null,
              relayPublicKey: msg.relayPublicKey ?? currentSession?.relayPublicKey ?? null,
              sessionSigningKey: msg.sessionSigningKey ?? currentSession?.sessionSigningKey ?? null,
              sessionNonce: msg.sessionNonce ?? currentSession?.sessionNonce ?? null,
              transportTier: msg.transportTier ?? currentSession?.transportTier ?? 0,
              directTransport: msg.directTransport ?? currentSession?.directTransport ?? null,
              iceEnabled: msg.iceEnabled === true || currentSession?.iceEnabled === true,
              iceServers: msg.iceServers ?? currentSession?.iceServers ?? [],
              providerDirectEndpoint: msg.providerDirectEndpoint ?? currentSession?.providerDirectEndpoint ?? null,
            }),
            signal: AbortSignal.timeout(4000),
          })
          if (!response.ok) throw new Error(`desktop proxy status=${response.status}`)
          connectDesktopSignaling(currentSession)
          setProxyDesktop(msg.sessionId, msg.country || country)
        } catch (error) {
          const reason = `Desktop proxy unavailable after reconnect: ${error.message}`
          setProxyFailClosed(reason)
          broadcastSessionEnded(reason).catch(() => {})
          return
        }

        // Reapply header rules if provider country changed
        if (msg.country && msg.country !== country) applyHeaderRules({ country: msg.country, userId })

        // Update proxy auth credentials with new sessionId
        chrome.storage.session.set({ proxySessionId: msg.sessionId })
        chrome.storage.local.get(['session']).then(({ session }) => {
          if (!session) return
          chrome.storage.local.set({
            session: {
              ...session,
              id: msg.sessionId,
              sessionId: msg.sessionId,
              country: msg.country || session.country || country,
              relayEndpoint: reconnectRelay,
              reconnectedAt: new Date().toISOString(),
            },
          })
        }).catch(() => {})

        // Notify popup so it can show a brief "reconnected" indicator
        chrome.runtime.sendMessage({ type: 'SESSION_RECONNECTED', sessionId: msg.sessionId, attempt: msg.attempt }).catch(() => {})
        broadcastBrowsingStatus({
          state: 'reconnected',
          title: 'PeerMesh reconnected',
          message: 'Browsing is protected again. Reload the page if this site did not recover automatically.',
          sessionId: msg.sessionId,
        }).catch(() => {})
      }

      if (msg.type === 'session_reconnecting') {
        const attempt = Number(msg.attempt) || 1
        const maxAttempts = Number(msg.maxAttempts) || 0
        const reason = `Provider reconnecting${maxAttempts ? ` (${attempt}/${maxAttempts})` : ''}`
        if (currentSession) currentSession = { ...currentSession, reconnecting: true }
        setProxyFailClosed(reason)
        chrome.runtime.sendMessage({ type: 'SESSION_RECONNECTING', reason, attempt, maxAttempts }).catch(() => {})
        broadcastBrowsingStatus({
          state: 'reconnecting',
          title: 'PeerMesh reconnecting',
          message: `${reason}. Traffic is blocked so your real connection does not leak.`,
          attempt,
          maxAttempts,
        }).catch(() => {})
      }

      if (msg.type === 'ice_answer' || msg.type === 'ice_candidate' || msg.type === 'direct_failed' || msg.type === 'direct_open') {
        if (currentSession && (!msg.sessionId || currentSession.sessionId === msg.sessionId)) {
          if (msg.type === 'direct_open') currentSession = { ...currentSession, directState: 'direct' }
          if (msg.type === 'direct_failed') currentSession = { ...currentSession, directState: 'relay' }
        }
        forwardRelaySignalToDesktop(msg)
      }

      if (msg.type === 'proxy_response') {
        const requestId = msg.response?.requestId
        const pending = pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingRequests.delete(requestId)
          pending.resolve({ ok: true, status: msg.response.status, headers: msg.response.headers, body: msg.response.body, finalUrl: msg.response.finalUrl })
        }
      }

      if (msg.type === 'error') {
        log('error', `[CONNECT] relay error: ${msg.message}`)
        ws.close(1000)
        settle(reject, new Error(msg.message))
      }

      if (msg.type === 'session_ended') {
        const reason = msg.reason || 'Peer connection dropped'
        log('info', `[CONNECT] session_ended reason=${reason}`)
        if (_userInitiatedDisconnect) clearProxy()
        else if (!_sessionRefreshing) setProxyFailClosed(reason)
        currentSession = null
        relayWs = null
        agentSessionId = null
        closeDesktopSignaling('session_ended')
        if (!_userInitiatedDisconnect && !_sessionRefreshing) {
          broadcastSessionEnded(reason).catch(() => {})
        }
      }

      if (msg.type === 'session_expiring') {
        log('warn', '[CONNECT] relay reported session_expiring')
        refreshRequesterSession('relay reported session expiry').catch((error) => {
          setProxyFailClosed(error.message)
          broadcastSessionEnded(error.message).catch(() => {})
        })
      }

      if (msg.type === 'session_quality') {
        const quality = {
          avgMbps: Number(msg.avgMbps) || 0,
          currentMbps: Number(msg.currentMbps) || 0,
          transferredBytes: Number(msg.transferredBytes) || 0,
          sampleWindowMs: Number(msg.sampleWindowMs) || 0,
          providerKind: msg.providerKind || null,
          providerDeviceId: msg.providerDeviceId || null,
        }
        if (currentSession && (!msg.sessionId || currentSession.sessionId === msg.sessionId)) {
          currentSession.quality = quality
        }
        chrome.storage.local.get(['session']).then(({ session }) => {
          if (!session) return
          const storedSessionId = session.id || session.sessionId
          if (msg.sessionId && storedSessionId && storedSessionId !== msg.sessionId) return
          chrome.storage.local.set({ session: { ...session, quality } })
        }).catch(() => {})
        chrome.runtime.sendMessage({ type: 'SESSION_QUALITY', sessionId: msg.sessionId, quality }).catch(() => {})
      }
    }

    ws.onerror = (e) => {
      log('error', `[CONNECT] WS error: ${e.message || 'unknown'}`)
      settle(reject, new Error('WebSocket connection failed'))
    }

    ws.onclose = (e) => {
      log('warn', `[CONNECT] WS closed code=${e.code} reason=${e.reason || 'none'}`)
      clearInterval(keepaliveTimer)
      if (currentSession) {
        const reason = e.reason || 'Peer connection dropped'
        if (_userInitiatedDisconnect) clearProxy()
        else if (!_sessionRefreshing) setProxyFailClosed(reason)
        currentSession = null
        relayWs = null
        agentSessionId = null
        closeDesktopSignaling('relay_closed')
        if (!_userInitiatedDisconnect && !_sessionRefreshing) {
          broadcastSessionEnded(reason).catch(() => {})
        }
      }
      settle(reject, new Error('Connection closed before session was ready'))
    }

    setTimeout(() => {
      if (!settled) {
        log('warn', `[CONNECT] timeout Ã¢â‚¬â€ no peer found in ${country} after 15s`)
        ws.close(1000)
        settle(reject, new Error('No peer available in ' + country + ' Ã¢â‚¬â€ try again shortly'))
      }
    }, 15000)
  })
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Header spoofing (declarativeNetRequest dynamic rules) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Rule IDs Ã¢â‚¬â€ must be stable integers
const HDR_RULE_USER_AGENT = 1
const HDR_RULE_ACCEPT_LANG = 2
const HDR_RULE_SEC_CH_UA_PLATFORM = 3
const HDR_RULE_SEC_CH_UA_MOBILE = 4
const HDR_RULE_SEC_CH_UA = 5
const HEADER_RULE_IDS = [
  HDR_RULE_USER_AGENT,
  HDR_RULE_ACCEPT_LANG,
  HDR_RULE_SEC_CH_UA_PLATFORM,
  HDR_RULE_SEC_CH_UA_MOBILE,
  HDR_RULE_SEC_CH_UA,
]
const HEADER_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'other']

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createRequesterSession({ token, country, privateCode }) {
  const isPrivateConnect = !!privateCode
  let lastQueuedMessage = null
  for (let attempt = 0; attempt < (isPrivateConnect ? PRIVATE_ON_DEMAND_MAX_ATTEMPTS : 1); attempt += 1) {
    const res = await fetch(`${APP_URL}/api/session/create`, {
      method: 'POST',
      headers: withSharingHeaders({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }),
      body: JSON.stringify(isPrivateConnect ? { privateCode } : { country }),
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => ({}))

    if ((res.status === 401 || res.status === 403) && await tryRefreshExtensionToken()) {
      const stored = await chrome.storage.local.get(['user', 'desktopToken', 'supabaseToken'])
      token = stored.desktopToken || stored.user?.token || stored.supabaseToken || token
      continue
    }

    if (!res.ok || data.error) {
      if (isPrivateConnect && data.onDemandStartQueued && attempt < PRIVATE_ON_DEMAND_MAX_ATTEMPTS - 1) {
        lastQueuedMessage = data.error || 'Private provider is starting. Retrying...'
        const retryMs = Math.max(3000, Math.min(30000, Number(data.retryAfterSeconds ?? 5) * 1000))
        log('warn', `[REQUESTER] private on-demand queued; retrying in ${retryMs}ms`)
        await sleep(retryMs)
        continue
      }
      throw new Error(data.error || `Session refresh failed (${res.status})`)
    }

    return { data, token }
  }
  throw new Error(lastQueuedMessage || 'Private provider did not come online in time. Try again shortly.')
}

async function refreshRequesterSession(reason = 'session refresh') {
  if (_sessionRefreshing || !currentSession) return
  const previous = currentSession
  const token = previous.token || desktopToken || supabaseToken
  if (!token) throw new Error('Cannot refresh PeerMesh session: missing auth token')

  _sessionRefreshing = true
  // Clear proxy to DIRECT so the new relay WebSocket is not routed through
  // the fail-closed proxy (127.0.0.1:9), which causes ERR_PROXY_CONNECTION_FAILED.
  chrome.proxy.settings.clear({ scope: 'regular' })
  try {
    const oldWs = relayWs
    relayWs = null
    currentSession = null
    agentSessionId = null
    closeDesktopSignaling('session_refresh')
    if (oldWs) {
      oldWs.onclose = null
      oldWs.onerror = null
      oldWs.onmessage = null
      try { oldWs.close(1000) } catch {}
    }

    const { data, token: refreshedToken } = await createRequesterSession({
      token,
      country: previous.country,
      privateCode: previous.privateCode,
    })

    await connectToRelay({
      relayEndpoint: data.relayEndpoint,
      relayFallbackList: data.relayFallbackList || [data.relayEndpoint],
      country: data.country || previous.country,
      userId: previous.userId,
      dbSessionId: data.sessionId,
      preferredProviderUserId: data.preferredProviderUserId || null,
      privateProviderUserId: data.privateProviderUserId || null,
      privateBaseDeviceId: data.privateBaseDeviceId || null,
      privateCode: previous.privateCode || null,
      connectionType: previous.connectionType || (previous.privateCode ? 'private' : 'public'),
      token: refreshedToken,
    })

    const session = {
      id: data.sessionId,
      country: data.country || previous.country,
      relayEndpoint: data.relayEndpoint,
      refreshedAt: new Date().toISOString(),
    }
    await chrome.storage.local.set({ session, connectionType: previous.connectionType || (previous.privateCode ? 'private' : 'public') })
    chrome.runtime.sendMessage({ type: 'SESSION_RECONNECTED', sessionId: data.sessionId, reason }).catch(() => {})
  } finally {
    _sessionRefreshing = false
  }
}

async function syncDesktopProxySession(session, reason = 'desktop proxy sync') {
  if (!session?.sessionId || !session?.relayEndpoint) {
    throw new Error('missing active session for desktop proxy sync')
  }

  const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      relayEndpoint: session.relayEndpoint,
      country: session.country,
      mandate: session.mandate ?? null,
      relayPublicKey: session.relayPublicKey ?? null,
      sessionSigningKey: session.sessionSigningKey ?? null,
      sessionNonce: session.sessionNonce ?? null,
      transportTier: session.transportTier ?? 0,
      directTransport: session.directTransport ?? null,
      iceEnabled: session.iceEnabled === true,
      iceServers: session.iceServers ?? [],
      providerDirectEndpoint: session.providerDirectEndpoint ?? null,
    }),
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) throw new Error(`${reason}: desktop proxy status=${response.status}`)
  setProxyDesktop(session.sessionId, session.country)
}

async function applyHeaderRules(session) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return
  const profile = buildSpoofProfile(typeof session === 'string' ? { country: session } : session)
  const acceptLang = buildAcceptLanguage(profile)
  const platform = profile.platformLabel || (profile.mobile ? 'Android' : 'Windows')
  const mobile = profile.mobile ? '?1' : '?0'
  const secChUa = buildSecChUa(profile)

  const rules = [
    {
      id: HDR_RULE_USER_AGENT,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: profile.userAgent }],
      },
      condition: { urlFilter: '*', resourceTypes: HEADER_RESOURCE_TYPES },
    },
    {
      id: HDR_RULE_ACCEPT_LANG,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Accept-Language', operation: 'set', value: acceptLang }],
      },
      condition: { urlFilter: '*', resourceTypes: HEADER_RESOURCE_TYPES },
    },
    {
      id: HDR_RULE_SEC_CH_UA_PLATFORM,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Sec-CH-UA-Platform', operation: 'set', value: `"${platform}"` }],
      },
      condition: { urlFilter: '*', resourceTypes: HEADER_RESOURCE_TYPES },
    },
    {
      id: HDR_RULE_SEC_CH_UA_MOBILE,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Sec-CH-UA-Mobile', operation: 'set', value: mobile }],
      },
      condition: { urlFilter: '*', resourceTypes: HEADER_RESOURCE_TYPES },
    },
    {
      id: HDR_RULE_SEC_CH_UA,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Sec-CH-UA', operation: 'set', value: secChUa }],
      },
      condition: { urlFilter: '*', resourceTypes: HEADER_RESOURCE_TYPES },
    },
  ]

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: HEADER_RULE_IDS,
      addRules: rules,
    })
    log('info', `[HEADERS] rules applied country=${profile.country} persona=${profile.persona} ua=${profile.uaVersion} lang=${acceptLang}`)
  } catch (e) {
    log('warn', `[HEADERS] updateDynamicRules failed: ${e.message}`)
  }
}

async function clearHeaderRules() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: HEADER_RULE_IDS,
      addRules: [],
    })
    log('info', '[HEADERS] rules cleared')
  } catch (e) {
    log('warn', `[HEADERS] clearDynamicRules failed: ${e.message}`)
  }
}

async function syncSessionSpoofState(session) {
  if (session?.country) {
    blockWebRTC()
    await applyHeaderRules(session)
    return
  }

  if (!currentSession) {
    restoreWebRTC()
    await clearHeaderRules()
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Proxy settings Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function blockWebRTC() {
  chrome.privacy.network.webRTCIPHandlingPolicy.set(
    { value: 'disable_non_proxied_udp' },
    () => { if (chrome.runtime.lastError) log('warn', '[WEBRTC] block failed: ' + chrome.runtime.lastError.message)
            else log('info', '[WEBRTC] leak prevention active') }
  )
}

function restoreWebRTC() {
  chrome.privacy.network.webRTCIPHandlingPolicy.clear(
    { scope: 'regular' },
    () => { if (chrome.runtime.lastError) log('warn', '[WEBRTC] restore failed: ' + chrome.runtime.lastError.message)
            else log('info', '[WEBRTC] policy restored') }
  )
}

function setProxyDesktop(sessionId, country) {
  proxyFailClosed = false
  if (currentSession?.sessionId === sessionId) {
    currentSession = { ...currentSession, lastDesktopSyncAt: Date.now(), reconnecting: false }
  }
  chrome.proxy.settings.set(
    {
      value: {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 7655 },
          bypassList: ['localhost', '127.0.0.1', '<local>', APP_HOST],
        },
      },
      scope: 'regular',
    },
    () => {
      if (chrome.runtime.lastError) {
        log('error', `[PROXY] fixed_servers error: ${chrome.runtime.lastError.message}`)
      } else {
        log('info', '[PROXY] mode=fixed_servers 127.0.0.1:7655 Ã¢Å“â€œ')
      }
    }
  )
  chrome.storage.session.remove(['proxyFailClosed', 'proxyFailClosedReason'])
  chrome.storage.session.set({ proxySessionId: sessionId, proxyHost: '127.0.0.1', proxyPort: 7655 })
  broadcastBrowsingStatus({
    state: 'connected',
    title: 'PeerMesh connected',
    message: country ? `Browsing via ${country}.` : 'Browsing through PeerMesh.',
  }).catch(() => {})
  syncActionBadge()
  blockWebRTC()
  if (country) applyHeaderRules({ country, userId: currentSession?.userId || '' })
}

// Kept as a fallback utility for emergency relay-proxy builds; normal browsing requires desktop.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setProxyRelay(relayEndpoint, sessionId, country) {
  proxyFailClosed = false
  const relayUrl = relayEndpoint.replace('wss://', 'https://').replace('ws://', 'http://')
  const relayHost = new URL(relayUrl).hostname
  // Port 8080 is the relay's actual HTTP port Ã¢â‚¬â€ it handles both WS upgrades
  // and raw HTTP CONNECT requests for the PAC proxy path.
  const pacScript = `
    function FindProxyForURL(url, host) {
      if (host === 'localhost' || host === '127.0.0.1' || isPlainHostName(host)) return 'DIRECT';
      return 'PROXY ${relayHost}:8080';
    }
  `
  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {
      if (chrome.runtime.lastError) log('error', `[PROXY] PAC error: ${chrome.runtime.lastError.message}`)
      else log('info', `[PROXY] PAC active Ã¢â€ â€™ ${relayHost}:8080 Ã¢Å“â€œ`)
    }
  )
  chrome.storage.session.remove(['proxyFailClosed', 'proxyFailClosedReason'])
  chrome.storage.session.set({ proxySessionId: sessionId, proxyHost: relayHost, proxyPort: 8080 })
  syncActionBadge()
  blockWebRTC()
  if (country) applyHeaderRules({ country, userId: currentSession?.userId || '' })
}

function setProxyFailClosed(reason = 'Peer connection dropped') {
  proxyFailClosed = true
  const pacScript = `
    function FindProxyForURL(url, host) {
      if (host === 'localhost' || host === '127.0.0.1' || isPlainHostName(host)) return 'DIRECT';
      if (host === '${APP_HOST}') return 'DIRECT';
      return 'PROXY 127.0.0.1:9';
    }
  `
  chrome.proxy.settings.set(
    { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
    () => {
      if (chrome.runtime.lastError) log('error', `[PROXY] fail-closed error: ${chrome.runtime.lastError.message}`)
      else log('warn', `[PROXY] fail-closed active: ${reason}`)
    }
  )
  chrome.storage.session.remove(['proxySessionId', 'proxyHost', 'proxyPort'])
  chrome.storage.session.set({ proxyFailClosed: true, proxyFailClosedReason: reason })
  broadcastBrowsingStatus({
    state: 'blocked',
    title: 'PeerMesh protecting your IP',
    message: `${reason}. Traffic is blocked until PeerMesh reconnects or you disconnect.`,
  }).catch(() => {})
  syncActionBadge()
  blockWebRTC()
}

function clearProxy() {
  proxyFailClosed = false
  log('info', 'proxy cleared')
  chrome.proxy.settings.clear({ scope: 'regular' })
  chrome.storage.session.remove(['proxySessionId', 'proxyHost', 'proxyPort', 'proxyFailClosed', 'proxyFailClosedReason'])
  broadcastBrowsingStatus({ state: 'clear' }).catch(() => {})
  syncActionBadge()
  restoreWebRTC()
  clearHeaderRules()
}

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy) {
      chrome.storage.session.get(['proxySessionId', 'proxyHost'], ({ proxySessionId, proxyHost }) => {
        if (proxySessionId && (!proxyHost || details.challenger?.host === proxyHost)) {
          callback({ authCredentials: { username: proxySessionId, password: 'x' } })
        } else {
          callback({})
        }
      })
    } else {
      callback({})
    }
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
)

let _userInitiatedDisconnect = false

async function disconnect() {
  _userInitiatedDisconnect = true
  if (relayWs?.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify({ type: 'end_session' }))
    relayWs.close(1000)
  }
  relayWs = null
  currentSession = null
  agentSessionId = null
  closeDesktopSignaling('disconnect')
  clearProxy()
  fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, { method: 'DELETE' }).catch(() => {})
  _userInitiatedDisconnect = false
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Lifecycle Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async function manualUnblockBrowser() {
  _userInitiatedDisconnect = true
  if (relayWs?.readyState === WebSocket.OPEN) {
    try { relayWs.send(JSON.stringify({ type: 'end_session' })) } catch {}
    try { relayWs.close(1000) } catch {}
  }
  relayWs = null
  currentSession = null
  agentSessionId = null
  clearProxy()
  await chrome.storage.local.set({ session: null, connectionType: 'public' })
  await chrome.storage.session.remove(['proxyFailClosed', 'proxyFailClosedReason', 'proxySessionId', 'proxyHost', 'proxyPort']).catch(() => {})
  fetch(`http://127.0.0.1:${CONTROL_PORT}/proxy-session`, { method: 'DELETE' }).catch(() => {})
  _userInitiatedDisconnect = false
}

async function restoreSharingRuntime() {
  const storedSession = await chrome.storage.local.get(['session'])
  if (storedSession.session) {
    setProxyFailClosed('PeerMesh background restarted. Reconnect before browsing.')
    await chrome.storage.local.set({ session: null })
    broadcastSessionEnded('PeerMesh background restarted. Reconnect before browsing.').catch(() => {})
  } else {
    clearProxy()
  }
  await loadSharingContext()
  await syncProviderPrivateShareState({ source: 'restore' })
  const helper = await getSharingStatus()
  await persistSharingState(helper)
  if (sharingMode === 'extension') {
    providerShareEnabled = true
    if (!providerRegistered && (!providerWs || providerWs.readyState === WebSocket.CLOSED)) {
      try {
        await connectStandaloneProvider()
      } catch (error) {
        scheduleProviderReconnect(`restore:${error.message}`)
      }
    }
  } else {
    providerShareEnabled = false
    stopExtensionHeartbeat(false)
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await restoreSharingRuntime()
})

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    clearProxy()
    await chrome.storage.local.clear()
  }
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.session) return
  void syncSessionSpoofState(changes.session.newValue ?? null)
})

chrome.storage.local.get(['extId'], ({ extId }) => {
  if (extId) {
    chrome.runtime.setUninstallURL(`${APP_URL}/api/extension-auth/revoke?ext_id=${extId}`)
  }
})

chrome.runtime.onMessageExternal.addListener((msg) => {
  if (msg.type === 'PEERMESH_AUTH' && msg.user) {
    chrome.storage.local.set({ user: msg.user })
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS', user: msg.user }).catch(() => {})
  }
})

chrome.alarms.create('syncSharingState', { periodInMinutes: 0.17 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'syncSharingState') return

  await loadSharingContext()

  // Proactively refresh the token every ~10 minutes so it never expires mid-session.
  // The access token TTL is 15 minutes — refresh at ~10 min to stay ahead of expiry.
  const stored = await chrome.storage.local.get(['user', '_lastTokenRefresh'])
  const lastRefresh = stored._lastTokenRefresh ?? 0
  const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000
  if (stored.user?.refreshToken && stored.user?.deviceSessionId && Date.now() - lastRefresh > TOKEN_REFRESH_INTERVAL_MS) {
    const refreshed = await tryRefreshExtensionToken()
    if (refreshed) await chrome.storage.local.set({ _lastTokenRefresh: Date.now() })
  }

  if (sharingMode === 'extension' || providerShareEnabled) {
    await syncProviderPrivateShareState({ source: 'alarm' })
  }
  const helper = await getSharingStatus()
  await persistSharingState(helper)

  if (currentSession) {
    if (!relayWs || relayWs.readyState === WebSocket.CLOSED) {
      const reason = 'PeerMesh relay connection dropped'
      setProxyFailClosed(reason)
      currentSession = null
      agentSessionId = null
      broadcastSessionEnded(reason).catch(() => {})
    } else if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      if (!currentSession.reconnecting && Date.now() - (currentSession.createdAt || 0) > REQUESTER_SESSION_REFRESH_MS) {
        try {
          await refreshRequesterSession('scheduled pre-expiry refresh')
        } catch (error) {
          const reason = error.message || 'PeerMesh session refresh failed'
          setProxyFailClosed(reason)
          currentSession = null
          relayWs = null
          agentSessionId = null
          broadcastSessionEnded(reason).catch(() => {})
        }
      } else if (!currentSession.reconnecting) {
        // Desktop proxy health check: relay WS alive but 127.0.0.1:7655 may be dead.
        // Re-assert the local proxy session periodically so a desktop restart does
        // not leave Chrome pointing at a helper that forgot the active relay session.
        try {
          await fetch(`http://127.0.0.1:${CONTROL_PORT}/health`, { signal: AbortSignal.timeout(1500) })
          if (proxyFailClosed || Date.now() - (currentSession.lastDesktopSyncAt || 0) > DESKTOP_PROXY_SYNC_MS) {
            await syncDesktopProxySession(currentSession, proxyFailClosed ? 'desktop proxy recovery' : 'desktop proxy keepalive')
          }
        } catch {
          const reason = 'Desktop proxy unreachable - reopen the desktop app'
          log('warn', '[SESSION] desktop proxy health check failed mid-session')
          setProxyFailClosed(reason)
          broadcastBrowsingStatus({ state: 'blocked', title: 'PeerMesh desktop offline', message: reason }).catch(() => {})
        }
      }
    }
  }

  if (sharingMode === 'extension' && providerShareEnabled) {
    if (!providerWs || providerWs.readyState === WebSocket.CLOSED) {
      try {
        await connectStandaloneProvider()
      } catch (error) {
        scheduleProviderReconnect(`alarm:${error.message}`)
      }
    } else if (!heartbeatInterval) {
      startExtensionHeartbeat()
    }
  }
})

void restoreSharingRuntime()

