# PeerMesh — Complete Engineering Architecture
> **duo-plan.md** · Canonical architecture reference · All gaps closed · Build-ready

---

## Foundational Principle

The relay is a **cryptographic authority**, not a data pipe. Authority is enforced through signed credentials, not physical position in the data path. Transport is a policy decision made by the control plane, not a fixed topology.

---

## The Three Planes

```
┌─────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE                           │
│  Identity · Auth · Session issuance · Policy · Kill auth    │
│  NAT coordination · Route selection · Accounting settle     │
└──────────────────────┬──────────────────────────────────────┘
                       │ signed capability tokens
          ┌────────────┼────────────┐
          │            │            │
┌─────────▼──────┐     │    ┌───────▼────────┐
│  TRUST PLANE   │     │    │  DATA PLANE    │
│  Verifier      │     │    │  Tier 0-3      │
│  Receipt audit │     │    │  Direct/Relay  │
│  Probe inject  │     │    │  QUIC/WS       │
│  Fraud detect  │     │    └───────┬────────┘
└─────────┬──────┘     │            │
          │            │            │
          └────────────┼────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
   ┌──────▼──────┐           ┌──────▼──────┐
   │  REQUESTER  │◄─────────►│  PROVIDER   │
   │  Node       │           │  Node       │
   └─────────────┘           └─────────────┘
```

---

## 1. Control Plane

### 1.1 What It Does

The control plane is the only entity that can authorize sessions, issue credentials, and terminate sessions. It never forwards bulk traffic. Its outputs are signed tokens and kill messages. Its inputs are registration requests, session requests, receipts, and anomaly reports.

### 1.2 Components

**Identity Registry** — stores provider and requester device public keys, user profiles, trust scores, session history, and device attestation status. Backed by the existing Supabase Postgres instance. New tables: `device_keys`, `capability_tokens`, `trust_events`, `session_receipts`.

**Session Authority** — handles session creation. Validates both parties, selects transport tier, issues capability token, coordinates NAT if needed, notifies Verifier. Evolution of the existing `app/api/session/create` and `app/api/relay/auth` routes.

**Policy Engine** — maintains versioned policy documents. Each policy has an ID, a version, and a SHA-256 hash. Policies define: allowed ports, blocked patterns, rate limits, tier eligibility thresholds. Policies are referenced by hash in capability tokens.

**Kill Authority** — maintains persistent signaling connections to all active providers and requesters. Can terminate any session instantly by sending a signed kill message. Providers are required by their device key contract to honor kill messages within 5 seconds or face key revocation.

**Accounting Reconciler** — receives signed receipts from providers and requesters, cross-checks them, settles billing. Feeds into the existing wallet and earnings system.

**NAT Coordinator** — during session creation, collects each side's public IP as seen from the relay, their NAT type (detected at registration), and their region. Selects transport tier and provides connection info to both sides.

**Routing Service** — edge relay selection using actual RTT measurements from heartbeats, not region estimates.

### 1.3 Capability Token Structure

```json
{
  "capabilityId": "cap_uuid",
  "sessionId": "session_uuid",
  "transportAttempt": 1,
  "attemptNonce": "random_32_bytes_hex",
  "previousAttemptHash": null,
  "issuedAt": 1234567890000,
  "expiresAt": 1234568490000,
  "requesterUserId": "user_uuid",
  "requesterDeviceId": "device_uuid",
  "providerUserId": "user_uuid",
  "providerDeviceId": "device_uuid",
  "transportTier": 1,
  "receiptIntervalSeconds": 10,
  "policyId": "policy_v4",
  "policyHash": "sha256_hex",
  "policyInline": {
    "allowedPorts": [80, 443, 8080, 8443],
    "blockedPatterns": ["onion", "smtp", "mail", "torrent"],
    "maxBytesPerMinute": 262144000,
    "maxTunnelsPerMinute": 200,
    "privateIPBlocked": true
  },
  "hardExpiryOnSignalingLoss": 30,
  "providerDirectEndpoint": "ip:port or null",
  "relayFallback": "wss://relay.peermesh.dev",
  "verifierEndpoint": "wss://verifier.peermesh.dev",
  "verifierPublicKey": "base64_pubkey",
  "verifierTunnelAllowed": true,
  "ephemeralSessionPubKey": "base64_ecdh_pubkey",
  "forcedRelaySession": false,
  "signature": "relay_ed25519_sig_over_all_fields"
}
```

**Key fields explained:**

- `policyInline` + `policyHash` — full policy inline so clients verify locally without a network call. When policies grow large, clients switch to fetch-by-`policyId` and verify against `policyHash`. Token structure doesn't change.
- `forcedRelaySession: true` — random audit session. Provider cannot distinguish from a normal relay session. Flag tells the relay to record observed bytes for cross-checking against historical receipts.
- `hardExpiryOnSignalingLoss: 30` — provider self-terminates direct tunnel 30 seconds after losing signaling connection. Closes orphaned tunnel gap without requiring a kill message.
- `transportAttempt` + `attemptNonce` + `previousAttemptHash` — sequence binding. Prevents replay across reconnects and edge failover. On reconnect, control plane issues new token with `transportAttempt + 1` and `previousAttemptHash = sha256(previous_token)`.
- `receiptIntervalSeconds` — adaptive interval based on trust score. Included in token so both sides and the Verifier use the same value.
- `verifierTunnelAllowed: true` — enables shadow probe substream (Phase 2 probes).

### 1.4 Tier Selection Algorithm

Run at session creation time by the Session Authority. Deterministic given the inputs. Not reactive.

