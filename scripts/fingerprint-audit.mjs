#!/usr/bin/env node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawn, spawnSync } from 'child_process'
import WebSocket from 'ws'

const DEFAULT_SITES = [
  { name: 'proxyrack-register', url: 'https://peer.proxyrack.com/register' },
  { name: 'browserleaks-javascript', url: 'https://browserleaks.com/javascript' },
  { name: 'browserleaks-canvas', url: 'https://browserleaks.com/canvas' },
  { name: 'browserleaks-webgl', url: 'https://browserleaks.com/webgl' },
  { name: 'browserleaks-webrtc', url: 'https://browserleaks.com/webrtc' },
  { name: 'browserleaks-rects', url: 'https://browserleaks.com/rects' },
  { name: 'browserleaks-fonts', url: 'https://browserleaks.com/fonts' },
  { name: 'creepjs-main', url: 'https://abrahamjuliot.github.io/creepjs/index.html' },
  { name: 'creepjs-workers', url: 'https://abrahamjuliot.github.io/creepjs/tests/workers.html' },
  { name: 'creepjs-iframes', url: 'https://abrahamjuliot.github.io/creepjs/tests/iframes.html' },
]

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

const KEY_DIFFS = [
  'extensionFlag',
  'extVersion',
  'ua',
  'lang',
  'platform',
  'timezone',
  'screen.width',
  'screen.height',
  'screen.colorDepth',
  'window.devicePixelRatio',
  'window.innerWidth',
  'window.innerHeight',
  'uaData.mobile',
  'uaData.platform',
  'uaHighEntropy.architecture',
  'uaHighEntropy.model',
  'webgl.vendor',
  'webgl.renderer',
  'canvas.hash',
  'audio.sampleRate',
  'audio.maxChannelCount',
  'connection.effectiveType',
  'connection.rtt',
  'perf.nowInteger',
  'creep.workerScope.locale',
  'creep.workerScope.localeIntlEntropyIsTrusty',
  'creep.workerScope.platform',
  'creep.workerScope.userAgent',
  'creep.navigator.lied',
  'workerMatrix.window.data',
  'workerMatrix.window.gpu',
  'workerMatrix.dedicated.ua',
  'workerMatrix.dedicated.data',
  'workerMatrix.dedicated.platform',
  'workerMatrix.dedicated.gpu',
  'workerMatrix.dedicated.tz',
  'iframeProbe.userAgent',
  'iframeProbe.platform',
]

const args = new Set(process.argv.slice(2))
const headless = args.has('--headless') || process.env.PEERMESH_AUDIT_HEADLESS === '1'
const controlOnly = args.has('--control-only')
const extensionOnly = args.has('--extension-only')
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='))
const limit = limitArg ? Number.parseInt(limitArg.split('=')[1], 10) : 0
const countryArg = process.argv.find((arg) => arg.startsWith('--country='))
const userIdArg = process.argv.find((arg) => arg.startsWith('--user-id='))
const spoofCountry = (countryArg ? countryArg.split('=')[1] : process.env.PEERMESH_AUDIT_COUNTRY || 'RW').toUpperCase()
const spoofUserId = userIdArg ? userIdArg.split('=')[1] : process.env.PEERMESH_AUDIT_USER_ID || 'audit-user-001'

if (controlOnly && extensionOnly) {
  console.error('Choose either --control-only or --extension-only, not both.')
  process.exit(1)
}

function findBrowserPath() {
  const browserPath = EDGE_CANDIDATES.find((candidate) => candidate && existsSync(candidate))
  if (!browserPath) throw new Error('Could not find Edge/Chrome. Set EDGE_PATH or CHROME_PATH.')
  return browserPath
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickSites() {
  const siteArgs = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--site='))
    .map((arg) => {
      const raw = arg.slice('--site='.length)
      return { name: raw.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '-'), url: raw }
    })

  const sites = siteArgs.length > 0 ? siteArgs : DEFAULT_SITES
  return limit > 0 ? sites.slice(0, limit) : sites
}

function makePort(offset = 0) {
  return 9222 + Math.floor(Math.random() * 400) + offset
}

