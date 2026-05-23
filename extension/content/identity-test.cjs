#!/usr/bin/env node
// identity-test.js — PeerMesh identity.js spoof coverage tester
// Usage:  node identity-test.js [country] [persona]
// Examples:
//   node identity-test.js RW mobile
//   node identity-test.js US desktop
//   node identity-test.js DE mac

'use strict'
const fs     = require('fs')
const path   = require('path')
const vm     = require('vm')
const crypto = require('crypto')
const { URL: NodeURL } = require('url')

// ── Profile ────────────────────────────────────────────────────────────────────
const PERSONA = process.argv[3] || 'mobile'
const IS_MOB  = PERSONA === 'mobile'

const STREAMING_TEST_URL = 'https://www.netflix.com/watch/123456'
const FINGERPRINT_TEST_URL = 'https://abrahamjuliot.github.io/creepjs/tests/workers.html'

const P = {
  country: process.argv[2] || 'RW',
  userId:  'test-user-peermesh-001',
  tz:               IS_MOB ? 'Africa/Kigali'   : 'America/New_York',
  lang:             IS_MOB ? 'rw-RW'           : 'en-US',
  lat:              IS_MOB ? -1.9441           : 40.7128,
  lon:              IS_MOB ? 30.0619           : -74.0060,
  persona:          PERSONA,
  mobile:           IS_MOB,
  userAgent: IS_MOB
    ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
  platform:         IS_MOB ? 'Linux armv8l'   : 'Win32',
  platformLabel:    IS_MOB ? 'Android'         : 'Windows',
  platformVersion:  IS_MOB ? '14.0.0'          : '10.0.0',
  uaVersion:        '131',
  uaFullVersion:    '131.0.6778.86',
  hardwareConcurrency: IS_MOB ? 8  : 16,
  deviceMemory:     IS_MOB ? 8    : 8,
  maxTouchPoints:   IS_MOB ? 5   : 0,
  architecture:     IS_MOB ? 'arm' : 'x86',
  bitness:          '64',
  deviceModel:      IS_MOB ? 'Pixel 8' : '',
  colorDepth:       24, pixelDepth: 24,
  sampleRate:       48000,
  screen: IS_MOB
    ? { width: 412, height: 915, availWidth: 412, availHeight: 915, innerWidth: 412, innerHeight: 834 }
    : { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, innerWidth: 1920, innerHeight: 947 },
  connection: IS_MOB
    ? { effectiveType: '4g', downlink: 15, rtt: 65,  saveData: false }
    : { effectiveType: '4g', downlink: 30, rtt: 20,  saveData: false },
}

// ── Stubs ──────────────────────────────────────────────────────────────────────
// All spoofable properties go on the PROTOTYPE so identity.js prototype patches win.
global.window   = global
global.document = {
  currentScript: { dataset: { profile: JSON.stringify(P) } },
  createElement(t) { return { setAttribute() {}, textContent: '', style: {} } },
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
}