```
inputs:
  provider.trustScore (multidimensional)
  provider.sessionCount
  provider.natType          (open / moderate / symmetric)
  provider.edge_relay_rtts  (actual measurements from heartbeat)
  requester.natType
  requester.edge_relay_rtts (measured at session creation)
  sameNetwork               (provider public IP == requester public IP)
  randomAuditRoll           (0.0–1.0, uniform random)

algorithm:
  if provider.fraudRisk > 0.4 OR provider.sessionCount < 10:
    return Tier0

  if randomAuditRoll < 0.05:
    return Tier0  // forced relay audit, forcedRelaySession=true

  if sameNetwork:
    return Tier2  // pure direct, LAN routing

  if provider.natType == open AND requester.natType == open:
    return Tier1  // STUN-assisted direct

  if provider.natType == moderate OR requester.natType == moderate:
    return Tier1  // attempt hole-punch, fallback to Tier3 on failure

  best_edge = min(provider.edge_relay_rtts[r] + requester.edge_relay_rtts[r])
  if best_edge <= 150ms:
    return Tier3  // edge relay forwarding

  return Tier0    // central relay forwarding

Tier eligibility uses min(provider.tier_eligibility, requester.tier_eligibility).
One low-trust party forces the session down.
```

The tier is recorded in the session row. It cannot be changed after session creation except by the Kill Authority terminating the session and creating a new one.

### 1.5 Event-Driven Internal Architecture

Each service publishes events to an append-only stream. Other services subscribe to the events they care about. No direct service-to-service calls for non-critical paths.

**Event stream:** Redis Streams initially → NATS or Kafka at scale.

```
Events published by Session Service:
  session.created      { sessionId, tier, capabilityId, ... }
  session.ended        { sessionId, reason, ... }
  session.tier_changed { sessionId, oldTier, newTier, ... }

Events published by Trust Service:
  trust.score_updated   { deviceId, oldScore, newScore, reason }
  trust.device_revoked  { deviceId, reason }
  trust.anomaly_flagged { sessionId, deviceId, anomalyType, severity }

Events published by Verifier Service:
  receipt.verified  { sessionId, periodStart, bytesProvider, bytesRequester, match }
  receipt.anomaly   { sessionId, anomalyType, severity, details }
  probe.result      { sessionId, probeId, passed, bytesExpected, bytesReceived }

Events published by Accounting Service:
  billing.settled   { sessionId, requesterCharge, providerEarning }
  billing.disputed  { sessionId, reason }
  billing.withheld  { sessionId, reason }

Events published by Kill Authority:
  session.kill_issued     { sessionId, reason, issuedAt }
  session.kill_confirmed  { sessionId, confirmedAt }
```

**Service subscriptions:**

| Service | Subscribes to |
|---|---|
| Trust Service | `receipt.anomaly`, `probe.result`, `session.ended` |
| Accounting Service | `receipt.verified`, `session.ended` |
| Kill Authority | `receipt.anomaly` (auto-kill on MAJOR), `trust.device_revoked` |
| Session Service | `trust.device_revoked`, `trust.score_updated` |
| Verifier Service | `session.created` |

**Migration path:**
- Phase 1: All services are modules within the existing Next.js app. Event stream is Redis Streams. External API surface unchanged.
- Phase 2: Extract any service that needs independent scaling. It reads/writes the same event stream. No other changes needed.
- Phase 3: Each service independently deployed. NATS or Kafka. Horizontal scaling.

**Rule:** Never add a direct function call between services for non-critical paths. The only exception is synchronous calls on the critical path of session creation (e.g. tier selection needing routing info).

---

## 2. Device Identity and Key Model

### 2.1 Key Generation — Device Side (Provider and Requester)

The device generates its own keypair locally. The private key never leaves the device.

```
On first launch (desktop or CLI):
  1. Generate Ed25519 keypair locally
  2. Store private key in ~/.peermesh/device-identity.json (chmod 600)
  3. Send public key + user auth token to relay registration endpoint
  4. Relay stores public key in device_keys table
  5. Relay returns device_id (UUID bound to this public key)

device-identity.json:
{
  "deviceId": "device_uuid",
  "publicKey": "base64_ed25519_pubkey",
  "privateKey": "base64_ed25519_privkey",
  "registeredAt": "iso8601",
  "baseDeviceId": "pm_uuid"
}
```

The relay stores only the public key. It cannot impersonate the device. If the relay database is compromised, attackers get public keys — useless for forging receipts.

### 2.2 Attestation Challenge

Run at registration and every 30 days thereafter, and after every client update.

**Provider attestation** — verifies enforcement code is actually running:

```
Relay → Provider Device:
{
  "challengeId": "uuid",
  "testSessionId": "uuid",
  "testTarget": "https://probe-target.peermesh.dev/segment-abc",
  "expectedBytes": 524288,
  "nonce": "random_32_bytes_hex"
}

Provider:
  1. Connect to relay test session
  2. Forward exactly expectedBytes from testTarget through tunnel
  3. Generate receipt signed with device private key
  4. Send receipt to relay

Relay:
  1. Verify receipt signature against registered public key
  2. Verify relay-observed bytes match expectedBytes ± 1%
  3. Verify nonce matches
  4. Mark device attested, record attestation timestamp
```

**Requester attestation** — verifies receipt-signing code is working:

```
Relay → Requester Device:
  { challengeId, testSessionId, nonce }

Requester:
  1. Participate in test session
  2. Generate receipt signed with device private key
  3. Send receipt to relay

Relay:
  1. Verify signature against registered public key
  2. Verify receipt fields correctly populated
  3. Mark device attested
```

**Failure handling:**
- Device remains Tier0-only until attestation passes
- Three consecutive failures: device key revoked

The test target is a relay-controlled endpoint serving real content. From the device's perspective it looks identical to a real session. The nonce prevents replay of a previously valid receipt.

### 2.3 Key Revocation