async function waitForDebugger(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return res.json()
    } catch {}
    await sleep(250)
  }
  throw new Error(`Timed out waiting for browser debugger on port ${port}`)
}

function launchBrowser({ browserPath, port, userDataDir, extensionDir, loadExtension }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-popup-blocking',
    '--disable-renderer-backgrounding',
    '--window-size=1600,1200',
  ]

  if (headless) args.push('--headless=new', '--disable-gpu')
  if (loadExtension) {
    args.push(`--disable-extensions-except=${extensionDir}`)
    args.push(`--load-extension=${extensionDir}`)
  }

  args.push('about:blank')

  return spawn(browserPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
}

async function shutdownBrowser(browser) {
  if (!browser || browser.exitCode !== null) return

  browser.kill()

  await Promise.race([
    new Promise((resolve) => browser.once('exit', resolve)),
    sleep(3_000),
  ])

  if (browser.exitCode !== null) return

  if (browser.pid) {
    spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' })
  }

  await Promise.race([
    new Promise((resolve) => browser.once('exit', resolve)),
    sleep(3_000),
  ])
}

function cleanupUserDataDir(userDataDir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ws = null
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })

    this.ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message || 'CDP error'))
        else pending.resolve(message.result)
        return
      }

      const key = `${message.sessionId || 'browser'}:${message.method}`
      const handlers = this.listeners.get(key)
      if (!handlers) return
      for (const handler of [...handlers]) handler(message.params ?? {})
    })

    this.ws.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  on(method, handler, sessionId = undefined) {
    const key = `${sessionId || 'browser'}:${method}`
    const handlers = this.listeners.get(key) || []
    handlers.push(handler)
    this.listeners.set(key, handlers)
    return () => {
      const next = (this.listeners.get(key) || []).filter((item) => item !== handler)
      if (next.length === 0) this.listeners.delete(key)
      else this.listeners.set(key, next)
    }
  }

  waitFor(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      const off = this.on(method, (params) => {
        clearTimeout(timer)
        off()
        resolve(params)
      }, sessionId)
    })
  }

  async close() {
    if (!this.ws) return
    await new Promise((resolve) => {
      this.ws.once('close', resolve)
      this.ws.close()
    })
  }
}

async function createPage(client) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
  await client.send('Page.enable', {}, sessionId)
  await client.send('Runtime.enable', {}, sessionId)
  await client.send('Log.enable', {}, sessionId)
  return { targetId, sessionId }
}

function buildAuditProfile(country, userId) {
  if (country === 'RW') {
    return {
      country,
      userId,
      tz: 'Africa/Kigali',
      lang: 'rw-RW',
      lat: -1.9441,
      lon: 30.0619,
      persona: 'mobile',
      mobile: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      platformLabel: 'Android',
      platformVersion: '14.0.0',
      uaVersion: '148',
      uaFullVersion: '131.0.6778.86',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
      architecture: 'arm',
      bitness: '64',
      deviceModel: 'Pixel 8',
      colorDepth: 24,
      pixelDepth: 24,
      sampleRate: 48000,
      screen: {
        width: 412,
        height: 915,
        availWidth: 412,
        availHeight: 915,
        innerWidth: 412,
        innerHeight: 834,
      },
      connection: {
        effectiveType: '4g',
        downlink: 15,
        rtt: 65,
        saveData: false,
      },
    }
  }

  return {
    country,
    userId,
    tz: 'America/New_York',
    lang: 'en-US',
    lat: 40.7128,
    lon: -74.0060,
    persona: 'desktop',
    mobile: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
    platform: 'Win32',
    platformLabel: 'Windows',
    platformVersion: '10.0.0',
    uaVersion: '148',
    uaFullVersion: '131.0.6778.86',
    hardwareConcurrency: 16,
    deviceMemory: 8,
    maxTouchPoints: 0,
    architecture: 'x86',
    bitness: '64',
    deviceModel: '',
    colorDepth: 24,
    pixelDepth: 24,
    sampleRate: 48000,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      innerWidth: 1920,
      innerHeight: 947,
    },
    connection: {
      effectiveType: '4g',
      downlink: 30,
      rtt: 20,
      saveData: false,
    },
  }
}

