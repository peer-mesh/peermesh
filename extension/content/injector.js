// injector.js - runs in the isolated world.
// It computes the active spoof profile and publishes it through the DOM so the
// main-world content script can apply it without relying on a page-inserted
// <script> tag that can be blocked by CSP.

const PROFILE_ATTR = 'data-peermesh-profile'
const PROFILE_EVENT = 'peermesh:profile'
const EARLY_IDENTITY_ATTR = 'data-peermesh-identity-loader'
const EARLY_IDENTITY_HOSTS = ['browserleaks.com', 'abrahamjuliot.github.io', 'creepjs.vercel.app']
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
      screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, iw: 1920, ih: 947 },
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

function hashString(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function defaultFontForPlatform(platformLabel) {
  if (platformLabel === 'Android') return 'Roboto'
  if (platformLabel === 'macOS') return 'Helvetica'
  if (platformLabel === 'Linux') return 'Noto Sans'
  return 'Arial'
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
  if (!variant.mobile) return ''
  const match = /Android [^;]+; ([^)]+)\)/.exec(variant.userAgent || '')
  return match?.[1] || 'Android'
}

function getPlatformVersion(variant) {
  const userAgent = variant.userAgent || ''

  if (variant.platformLabel === 'Android') {
    const match = /Android ([\d.]+)/.exec(userAgent)
    return match?.[1]
      ? match[1].split('.').concat(['0', '0']).slice(0, 3).join('.')
      : '14.0.0'
  }

  if (variant.platformLabel === 'Windows') {
    const match = /Windows NT ([\d.]+)/.exec(userAgent)
    return match?.[1] ? `${match[1]}.0` : '10.0.0'
  }

  if (variant.platformLabel === 'macOS') {
    const match = /Mac OS X ([\d_]+)/.exec(userAgent)
    return match?.[1]?.replace(/_/g, '.') || '10.15.7'
  }

  return '0.0.0'
}

function normalizeScreen(screen = {}) {
  return {
    width: screen.w ?? screen.width ?? 1366,
    height: screen.h ?? screen.height ?? 768,
    availWidth: screen.aw ?? screen.availWidth ?? screen.w ?? screen.width ?? 1366,
    availHeight: screen.ah ?? screen.availHeight ?? screen.h ?? screen.height ?? 768,
    innerWidth: screen.iw ?? screen.innerWidth ?? screen.w ?? screen.width ?? 1366,
    innerHeight: screen.ih ?? screen.innerHeight ?? screen.h ?? screen.height ?? 768,
  }
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
    screen: normalizeScreen(variant.screen),
    hardwareConcurrency: variant.hardwareConcurrency ?? (variant.mobile ? 6 : 8),
    deviceMemory: variant.deviceMemory ?? (variant.mobile ? 4 : 8),
    connection: {
      effectiveType: variant.connection?.effectiveType || '4g',
      downlink: variant.connection?.downlink ?? 10,
      rtt: variant.connection?.rtt ?? 50,
      saveData: !!variant.connection?.saveData,
    },
    sampleRate: variant.sampleRate ?? 48000,
    colorDepth: variant.colorDepth ?? 24,
    pixelDepth: variant.pixelDepth ?? variant.colorDepth ?? 24,
    maxTouchPoints: variant.maxTouchPoints ?? (variant.mobile ? 5 : 0),
    fontFamily: variant.fontFamily || defaultFontForPlatform(platformLabel),
  }
}

function selectPersonaVariant(country, personaName, pool, session) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return { variant: PERSONA_POOL_MAP.desktop[0], variantIndex: 0 }
  }

  // Seed from stable identity: userId + country only.
  // Session ID, relay endpoint, and timestamp are intentionally excluded â€”
  // they change every connection. userId + country is permanent, so the same
  // user always gets the same device fingerprint for a given country across
  // disconnects, reconnects, and provider changes.
  // An IP change between sessions looks like the user moved, not a device swap.
  const stableSeed = [session?.userId, country].filter(Boolean).join('|')
    || `${country}|${personaName}`
  const variantIndex = hashString(stableSeed) % pool.length
  return { variant: pool[variantIndex], variantIndex }
}

