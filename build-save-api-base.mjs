#!/usr/bin/env node
/**
 * build-save-api-base.mjs
 *
 * Updates every hardcoded API_BASE / APP_URL reference across the codebase
 * to a new value, then prints all environment variables that must be updated
 * in deployed services (Render, Fly.io, etc.).
 *
 * Usage:
 *   node build-save-api-base.mjs <url>
 *   node build-save-api-base.mjs https://peermesh.onrender.com
 *   node build-save-api-base.mjs https://peermesh.com
 *   node build-save-api-base.mjs --dry-run https://peermesh.onrender.com
 */

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const newBase = args.find(a => a.startsWith('http'))

if (!newBase) {
  console.error('\n  ✗ No URL provided.')
  console.error('  Usage: node build-save-api-base.mjs <url>')
  console.error('  Example: node build-save-api-base.mjs https://peermesh.onrender.com\n')
  process.exit(1)
}

// Strip trailing slash
const base = newBase.replace(/\/$/, '')

// Validate it looks like a real URL
try {
  const parsed = new URL(base)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol')
} catch {
  console.error(`\n  ✗ Invalid URL: ${base}\n`)
  process.exit(1)
}

// ── Colours ───────────────────────────────────────────────────────────────────

const G = '\x1b[32m'   // green
const C = '\x1b[36m'   // cyan
const Y = '\x1b[33m'   // yellow
const D = '\x1b[90m'   // dim
const B = '\x1b[1m'    // bold
const R = '\x1b[0m'    // reset

// ── File patch helpers ────────────────────────────────────────────────────────

function read(rel) {
  return readFileSync(join(__dirname, rel), 'utf-8')
}

function write(rel, content) {
  if (!dryRun) writeFileSync(join(__dirname, rel), content)
}

/**
 * Replace the first occurrence of oldUrl with base in the file at rel.
 * Returns { changed: boolean, preview: string }
 */
function patch(rel, oldUrl, description) {
  const src = read(rel)
  if (!src.includes(oldUrl)) {
    console.log(`  ${D}skip${R}  ${rel} ${D}(${oldUrl} not found)${R}`)
    return false
  }
  const next = src.replaceAll(oldUrl, base)
  write(rel, next)
  const tag = dryRun ? `${Y}dry ${R}` : `${G}  ✓  ${R}`
  console.log(`  ${tag} ${rel}  ${D}${description}${R}`)
  return true
}

// ── Detect current hardcoded base ─────────────────────────────────────────────

// Read the current value from the most reliable source
let currentBase = null
try {
  const desktopMain = read('desktop/main.js')
  const match = desktopMain.match(/const API_BASE\s*=\s*'(https?:\/\/[^']+)'/)
  if (match) currentBase = match[1].replace(/\/$/, '')
} catch {}

if (!currentBase) {
  try {
    const extSw = read('extension/background/service-worker.js')
    const match = extSw.match(/const APP_URL\s*=\s*'(https?:\/\/[^']+)'/)
    if (match) currentBase = match[1].replace(/\/$/, '')
  } catch {}
}

if (!currentBase) {
  console.error('\n  ✗ Could not detect current API_BASE from source files.')
  console.error('  Make sure desktop/main.js or extension/background/service-worker.js exists.\n')
  process.exit(1)
}

