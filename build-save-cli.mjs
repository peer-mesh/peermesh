#!/usr/bin/env node
/**
 * build-save-cli.mjs
 * Usage:
 *   node build-save-cli.mjs               - patch bump + publish
 *   node build-save-cli.mjs minor         - minor bump + publish
 *   node build-save-cli.mjs major         - major bump + publish
 *   node build-save-cli.mjs --no-bump     - publish without version change
 *   node build-save-cli.mjs --dry-run     - preview next version, do not write or publish
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import './lib/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_DIR = join(__dirname, 'cli')
const PKG_PATH = join(CLI_DIR, 'package.json')
const IDX_PATH = join(CLI_DIR, 'index.js')
const CLI_NPMRC_PATH = join(CLI_DIR, '.npmrc')

const args = process.argv.slice(2)
const bumpType = args.find(a => ['major', 'minor', 'patch'].includes(a)) ?? 'patch'
const noBump = args.includes('--no-bump')
const dryRun = args.includes('--dry-run')
const usesOtpArg = args.some(a => a === '--otp' || a.startsWith('--otp='))

if (usesOtpArg) {
  console.error('\n  x --otp is no longer supported by this script.')
  console.error('  Put an npm automation token in cli/.npmrc, then rerun without --otp.\n')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'))
const currentVersion = pkg.version
const [major, minor, patch] = currentVersion.split('.').map(Number)

function run(command, options = {}) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: {
      ...process.env,
      ...(existsSync(CLI_NPMRC_PATH) ? { NPM_CONFIG_USERCONFIG: CLI_NPMRC_PATH } : {}),
    },
    ...options,
  })
}

function assertNpmPublishReady(packageName) {
  if (existsSync(CLI_NPMRC_PATH)) {
    console.log('\n  npm auth: using cli/.npmrc via NPM_CONFIG_USERCONFIG')
  }

  let npmUser = ''
  try {
    npmUser = run('npm whoami --registry=https://registry.npmjs.org/', { cwd: CLI_DIR }).trim()
  } catch {
    console.error('\n  x npm is not authenticated for publishing.')
    console.error('  Run: npm login')
    console.error('  Then rerun: node build-save-cli.mjs --no-bump  (publish the current local version)')
    console.error('  Or rerun:   node build-save-cli.mjs            (bump once more, then publish)')
    console.error('\n  No version files were changed.\n')
    process.exit(1)
  }

  try {
    run(`npm view ${packageName} name --registry=https://registry.npmjs.org/`, { cwd: CLI_DIR })
  } catch {
    console.error(`\n  x npm package ${packageName} is not visible from npm user ${npmUser}.`)
    console.error('  Check that the package name/scope is correct and this npm user has publish access.')
    console.error('  For a first scoped publish, the npm account must own the scope and the package must be public.')
    console.error('\n  No version files were changed.\n')
    process.exit(1)
  }

  console.log(`\n  npm user: ${npmUser}`)
}

let newVersion = currentVersion
if (!noBump) {
  if (bumpType === 'major') newVersion = `${major + 1}.0.0`
  else if (bumpType === 'minor') newVersion = `${major}.${minor + 1}.0`
  else newVersion = `${major}.${minor}.${patch + 1}`
}

if (dryRun) {
  console.log(`\n  Version: ${currentVersion}${noBump ? ' (no bump)' : ` -> ${newVersion}`}`)
  console.log('  OK Dry run - no files changed and publish skipped')
  console.log(`  Run without --dry-run to publish v${newVersion} to npm\n`)
  process.exit(0)
}

assertNpmPublishReady(pkg.name)

if (!noBump) {
  pkg.version = newVersion
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n')

  let src = readFileSync(IDX_PATH, 'utf-8')
  src = src.replace(/^const VERSION\s*=\s*'[^']+'/m, `const VERSION     = '${newVersion}'`)
  writeFileSync(IDX_PATH, src)

  console.log(`\n  Version: ${currentVersion} -> ${newVersion}`)
} else {
  console.log(`\n  Version: ${currentVersion} (no bump)`)
}

console.log(`\n  Publishing peermesh-provider@${newVersion} to npm...`)
try {
  run('npm publish --access public --registry=https://registry.npmjs.org/', { cwd: CLI_DIR, stdio: 'inherit' })
} catch {
  console.error('\n  x npm publish failed after the version files were updated.')
  console.error('  Check cli/.npmrc contains an npm automation token with publish access.')
  console.error('  If the version already exists on npm, rerun without --no-bump to publish a new patch version.\n')
  process.exit(1)
}

console.log(`\n  OK peermesh-provider@${newVersion} published`)
console.log('  https://www.npmjs.com/package/@btcmaster1000/peermesh-provider\n')