function buildProfile(session) {
  const { code: country, meta } = normalizeCountry(session?.country)
  const personaName = PERSONA_POOL_MAP[meta.persona] ? meta.persona : DEFAULT_COUNTRY.persona || 'desktop'
  const pool = PERSONA_POOL_MAP[personaName] || PERSONA_POOL_MAP.desktop
  const { variant, variantIndex } = selectPersonaVariant(country, personaName, pool, session)
  const persona = normalizePersona(personaName, variant, variantIndex)

  return {
    country,
    // userId passed through so identity.js can anchor canvas/audio/geo noise
    // to the user rather than the persona variant. Same user = same noise forever.
    userId: session?.userId || '',
    tz: meta.tz,
    lang: meta.lang,
    lat: meta.lat,
    lon: meta.lon,
    ...persona,
  }
}

function markExtensionPresence() {
  const root = document.documentElement
  if (!root) return false

  root.setAttribute('data-peermesh-extension', '1')
  root.setAttribute('data-ext-version', chrome.runtime.getManifest().version)
  return true
}

function withDocumentRoot(callback) {
  if (callback()) return

  const retry = () => {
    if (!callback()) return
    document.removeEventListener('readystatechange', retry)
    document.removeEventListener('DOMContentLoaded', retry)
  }

  document.addEventListener('readystatechange', retry)
  document.addEventListener('DOMContentLoaded', retry)
}

// Pattern-based frame skip â€” covers Cloudflare, hCaptcha, reCAPTCHA, Turnstile,
// DataDome, PerimeterX, Akamai, Stripe, PayPal, and any other challenge/payment
// iframe that uses strict CSP / TrustedTypes / sandboxing.
// Rules (all must match to skip):
//   1. We are inside a cross-origin iframe (window !== window.top)
//   2. The frame's hostname matches a known challenge/payment pattern
// Rule 1 alone is not enough â€” legitimate proxy iframes also need spoofing.
// Rule 2 alone is not enough â€” some challenge providers share domains with real pages.
const CHALLENGE_HOSTNAME_PATTERNS = [
  // Cloudflare
  /^challenges\.cloudflare\.com$/,
  /^[\w-]+\.turnstile\.cloudflare\.com$/,
  // hCaptcha
  /^(?:newassets|assets)\.hcaptcha\.com$/,
  /^hcaptcha\.com$/,
  // Google reCAPTCHA
  /^(?:www\.)?google\.com$/, // only when in iframe â€” rule 1 guards this
  /^recaptcha\.google\.com$/,
  /^[\w-]+\.recaptcha\.net$/,
  // DataDome
  /^geo\.captcha-delivery\.com$/,
  /^[\w-]+\.datadome\.co$/,
  // PerimeterX / HUMAN
  /^[\w-]+\.px-cdn\.net$/,
  /^[\w-]+\.perimeterx\.net$/,
  /^[\w-]+\.humansecurity\.com$/,
  // Akamai Bot Manager
  /^[\w-]+\.akstat\.io$/,
  /^[\w-]+\.akamaized\.net$/,
  // Arkose Labs (FunCaptcha)
  /^[\w-]+\.arkoselabs\.com$/,
  /^[\w-]+\.funcaptcha\.com$/,
  // GeeTest
  /^[\w-]+\.geetest\.com$/,
  // Payment iframes (strict CSP + TrustedTypes)
  /^js\.stripe\.com$/,
  /^[\w-]+\.stripe\.com$/,
  /^[\w-]+\.paypal\.com$/,
  /^[\w-]+\.braintreegateway\.com$/,
  /^[\w-]+\.adyen\.com$/,
]

function shouldSkipFrame() {
  try {
    if (window === window.top) return false // top-level page â€” always spoof
  } catch {
    // Cross-origin top access throws â€” we are in a sandboxed cross-origin iframe
    // Fall through to hostname check
  }

  try {
    const hostname = String(window.location?.hostname || '').toLowerCase()
    return CHALLENGE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))
  } catch {
    return false
  }
}