```
Revocation triggers:
  - User account suspension
  - Three consecutive attestation failures
  - Receipt discrepancy > 15% confirmed by Verifier
  - Probe failure confirmed
  - Manual admin action

Revocation process:
  1. Relay marks device_keys.revoked = true, revoked_at = now
  2. Relay sends signed kill message to device's active sessions
  3. All future capability tokens for this device are rejected
  4. Device cannot re-register without new user verification flow

Re-registration after revocation:
  - Requires fresh phone verification
  - Requires new $1 payment (for requesters)
  - Starts at trust score 0, Tier0 only
  - New device keypair generated
```

---

## 3. Trust Plane

### 3.1 The Verifier Service

A separate lightweight service running on **different infrastructure from the relay**. Different cloud provider or different Fly.io organization. Different deployment pipeline. A relay compromise does not compromise the Verifier.

The Verifier's only job: receive signed receipts from both sides of a session, cross-check them, report anomalies to the relay and to an independent audit log.

**Verifier is the authoritative receipt processor.** The relay receives the Verifier's verdict, not raw receipts. This ensures: a compromised relay cannot act on receipts before cross-checking; relay and Verifier cannot disagree with no tiebreaker; receipt processing has a single source of truth.

**Verifier receipts (every N seconds, where N = `receiptIntervalSeconds` from token):**

```json
// Provider receipt
{
  "sessionId": "uuid",
  "capabilityId": "uuid",
  "role": "provider",
  "periodStart": 1234567890000,
  "periodEnd": 1234567895000,
  "bytesForwarded": 9250000,
  "tunnelsOpened": 2,
  "activeConnections": 3,
  "blockedAttempts": 0,
  "topHostBytes": {
    "ttvnw.net": 8900000,
    "cloudfront.net": 350000
  },
  "nonce": "uuid",
  "deviceId": "device_uuid",
  "signature": "ed25519_sig_with_device_privkey"
}

// Requester receipt
{
  "sessionId": "uuid",
  "capabilityId": "uuid",
  "role": "requester",
  "periodStart": 1234567890000,
  "periodEnd": 1234567895000,
  "bytesReceived": 9245000,
  "activeConnections": 3,
  "nonce": "uuid",
  "deviceId": "device_uuid",
  "signature": "ed25519_sig_with_device_privkey"
}
```

### 3.2 Verifier Handshake and Timeout Policy

Both provider and requester connect to Verifier using capability token as auth. Verifier confirms both sides present, sends `session_ready` to control plane. Control plane will not allow data plane connection until Verifier confirms.

**Timeout: 2 seconds across two Verifier instances (500ms retry to secondary).**

```
Phase 1 (first 90 days of production):
  On timeout → Fail open
  Allow session, set session.verifier_confirmed = false
  Force session to Tier0 regardless of selected tier
  Flag for manual review, log VERIFIER_TIMEOUT_FAILOPEN

Phase 2 (after Verifier demonstrates > 99.9% uptime over 30 days):
  On timeout → Fail closed
  Reject session, requester retries (may hit different Verifier instance)
  Log VERIFIER_TIMEOUT_FAILCLOSED

If ALL Verifier instances down:
  Fail open, all sessions proceed as Tier0
  Alert immediately
  This is the only condition where Verifier is fully bypassed
```

**Verifier availability target:** 99.9% (< 44 min downtime/month). Minimum 2 instances in different regions.

### 3.3 Verifier Cross-Check Logic

```
For each matched (provider, requester) receipt pair:

1. Signature verification
   Verify both signatures against registered device public keys
   Failure → flag immediately, alert relay

2. Byte cross-check
   delta = abs(provider.bytesForwarded - requester.bytesReceived)
   tolerance = max(provider.bytesForwarded, requester.bytesReceived) * 0.02
   if delta > tolerance * 2.5  // > 5%
     flag(BYTE_DISCREPANCY_MINOR, delta_pct)
   if delta > tolerance * 7.5  // > 15%
     flag(BYTE_DISCREPANCY_MAJOR, delta_pct)
     alert_relay(KILL_SESSION, sessionId)

3. Connection count cross-check
   if provider.activeConnections != requester.activeConnections
     flag(CONNECTION_COUNT_MISMATCH)

4. Clock skew check
   skew = abs(provider.periodStart - requester.periodStart)
   if skew > 500ms  → flag(CLOCK_SKEW_MINOR)
   if skew > 2000ms → flag(CLOCK_SKEW_MAJOR)  // possible replay attack

5. Receipt continuity check
   Verify nonces are unique (no replays)
   Verify period timestamps are monotonically increasing
   gap_threshold = receiptIntervalSeconds * 3
   if gap > gap_threshold → flag(RECEIPT_GAP)

6. Session baseline comparison (after first 60s)
   Build rolling baseline: mean and stddev of bytesForwarded per period
   if current period deviates > 3 stddev from baseline
     flag(THROUGHPUT_ANOMALY)
   Catches sudden behavioral changes without false-positiving on
   bursty traffic (browse/pause/stream establishes its own baseline)
```

### 3.4 Probe Injection

**Phase 1 — In-band probes (simpler, ships first):**

Probes are injected via the requester, not the relay directly. The relay instructs the requester to make a specific request through the normal tunnel. From the provider's perspective it is indistinguishable from any other requester request.

```
1. Relay selects session for probing
2. Relay sends probe instruction to REQUESTER via signaling:
   {
     type: "probe_instruction",
     probeId: "uuid",
     targetUrl: "https://rotating-probe-domain.com/segment-xyz",
     expectedBytes: 524288,
     nonce: "hex",
     signature: "relay_sig"   // requester verifies this is a real relay instruction
   }

3. Requester makes request through normal tunnel
   (CONNECT to rotating-probe-domain.com, fetch content)
   Path: requester → tunnel → provider → internet → probe endpoint

4. Probe endpoint records:
   { probeId, sourceIP (provider's IP), bytesReceived, timestamp }

5. Relay cross-checks:
   probe_endpoint.sourceIP == provider.registered_ip   // actually forwarded
   probe_endpoint.bytesReceived ≈ expectedBytes ± 1%   // forwarded correctly
   probe_endpoint.timestamp within 10s of probe_instruction

Failure responses:
  probe not received within 10s → flag(PROBE_MISS)
  probe received but bytes wrong → flag(PROBE_TAMPERED)
  three probe misses in one session → alert Verifier, increase forced relay
```