// Navigator
class FakeNavigator {}
global.Navigator  = { prototype: FakeNavigator.prototype }
// Node 22 defines global.navigator as a getter-only — redefine it as writable first
Object.defineProperty(global, 'navigator', { value: new FakeNavigator(), writable: true, configurable: true, enumerable: true })
function navProp(k, v) {
  Object.defineProperty(FakeNavigator.prototype, k, {
    get: typeof v === 'function' ? v : () => v,
    set() {}, configurable: true, enumerable: true,
  })
}
navProp('language',            'en-US')
navProp('languages',           ['en-US'])
navProp('userAgent',           'Mozilla/5.0 (Windows NT 10.0) Chrome/147')
navProp('appVersion',          '5.0 (Windows NT 10.0) Chrome/147')
navProp('platform',            'Win32')
navProp('vendor',              'Google Inc.')
navProp('hardwareConcurrency', 4)
navProp('deviceMemory',        16)
navProp('maxTouchPoints',      0)
navProp('doNotTrack',          null)
navProp('plugins',             { length: 0 })
navProp('mimeTypes',           { length: 0 })
navProp('connection',          { effectiveType: '4g', downlink: 10, rtt: 100, saveData: false })
navProp('userAgentData',       { brands: [], mobile: false, platform: 'Windows', getHighEntropyValues: async () => ({}) })
navProp('mediaDevices', {
  enumerateDevices: async () => [
    { kind: 'videoinput',  label: '', deviceId: 'real-cam', groupId: 'g1' },
    { kind: 'audioinput',  label: '', deviceId: 'real-mic', groupId: 'g1' },
    { kind: 'audiooutput', label: '', deviceId: 'real-spk', groupId: 'g1' },
  ],
})
class FakeServiceWorkerContainer {}
global.ServiceWorkerContainer = { prototype: FakeServiceWorkerContainer.prototype }
global.ServiceWorkerRegistration = { prototype: {} }
global.ServiceWorker = { prototype: {} }
FakeServiceWorkerContainer.prototype.register = function register(scriptURL, options) {
  return Promise.resolve({ native: true, scriptURL, options })
}
Object.defineProperty(FakeNavigator.prototype, 'serviceWorker', {
  get: () => Object.create(FakeServiceWorkerContainer.prototype),
  configurable: true,
  enumerable: true,
})
Object.defineProperty(FakeNavigator.prototype, 'getBattery', {
  value: () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 }),
  writable: true, configurable: true, enumerable: true,
})
Object.defineProperty(global.navigator, 'geolocation', {
  get: () => ({
    getCurrentPosition(cb) { cb({ coords: { latitude: 0, longitude: 0, accuracy: 10 } }) },
    watchPosition(cb)      { cb({ coords: { latitude: 0, longitude: 0, accuracy: 10 } }); return 0 },
    clearWatch() {},
  }),
  configurable: true, enumerable: true,
})

// Screen
class FakeScreen {}
global.Screen = { prototype: FakeScreen.prototype }
global.screen = new FakeScreen()
function screenProp(k, v) {
  Object.defineProperty(FakeScreen.prototype, k, { get: () => v, set() {}, configurable: true, enumerable: true })
}
screenProp('width', 1098); screenProp('height', 618)
screenProp('availWidth', 1098); screenProp('availHeight', 618)
screenProp('colorDepth', 32); screenProp('pixelDepth', 32)
Object.defineProperty(FakeScreen.prototype, 'orientation', {
  get: () => ({ type: 'landscape-primary', angle: 0, onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }),
  configurable: true, enumerable: true,
})

// Window geometry
global.innerWidth = 1098; global.innerHeight = 529
global.outerWidth = 1098; global.outerHeight = 618
global.devicePixelRatio = 1.75
global.visualViewport   = { width: 1098, height: 529.1428833007812, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0 }
global.location = {
  href: STREAMING_TEST_URL,
  origin: 'https://www.netflix.com',
  hostname: 'www.netflix.com',
  pathname: '/watch/123456',
}
global.locationbar  = { visible: false }; global.menubar     = { visible: false }
global.personalbar  = { visible: false }; global.scrollbars  = { visible: false }
global.statusbar    = { visible: false }; global.toolbar     = { visible: false }
const REAL_VIEWPORT = {
  innerWidth: global.innerWidth,
  innerHeight: global.innerHeight,
  outerWidth: global.outerWidth,
  outerHeight: global.outerHeight,
}

// Canvas
class FakeCRCTX {
  getImageData(x,y,w,h) { return { data: new Uint8ClampedArray(w*h*4).fill(128) } }
  putImageData() {}
  measureText(t) {
    return { width: t.length*8, actualBoundingBoxLeft: 0, actualBoundingBoxRight: t.length*8,
      actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3,
      emHeightAscent: 10, emHeightDescent: 2,
      hangingBaseline: 8, alphabeticBaseline: 0, ideographicBaseline: -2 }
  }
}
global.CanvasRenderingContext2D = { prototype: FakeCRCTX.prototype }
class FakeHTMLCanvas {
  getContext() { return new FakeCRCTX() }
  toDataURL()  { return 'data:image/png;base64,FAKE' }
  toBlob(cb)   { cb(null) }
  get width()  { return 300 }
  get height() { return 150 }
}
global.HTMLCanvasElement = { prototype: FakeHTMLCanvas.prototype }