function buildAuditSession(country, userId) {
  return {
    country,
    userId,
  }
}

async function findExtensionId(client) {
  const { targetInfos } = await client.send('Target.getTargets')
  const extensionTarget = targetInfos.find((target) => target.url?.startsWith('chrome-extension://'))
  if (!extensionTarget) return null
  return new URL(extensionTarget.url).hostname
}

async function primeExtensionStorage(client, extensionId, session) {
  const { targetId } = await client.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  })
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })

  try {
    await client.send('Page.enable', {}, sessionId)
    await client.send('Runtime.enable', {}, sessionId)
    await client.waitFor('Page.loadEventFired', sessionId, 10_000).catch(() => null)

    await client.send('Runtime.evaluate', {
      expression: `new Promise((resolve) => chrome.storage.local.set(${JSON.stringify({ session })}, resolve))`,
      awaitPromise: true,
    }, sessionId)
  } finally {
    await client.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

async function installProfilePublisher(client, sessionId, profile) {
  const source = `(() => {
    const rawProfile = ${JSON.stringify(JSON.stringify(profile))}
    const publishProfile = () => {
      const root = document.documentElement
      if (!root) return false
      root.setAttribute('data-peermesh-profile', rawProfile)
      document.dispatchEvent(new CustomEvent('peermesh:profile', { detail: rawProfile }))
      return true
    }
    if (publishProfile()) return
    const retry = () => {
      if (!publishProfile()) return
      document.removeEventListener('readystatechange', retry)
      document.removeEventListener('DOMContentLoaded', retry)
    }
    document.addEventListener('readystatechange', retry)
    document.addEventListener('DOMContentLoaded', retry)
  })();`

  await client.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
}

async function evaluateJson(client, sessionId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId)

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed')
  }

  return result.result?.value ?? null
}