Why this closes the sophisticated adversary gap: a modified client monitoring the signaling channel sees the probe instruction arrive — but cannot suppress the probe without also suppressing real requester requests, because the probe travels through the same path.

**Phase 2 — Shadow probes (when in-band probe complaints arise):**

```
During session establishment, Verifier opens a parallel validation substream.
This substream:
  - Uses same capability token for auth (verifierTunnelAllowed: true)
  - Connects to provider through a SEPARATE WebSocket connection
  - Is NOT routed through the requester's browser proxy
  - Makes requests directly from Verifier to provider's tunnel

From provider's perspective:
  - Two WebSocket connections open for this session
  - One is requester's tunnel (real traffic)
  - One is Verifier's validation substream (probe traffic)
  - Both authenticated by same capability token
  - Provider cannot distinguish which is which
  - Monitoring connection timing is detectable as suspicious behavior itself

Verifier controls both ends: sends the request and receives the response.
No real user traffic is contaminated.
```

**Probe domain pool:**

```
Pool size: 200+ domains
  All relay-controlled, serving real cached content
  Domains look like legitimate CDN/media domains
  Content: real video segments, images, JS files
  Sizes: 64KB–8MB (matches real HLS segment distribution)

Rotation policy:
  Each domain used at most once per provider per 30 days
  Domain selection: hash(providerId + date + random_salt) % pool_size
  Salt rotates daily — providers cannot predict tomorrow's probe domain

Rate:
  1 probe per 10 minutes of active session time per provider
  Never more than 3 probes in any 30-minute window
  Low enough that statistical detection requires > 1,000 sessions
  By that point forced relay sessions have already caught the provider
```

### 3.5 Adaptive Receipt Intervals

```
Receipt interval by trust tier:

  fraudRisk <= 0.2 (high trust):    every 20s
  fraudRisk <= 0.4 (medium trust):  every 10s
  fraudRisk >  0.4 (low trust):     every 5s
  forcedRelaySession = true:        every 5s regardless

Interval is included in capability token as receiptIntervalSeconds.
Both provider and requester use this interval.
Verifier gap threshold = receiptIntervalSeconds * 3.

Traffic estimate at 100k sessions (adaptive vs fixed 5s):
  40% high trust (20s):  40k × 2 × 3/min  = 240k receipts/min
  40% medium (10s):      40k × 2 × 6/min  = 480k receipts/min
  20% low trust (5s):    20k × 2 × 12/min = 480k receipts/min
  Total: ~1.2M receipts/min vs 4.8M at fixed 5s → 75% reduction
```

### 3.6 Multidimensional Trust Score

The scalar trust score remains for backward compatibility. Dimensions are stored alongside it and used directly in routing decisions.

```
Trust dimensions (stored in trust_scores table):

transportReliability:
  Measures: session uptime, reconnect frequency, heartbeat consistency
  Affects: tier eligibility, edge relay selection
  Range: 0.0–1.0

fraudRisk:
  Measures: receipt discrepancies, probe failures, forced relay anomalies
  Affects: forced relay probability, Verifier scrutiny level
  Range: 0.0–1.0 (higher = more risky)

policyCompliance:
  Measures: blocked target attempts, rate limit violations, security events
  Affects: whether direct tunnel is allowed at all
  Range: 0.0–1.0

networkQuality:
  Measures: provider avg Mbps, disconnect count, reconnect count
  Affects: provider selection priority in findProvider
  Range: 0.0–1.0

sessionStability:
  Measures: session duration distribution, early termination rate
  Affects: tier eligibility for long sessions (streaming use case)
  Range: 0.0–1.0

peerDiversity:
  Measures: unique counterparties / total sessions (graph metric)
  Affects: collusion detection sensitivity
  Range: 0.0–1.0
```

**Routing decisions use dimensions directly:**

```
Tier eligibility:
  Tier2: transportReliability >= 0.7 AND fraudRisk <= 0.2 AND sessions >= 50
  Tier1: transportReliability >= 0.5 AND fraudRisk <= 0.4 AND sessions >= 10
  Tier3: fraudRisk <= 0.6 AND sessions >= 10
  Tier0: everything else

Provider selection priority:
  score = networkQuality * 0.4 + transportReliability * 0.3 +
          (1 - fraudRisk) * 0.2 + policyCompliance * 0.1

Forced relay probability:
  base_rate = 0.05
  adjusted_rate = base_rate + fraudRisk * 0.15 + (1 - peerDiversity) * 0.05
  cap at 0.50

Scalar score (backward compatibility):
  trust_score = transportReliability * 0.3 + (1 - fraudRisk) * 0.3 +
                policyCompliance * 0.2 + networkQuality * 0.1 +
                sessionStability * 0.1
```

**Score events:**

```
Provider increases (slow):
  Clean session completed:        +0.015
  Attestation passed:             +0.010
  Forced relay session clean:     +0.020  (extra weight, harder to fake)

Provider decreases (fast):
  Receipt discrepancy 5–15%:      -0.04
  Receipt discrepancy > 15%:      -0.08
  Probe miss:                     -0.06
  Probe tampered:                 -0.15
  Security event (blocked target):-0.03
  Attestation failure:            -0.05
  Clock skew major:               -0.03
  Receipt gap > 30s:              -0.02

Requester increases:
  Clean session completed:        +0.010
  Session paid in full:           +0.008
  Long session (> 30 min) clean:  +0.015

Requester decreases:
  Session collapsed by requester: -0.02
  Billing dispute filed:          -0.05
  Blocked target attempt:         -0.03
  Receipt discrepancy:            -0.04
  Repeated short sessions (< 30s):-0.01 per session above 5/hour
  Clock skew major:               -0.03

Score floor: 0.0 → device key revocation
Score ceiling: 1.0
```