// Audio
class FakeAudioBuffer {}
Object.defineProperty(FakeAudioBuffer.prototype, 'getChannelData', {
  value(ch) { return new Float32Array(128).fill(0.5) }, writable: true, configurable: true,
})
global.AudioBuffer = FakeAudioBuffer
class FakeAC { constructor() { this.sampleRate = 44100; this.destination = { maxChannelCount: 1, channelCount: 1 } } }
global.AudioContext = FakeAC; global.webkitAudioContext = FakeAC
class FakeOAC { constructor() { this.sampleRate = 44100; this.destination = { maxChannelCount: 1, channelCount: 1 } } }
global.OfflineAudioContext = FakeOAC; global.webkitOfflineAudioContext = FakeOAC

// WebRTC
global.RTCPeerConnection = function(c) { this.config = c }
global.RTCPeerConnection.prototype = {}

// Workers
const workerBlobs = new Map()
let workerBlobId = 0
global.URL = class URLWithBlob extends NodeURL {
  static createObjectURL(blob) {
    const id = `blob:peermesh-${++workerBlobId}`
    workerBlobs.set(id, blob)
    return id
  }
  static revokeObjectURL(id) {
    workerBlobs.delete(id)
  }
}
class FakeWorker {
  constructor(url, options = {}) {
    this.url = url
    this.options = options
  }
}
global.Worker = FakeWorker
global.SharedWorker = FakeWorker

// WebAssembly
global.WebAssembly = { validate(buf) { try { return buf.byteLength > 4 } catch { return false } } }

// Speech
global.speechSynthesis = {
  speak(){}, cancel(){}, pause(){}, resume(){}, pending: false, speaking: false, paused: false,
  getVoices: () => Array.from({ length: 25 }, (_,i) => ({ name: `Voice ${i}`, lang: 'en-US' })),
  onvoiceschanged: null, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false },
}

// matchMedia — returns a real-ish object that identity.js can call
// Object.defineProperty(mql, 'matches', ...) on
class FakeMQL {
  constructor(q) {
    this.media = q; this.onchange = null
    Object.defineProperty(this, 'matches', { get: () => q.includes('dark'), set() {}, configurable: true })
  }
  addEventListener(){}; removeEventListener(){}; dispatchEvent(){ return false }
  addListener(){}; removeListener(){}
}
global.MediaQueryList = FakeMQL
global.matchMedia = q => new FakeMQL(q)

// Performance
class FakePerf { now() { return Date.now() + 0.987654 } }
global.Performance = { prototype: FakePerf.prototype }
global.performance = new FakePerf()

// Misc
global.HTMLElement  = { prototype: {} }
global.DOMException = class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message)
    this.name = name
  }
}
global.Blob         = class Blob {
  constructor(parts = [], options = {}) {
    this.parts = parts
    this.type = options.type || ''
  }
}
global.chrome       = {
  runtime: { getManifest: () => ({ version: '1.0.0' }), getURL: s => `chrome-extension://x/${s}` },
  storage: { local: { get: (k, cb) => cb({}) } },
}

// ── Load identity.js ──────────────────────────────────────────────────────────
const identityPath = path.resolve(__dirname, 'identity.js')
const injectorPath = path.resolve(__dirname, 'injector.js')
if (!fs.existsSync(identityPath)) { console.error('identity.js not found'); process.exit(1) }
const identitySource = fs.readFileSync(identityPath, 'utf8')
const injectorSource = fs.existsSync(injectorPath) ? fs.readFileSync(injectorPath, 'utf8') : ''
if (!fs.existsSync(identityPath)) { console.error('\n  ✖  identity.js not found\n'); process.exit(1) }
let loadError = null
try { vm.runInThisContext(identitySource, { filename: 'identity.js' }) }
catch (e) { loadError = e }

// ── Harness ────────────────────────────────────────────────────────────────────
const results = []
function test(cat, lbl, actual, expected, warn = false) {
  let ok
  if (expected instanceof RegExp)        ok = expected.test(String(actual))
  else if (typeof expected === 'boolean') ok = Boolean(actual) === expected
  else                                    ok = String(actual) === String(expected)
  results.push({ status: ok ? 'PASS' : (warn ? 'WARN' : 'FAIL'), cat, lbl, actual: String(actual), expected: String(expected) })
}
function skip(cat, lbl, why) { results.push({ status: 'SKIP', cat, lbl, actual: why, expected: '' }) }
function g(obj, k) { try { return obj[k] } catch { return '<err>' } }