const SNAPSHOT_SCRIPT = String.raw`(async () => {
  const canvasHash = (() => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 64
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.textBaseline = 'top'
      ctx.font = '16px Arial'
      ctx.fillStyle = '#f60'
      ctx.fillRect(0, 0, 256, 64)
      ctx.fillStyle = '#069'
      ctx.fillText('PeerMesh canvas probe', 8, 8)
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'
      ctx.fillText('CSP-safe fingerprint smoke', 8, 28)
      return canvas.toDataURL().slice(0, 96)
    } catch (error) {
      return { error: error.message }
    }
  })()

  const webgl = (() => {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
      if (!gl) return null
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      }
    } catch (error) {
      return { error: error.message }
    }
  })()

  const audio = (() => {
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioCtor) return null
      const ctx = new AudioCtor()
      const sampleRate = ctx.sampleRate
      const maxChannelCount = ctx.destination?.maxChannelCount ?? null
      const channelCount = ctx.destination?.channelCount ?? null
      if (typeof ctx.close === 'function') ctx.close().catch(() => {})
      return { sampleRate, maxChannelCount, channelCount }
    } catch (error) {
      return { error: error.message }
    }
  })()

  const connection = navigator.connection
    ? {
        type: navigator.connection.type ?? null,
        effectiveType: navigator.connection.effectiveType ?? null,
        downlink: navigator.connection.downlink ?? null,
        rtt: navigator.connection.rtt ?? null,
        saveData: navigator.connection.saveData ?? null,
      }
    : null

  const uaHighEntropy = navigator.userAgentData
    ? await navigator.userAgentData.getHighEntropyValues([
        'architecture',
        'bitness',
        'formFactors',
        'model',
        'platformVersion',
        'uaFullVersion',
        'fullVersionList',
      ]).catch((error) => ({ error: error.message }))
    : null

  const iframeProbe = (() => {
    try {
      const iframe = document.createElement('iframe')
      iframe.src = 'about:blank'
      iframe.style.display = 'none'
      ;(document.body || document.documentElement).appendChild(iframe)
      const out = {
        userAgent: iframe.contentWindow?.navigator?.userAgent ?? null,
        platform: iframe.contentWindow?.navigator?.platform ?? null,
      }
      iframe.remove()
      return out
    } catch (error) {
      return { error: error.message }
    }
  })()

  const readPath = (source, path) => path.split('.').reduce((value, key) => value?.[key], source)

  const toJsonSafe = (value) => {
    if (value == null) return value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map((item) => toJsonSafe(item)).slice(0, 24)
    if (typeof value === 'object') {
      const out = {}
      for (const [key, nested] of Object.entries(value).slice(0, 32)) {
        out[key] = toJsonSafe(nested)
      }
      return out
    }
    return String(value)
  }

  const pickFields = (source, fields) => {
    if (!source || typeof source !== 'object') return null
    const out = {}
    for (const [key, path] of Object.entries(fields)) {
      out[key] = toJsonSafe(readPath(source, path))
    }
    return out
  }

  const creep = (() => {
    const fingerprintSource = window.Fingerprint
      || window.Creep?.fingerprint
      || window.Creep?.fp
      || window.Creep
      || null

    if (!fingerprintSource || typeof fingerprintSource !== 'object') return null

    return {
      workerScope: pickFields(fingerprintSource, {
        locale: 'workerScope.locale',
        localeEntropyIsTrusty: 'workerScope.localeEntropyIsTrusty',
        localeIntlEntropyIsTrusty: 'workerScope.localeIntlEntropyIsTrusty',
        timezoneLocation: 'workerScope.timezoneLocation',
        language: 'workerScope.language',
        languages: 'workerScope.languages',
        platform: 'workerScope.platform',
        userAgent: 'workerScope.userAgent',
        deviceMemory: 'workerScope.deviceMemory',
        hardwareConcurrency: 'workerScope.hardwareConcurrency',
        webglVendor: 'workerScope.webglVendor',
        webglRenderer: 'workerScope.webglRenderer',
        lied: 'workerScope.lied',
        lies: 'workerScope.lies',
        userAgentData: 'workerScope.userAgentData',
      }),
      navigator: pickFields(fingerprintSource, {
        platform: 'navigator.platform',
        userAgent: 'navigator.userAgent',
        language: 'navigator.language',
        deviceMemory: 'navigator.deviceMemory',
        hardwareConcurrency: 'navigator.hardwareConcurrency',
        maxTouchPoints: 'navigator.maxTouchPoints',
        lied: 'navigator.lied',
        userAgentData: 'navigator.userAgentData',
      }),
    }
  })()

  const workerMatrix = (() => {
    if (!/creepjs\/tests\/workers\.html/i.test(location.href)) return null

    const root = document.querySelector('#fingerprint-data')
    if (!root) return null

    const sections = {}
    for (const section of Array.from(root.querySelectorAll('.flex-grid.relative > div'))) {
      const label = section.querySelector('strong')?.textContent?.trim()?.toLowerCase()
      if (!label) continue

      const values = {
        hash: section.querySelector('.hash')?.textContent?.trim() || null,
      }
      const rows = Array.from((section.querySelector('.worker') || section).children)
        .filter((node) => node.tagName === 'DIV')

      for (const row of rows) {
        const text = row.textContent?.replace(/\s+/g, ' ').trim()
        const match = /^([^:]+):\s*(.*)$/.exec(text || '')
        if (!match) continue
        const key = match[1].trim().toLowerCase().replace(/[^\w]+/g, '_')
        values[key] = match[2].trim()
      }

      sections[label] = values
    }

    return Object.keys(sections).length > 0 ? sections : null
  })()

  return {
    href: location.href,
    title: document.title,
    extensionFlag: document.documentElement?.getAttribute('data-peermesh-extension') || null,
    extVersion: document.documentElement?.getAttribute('data-ext-version') || null,
    ua: navigator.userAgent,
    lang: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: new Intl.NumberFormat().resolvedOptions().locale,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportHeight: window.visualViewport?.height ?? null,
      visualViewportWidth: window.visualViewport?.width ?? null,
    },
    uaData: navigator.userAgentData
      ? {
          mobile: navigator.userAgentData.mobile,
          platform: navigator.userAgentData.platform,
          brands: navigator.userAgentData.brands,
        }
      : null,
    uaHighEntropy,
    connection,
    pluginsLength: navigator.plugins?.length ?? null,
    mimeTypesLength: navigator.mimeTypes?.length ?? null,
    perf: {
      nowInteger: Number.isInteger(performance.now()),
    },
    media: {
      darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
      finePointer: matchMedia('(pointer: fine)').matches,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
    },
    batteryApi: typeof navigator.getBattery === 'function',
    serviceWorkerApi: typeof navigator.serviceWorker?.register === 'function',
    canvas: {
      hash: canvasHash,
    },
    webgl,
    audio,
    speechVoices: window.speechSynthesis?.getVoices?.().length ?? null,
    creep,
    workerMatrix,
    iframeProbe,
    turnstileFrames: document.querySelectorAll('iframe[src*="cloudflare"], iframe[src*="turnstile"]').length,
    pageText: document.body?.innerText?.slice(0, 800) || '',
  }
})()`