function shouldInjectEarlyIdentity() {
  const hostname = String(window.location?.hostname || '').toLowerCase()
  return EARLY_IDENTITY_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

function ensureEarlyIdentityScript(rawProfile) {
  if (!shouldInjectEarlyIdentity()) return false

  const root = document.documentElement
  if (!root) return false

  const existing = document.querySelector(`script[${EARLY_IDENTITY_ATTR}="1"]`)
  if (existing) return true

  try {
    const script = document.createElement('script')
    script.src = chrome.runtime.getURL('content/identity.js')
    script.async = false
    script.dataset.profile = rawProfile
    script.setAttribute(EARLY_IDENTITY_ATTR, '1')
    ;(document.head || root).appendChild(script)
    return true
  } catch {
    return false
  }
}

function publishProfile(profile) {
  const root = document.documentElement
  if (!root) return false

  const rawProfile = JSON.stringify(profile)
  ensureEarlyIdentityScript(rawProfile)
  root.setAttribute(PROFILE_ATTR, rawProfile)
  document.dispatchEvent(new CustomEvent(PROFILE_EVENT, { detail: rawProfile }))
  return true
}

function clearPublishedProfile() {
  const root = document.documentElement
  if (!root) return false

  root.removeAttribute(PROFILE_ATTR)
  return true
}

function syncProfile(session) {
  if (shouldSkipFrame()) return
  withDocumentRoot(() => {
    markExtensionPresence()

    if (!session?.country) {
      return clearPublishedProfile()
    }

    return publishProfile(buildProfile(session))
  })
}

function removePeerMeshOverlay() {
  document.getElementById('peermesh-status-overlay')?.remove()
  document.getElementById('peermesh-disconnect-overlay')?.remove()
}

function showPeerMeshStatusOverlay({ state = 'blocked', title, message, autoHideMs = 0 } = {}) {
  try {
    if (window !== window.top) return
  } catch {
    return
  }

  const root = document.documentElement
  const body = document.body
  if (!root || !body) return

  removePeerMeshOverlay()

  if (state === 'clear' || state === 'connected') return

  const palette = {
    reconnecting: { accent: '#00ff88', border: 'rgba(0,255,136,0.35)', label: 'PEERMESH RECONNECTING' },
    reconnected: { accent: '#00ff88', border: 'rgba(0,255,136,0.35)', label: 'PEERMESH RECONNECTED' },
    blocked: { accent: '#ffaa00', border: 'rgba(255,170,0,0.36)', label: 'PEERMESH PROTECTION ACTIVE' },
    ended: { accent: '#ff6060', border: 'rgba(255,96,96,0.35)', label: 'PEERMESH DISCONNECTED' },
  }[state] || { accent: '#ffaa00', border: 'rgba(255,170,0,0.36)', label: 'PEERMESH STATUS' }

  const overlay = document.createElement('div')
  overlay.id = 'peermesh-status-overlay'
  overlay.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:2147483647',
    'max-width:360px',
    'padding:14px 16px',
    'background:rgba(10,10,15,0.96)',
    `border:1px solid ${palette.border}`,
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.3)',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#f5f5f8',
    'text-align:left',
  ].join(';')
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      ${state === 'reconnecting' ? `<span style="width:10px;height:10px;border:2px solid rgba(0,255,136,0.25);border-top-color:${palette.accent};border-radius:999px;display:inline-block;animation:peermesh-spin 0.8s linear infinite"></span>` : ''}
      <div style="font-size:10px;letter-spacing:1px;color:${palette.accent}">${palette.label}</div>
    </div>
    <div style="font-size:13px;line-height:1.45;color:#f5f5f8;font-weight:700">${String(title || 'PeerMesh status')}</div>
    <div style="font-size:12px;line-height:1.6;color:#cfd3dc;margin-top:5px">${String(message || 'Traffic is blocked until PeerMesh is ready.')}</div>
    ${state === 'ended' ? `<div style="font-size:11px;line-height:1.5;color:#9090a8;margin-top:6px">Reconnect from the extension popup, then reload this tab.</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="peermesh-status-close" style="padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:#f5f5f8;cursor:pointer;font:inherit;font-size:11px">DISMISS</button>
    </div>
    <style>@keyframes peermesh-spin{to{transform:rotate(360deg)}}</style>
  `
  body.appendChild(overlay)
  document.getElementById('peermesh-status-close')?.addEventListener('click', () => overlay.remove())
  if (autoHideMs > 0) {
    setTimeout(() => {
      if (document.getElementById('peermesh-status-overlay') === overlay) overlay.remove()
    }, autoHideMs)
  }
}