// ── Run tests ─────────────────────────────────────────────────────────────────
test('Load', 'identity.js loads without error', loadError === null, true)
test('Safety', 'worker spoof enabled for active profile', /function shouldPatchWorkers\b/.test(identitySource) && /return !!profile/.test(identitySource), true)
test('Safety', 'fingerprint service worker bypass remains host-gated', /function isFingerprintTestHost\b/.test(identitySource) && /WORKER_SPOOF_HOSTS/.test(identitySource) && /browserleaks\.com/.test(identitySource), true)
test('Safety', 'service worker fallback patch present', /function patchServiceWorkerRegister\b/.test(identitySource), true)
test('Safety', 'service worker fallback limited to creepjs scripts', /shouldBypassServiceWorker/.test(identitySource) && /creep\.js/.test(identitySource) && /worker_service\.js/.test(identitySource), true)
test('Safety', 'no inline scrollbar style injector', !/appendChild\(style\)|style\.textContent/.test(identitySource), true)
test('Safety', 'injector has shouldSkipFrame guard',          /function shouldSkipFrame\b/.test(injectorSource), true)
test('Safety', 'injector skip covers challenge patterns',     /CHALLENGE_HOSTNAME_PATTERNS/.test(injectorSource), true)
test('Safety', 'injector skip covers cross-origin iframes',  /window\.top/.test(injectorSource), true)
test('Safety', 'injector syncProfile gated by shouldSkipFrame', /shouldSkipFrame\(\)/.test(injectorSource), true)

// Navigator
test('Navigator', 'language',            g(navigator,'language'),            P.lang)
test('Navigator', 'languages[0]',        g(navigator,'languages')?.[0],      P.lang)
test('Navigator', 'userAgent',           g(navigator,'userAgent'),           P.userAgent)
test('Navigator', 'platform',            g(navigator,'platform'),            P.platform)
test('Navigator', 'hardwareConcurrency', g(navigator,'hardwareConcurrency'), P.hardwareConcurrency)
test('Navigator', 'deviceMemory',        g(navigator,'deviceMemory'),        P.deviceMemory)
test('Navigator', 'maxTouchPoints',      g(navigator,'maxTouchPoints'),      P.maxTouchPoints)
test('Navigator', 'vendor',              g(navigator,'vendor'),              'Google Inc.')
test('Navigator', 'doNotTrack',          g(navigator,'doNotTrack'),          null)

// UAData
const uad = g(navigator,'userAgentData')
test('UAData', 'mobile',            uad?.mobile,              P.mobile)
test('UAData', 'platform',          uad?.platform,            P.platformLabel)
test('UAData', 'brands[0].brand',   uad?.brands?.[0]?.brand,  'Google Chrome')
test('UAData', 'brands[0].version', uad?.brands?.[0]?.version, P.uaVersion)

// Connection
const conn = g(navigator,'connection')
test('Connection', 'effectiveType', conn?.effectiveType, P.connection.effectiveType)
test('Connection', 'downlink',      conn?.downlink,      P.connection.downlink)
test('Connection', 'rtt',           conn?.rtt,           P.connection.rtt)
test('Connection', 'saveData',      conn?.saveData,      P.connection.saveData)

// Screen
test('Screen', 'width',       g(screen,'width'),       P.screen.width)
test('Screen', 'height',      g(screen,'height'),      P.screen.height)
test('Screen', 'availWidth',  g(screen,'availWidth'),  P.screen.availWidth)
test('Screen', 'availHeight', g(screen,'availHeight'), P.screen.availHeight)
test('Screen', 'colorDepth',  g(screen,'colorDepth'),  P.colorDepth)
test('Screen', 'pixelDepth',  g(screen,'pixelDepth'),  P.pixelDepth)