**Temporal signals (computed daily):**

```
30-day throughput variance:
  stddev(bytesForwarded per session) / mean
  if variance > 0.8: -0.02/day until normalized

Peer diversity score:
  unique_requesters_last_30_days / total_sessions
  if < 0.1: flag for collusion review

Behavioral shift detector:
  compare last_7_days against prev_30_days baseline
  if any metric shifts > 2 stddev: increase forced relay to 15% for 14 days
```

### 3.7 Collusion Detection — Response Ladder

**Detection signals:**
- Provider-requester pair frequency > 30% of either party's sessions
- Sessions consistently reporting exactly at mandate limit
- Receipt timing suspiciously synchronized (< 100ms variance)
- Peer diversity score < 0.1 for both parties
- Graph clustering: both in same suspicious cluster

```
Level 1 (first detection):
  Increase forced relay for this pair to 20% for 30 days
  No notification, no penalty
  Log event for pattern tracking

Level 2 (second detection within 30 days):
  Increase forced relay for this pair to 50%
  Reduce both trust scores by 0.05
  Flag for manual review queue

Level 3 (third detection or anomaly in forced relay session):
  Provider: Tier0 only for 30 days
  Reduce trust scores by 0.15
  Notify provider account is under review
  Requester: increased monitoring, no suspension yet

Level 4 (confirmed fraud: receipt discrepancy + probe failure + forced relay anomaly):
  Provider: device key revocation, account suspension
  Requester: account suspension
  Earnings withheld pending investigation
  Both parties notified with evidence summary
```

### 3.8 Graph-Based Reputation

```
Data source: session table (requester_id, provider_id, timestamp, bytes)
Computation: weekly batch job over last 90 days

Metrics per node:
  degree_centrality:      unique counterparties
  session_concentration:  max(sessions_with_single_counterparty) / total
  cluster_membership:     fraud cluster if any (Louvain algorithm)
  temporal_entropy:       how evenly sessions are distributed over time

Metrics per edge (provider-requester pair):
  pair_frequency:        sessions_together / min(provider_total, requester_total)
  byte_consistency:      stddev(bytes_per_session) / mean
  timing_correlation:    cross-correlation of session start times

Fraud signals:
  session_concentration > 0.3:        over-reliance on single counterparty
  cluster with > 5 nodes serving each other: ring fraud candidate
  pair_frequency > 0.3 for both:      collusion candidate
  byte_consistency < 0.05:            suspiciously consistent (scripted)

Output: fraud_risk_score per node (0.0–1.0)
  trust_score_adjusted = trust_score * (1 - fraud_risk_score * 0.3)
  fraud_risk_score of 0.5 → effective trust score reduced by 15%
```

**Requester graph metrics:**

```
requester_provider_concentration:
  max(sessions_with_single_provider) / total_sessions
  > 0.4: flag for collusion review

requester_session_collapse_rate:
  sessions_ended_by_requester_early / total_sessions
  > 0.3: trust penalty, flag for review

requester_blocked_target_rate:
  blocked_attempts / total_tunnel_opens
  > 0.05: trust penalty
  > 0.15: Tier0 only, flag for review
```

---

## 4. Data Plane

### 4.1 Transport Tiers

**Tier 0 — Full Relay Forwarding**

Existing architecture unchanged. Relay sees all traffic. Full enforcement. Used for: new providers/requesters, low trust, forced audit sessions, NAT traversal failure.

```
Requester → Relay → Provider → Target
         ←        ←
```

**Tier 1 — STUN-Assisted Direct**

Relay coordinates hole-punching. Data flows directly. Relay sees only receipts and signaling.

```
Session creation:
  Relay → Provider: "your public endpoint is A:P1, requester will connect"
  Relay → Requester: "provider public endpoint is A:P1, capability token enclosed"

Connection:
  Requester → Provider (direct, authenticated by capability token)
  Provider verifies: token signature valid, requester identity matches, not expired

Data flow:
  Requester ←→ Provider (direct)
  Both → Verifier (receipts at receiptIntervalSeconds)
  Both → Relay (signaling keepalive, kill authority)

Fallback:
  If direct connection fails within 3s → Tier3 or Tier0
  Fallback endpoint is in the capability token
```

**Tier 2 — Pure Direct (Same Network)**

Same as Tier 1 but using LAN IP. No NAT traversal needed.

```
Provider registers at heartbeat:
  PUT /api/user/sharing
  { device_id, relay_url, lan_ip: "192.168.1.x", lan_port: 7657,
    edge_relay_rtts: { "edge-us-east": 45, "edge-eu-west": 120 } }

Session creation for same-network pair:
  Relay detects: provider.public_ip == requester.public_ip
  Relay includes: providerDirectEndpoint: "192.168.1.x:7657" in capability token

Connection:
  Requester → Provider (LAN, sub-1ms)
  No relay involvement in data path
  Receipts still flow to Verifier and Relay
```

**Tier 3 — Edge Relay Forwarding**

Data flows through nearest edge relay. Edge relay is a thin forwarder — accepts capability tokens, forwards bytes, reports byte counts. Does not run auth, session creation, or trust logic.

