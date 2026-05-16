// injector.js - runs in the isolated world.
// It computes the active spoof profile and publishes it through the DOM so the
// main-world content script can apply it without relying on a page-inserted
// <script> tag that can be blocked by CSP.

const PROFILE_ATTR = 'data-peermesh-profile'
const PROFILE_EVENT = 'peermesh:profile'
const EARLY_IDENTITY_ATTR = 'data-peermesh-identity-loader'
const EARLY_IDENTITY_HOSTS = ['browserleaks.com', 'abrahamjuliot.github.io', 'creepjs.vercel.app']

const COUNTRY_DATA_MAP = globalThis.__PEERMESH_COUNTRY_DATA__ || {
  XX: { tz: 'UTC', lang: 'en-US', lat: 51.5074, lon: -0.1278, persona: 'desktop' },
}

const PERSONA_POOL_MAP = globalThis.__PEERMESH_PERSONA_POOLS__ || {
  desktop: [
    {
      mobile: false,
      platform: 'Win32',
      platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      uaVersion: '124',
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
  return match?.[1] || (fallbackVersion ? `${fallbackVersion}.0.0.0` : '124.0.0.0')
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
  const uaVersion = String(variant.uaVersion || (getChromeFullVersion(variant.userAgent).split('.')[0] || '124'))
  const uaFullVersion = getChromeFullVersion(variant.userAgent, uaVersion)
  const platformLabel = variant.platformLabel || (variant.mobile ? 'Android' : 'Windows')

  return {
    name: personaName,
    persona: personaName,
    variant: variantIndex,
    mobile: !!variant.mobile,
    userAgent: variant.userAgent,
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
  // Session ID, relay endpoint, and timestamp are intentionally excluded —
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

// Pattern-based frame skip — covers Cloudflare, hCaptcha, reCAPTCHA, Turnstile,
// DataDome, PerimeterX, Akamai, Stripe, PayPal, and any other challenge/payment
// iframe that uses strict CSP / TrustedTypes / sandboxing.
// Rules (all must match to skip):
//   1. We are inside a cross-origin iframe (window !== window.top)
//   2. The frame's hostname matches a known challenge/payment pattern
// Rule 1 alone is not enough — legitimate proxy iframes also need spoofing.
// Rule 2 alone is not enough — some challenge providers share domains with real pages.
const CHALLENGE_HOSTNAME_PATTERNS = [
  // Cloudflare
  /^challenges\.cloudflare\.com$/,
  /^[\w-]+\.turnstile\.cloudflare\.com$/,
  // hCaptcha
  /^(?:newassets|assets)\.hcaptcha\.com$/,
  /^hcaptcha\.com$/,
  // Google reCAPTCHA
  /^(?:www\.)?google\.com$/, // only when in iframe — rule 1 guards this
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
    if (window === window.top) return false // top-level page — always spoof
  } catch {
    // Cross-origin top access throws — we are in a sandboxed cross-origin iframe
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

function showDisconnectOverlay(reason) {
  try {
    if (window !== window.top) return
  } catch {
    return
  }

  const root = document.documentElement
  const body = document.body
  if (!root || !body) return

  const existing = document.getElementById('peermesh-disconnect-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'peermesh-disconnect-overlay'
  overlay.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:2147483647',
    'max-width:360px',
    'padding:14px 16px',
    'background:rgba(10,10,15,0.96)',
    'border:1px solid rgba(255,96,96,0.35)',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.3)',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#f5f5f8',
  ].join(';')
  overlay.innerHTML = `
    <div style="font-size:10px;letter-spacing:1px;color:#ff8080;margin-bottom:8px">PEERMESH DISCONNECTED</div>
    <div style="font-size:12px;line-height:1.6;color:#cfd3dc">${String(reason || 'Your routed connection dropped.')}</div>
    <div style="font-size:11px;line-height:1.5;color:#9090a8;margin-top:6px">Reconnect from the extension popup, then reload this tab.</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="peermesh-disconnect-close" style="padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:#f5f5f8;cursor:pointer;font:inherit;font-size:11px">DISMISS</button>
    </div>
  `
  body.appendChild(overlay)
  document.getElementById('peermesh-disconnect-close')?.addEventListener('click', () => overlay.remove())
}

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
})