// Window
test('Window', 'innerWidth',                  g(window,'innerWidth'),        REAL_VIEWPORT.innerWidth)
test('Window', 'innerHeight',                 g(window,'innerHeight'),       REAL_VIEWPORT.innerHeight)
test('Window', 'outerWidth',                  g(window,'outerWidth'),        REAL_VIEWPORT.outerWidth)
test('Window', 'outerHeight',                 g(window,'outerHeight'),       REAL_VIEWPORT.outerHeight)
test('Window', 'devicePixelRatio',            g(window,'devicePixelRatio'),  IS_MOB ? 2.625 : 1.0)
test('Window', 'DPR not leaking real 1.75',   g(window,'devicePixelRatio') !== 1.75, true)

// ViewPort
const vvp = g(window,'visualViewport')
test('ViewPort', 'width',              vvp?.width,  REAL_VIEWPORT.innerWidth)
test('ViewPort', 'height',             vvp?.height, REAL_VIEWPORT.innerHeight)
test('ViewPort', 'scale',              vvp?.scale,  1)
test('ViewPort', 'height is integer',  Number.isInteger(vvp?.height ?? 0), true)

// Timezone
test('Timezone', 'Intl DTF timezone',       new Intl.DateTimeFormat().resolvedOptions().timeZone, P.tz)
test('Timezone', 'Intl DTF locale',         new Intl.DateTimeFormat().resolvedOptions().locale,   P.lang)
test('Timezone', 'getTimezoneOffset type',  typeof new Date().getTimezoneOffset(), 'number')

// Intl
test('Intl', 'NumberFormat locale', new Intl.NumberFormat().resolvedOptions().locale, P.lang)
test('Intl', 'Collator locale', new Intl.Collator().resolvedOptions().locale, P.lang)
if (typeof Intl.DisplayNames === 'function') {
  test('Intl', 'DisplayNames locale', new Intl.DisplayNames([P.lang], { type: 'language' }).resolvedOptions().locale, P.lang)
}

// Geolocation
let geoResult = null
try {
  const desc = Object.getOwnPropertyDescriptor(navigator, 'geolocation')
  const geo  = desc ? (desc.get ? desc.get() : desc.value) : navigator.geolocation
  geo?.getCurrentPosition(p => { geoResult = p })
} catch {}
if (geoResult) {
  test('Geo', 'latitude  near profile.lat', Math.abs(geoResult.coords.latitude  - P.lat) < 0.1, true)
  test('Geo', 'longitude near profile.lon', Math.abs(geoResult.coords.longitude - P.lon) < 0.1, true)
  test('Geo', 'accuracy is number',         typeof geoResult.coords.accuracy, 'number')
} else {
  test('Geo', 'getCurrentPosition works', false, true)
}

// Canvas measureText
const fctx = new FakeCRCTX()
const met  = CanvasRenderingContext2D.prototype.measureText.call(fctx, 'Hello World')
test('Canvas', 'measureText is object',                  typeof met === 'object', true)
test('Canvas', 'measureText not a Proxy',                met?.constructor?.name !== 'Proxy', true)
test('Canvas', 'measureText width is number',            typeof met?.width, 'number')
test('Canvas', 'measureText actualBoundingBoxAscent',    typeof met?.actualBoundingBoxAscent, 'number')
test('Canvas', 'measureText fontBoundingBoxAscent',      typeof met?.fontBoundingBoxAscent, 'number')
test('Canvas', 'measureText alphabeticBaseline',         typeof met?.alphabeticBaseline, 'number')

// Audio
const ac  = new AudioContext()
test('Audio', 'AudioContext sampleRate',          g(ac, 'sampleRate'), P.sampleRate)
test('Audio', 'destination.maxChannelCount',      g(ac.destination, 'maxChannelCount'), IS_MOB ? 2 : 8)
test('Audio', 'channelCount <= maxChannelCount',  ac.destination.channelCount <= ac.destination.maxChannelCount, true)
const oac = new OfflineAudioContext()
test('Audio', 'OfflineAudioContext sampleRate',   g(oac, 'sampleRate'), P.sampleRate)
const abuf  = Object.create(AudioBuffer.prototype)
const chdat = AudioBuffer.prototype.getChannelData.call(abuf, 0)
test('Audio', 'getChannelData is Float32Array',   chdat instanceof Float32Array, true)
test('Audio', 'getChannelData noise applied',     chdat[0] !== 0.5, true)

