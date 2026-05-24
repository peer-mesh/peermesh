import type { ApiKeyTier, ApiSessionMode, PeerMeshRole } from '@/lib/billing'

export type SyncState = {
  state_actor: string | null
  state_changed_at: string | null
}

export type Profile = {
  id: string
  username: string | null
  role: PeerMeshRole
  country_code: string
  trust_score: number
  is_verified: boolean
  verified_at: string | null
  phone_number: string | null
  gov_id_verified: boolean
  is_premium: boolean
  subscription_status: string
  stripe_customer_id: string | null
  is_sharing: boolean
  total_bytes_shared: number
  total_bytes_used: number
  bandwidth_used_month: number
  bandwidth_limit: number
  preferred_providers: Record<string, string>
  has_accepted_provider_terms: boolean
  daily_share_limit_mb: number | null
  contribution_credits_bytes: number
  wallet_balance_usd: number
  outstanding_balance_usd: number | null
  wallet_pending_payout_usd: number
  payout_currency: string | null
  created_at: string
  updated_at: string
} & SyncState

export type PrivateShare = {
  device_id: string
  base_device_id: string
  slot_index: number | null
  code: string
  enabled: boolean
  expires_at: string | null
  active: boolean
} & SyncState

export type Session = {
  id: string
  user_id: string
  provider_id: string | null
  provider_kind: string | null
  provider_device_id: string | null
  provider_base_device_id: string | null
  target_country: string
  target_host: string | null
  target_hosts: string[]
  relay_endpoint: string | null
  status: 'pending' | 'active' | 'ended' | 'flagged'
  bytes_used: number
  signed_receipt: string | null
  disconnect_reason: string | null
  started_at: string
  ended_at: string | null
}

export type PeerAvailability = {
  country: string
  count: number
}

export type WalletLedgerEntry = {
  id: string
  user_id: string
  kind: 'credit' | 'debit' | 'payment' | 'payout' | 'refund' | 'bonus' | 'contribution_credit'
  amount_usd: number
  currency: string
  reference: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export type ApiKeyRecord = {
  id: string
  user_id: string
  name: string
  key_prefix: string
  tier: ApiKeyTier
  rpm_limit: number
  session_mode: ApiSessionMode
  requires_verification: boolean
  is_active: boolean
  last_used_at: string | null
  created_at: string
}