function showDisconnectOverlay(reason) {
  showPeerMeshStatusOverlay({
    state: 'ended',
    title: 'PeerMesh connection lost',
    message: String(reason || 'Your routed connection dropped.'),
  })
}

let sessionPanelTimer = null

function formatPanelMbps(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed) || speed <= 0) return '0.00 Mbps'
  return `${speed >= 10 ? speed.toFixed(1) : speed.toFixed(2)} Mbps`
}

function stopSessionPanelPolling() {
  if (!sessionPanelTimer) return
  clearInterval(sessionPanelTimer)
  sessionPanelTimer = null
}

function closeSessionPanel() {
  stopSessionPanelPolling()
  document.getElementById('peermesh-session-panel')?.remove()
}

function getSessionPanelStatusLabel(status) {
  if (status?.failClosed) return { label: 'PROTECTED BLOCK', color: '#ffaa00' }
  if (status?.connected) return { label: 'CONNECTED', color: '#00ff88' }
  return { label: 'DISCONNECTED', color: '#ff6060' }
}

function renderSessionPanelStatus(status = {}) {
  const panel = document.getElementById('peermesh-session-panel')
  if (!panel) return

  const session = status.session || null
  const quality = session?.quality || null
  const helper = status.helper || null
  const state = getSessionPanelStatusLabel(status)
  const country = session?.country || helper?.country || 'none'
  const connectionType = session?.connectionType || 'none'
  const currentSpeed = quality ? formatPanelMbps(quality.currentMbps) : '0.00 Mbps'
  const avgSpeed = quality ? formatPanelMbps(quality.avgMbps) : '0.00 Mbps'
  const provider = quality?.providerKind || helper?.source || 'unknown'
  const sessionId = session?.sessionId || session?.id || ''
  const failReason = status.failClosedReason || (status.failClosed ? 'Traffic is blocked to protect your real connection.' : '')

  panel.querySelector('[data-pm-status]').textContent = state.label
  panel.querySelector('[data-pm-status]').style.color = state.color
  panel.querySelector('[data-pm-dot]').style.background = state.color
  panel.querySelector('[data-pm-country]').textContent = country
  panel.querySelector('[data-pm-mode]').textContent = connectionType
  panel.querySelector('[data-pm-current]').textContent = currentSpeed
  panel.querySelector('[data-pm-avg]').textContent = avgSpeed
  panel.querySelector('[data-pm-provider]').textContent = provider
  panel.querySelector('[data-pm-session]').textContent = sessionId ? sessionId.slice(0, 8) : 'none'
  panel.querySelector('[data-pm-helper]').textContent = helper?.available
    ? `${helper.source || 'desktop'} ${helper.running ? 'sharing' : 'ready'}`
    : 'not available'
  panel.querySelector('[data-pm-reason]').textContent = failReason
}

async function refreshSessionPanelStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' })
    renderSessionPanelStatus(status || {})
  } catch {
    renderSessionPanelStatus({ failClosed: true, failClosedReason: 'PeerMesh background is not reachable.' })
  }
}