// Speech
if (IS_MOB) {
  const ss = g(window, 'speechSynthesis')
  test('Speech', 'getVoices returns array', Array.isArray(ss?.getVoices?.()), true)
  test('Speech', 'voice count is 0',        ss?.getVoices?.()?.length ?? -1, 0)
} else { skip('Speech', 'voice spoof', 'desktop — pass-through') }

// WebRTC
const rtc = new RTCPeerConnection({ iceTransportPolicy: 'all', iceServers: [{ urls: 'stun:stun.l.google.com' }] })
test('WebRTC', 'iceTransportPolicy = relay', rtc.config?.iceTransportPolicy, 'relay')
test('WebRTC', 'STUN servers stripped',      rtc.config?.iceServers?.length,  0)

// Workers
const dedicatedWorker = new Worker('https://abrahamjuliot.github.io/creepjs/tests/worker.js')
const dedicatedWorkerBlob = workerBlobs.get(dedicatedWorker.url)
const dedicatedWorkerSource = Array.isArray(dedicatedWorkerBlob?.parts)
  ? dedicatedWorkerBlob.parts.map((part) => typeof part === 'string' ? part : String(part)).join('')
  : ''
test('Workers', 'worker wrapping', dedicatedWorker.url.startsWith('blob:peermesh-'), true)
test('Workers', 'bootstrap keeps original script url', /worker\.js/.test(dedicatedWorkerSource), true)
test('Workers', 'bootstrap re-wraps nested workers', /bootWorker\.toString\(\)/.test(dedicatedWorkerSource), true)
test('Workers', 'bootstrap spoofs geolocation', /patchGeolocation/.test(dedicatedWorkerSource) && /profile\.lat/.test(dedicatedWorkerSource), true)
test('Workers', 'bootstrap spoofs geolocation permission', /descriptor\?\.name === 'geolocation'/.test(dedicatedWorkerSource), true)
const sharedWorker = new SharedWorker('https://abrahamjuliot.github.io/creepjs/tests/worker_shared.js')
test('Workers', 'shared worker wrapping', sharedWorker.url.startsWith('blob:peermesh-'), true)

const workerRuntimeP = (async () => {
  try {
    if (typeof buildWorkerBootstrap !== 'function') {
      test('Workers', 'bootstrap function available', false, true)
      return
    }

    const workerContext = {
      self: null,
      navigator: {
        geolocation: {
          getCurrentPosition(cb) { cb({ coords: { latitude: 0, longitude: 0, accuracy: 10 } }) },
          watchPosition(cb) { cb({ coords: { latitude: 0, longitude: 0, accuracy: 10 } }); return 1 },
          clearWatch() {},
        },
        permissions: {
          query: async () => ({ state: 'prompt' }),
        },
      },
      location: {
        href: 'https://www.netflix.com/worker.js',
        origin: 'https://www.netflix.com',
      },
      URL: NodeURL,
      setTimeout,
      Blob: global.Blob,
      importScripts() {},
    }
    workerContext.self = workerContext

    const workerBootstrap = buildWorkerBootstrap(P, null, 'classic', `
      self.navigator.geolocation.getCurrentPosition((position) => { self.__geoResult = position })
      self.navigator.permissions.query({ name: 'geolocation' }).then((status) => { self.__geoPermissionState = status.state })
    `)

    vm.runInNewContext(workerBootstrap, workerContext, { filename: 'worker-bootstrap.js', timeout: 1000 })
    await new Promise(resolve => setImmediate(resolve))

    test('Workers', 'runtime geolocation latitude near profile.lat', Math.abs(workerContext.__geoResult?.coords?.latitude - P.lat) < 0.1, true)
    test('Workers', 'runtime geolocation longitude near profile.lon', Math.abs(workerContext.__geoResult?.coords?.longitude - P.lon) < 0.1, true)
    test('Workers', 'runtime geolocation permission granted', workerContext.__geoPermissionState, 'granted')
  } catch (error) {
    test('Workers', 'runtime bootstrap geolocation executes', error?.message || error, 'no error')
  }
})()