if (currentBase === base) {
  console.log(`\n  ${Y}Nothing to do — API_BASE is already ${base}${R}\n`)
  process.exit(0)
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${B}  PeerMesh API Base Migration${R}`)
console.log(`  ${D}from${R}  ${C}${currentBase}${R}`)
console.log(`  ${D}to${R}    ${G}${base}${R}`)
if (dryRun) console.log(`  ${Y}dry-run — no files will be written${R}`)
console.log()

// ── Source file patches ───────────────────────────────────────────────────────

console.log(`${B}  Source files${R}`)

patch('desktop/main.js',
  currentBase,
  'const API_BASE')

patch('desktop/preload.js',
  currentBase,
  'appBaseUrl')

patch('cli/index.js',
  currentBase,
  'const API_BASE')

patch('extension/popup/popup.js',
  currentBase,
  'const API')

patch('extension/background/service-worker.js',
  currentBase,
  'const APP_URL')

patch('lib/relay-config-client.ts',
  currentBase,
  'const API_BASE')

patch('provider-agent/install-windows.bat',
  currentBase,
  'AGENT_URL')

patch('provider-agent/install-mac.sh',
  currentBase,
  'AGENT_URL')

patch('app/developers/page.tsx',
  currentBase,
  'const BASE')

patch('app/developers/api-docs/page.tsx',
  currentBase,
  'const BASE')

patch('app/api/extension-auth/route.ts',
  currentBase,
  'APP_URL fallback')

patch('desktop/renderer/app.js',
  currentBase,
  'appBaseUrl fallback')

patch('tests/cli-behavior.test.mjs',
  currentBase,
  'apiBase test constant')

patch('public/demo/developer-docs-screenshot.svg',
  currentBase,
  'demo SVG curl example')

// ── Fly.toml (relay env) ──────────────────────────────────────────────────────

console.log()
console.log(`${B}  relay/fly.toml${R}`)
patch('relay/fly.toml',
  currentBase,
  'API_BASE env var')

// ── Done with source files ────────────────────────────────────────────────────

console.log()
console.log(`${B}  Environment variables to update in deployed services${R}`)
console.log()

// Render (Next.js app)
console.log(`  ${C}Render${R} — Web Service environment variables`)
console.log(`  ${D}┌─────────────────────────────────────────────────────────────┐${R}`)
console.log(`  ${D}│${R}  ${B}API_BASE${R}                 ${G}${base}${R}`)
console.log(`  ${D}│${R}  ${B}NEXT_PUBLIC_APP_URL${R}      ${G}${base}${R}`)
console.log(`  ${D}└─────────────────────────────────────────────────────────────┘${R}`)
console.log()

// Fly.io (relay)
console.log(`  ${C}Fly.io${R} — relay environment variables`)
console.log(`  ${D}┌─────────────────────────────────────────────────────────────┐${R}`)
console.log(`  ${D}│${R}  ${B}API_BASE${R}                 ${G}${base}${R}`)
console.log(`  ${D}└─────────────────────────────────────────────────────────────┘${R}`)
console.log(`  ${D}Update with:${R} fly secrets set API_BASE=${base} -a <your-relay-app>`)
console.log()

// .env.local
console.log(`  ${C}.env.local${R} — local development`)
console.log(`  ${D}┌─────────────────────────────────────────────────────────────┐${R}`)
console.log(`  ${D}│${R}  ${B}API_BASE${R}=${G}${base}${R}`)
console.log(`  ${D}└─────────────────────────────────────────────────────────────┘${R}`)
console.log()

// ── Next steps ────────────────────────────────────────────────────────────────

console.log(`${B}  Next steps${R}`)
if (dryRun) {
  console.log(`  1. Rerun without --dry-run to apply changes`)
  console.log(`  2. Rebuild extension:  node build-save-extension.mjs`)
  console.log(`  3. Rebuild desktop:    node build-save-desktop.mjs`)
  console.log(`  4. Rebuild CLI:        node build-save-cli.mjs`)
  console.log(`  5. Update env vars in Render and Fly.io (see above)`)
  console.log(`  6. Deploy relay:       fly deploy -a <your-relay-app>`)
} else {
  console.log(`  1. Rebuild extension:  node build-save-extension.mjs`)
  console.log(`  2. Rebuild desktop:    node build-save-desktop.mjs`)
  console.log(`  3. Rebuild CLI:        node build-save-cli.mjs`)
  console.log(`  4. Update env vars in Render and Fly.io (see above)`)
  console.log(`  5. Deploy relay:       fly deploy -a <your-relay-app>`)
  console.log(`  6. Commit all changes and push to trigger Render deploy`)
}
console.log()