function showSessionPanel() {
  try {
    if (window !== window.top) return
  } catch {
    return
  }

  const body = document.body
  if (!body) return

  const existing = document.getElementById('peermesh-session-panel')
  if (existing) {
    closeSessionPanel()
    return
  }

  const panel = document.createElement('div')
  panel.id = 'peermesh-session-panel'
  panel.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:2147483647',
    'width:min(360px,calc(100vw - 32px))',
    'background:rgba(10,10,15,0.97)',
    'border:1px solid rgba(0,255,136,0.28)',
    'border-radius:10px',
    'box-shadow:0 12px 36px rgba(0,0,0,0.34)',
    'color:#f5f5f8',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
    'text-align:left',
    'overflow:hidden',
  ].join(';')
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08)">
      <div style="display:flex;align-items:center;gap:8px">
        <span data-pm-dot style="width:8px;height:8px;border-radius:999px;background:#666"></span>
        <div>
          <div style="font-size:11px;letter-spacing:1px;color:#00ff88">PEERMESH SESSION</div>
          <div data-pm-status style="font-size:13px;font-weight:700;margin-top:2px">LOADING</div>
        </div>
      </div>
      <button id="peermesh-session-panel-close" style="border:1px solid rgba(255,255,255,0.14);background:transparent;color:#cfd3dc;border-radius:7px;padding:6px 8px;cursor:pointer;font:inherit;font-size:11px">DISMISS</button>
    </div>
    <div style="padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
      <div><div style="color:#777b8f;font-size:10px">COUNTRY</div><div data-pm-country style="margin-top:3px">none</div></div>
      <div><div style="color:#777b8f;font-size:10px">MODE</div><div data-pm-mode style="margin-top:3px">none</div></div>
      <div><div style="color:#777b8f;font-size:10px">CURRENT SPEED</div><div data-pm-current style="margin-top:3px;color:#00ff88">0.00 Mbps</div></div>
      <div><div style="color:#777b8f;font-size:10px">AVG SPEED</div><div data-pm-avg style="margin-top:3px;color:#00ff88">0.00 Mbps</div></div>
      <div><div style="color:#777b8f;font-size:10px">PROVIDER</div><div data-pm-provider style="margin-top:3px">unknown</div></div>
      <div><div style="color:#777b8f;font-size:10px">SESSION</div><div data-pm-session style="margin-top:3px">none</div></div>
      <div style="grid-column:1 / -1"><div style="color:#777b8f;font-size:10px">LOCAL HELPER</div><div data-pm-helper style="margin-top:3px">checking</div></div>
      <div style="grid-column:1 / -1;color:#ffaa00;font-size:11px;line-height:1.5;min-height:16px" data-pm-reason></div>
    </div>
    <div style="padding:8px 14px;border-top:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;gap:10px">
      <span style="font-size:10px;color:#777b8f">Shortcut: Ctrl+Shift+P</span>
      <button id="peermesh-session-panel-dismiss" style="border:none;background:transparent;color:#9090a8;cursor:pointer;font:inherit;font-size:10px;padding:0">DISMISS</button>
    </div>
  `
  body.appendChild(panel)
  document.getElementById('peermesh-session-panel-close')?.addEventListener('click', closeSessionPanel)
  document.getElementById('peermesh-session-panel-dismiss')?.addEventListener('click', closeSessionPanel)
  refreshSessionPanelStatus()
  stopSessionPanelPolling()
  sessionPanelTimer = setInterval(refreshSessionPanelStatus, 2000)
}

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'p') return
  event.preventDefault()
  event.stopPropagation()
  showSessionPanel()
}, true)

withDocumentRoot(markExtensionPresence)

chrome.storage.local.get(['session'], ({ session }) => {
  syncProfile(session)
})

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.session) return
  syncProfile(changes.session.newValue ?? null)
})

chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type === 'PEERMESH_SESSION_ENDED') {
    showDisconnectOverlay(message.reason)
  }
  if (message?.type === 'PEERMESH_BROWSING_STATUS') {
    if (message.state === 'clear' || message.state === 'connected') {
      removePeerMeshOverlay()
      return
    }
    showPeerMeshStatusOverlay({
      state: message.state,
      title: message.title,
      message: message.message,
      autoHideMs: message.state === 'reconnected' ? 4500 : 0,
    })
    refreshSessionPanelStatus()
  }
})