// Orientation
test('Orient', 'type matches persona', g(screen, 'orientation')?.type, IS_MOB ? 'portrait-primary' : 'landscape-primary')

// matchMedia
let mqlDark = null, mqlErr = null
try {
  mqlDark = window.matchMedia('(prefers-color-scheme: dark)')
  test('matchMedia', 'dark mode = false on mobile',     mqlDark?.matches, IS_MOB ? false : mqlDark?.matches)
  test('matchMedia', 'has addEventListener (real MQL)',  typeof mqlDark?.addEventListener, 'function')
  test('matchMedia', 'not null-prototype (no Polymer crash)', Object.getPrototypeOf(mqlDark) !== null, true)
  // Simulate what Polymer does: set .matches — must not throw
  let crash = null
  try { mqlDark.matches = true } catch(e) { crash = e.message }
  test('matchMedia', 'Polymer: set .matches does not throw', crash === null, true)
} catch(e) {
  mqlErr = e.message
  test('matchMedia', 'no TypeError', false, true)
}

// Performance
test('Perf', 'now() clamped to integer ms', Number.isInteger(performance.now()), true)

// colorDepth not leaking real 32
test('Screen', 'colorDepth not leaking 32', screen.colorDepth !== 32, true)

// Location bars
for (const bar of ['locationbar','menubar','personalbar','scrollbars','statusbar','toolbar']) {
  test('LocBars', `${bar}.visible`, window[bar]?.visible, true)
}

// WebAssembly probe
if (IS_MOB) {
  test('Wasm', 'small probe blocked', WebAssembly.validate(new Uint8Array(16).buffer), false)
} else { skip('Wasm', 'SIMD probe', 'desktop — not blocked') }

// Async: Battery + enumerateDevices
const battP = navigator.getBattery().then(b => {
  test('Battery', 'resolves',              b !== undefined, true)
  test('Battery', 'charging = !mobile',   b.charging,      !IS_MOB)
  test('Battery', 'level is number',       typeof b.level, 'number')
  test('Battery', 'level < 1 on mobile',  IS_MOB ? b.level < 1.0 : b.level === 1.0, true)
}).catch(() => test('Battery', 'getBattery resolves', false, true))

const enumP = navigator.mediaDevices.enumerateDevices().then(devs => {
  test('Devices', 'cameras',       devs.filter(d=>d.kind==='videoinput').length,  IS_MOB ? 2 : 1)
  test('Devices', 'microphones',   devs.filter(d=>d.kind==='audioinput').length,  1)
  test('Devices', 'audio outputs', devs.filter(d=>d.kind==='audiooutput').length, IS_MOB ? 1 : 2)
}).catch(() => test('Devices', 'enumerateDevices resolves', false, true))

Object.assign(global.location, {
  href: FINGERPRINT_TEST_URL,
  origin: 'https://abrahamjuliot.github.io',
  hostname: 'abrahamjuliot.github.io',
  pathname: '/creepjs/tests/workers.html',
})

const swP = navigator.serviceWorker.register('https://abrahamjuliot.github.io/creepjs/tests/worker_service.js')
  .then(() => {
    test('ServiceWorker', 'worker_service.js registration bypassed', false, true)
  })
  .catch((error) => {
    test('ServiceWorker', 'worker_service.js registration bypassed', error?.name, 'AbortError')
    return navigator.serviceWorker.register('https://abrahamjuliot.github.io/creepjs/tests/other.js')
  })
  .then((registration) => {
    test('ServiceWorker', 'non-creep registration falls through', registration?.native, true)
  })
  .catch(() => test('ServiceWorker', 'register resolves', false, true))

