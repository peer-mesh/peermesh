#!/usr/bin/env node

const { existsSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

const configDir = join(homedir(), '.peermesh')
const debugLog = join(homedir(), 'Desktop', 'peermesh-debug.log')

console.log('')
console.log('  Uninstalling PeerMesh Provider...')
console.log('')

if (existsSync(join(configDir, 'config.json'))) {
  console.log('  Note: Your credentials and config are saved in:')
  console.log(`    ${configDir}`)
  console.log('  To remove them completely:')
  console.log('    Windows:  rmdir /s /q %USERPROFILE%\\.peermesh')
  console.log('    macOS/Linux: rm -rf ~/.peermesh')
  console.log('')
}

if (existsSync(debugLog)) {
  console.log('  Debug log is at:')
  console.log(`    ${debugLog}`)
  console.log('')
}

console.log('  Thank you for using PeerMesh!')
console.log('')
