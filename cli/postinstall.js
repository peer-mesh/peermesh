#!/usr/bin/env node

const { join } = require('path')
const { homedir } = require('os')

const debugLog = join(homedir(), 'Desktop', 'peermesh-debug.log')
const configDir = join(homedir(), '.peermesh')

console.log('')
console.log('  \u2713 PeerMesh Provider installed successfully!')
console.log('')
console.log('  Get started:')
console.log('    peermesh-provider              Start sharing')
console.log('    peermesh-provider --docs       View full documentation')
console.log('    peermesh-provider --status     Check current status')
console.log('')
console.log('  Developer info:')
console.log(`    Debug log:   ${debugLog}`)
console.log(`    Config dir:  ${configDir}`)
console.log('    Flags:       peermesh-provider --debug  (verbose logs to console)')
console.log('')
console.log('  Share your connection. Stay free.')
console.log('')