Promise.all([battP, enumP, swP, workerRuntimeP]).then(render)

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const R='\x1b[0m',GR='\x1b[32m',RE='\x1b[31m',YE='\x1b[33m',GY='\x1b[90m',BD='\x1b[1m',CY='\x1b[36m'
  const catW = Math.max(...results.map(r=>r.cat.length),  8)
  const lblW = Math.max(...results.map(r=>r.lbl.length), 20)
  const actW = 46
  const pad  = (s,n) => String(s).slice(0,n).padEnd(n)
  const col  = s => s==='PASS'?GR:s==='FAIL'?RE:s==='WARN'?YE:GY
  const ico  = s => s==='PASS'?'✔':s==='FAIL'?'✘':s==='WARN'?'⚠':'–'

  console.log()
  console.log(`${BD}${CY}  PeerMesh identity.js — Spoof Coverage Report${R}`)
  console.log(`  Profile : ${BD}${P.country}${R} / ${BD}${P.persona}${R}  |  userId: ${P.userId}`)
  console.log(`  UA      : ${P.userAgent.slice(0,80)}`)
  console.log()
  const hdr = `  ${' '.padEnd(3)}  ${pad('CATEGORY',catW)}  ${pad('PROPERTY',lblW)}  ${pad('ACTUAL',actW)}  EXPECTED`
  console.log(`${GY}${hdr}${R}`)
  console.log(`  ${'─'.repeat(hdr.length-2)}`)

  let lastCat = ''
  for (const r of results) {
    if (r.cat !== lastCat) { if (lastCat) console.log(); lastCat = r.cat }
    const c=col(r.status), i=ico(r.status)
    console.log(`  ${c}${i}${R}  ${GY}${pad(r.cat,catW)}${R}  ${pad(r.lbl,lblW)}  ${c}${pad(r.actual,actW)}${R}  ${GY}${r.expected.slice(0,50)}${R}`)
  }

  const pass = results.filter(r=>r.status==='PASS').length
  const fail = results.filter(r=>r.status==='FAIL').length
  const warn = results.filter(r=>r.status==='WARN').length
  const skp  = results.filter(r=>r.status==='SKIP').length

  // Fingerprint hash — deterministic signal vector
  const fp = {
    lang:       g(navigator,'language'),
    ua:         g(navigator,'userAgent').slice(0,80),
    platform:   g(navigator,'platform'),
    cores:      g(navigator,'hardwareConcurrency'),
    mem:        g(navigator,'deviceMemory'),
    touch:      g(navigator,'maxTouchPoints'),
    tz:         new Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale:     new Intl.NumberFormat().resolvedOptions().locale,
    sw:         g(screen,'width'), sh: g(screen,'height'), cd: g(screen,'colorDepth'),
    dpr:        g(window,'devicePixelRatio'), iw: g(window,'innerWidth'), ih: g(window,'innerHeight'),
    vvh:        g(window?.visualViewport,'height'),
    conn:       `${conn?.effectiveType}/${conn?.rtt}`,
    sampleRate: g(new AudioContext(),'sampleRate'),
    maxCh:      new AudioContext().destination.maxChannelCount,
    rtcPolicy:  new RTCPeerConnection({iceServers:[]}).config?.iceTransportPolicy,
    voices:     g(window,'speechSynthesis')?.getVoices?.()?.length ?? '?',
    uadMobile:  g(navigator,'userAgentData')?.mobile,
    perfClamped: Number.isInteger(performance.now()),
    darkMode:   window.matchMedia('(prefers-color-scheme: dark)')?.matches,
    locBar:     window.locationbar?.visible,
    orient:     g(screen,'orientation')?.type,
    geoLat:     geoResult?.coords.latitude.toFixed(4)  ?? 'n/a',
    geoLon:     geoResult?.coords.longitude.toFixed(4) ?? 'n/a',
  }
  const fpHash = crypto.createHash('sha256').update(JSON.stringify(fp)).digest('hex').slice(0,8)

  console.log()
  console.log(`  ${'─'.repeat(hdr.length-2)}`)
  console.log()
  console.log(
    `  ${GR}${BD}${pass} passed${R}` +
    (fail ? `   ${RE}${BD}${fail} failed${R}` : '') +
    (warn ? `   ${YE}${warn} warned${R}` : '') +
    (skp  ? `   ${GY}${skp} skipped${R}` : '') +
    `   ${GY}(${results.length} total)${R}`
  )
  console.log()
  console.log(`  ${BD}${CY}Fingerprint ID  ${fpHash}${R}`)
  console.log(`  ${GY}sha256 of spoofed signal vector — same profile = same hash always${R}`)
  console.log()
  if (fail > 0) process.exit(1)
}