```
Edge relay selection (using actual RTT measurements):
  For each edge relay:
    combined_rtt = provider.edge_relay_rtts[relay_id] +
                   requester.edge_relay_rtts[relay_id]
  Select edge relay with lowest combined_rtt
  If lowest combined_rtt > 150ms: use central relay (Tier 0)

Edge relay behavior:
  Accept connection authenticated by capability token
  Verify token signature against embedded relay public key
  Forward bytes between provider and requester
  Report byte counts to control plane every 5s
  Honor kill messages from control plane
```

**RTT measurement — actual, not estimated:**

```
Provider heartbeat (every 30s) includes:
  edge_relay_rtts: {
    "edge-us-east": 45,    // ms, average of last 3 pings
    "edge-eu-west": 120,
    "edge-ap-se": 280
  }

Requester measures once at session creation time:
  Pings each edge relay, includes in session create request

Staleness handling:
  Provider RTT measurements expire after 5 minutes
  If stale or missing: fall back to region-based estimation
  Flag: EDGE_RTT_STALE
  Requester measurements are per-session, never stale
```

### 4.2 Direct Tunnel Protocol

The direct tunnel uses the existing WebSocket tunnel protocol (CONNECT + binary forwarding) with one addition: the capability token is presented as the auth credential during the WebSocket handshake.

```
Requester → Provider WebSocket handshake:
  GET /tunnel HTTP/1.1
  Upgrade: websocket
  X-Capability-Token: <base64_encoded_capability_token>
  X-Session-Id: <session_uuid>

Provider validates:
  1. Decode capability token
  2. Verify relay signature (Ed25519, relay public key embedded at build time)
  3. Verify token not expired (expiresAt > now)
  4. Verify requester device ID matches registered device
  5. Verify transportAttempt is current (no replay)
  6. Accept connection

On reconnect / edge failover:
  Control plane issues new token with:
    transportAttempt: previous + 1
    previousAttemptHash: sha256(previous_capability_token)
    attemptNonce: new random value
  Provider validates chain before accepting
```

### 4.3 Provider-Side Enforcement Under Mandate

The provider enforces the capability token's policy locally. This is not optional — it is a condition of device key registration. Provider-side enforcement is the **primary real-time gate**. Receipts are for audit and billing.

```
For every tunnel open request:
  1. Validate hostname against policyInline.blockedPatterns
  2. Validate port against policyInline.allowedPorts
  3. DNS resolve hostname, check all IPs against private ranges
  4. Check sliding window byte counter against policyInline.maxBytesPerMinute
  5. Check tunnel open counter against policyInline.maxTunnelsPerMinute
  6. If any check fails: reject, log security event, send to relay

Sliding window (real-time, in-memory):
  byteBurstSamples: array of {t: timestamp, b: bytes}
  On each byte chunk:
    push {t: now, b: chunk.length}
    evict samples older than 60s
    sum remaining samples
    if sum > maxBytesPerMinute: drop connection, log violation

Security event reporting to relay signaling channel:
  {
    type: "security_event",
    sessionId: "uuid",
    capabilityId: "uuid",
    eventType: "blocked_target" | "rate_limit" | "private_ip",
    hostname: "...",
    port: 443,
    timestamp: "iso8601",
    signature: "device_sig"
  }

Self-termination:
  If signaling connection lost > hardExpiryOnSignalingLoss seconds:
    Close all active tunnel connections
    Log: SELF_TERMINATED_SIGNALING_LOSS
```

### 4.4 QUIC/WebTransport Migration Path

WebSockets remain the transport for the control plane indefinitely.

The data plane migrates to WebTransport (QUIC-based) in Sprint 6. The migration is enabled by a clean abstraction layer defined in Sprint 1:

```typescript
interface DataPlaneTransport {
  connect(endpoint: string, capabilityToken: string): Promise<TunnelConnection>
}

interface TunnelConnection {
  openTunnel(hostname: string, port: number): Promise<TunnelStream>
  close(): void
  onDisconnect(callback: () => void): void
  bytesForwarded: number
  bytesReceived: number
}

interface TunnelStream {
  write(chunk: Buffer): void
  read(): Promise<Buffer>
  close(): void
}
```

The current WebSocket tunnel implementation satisfies this interface. The future WebTransport implementation satisfies the same interface. The capability token, receipt, and enforcement logic are identical regardless of transport. Swapping is a single implementation change.