function flatten(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object)
}

function collectIssueMessages(report) {
  const messages = [
    ...(report.console || []),
    ...(report.logs || []),
    ...(report.exceptions || []),
  ].map((entry) => entry.text || entry.message || entry)

  return messages.filter((message) => {
    const text = String(message)
    if (/^diff check at https:\/\/www\.diffchecker\.com\/diff/i.test(text)) return false
    return /content security policy|worker-src|importscripts|turnstile|cloudflare|blob:|failed to execute|403|networkerror/i.test(text)
  })
}

async function runScenario({ name, browserPath, sites, loadExtension, extensionDir }) {
  const userDataDir = mkdtempSync(join(tmpdir(), `peermesh-${name}-`))
  const port = makePort(loadExtension ? 100 : 0)
  const browser = launchBrowser({ browserPath, port, userDataDir, extensionDir, loadExtension })
  let browserClosed = false

  const closeBrowser = () => {
    if (browserClosed) return
    browserClosed = true
    browser.kill()
  }

  try {
    const versionInfo = await waitForDebugger(port)
    const client = new CdpClient(versionInfo.webSocketDebuggerUrl)
    await client.connect()
    const { targetId, sessionId } = await createPage(client)

    if (loadExtension) {
      const extensionId = await findExtensionId(client)
      if (extensionId) {
        await primeExtensionStorage(client, extensionId, buildAuditSession(spoofCountry, spoofUserId))
        await sleep(750)
      } else {
        await installProfilePublisher(client, sessionId, buildAuditProfile(spoofCountry, spoofUserId))
      }
    }

    const consoleEvents = []
    const logEntries = []
    const exceptions = []
    let currentPage = null

    client.on('Runtime.consoleAPICalled', (params) => {
      if (!currentPage) return
      consoleEvents.push({
        page: currentPage,
        level: params.type,
        text: (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ').trim(),
      })
    }, sessionId)

    client.on('Log.entryAdded', (params) => {
      if (!currentPage) return
      logEntries.push({
        page: currentPage,
        level: params.entry?.level,
        text: params.entry?.text || '',
      })
    }, sessionId)

    client.on('Runtime.exceptionThrown', (params) => {
      if (!currentPage) return
      exceptions.push({
        page: currentPage,
        text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Runtime exception',
      })
    }, sessionId)

    const results = []
    for (const site of sites) {
      currentPage = site.name
      const beforeConsole = consoleEvents.length
      const beforeLogs = logEntries.length
      const beforeExceptions = exceptions.length
      const loadPromise = client.waitFor('Page.loadEventFired', sessionId, 45_000).catch(() => null)
      await client.send('Page.navigate', { url: site.url }, sessionId)
      await loadPromise
      await sleep(7_000)
      const snapshot = await evaluateJson(client, sessionId, SNAPSHOT_SCRIPT).catch((error) => ({
        error: error.message,
      }))

      await sleep(1_500)

      results.push({
        name: site.name,
        url: site.url,
        snapshot,
        console: consoleEvents.slice(beforeConsole),
        logs: logEntries.slice(beforeLogs),
        exceptions: exceptions.slice(beforeExceptions),
      })
    }

    await client.send('Target.closeTarget', { targetId })
    await client.close()
    closeBrowser()
    await shutdownBrowser(browser)
    cleanupUserDataDir(userDataDir)
    return { name, browserPath, headless, spoofCountry: loadExtension ? spoofCountry : null, results }
  } catch (error) {
    closeBrowser()
    await shutdownBrowser(browser)
    cleanupUserDataDir(userDataDir)
    throw error
  }
}

function summarizeSite(controlSite, extensionSite) {
  const controlSnapshot = controlSite?.snapshot || {}
  const extensionSnapshot = extensionSite?.snapshot || {}
  const diffs = KEY_DIFFS
    .map((path) => ({
      path,
      control: flatten(controlSnapshot, path),
      extension: flatten(extensionSnapshot, path),
    }))
    .filter((item) => JSON.stringify(item.control) !== JSON.stringify(item.extension))

  return {
    name: controlSite?.name || extensionSite?.name,
    url: controlSite?.url || extensionSite?.url,
    controlIssues: collectIssueMessages(controlSite || {}),
    extensionIssues: collectIssueMessages(extensionSite || {}),
    diffs,
  }
}

function printScenario(label, scenario) {
  console.log(`\n${label}`)
  console.log(`  Browser : ${scenario.browserPath}`)
  console.log(`  Headless: ${scenario.headless}`)
  if (scenario.spoofCountry) console.log(`  Country : ${scenario.spoofCountry}`)
  for (const result of scenario.results) {
    const issues = collectIssueMessages(result)
    console.log(`  - ${result.name}`)
    console.log(`    URL       : ${result.url}`)
    console.log(`    Extension : ${result.snapshot?.extensionFlag || '0'}${result.snapshot?.extVersion ? ` v${result.snapshot.extVersion}` : ''}`)
    console.log(`    Timezone  : ${result.snapshot?.timezone || 'n/a'}`)
    console.log(`    UA        : ${(result.snapshot?.ua || 'n/a').slice(0, 110)}`)
    console.log(`    WebGL     : ${result.snapshot?.webgl?.vendor || 'n/a'} | ${result.snapshot?.webgl?.renderer || 'n/a'}`)
    console.log(`    Issues    : ${issues.length}`)
    for (const message of issues.slice(0, 4)) {
      console.log(`      ${message}`)
    }
  }
}

function printComparison(control, extension) {
  const controlMap = new Map(control.results.map((result) => [result.name, result]))
  const extensionMap = new Map(extension.results.map((result) => [result.name, result]))

  console.log('\ncomparison')
  for (const name of new Set([...controlMap.keys(), ...extensionMap.keys()])) {
    const summary = summarizeSite(controlMap.get(name), extensionMap.get(name))
    console.log(`  - ${summary.name}`)
    console.log(`    URL             : ${summary.url}`)
    console.log(`    Control issues  : ${summary.controlIssues.length}`)
    console.log(`    Extension issues: ${summary.extensionIssues.length}`)
    if (summary.diffs.length === 0) {
      console.log('    Signal diffs    : none')
      continue
    }
    for (const diff of summary.diffs.slice(0, 8)) {
      console.log(`    ${diff.path}: ${JSON.stringify(diff.control)} -> ${JSON.stringify(diff.extension)}`)
    }
  }
}

async function main() {
  const browserPath = findBrowserPath()
  const sites = pickSites()
  const extensionDir = resolve(process.cwd(), 'extension')
  const runs = []

  if (!extensionOnly) {
    console.log('running control scenario...')
    runs.push(await runScenario({
      name: 'control',
      browserPath,
      sites,
      loadExtension: false,
      extensionDir,
    }))
  }

  if (!controlOnly) {
    console.log('running extension scenario...')
    runs.push(await runScenario({
      name: 'extension',
      browserPath,
      sites,
      loadExtension: true,
      extensionDir,
    }))
  }

  for (const run of runs) {
    printScenario(run.name, run)
  }

  if (runs.length === 2) {
    printComparison(runs[0], runs[1])
  }

  mkdirSync(resolve(process.cwd(), 'done'), { recursive: true })
  const outPath = resolve(process.cwd(), 'done', `fingerprint-audit-${Date.now()}.json`)
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    headless,
    browserPath,
    sites,
    runs,
  }, null, 2))
  console.log(`\nreport saved to ${outPath}`)
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exit(1)
})
