import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
  BYTE_TOKEN_GRANULARITY,
  MANDATE_TTL_MS,
  advanceHashChain,
  advanceRelayAnchoredChain,
  createByteToken,
  createCommitment,
  createDirectHandshakeProof,
  createRelayAnchor,
  createSessionNonce,
  createSessionSigningKey,
  createSignedMandate,
  crossCheckReceipts,
  generateRelaySigningKeyPair,
  getReachedTokenIndexes,
  signReceiptWithSplitKey,
  verifyDirectHandshakeProof,
  verifyCommitmentReveal,
  verifyReceiptSplitSignatures,
  verifySignedMandate,
} from '../relay/lib/mandate-relay.mjs'

test('signed mandate verifies and rejects policy tampering', () => {
  const relayKeys = generateRelaySigningKeyPair()
  const mandate = createSignedMandate({
    sessionId: 'session-1',
    requesterUserId: 'requester-1',
    requesterDeviceId: 'requester-device-1',
    providerUserId: 'provider-1',
    providerDeviceId: 'provider-device-1',
    sessionSigningKey: createSessionSigningKey(),
    sessionNonce: createSessionNonce(),
    providerDirectEndpoint: 'ws://192.168.1.20:32100/tunnel',
    relayFallback: 'wss://relay.peermesh.dev',
  }, relayKeys)

  assert.equal(verifySignedMandate(mandate, relayKeys.publicKeyPem, { rejectExpired: false }), true)

  const tampered = {
    ...mandate,
    policy: {
      ...mandate.policy,
      maxTunnelsPerMinute: mandate.policy.maxTunnelsPerMinute + 1,
    },
  }

  assert.equal(verifySignedMandate(tampered, relayKeys.publicKeyPem, { rejectExpired: false }), false)
  assert.ok(Number(mandate.expiresAt) - Number(mandate.issuedAt) >= MANDATE_TTL_MS)
})

test('direct handshake proof binds the requester to the signed mandate', () => {
  const relayKeys = generateRelaySigningKeyPair()
  const sessionSigningKey = createSessionSigningKey()
  const mandate = createSignedMandate({
    sessionId: 'direct-session-1',
    requesterUserId: 'requester-1',
    requesterDeviceId: 'requester-device-1',
    providerUserId: 'provider-1',
    providerDeviceId: 'provider-device-1',
    sessionSigningKey,
    sessionNonce: createSessionNonce(),
    directChallenge: createSessionNonce(),
    providerDirectEndpoint: 'ws://10.0.0.12:32100/tunnel',
    relayFallback: 'wss://relay.peermesh.dev',
    relayPublicKey: relayKeys.publicKeyPem,
    transportTier: 2,
    transportPreference: ['direct', 'relay'],
  }, relayKeys)

  const proof = createDirectHandshakeProof(mandate)

  assert.equal(verifyDirectHandshakeProof(mandate, proof), true)
  assert.equal(verifyDirectHandshakeProof({ ...mandate, providerDirectEndpoint: 'ws://10.0.0.99:32100/tunnel' }, proof), false)
  assert.equal(verifyDirectHandshakeProof(mandate, proof, createSessionSigningKey()), false)
})

test('byte tokens are deterministic and only reached after 10MB boundaries', () => {
  const secret = randomBytes(32).toString('base64url')
  const sessionId = 'session-byte-token'

  const first = createByteToken(secret, sessionId, 1)
  assert.equal(first, createByteToken(secret, sessionId, 1))
  assert.notEqual(first, createByteToken(secret, sessionId, 2))

  assert.deepEqual(getReachedTokenIndexes(0, BYTE_TOKEN_GRANULARITY - 1), [])
  assert.deepEqual(getReachedTokenIndexes(0, BYTE_TOKEN_GRANULARITY), [1])
  assert.deepEqual(getReachedTokenIndexes(BYTE_TOKEN_GRANULARITY - 1, BYTE_TOKEN_GRANULARITY * 2), [1, 2])
})

test('hash chain and commitment reveal agree only for the committed chain', () => {
  const key = createSessionSigningKey()
  const nonce = createSessionNonce()
  const first = advanceHashChain(nonce, 1024, 123456, key)
  const second = advanceHashChain(first, 2048, 123556, key)
  const periodNonce = createSessionNonce()
  const commitment = createCommitment(second, periodNonce, key)

  assert.equal(verifyCommitmentReveal(commitment, second, periodNonce, key), true)
  assert.equal(verifyCommitmentReveal(commitment, first, periodNonce, key), false)
})

test('relay anchors make hash chain ticks unpredictable without relay secret', () => {
  const key = createSessionSigningKey()
  const anchor = createRelayAnchor('relay-secret', 'session-anchor', 123)
  const nextAnchor = createRelayAnchor('relay-secret', 'session-anchor', 124)
  const chain = advanceRelayAnchoredChain('chain-0', 2048, anchor, key)

  assert.notEqual(anchor, nextAnchor)
  assert.equal(chain, advanceRelayAnchoredChain('chain-0', 2048, anchor, key))
  assert.notEqual(chain, advanceRelayAnchoredChain('chain-0', 2048, nextAnchor, key))
})

test('split receipt signatures require both device key and session key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const sessionKey = createSessionSigningKey()
  const receiptFields = {
    sessionId: 'receipt-session',
    bytesForwarded: 9_250_000,
    chainValue: 'abc123',
    nonce: 'nonce-1',
  }

  const signatures = signReceiptWithSplitKey(receiptFields, privateKey, sessionKey)
  assert.equal(verifyReceiptSplitSignatures(receiptFields, signatures, publicKey, sessionKey), true)
  assert.equal(verifyReceiptSplitSignatures(receiptFields, signatures, publicKey, createSessionSigningKey()), false)
})

test('receipt cross-check uses clean chain count or token floor on discrepancy', () => {
  const providerReceipt = {
    bytesForwarded: 20_000_000,
    chainValue: 'chain-a',
  }

  assert.deepEqual(crossCheckReceipts({
    providerReceipt,
    wrappedProviderReceipt: providerReceipt,
    requesterChainValue: 'chain-a',
    requesterBytesReceived: 20_000_000,
    tokenFloorBytes: BYTE_TOKEN_GRANULARITY,
  }), {
    status: 'CLEAN',
    chargeBytes: 20_000_000,
    providerEarningsWithheld: false,
  })

  const mismatch = crossCheckReceipts({
    providerReceipt,
    wrappedProviderReceipt: providerReceipt,
    requesterChainValue: 'chain-b',
    requesterBytesReceived: 5_000_000,
    tokenFloorBytes: BYTE_TOKEN_GRANULARITY,
  })

  assert.equal(mismatch.status, 'BYTE_DISCREPANCY')
  assert.equal(mismatch.chargeBytes, BYTE_TOKEN_GRANULARITY)
  assert.equal(mismatch.providerEarningsWithheld, true)
})
