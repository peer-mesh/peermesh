// persona-data.js — device persona pools
// Each persona type has multiple variants; one is picked deterministically from the seed

const PERSONA_POOLS = {

  // ── Mobile Android ────────────────────────────────────────────────────────
  mobile: [
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 412, h: 915, aw: 412, ah: 915, iw: 412, ih: 834 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 15, rtt: 65, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 360, h: 780, aw: 360, ah: 780, iw: 360, ih: 700 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 12, rtt: 75, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 393, h: 851, aw: 393, ah: 851, iw: 393, ih: 770 },
      hardwareConcurrency: 6, deviceMemory: 4, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 8, rtt: 90, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 11; TECNO KF6i) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 360, h: 800, aw: 360, ah: 800, iw: 360, ih: 720 },
      hardwareConcurrency: 4, deviceMemory: 2, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 5, rtt: 110, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 10; itel A56) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 320, h: 693, aw: 320, ah: 693, iw: 320, ih: 612 },
      hardwareConcurrency: 4, deviceMemory: 2, maxTouchPoints: 5,
      connection: { effectiveType: '3g', downlink: 3, rtt: 150, saveData: true },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Infinix X6816D) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 390, h: 844, aw: 390, ah: 844, iw: 390, ih: 763 },
      hardwareConcurrency: 6, deviceMemory: 4, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 7, rtt: 95, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
  ],

  // ── Windows Desktop ───────────────────────────────────────────────────────
  desktop: [
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, iw: 1920, ih: 947 },
      hardwareConcurrency: 16, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 30, rtt: 20, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 2560, h: 1440, aw: 2560, ah: 1400, iw: 2560, ih: 1307 },
      hardwareConcurrency: 12, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 50, rtt: 15, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, iw: 1920, ih: 947 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 25, rtt: 25, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1366, h: 768, aw: 1366, ah: 728, iw: 1366, ih: 657 },
      hardwareConcurrency: 4, deviceMemory: 4, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 20, rtt: 35, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1440, h: 900, aw: 1440, ah: 860, iw: 1440, ih: 769 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 20, rtt: 30, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1280, h: 720, aw: 1280, ah: 680, iw: 1280, ih: 591 },
      hardwareConcurrency: 4, deviceMemory: 4, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 15, rtt: 40, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
  ],

  // ── macOS ─────────────────────────────────────────────────────────────────
  mac: [
    {
      mobile: false, platform: 'MacIntel', platformLabel: 'macOS',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1440, h: 900, aw: 1440, ah: 875, iw: 1440, ih: 789 },
      hardwareConcurrency: 10, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 40, rtt: 15, saveData: false },
      sampleRate: 48000, colorDepth: 30,
    },
    {
      mobile: false, platform: 'MacIntel', platformLabel: 'macOS',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 2560, h: 1600, aw: 2560, ah: 1577, iw: 2560, ih: 1491 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 50, rtt: 10, saveData: false },
      sampleRate: 48000, colorDepth: 30,
    },
    {
      mobile: false, platform: 'MacIntel', platformLabel: 'macOS',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1920, h: 1200, aw: 1920, ah: 1177, iw: 1920, ih: 1091 },
      hardwareConcurrency: 12, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 35, rtt: 12, saveData: false },
      sampleRate: 48000, colorDepth: 30,
    },
    {
      mobile: false, platform: 'MacIntel', platformLabel: 'macOS',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1280, h: 800, aw: 1280, ah: 777, iw: 1280, ih: 691 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 30, rtt: 18, saveData: false },
      sampleRate: 48000, colorDepth: 30,
    },
  ],

  // ── Linux Desktop ─────────────────────────────────────────────────────────
  linux: [
    {
      mobile: false, platform: 'Linux x86_64', platformLabel: 'Linux',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1920, h: 1080, aw: 1920, ah: 1053, iw: 1920, ih: 966 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 20, rtt: 30, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Linux x86_64', platformLabel: 'Linux',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1366, h: 768, aw: 1366, ah: 741, iw: 1366, ih: 654 },
      hardwareConcurrency: 4, deviceMemory: 4, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 15, rtt: 40, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Linux x86_64', platformLabel: 'Linux',
      userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1440, h: 900, aw: 1440, ah: 873, iw: 1440, ih: 786 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 18, rtt: 35, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
  ],

  // ── Mixed (mid-range markets) ─────────────────────────────────────────────
  mixed: [
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1366, h: 768, aw: 1366, ah: 728, iw: 1366, ih: 657 },
      hardwareConcurrency: 4, deviceMemory: 4, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 12, rtt: 60, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 360, h: 800, aw: 360, ah: 800, iw: 360, ih: 720 },
      hardwareConcurrency: 8, deviceMemory: 6, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 10, rtt: 70, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1920, h: 1080, aw: 1920, ah: 1040, iw: 1920, ih: 947 },
      hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 20, rtt: 45, saveData: false },
      sampleRate: 48000, colorDepth: 24,
    },
    {
      mobile: true, platform: 'Linux armv8l', platformLabel: 'Android',
      userAgent: 'Mozilla/5.0 (Linux; Android 12; POCO X4 Pro 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Mobile Safari/537.36',
      uaVersion: '148', screen: { w: 393, h: 873, aw: 393, ah: 873, iw: 393, ih: 792 },
      hardwareConcurrency: 8, deviceMemory: 6, maxTouchPoints: 5,
      connection: { effectiveType: '4g', downlink: 9, rtt: 80, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
    {
      mobile: false, platform: 'Win32', platformLabel: 'Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
      uaVersion: '148', screen: { w: 1280, h: 1024, aw: 1280, ah: 984, iw: 1280, ih: 897 },
      hardwareConcurrency: 4, deviceMemory: 4, maxTouchPoints: 0,
      connection: { effectiveType: '4g', downlink: 10, rtt: 55, saveData: false },
      sampleRate: 44100, colorDepth: 24,
    },
  ],
}

globalThis.__PEERMESH_PERSONA_POOLS__ = PERSONA_POOLS
