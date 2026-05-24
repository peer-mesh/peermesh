#!/usr/bin/env node
/**
 * build-save-desktop.mjs
 * Usage:
 *   node build-save-desktop.mjs           — build current platform, patch bump
 *   node build-save-desktop.mjs win       — Windows only
 *   node build-save-desktop.mjs mac       — macOS only
 *   node build-save-desktop.mjs linux     — Linux only
 *   node build-save-desktop.mjs minor     — minor version bump
 *   node build-save-desktop.mjs major     — major version bump
 *   node build-save-desktop.mjs --no-bump — build without version change
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import './lib/env.mjs' // loads .env.local — no values needed for desktop build

const __dirname  = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(__dirname, 'desktop')
const PUBLIC_DIR  = join(__dirname, 'public')
const PKG_PATH    = join(DESKTOP_DIR, 'package.json')

const args     = process.argv.slice(2)
const bumpType = args.find(a => ['major', 'minor', 'patch'].includes(a)) ?? 'patch'
const noBump   = args.includes('--no-bump')

const PLATFORM_ARGS = ['win', 'mac', 'linux']
const requestedPlatforms = args.filter(a => PLATFORM_ARGS.includes(a))
const defaultPlatform = process.platform === 'darwin' ? 'mac'
  : process.platform === 'linux' ? 'linux' : 'win'
const platforms = requestedPlatforms.length > 0 ? requestedPlatforms : [defaultPlatform]

const distDir = join(DESKTOP_DIR, 'dist')
try { rmSync(distDir, { recursive: true, force: true }); console.log('\n  ✓ Cleared desktop/dist cache') } catch {}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
const currentVersion = pkg.version
const [major, minor, patch] = currentVersion.split('.').map(Number)

let newVersion = currentVersion
if (!noBump) {
  if (bumpType === 'major')      newVersion = `${major + 1}.0.0`
  else if (bumpType === 'minor') newVersion = `${major}.${minor + 1}.0`
  else                           newVersion = `${major}.${minor}.${patch + 1}`
  pkg.version = newVersion
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2))
  console.log(`\n  Version: ${currentVersion} → ${newVersion}`)
} else {
  console.log(`\n  Version: ${currentVersion} (no bump)`)
}

const PLATFORM_CONFIG = {
  win:   { script: 'build-win',   find: f => f.startsWith('PeerMesh-Setup-') && f.endsWith('.exe') && !f.endsWith('.blockmap'), dest: `PeerMesh-Setup_${newVersion}.exe` },
  mac:   { script: 'build-mac',   find: f => f.endsWith('.dmg'),      dest: `PeerMesh-Setup_${newVersion}.dmg` },
  linux: { script: 'build-linux', find: f => f.endsWith('.AppImage'), dest: `PeerMesh-Setup_${newVersion}.AppImage` },
}

for (const platform of platforms) {
  const { script, find, dest } = PLATFORM_CONFIG[platform]
  console.log(`\n  Building ${platform} (v${newVersion})...`)
  try {
    console.log('  Installing desktop dependencies...')
    execSync('npm install', { cwd: DESKTOP_DIR, stdio: 'inherit' })
    execSync(`npm run ${script}`, { cwd: DESKTOP_DIR, stdio: 'inherit' })
  } catch {
    console.error(`\n  Build failed for ${platform}!`)
    process.exit(1)
  }
  const artifact = readdirSync(distDir).find(find)
  if (!artifact) { console.error(`\n  ERROR: No ${platform} artifact found in desktop/dist/`); process.exit(1) }
  copyFileSync(join(distDir, artifact), join(PUBLIC_DIR, dest))
  console.log(`  ✓ ${artifact} → public/${dest}`)
}

console.log(`\n  ✓ Version: ${newVersion}`)
console.log(`  Deploy with: npx vercel --prod\n`)
