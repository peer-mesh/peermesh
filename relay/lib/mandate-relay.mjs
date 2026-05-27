import {
  createHmac,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'crypto'

export const MANDATE_VERSION = 1
export const BYTE_TOKEN_GRANULARITY = 10 * 1024 * 1024
export const RECEIPT_PERIOD_MS = 10_000
export const MANDATE_TTL_MS = 24 * 60 * 60_000
export const DIRECT_HANDSHAKE_CONTEXT = 'peermesh/direct-handshake/v1'
export const RELAY_ANCHOR_CONTEXT = 'peermesh/relay-anchor/v1'
export const RELAY_ANCHOR_INTERVAL_MS = 1_000

export const DEFAULT_MANDATE_POLICY = Object.freeze({
  allowedPorts: [80, 443, 8080, 8443],
  blockedPatterns: ['onion', 'smtp', 'imap', 'pop3', 'torrent'],
  maxBytesPerMinute: 250 * 1024 * 1024,
  maxTunnelsPerMinute: 200,
  privateIPBlocked: true,
})

let ephemeralRelayKeyPair = null

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function fromBase64url(value) {
  return Buffer.from(String(value), 'base64url')
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()

  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256HmacHex(secret, value) {
  return createHmac('sha256', String(secret)).update(String(value)).digest('hex')
}

function importPrivateKey(value) {
  if (!value) return null
  const raw = String(value).replace(/\\n/g, '\n').trim()
  if (raw.includes('BEGIN')) return createPrivateKey(raw)
  return createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' })
}

function importPublicKey(value) {
  if (!value) return null
  const raw = String(value).replace(/\\n/g, '\n').trim()
  if (raw.includes('BEGIN')) return createPublicKey(raw)
  return createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' })
}

export function exportPublicKeyPem(keyObject) {
  return keyObject.export({ format: 'pem', type: 'spki' }).toString()
}

export function exportPrivateKeyPem(keyObject) {
  return keyObject.export({ format: 'pem', type: 'pkcs8' }).toString()
}

export function generateRelaySigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKey,
    privateKeyPem: exportPrivateKeyPem(privateKey),
    publicKeyPem: exportPublicKeyPem(publicKey),
  }
}

export function getRelaySigningMaterial(env = process.env) {
  const privateKey = importPrivateKey(
    env.RELAY_ED25519_PRIVATE_KEY ??
    env.RELAY_MANDATE_PRIVATE_KEY ??
    env.MANDATE_PRIVATE_KEY ??
    '',
  )

  if (privateKey) {
    const publicKey = importPublicKey(
      env.RELAY_ED25519_PUBLIC_KEY ??
      env.RELAY_MANDATE_PUBLIC_KEY ??
      env.MANDATE_PUBLIC_KEY ??
      '',
    ) ?? createPublicKey(privateKey)

    return {
      privateKey,
      publicKey,
      publicKeyPem: exportPublicKeyPem(publicKey),
      keyId: env.RELAY_MANDATE_KEY_ID ?? 'relay-ed25519',
      ephemeral: false,
    }
  }

  if (!ephemeralRelayKeyPair) {
    const generated = generateRelaySigningKeyPair()
    ephemeralRelayKeyPair = {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
      publicKeyPem: generated.publicKeyPem,
      keyId: 'relay-ed25519-ephemeral',
      ephemeral: true,
    }
  }

  return ephemeralRelayKeyPair
}

export function mandateSigningPayload(mandate) {
  const unsignedMandate = { ...mandate }
  delete unsignedMandate.signature
  return Buffer.from(canonicalJson(unsignedMandate))
}

export function mandateDigest(mandate) {
  return createHash('sha256').update(mandateSigningPayload(mandate)).digest('hex')
}

export function createSessionSigningKey() {
  return base64url(randomBytes(32))
}

export function createSessionNonce() {
  return base64url(randomBytes(32))
}