**Why QUIC matters for streaming:**
- Head-of-line blocking eliminated (one lost packet doesn't stall entire stream)
- Connection migration survives IP changes (mobile network handoffs)
- BBR congestion control improves throughput on variable connections
- UDP-based NAT traversal is more reliable than TCP hole-punching

---

## 5. Edge Relay Mesh

### 5.1 Architecture

Edge relays are thin forwarders running a stripped-down relay process with only data forwarding logic. They authenticate connections using capability tokens (verify relay signature locally using embedded public key).

```
Edge relay responsibilities:
  ✓ Accept WebSocket connections authenticated by capability tokens
  ✓ Forward bytes between provider and requester
  ✓ Report byte counts to control plane every 5s
  ✓ Honor kill messages from control plane
  ✓ Health reporting to control plane

Edge relay does NOT:
  ✗ Create sessions
  ✗ Issue tokens
  ✗ Run trust logic
  ✗ Store session state beyond active connections
  ✗ Make routing decisions

Initial deployment (Sprint 4):
  Fly.io machines in: US-East, US-West, EU-West, EU-Central,
                      AP-Southeast, AP-Northeast, AF-East
```

### 5.2 Edge Relay Registration and Health

```
On startup, edge relay sends to control plane:
  { relayId, region, publicKey, endpoint }

Control plane maintains:
  Per edge relay:
    last_heartbeat
    active_session_count
    bytes_forwarded_last_minute
    consecutive_failures

If consecutive_failures > 3:
  Remove from routing rotation
  Alert on-call
  Sessions already on this relay fall back to central relay
```

---

## 6. Complete Session Lifecycle

```
PHASE 1: SESSION REQUEST
  Requester → Control Plane: POST /api/session/create
    { country, privateCode?, preferredProvider?, authToken,
      edge_relay_rtts: { ... } }

  Control Plane:
    Authenticate requester (existing flow)
    Check trust scores (provider + requester), roles, billing
    Find eligible provider (existing affinity + health logic)
    Determine transport tier (tier selection algorithm)
    Generate ephemeral ECDH keypair for session
    Generate capability token (signed with relay Ed25519 private key)
    Register session with Verifier
    Return: { capabilityToken, sessionId, verifierEndpoint }

PHASE 2: VERIFIER HANDSHAKE (required, 2s timeout)
  Both sides connect to Verifier using capability token
  Verifier confirms both sides present
  Verifier sends session_ready to control plane
  On timeout: fail-open (Phase 1) or fail-closed (Phase 2)
  Control plane will not allow data plane connection until confirmed

PHASE 3: DATA PLANE ESTABLISHMENT
  Tier 0: existing relay WebSocket flow, unchanged
  Tier 1/2: requester connects directly to provider using capability token
  Tier 3: requester connects to edge relay using capability token,
           edge relay connects to provider using capability token

  Provider validates capability token:
    Verify relay signature (embedded public key, set at build time)
    Verify not expired
    Verify requester identity matches
    Verify transportAttempt sequence
    Accept connection

PHASE 4: ACTIVE SESSION
  Every receiptIntervalSeconds:
    Provider: enforce limits (real-time) → signed receipt → Verifier
    Requester: track bytes → signed receipt → Verifier
    Verifier: cross-check → flag anomalies → kill if threshold exceeded
    Verifier: forward verified totals to relay for billing

  Relay: keepalive pings every 20s to both sides
  Provider: self-terminate if signaling lost > hardExpiryOnSignalingLoss

  Probes (1 per 10 min of active session time, per provider):
    Relay instructs requester to make probe request through normal tunnel
    Verifies probe arrives at relay-controlled endpoint
    Records result

  Forced relay sessions (5% random):
    Relay observes actual throughput
    Cross-checks against provider's historical receipts

PHASE 5: SESSION END
  Trigger: user disconnect, mandate expiry, relay kill, provider self-terminate

  Both sides generate and send final receipts
  Verifier sends session summary to audit log
  Kill Authority confirms termination (logs kill_confirmed)

  Control plane settles billing:
    Primary source: accumulated Verifier-verified provider receipts
    Discrepancy > 5%: flag, use lower of two values
    Discrepancy > 15%: flag, withhold earnings pending review

  Trust scores updated (all dimensions)
  Provider/requester session counts incremented
  Affinity saved (existing logic)
  capability_tokens.used = true
  Session row finalized
```

---

## 7. Database Schema

```sql
-- Device public keys (device-generated, relay stores public only)
CREATE TABLE device_keys (
  device_id           UUID PRIMARY KEY,
  user_id             UUID REFERENCES profiles(id),
  public_key          TEXT NOT NULL,          -- base64 Ed25519 public key
  registered_at       TIMESTAMPTZ NOT NULL,
  last_attested_at    TIMESTAMPTZ,
  attestation_failures INT DEFAULT 0,
  revoked             BOOLEAN DEFAULT FALSE,
  revoked_at          TIMESTAMPTZ,
  revocation_reason   TEXT
);

-- Capability tokens (audit trail)
CREATE TABLE capability_tokens (
  capability_id         UUID PRIMARY KEY,
  session_id            UUID REFERENCES sessions(id),
  issued_at             TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  transport_tier        INT NOT NULL,
  transport_attempt     INT NOT NULL DEFAULT 1,
  previous_attempt_hash TEXT,
  policy_id             TEXT NOT NULL,
  policy_hash           TEXT NOT NULL,
  receipt_interval_seconds INT NOT NULL DEFAULT 10,
  forced_relay_session  BOOLEAN DEFAULT FALSE,
  used                  BOOLEAN DEFAULT FALSE,
  verifier_confirmed    BOOLEAN DEFAULT FALSE
);

-- Session receipts from both sides
CREATE TABLE session_receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID REFERENCES sessions(id),
  capability_id     UUID REFERENCES capability_tokens(capability_id),
  device_id         UUID REFERENCES device_keys(device_id),
  role              TEXT NOT NULL CHECK (role IN ('provider', 'requester')),
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  bytes_reported    BIGINT NOT NULL,
  tunnels_opened    INT,
  active_connections INT,
  blocked_attempts  INT DEFAULT 0,
  nonce             UUID NOT NULL UNIQUE,        -- prevents replay
  signature         TEXT NOT NULL,              -- Ed25519 device sig
  verified          BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trust events (immutable audit log)
CREATE TABLE trust_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID REFERENCES device_keys(device_id),
  event_type    TEXT NOT NULL,
  delta         NUMERIC NOT NULL,
  dimension     TEXT NOT NULL,                  -- which trust dimension
  session_id    UUID REFERENCES sessions(id),
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Multidimensional trust scores
CREATE TABLE trust_scores (
  device_id              UUID PRIMARY KEY REFERENCES device_keys(device_id),
  scalar_score           NUMERIC NOT NULL DEFAULT 1.0,
  transport_reliability  NUMERIC NOT NULL DEFAULT 1.0,
  fraud_risk             NUMERIC NOT NULL DEFAULT 0.0,
  policy_compliance      NUMERIC NOT NULL DEFAULT 1.0,
  network_quality        NUMERIC NOT NULL DEFAULT 1.0,
  session_stability      NUMERIC NOT NULL DEFAULT 1.0,
  peer_diversity         NUMERIC NOT NULL DEFAULT 1.0,
  fraud_risk_score       NUMERIC NOT NULL DEFAULT 0.0,  -- from graph analysis
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Probe results
CREATE TABLE probe_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID REFERENCES sessions(id),
  probe_id         UUID NOT NULL,
  probe_type       TEXT NOT NULL CHECK (probe_type IN ('inband', 'shadow')),
  expected_bytes   BIGINT NOT NULL,
  received_bytes   BIGINT,
  passed           BOOLEAN,
  latency_ms       INT,
  provider_ip_match BOOLEAN,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Edge relay registry
CREATE TABLE edge_relays (
  relay_id           UUID PRIMARY KEY,
  region             TEXT NOT NULL,
  endpoint           TEXT NOT NULL,
  public_key         TEXT NOT NULL,
  active             BOOLEAN DEFAULT TRUE,
  last_heartbeat     TIMESTAMPTZ,
  active_sessions    INT DEFAULT 0,
  consecutive_failures INT DEFAULT 0
);

-- Provider RTT measurements (from heartbeats)
CREATE TABLE provider_rtts (
  device_id     UUID REFERENCES device_keys(device_id),
  relay_id      UUID REFERENCES edge_relays(relay_id),
  rtt_ms        INT NOT NULL,
  measured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, relay_id)
);

-- Kill log
CREATE TABLE kill_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID REFERENCES sessions(id),
  reason       TEXT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  issued_by    TEXT NOT NULL   -- 'verifier', 'admin', 'auto_fraud', etc.
);

-- Indexes
CREATE INDEX idx_session_receipts_session ON session_receipts(session_id, period_start);
CREATE INDEX idx_trust_events_device ON trust_events(device_id, created_at);
CREATE INDEX idx_capability_tokens_session ON capability_tokens(session_id);
CREATE INDEX idx_probe_results_session ON probe_results(session_id);
```

---

## 8. Build Sequence

### Sprint 1 — Trust Plane Foundation
- Device-local Ed25519 key generation (provider + requester)
- Device registration endpoint (stores public key, returns device_id)
- Provider attestation challenge (test session with real content)
- Requester attestation challenge (receipt signing verification)
- Signed receipts at adaptive intervals (schema + generation + verification)
- Verifier service — separate deployment, basic cross-checking
- Multidimensional trust score schema (even if only scalar populated initially)
- Verifier handshake with explicit 2s timeout, fail-open policy
- `DataPlaneTransport` interface defined (not yet implemented with QUIC)
- Redis Streams event bus wired up internally

### Sprint 2 — Capability Tokens + Same-Network Direct
- Capability token issuance with all fields including sequence binding
- `policyHash` + `policyInline` both present from day one
- Same-network detection (public IP matching)
- LAN IP registration in provider heartbeat
- Tier 2 direct for same-network sessions
- Provider-side mandate enforcement (real-time sliding window)
- `hardExpiryOnSignalingLoss` self-termination
- Requester trust scores (symmetric with provider)
- Capability token replaces session ID as auth primitive (Tier 0 unchanged)

### Sprint 3 — Verifier Hardening + Probe Injection
- In-band probe injection (requester-mediated)
- Probe domain pool (200+ domains, rotation policy)
- Forced relay sessions (5% random, `forcedRelaySession` flag)
- Collusion detection — graph batch job (weekly) + response ladder
- Receipt cross-checking with session baseline (60s rolling)
- Trust score dimension population (all six dimensions)
- Graph-based fraud risk score feeding into trust

### Sprint 4 — NAT Traversal + Cross-Network Direct
- STUN-assisted hole-punching (Tier 1)
- Actual RTT measurements in provider heartbeat + session create request
- Tier 1 routing for open/moderate NAT pairs
- Edge relay deployment (US-East, EU-West, AP-Southeast initially)
- Tier 3 routing using actual RTT measurements
- Edge relay health monitoring and failover

### Sprint 5 — Event-Driven Service Extraction
- Extract Trust Service as first independent process
- Extract Accounting Service
- Verifier Service formalized as independent service (already separate)
- Session Service and Kill Authority remain coupled initially
- NATS evaluation (migrate from Redis Streams if volume warrants)

### Sprint 6 — QUIC/WebTransport
- WebTransport implementation behind `DataPlaneTransport` abstraction
- A/B rollout: Tier2 sessions (highest trust, same-network) get QUIC first
- Shadow probe architecture (replaces in-band probes)
- Streaming quality metrics to validate improvement
- Mobile connection migration testing

---

## 9. Security Properties Summary

| Property | Relay-Only | This Architecture |
|---|---|---|
| Enforcement certainty | High (relay enforces) | High (real-time local + relay audit) |
| Billing fraud resistance | Medium (relay is sole counter) | Very High (3-party cross-check) |
| Relay compromise impact | Critical (controls everything) | Medium (Verifier is independent witness) |
| New provider risk | Low (relay enforces regardless) | Low (Tier0-only until 10 sessions + attestation) |
| Streaming quality (LAN) | Poor (relay RTT) | Excellent (sub-1ms direct) |
| Streaming quality (cross-network) | Medium | Good (edge relay or direct) |
| Privacy (HTTPS) | Same (relay sees encrypted bytes) | Same |
| Privacy (HTTP) | Lower (relay sees plaintext) | Higher (relay not in path) |
| Implementation complexity | Low | High (worth it at scale) |

**What no party can do unilaterally:**
- Provider cannot forge receipts (device key required, Verifier cross-checks)
- Provider cannot modify mandate limits (relay signature required)
- Requester cannot connect without valid mandate (relay signature required)
- Either side cannot claim the other misbehaved without signed evidence
- Relay cannot falsely inflate/deflate billing (Verifier holds independent audit log)
- Relay cannot suppress a Verifier anomaly (Verifier reports to independent audit log)

---

*This document supersedes all previous architecture discussions. Every design decision is explicit. Every gap is closed. Build from Sprint 1.*