export function createSignedMandate(input, signingMaterial = getRelaySigningMaterial()) {
  const now = Date.now()
  const mandate = {
    version: MANDATE_VERSION,
    issuedAt: now,
    expiresAt: now + MANDATE_TTL_MS,
    policy: DEFAULT_MANDATE_POLICY,
    hardExpiryOnSignalingLoss: 30,
    binaryHash: null,
    signatureAlg: 'Ed25519',
    keyId: signingMaterial.keyId ?? 'relay-ed25519',
    ...input,
  }

  const signature = sign(null, mandateSigningPayload(mandate), signingMaterial.privateKey)
  return {
    ...mandate,
    signature: base64url(signature),
  }
}

export function verifySignedMandate(mandate, publicKey, options = {}) {
  if (!mandate || typeof mandate !== 'object' || typeof mandate.signature !== 'string') return false
  const key = typeof publicKey === 'string' ? importPublicKey(publicKey) : publicKey
  if (!key) return false
  if (options.rejectExpired !== false && Number(mandate.expiresAt ?? 0) <= Date.now()) return false
  return verify(null, mandateSigningPayload(mandate), key, fromBase64url(mandate.signature))
}

export function encodeMandate(mandate) {
  return base64url(Buffer.from(JSON.stringify(mandate)))
}

export function decodeMandate(encoded) {
  return JSON.parse(fromBase64url(encoded).toString('utf8'))
}

export function createByteToken(sessionSecret, sessionId, tokenIndex, granularity = BYTE_TOKEN_GRANULARITY) {
  const position = tokenIndex * granularity
  return createHmac('sha256', String(sessionSecret))
    .update(`${sessionId}:${position}`)
    .digest('hex')
}

export function createRelayAnchor(relaySecret, sessionId, tick) {
  return createHmac('sha256', String(relaySecret))
    .update(RELAY_ANCHOR_CONTEXT)
    .update(':')
    .update(String(sessionId))
    .update(':')
    .update(String(tick))
    .digest('hex')
}

export function relayAnchorTick(timestampMs = Date.now(), intervalMs = RELAY_ANCHOR_INTERVAL_MS) {
  return Math.floor(Math.max(0, Number(timestampMs) || 0) / intervalMs)
}

export function advanceRelayAnchoredChain(chainValue, chunkSize, relayAnchor, key) {
  return createHmac('sha256', String(key))
    .update(String(chainValue))
    .update(':')
    .update(String(Math.max(0, Number(chunkSize) || 0)))
    .update(':')
    .update(String(relayAnchor))
    .digest('hex')
}

function directHandshakePayload(mandate) {
  return canonicalJson({
    context: DIRECT_HANDSHAKE_CONTEXT,
    sessionId: mandate?.sessionId ?? null,
    directChallenge: mandate?.directChallenge ?? null,
    requesterDeviceId: mandate?.requesterDeviceId ?? null,
    providerDeviceId: mandate?.providerDeviceId ?? null,
    providerDirectEndpoint: mandate?.providerDirectEndpoint ?? null,
    relayFallback: mandate?.relayFallback ?? null,
    mandateDigest: mandateDigest(mandate ?? {}),
  })
}

export function createDirectHandshakeProof(mandate, sessionSigningKey = mandate?.sessionSigningKey) {
  if (!mandate || !sessionSigningKey) return ''
  return createHmac('sha256', String(sessionSigningKey))
    .update(directHandshakePayload(mandate))
    .digest('base64url')
}

export function verifyDirectHandshakeProof(mandate, proof, sessionSigningKey = mandate?.sessionSigningKey) {
  if (!proof) return false
  return safeEqualString(proof, createDirectHandshakeProof(mandate, sessionSigningKey))
}

export function getReachedTokenIndexes(previousBytes, nextBytes, granularity = BYTE_TOKEN_GRANULARITY) {
  const start = Math.floor(Math.max(0, previousBytes) / granularity) + 1
  const end = Math.floor(Math.max(0, nextBytes) / granularity)
  const indexes = []
  for (let index = start; index <= end; index++) indexes.push(index)
  return indexes
}

export function advanceHashChain(chainValue, chunkSize, timestampMs, key) {
  return createHmac('sha256', String(key))
    .update(String(chainValue))
    .update(':')
    .update(String(Math.max(0, Number(chunkSize) || 0)))
    .update(':')
    .update(String(Math.max(0, Number(timestampMs) || 0)))
    .digest('hex')
}

export function createCommitment(chainValue, periodNonce, key) {
  return createHmac('sha256', String(key))
    .update(String(chainValue))
    .update(':')
    .update(String(periodNonce))
    .digest('hex')
}

export function verifyCommitmentReveal(commitment, chainValue, periodNonce, key) {
  const expected = createCommitment(chainValue, periodNonce, key)
  return safeEqualHex(commitment, expected)
}

export function signReceiptWithSplitKey(receiptFields, devicePrivateKey, sessionSigningKey) {
  const receiptPayload = Buffer.from(canonicalJson(receiptFields))
  const deviceKey = typeof devicePrivateKey === 'string' ? importPrivateKey(devicePrivateKey) : devicePrivateKey
  const deviceSig = base64url(sign(null, receiptPayload, deviceKey))
  const sessionSig = createHmac('sha256', String(sessionSigningKey))
    .update(canonicalJson({ receiptFields, deviceSig }))
    .digest('base64url')
  return { device_sig: deviceSig, session_sig: sessionSig }
}

export function verifyReceiptSplitSignatures(receiptFields, signatures, devicePublicKey, sessionSigningKey) {
  if (!signatures?.device_sig || !signatures?.session_sig) return false
  const publicKey = typeof devicePublicKey === 'string' ? importPublicKey(devicePublicKey) : devicePublicKey
  if (!publicKey) return false

  const receiptPayload = Buffer.from(canonicalJson(receiptFields))
  const deviceOk = verify(null, receiptPayload, publicKey, fromBase64url(signatures.device_sig))
  if (!deviceOk) return false

  const expectedSessionSig = createHmac('sha256', String(sessionSigningKey))
    .update(canonicalJson({ receiptFields, deviceSig: signatures.device_sig }))
    .digest('base64url')
  return safeEqualString(signatures.session_sig, expectedSessionSig)
}

export function crossCheckReceipts({
  providerReceipt,
  wrappedProviderReceipt,
  requesterChainValue,
  requesterBytesReceived,
  tokenFloorBytes = 0,
}) {
  const providerCopyIntact = canonicalJson(providerReceipt) === canonicalJson(wrappedProviderReceipt)
  if (!providerCopyIntact) {
    return {
      status: 'RECEIPT_TAMPERED',
      chargeBytes: tokenFloorBytes,
      providerEarningsWithheld: true,
    }
  }

  const chainsMatch = providerReceipt?.chainValue === requesterChainValue
  if (chainsMatch) {
    return {
      status: 'CLEAN',
      chargeBytes: Math.max(0, Number(providerReceipt?.bytesForwarded ?? 0)),
      providerEarningsWithheld: false,
    }
  }

  const providerBytes = Math.max(0, Number(providerReceipt?.bytesForwarded ?? 0))
  const requesterBytes = Math.max(0, Number(requesterBytesReceived ?? 0))
  const delta = Math.abs(providerBytes - requesterBytes)
  const baseline = Math.max(providerBytes, requesterBytes, 1)
  const ratio = delta / baseline

  return {
    status: ratio > 0.10 ? 'BYTE_DISCREPANCY' : 'CHAIN_MISMATCH',
    chargeBytes: Math.max(0, tokenFloorBytes),
    providerEarningsWithheld: ratio > 0.10,
    byteDeltaRatio: ratio,
  }
}

export function safeEqualString(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex')
  const right = Buffer.from(String(b), 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
