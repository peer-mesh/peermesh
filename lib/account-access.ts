import { canRoleUseNetwork, getUsageRoleError, normalizePeerMeshRole } from './roles.ts'

export type ConnectionAccessProfile = {
  role?: string | null
  is_verified?: boolean | null
  is_sharing?: boolean | null
  is_premium?: boolean | null
  wallet_balance_usd?: number | string | null
  contribution_credits_bytes?: number | string | null
}

export type ConnectionAccessMode = 'public' | 'private'

export type ConnectionAccessRequirement = {
  ok: boolean
  code: 'phone_verification_required' | 'usage_access_required' | 'role_not_allowed' | null
  error: string | null
  nextStep: '/verify/phone' | '/developers/billing' | null
}

export function hasPaidAccess(profile: ConnectionAccessProfile | null | undefined): boolean {
  return Number(profile?.wallet_balance_usd ?? 0) > 0
    || Number(profile?.contribution_credits_bytes ?? 0) > 0
}

export function hasUsageAccess(profile: ConnectionAccessProfile | null | undefined): boolean {
  return hasPaidAccess(profile) || !!profile?.is_sharing
}

export function getConnectionAccessRequirement(
  profile: ConnectionAccessProfile | null | undefined,
  options: {
    mode?: ConnectionAccessMode
  } = {},
): ConnectionAccessRequirement {
  const mode = options.mode === 'private' ? 'private' : 'public'

  if (!profile?.is_verified) {
    return {
      ok: false,
      code: 'phone_verification_required',
      error: 'Verify your phone to connect to providers.',
      nextStep: '/verify/phone',
    }
  }

  if (!canRoleUseNetwork(profile?.role)) {
    return {
      ok: false,
      code: 'role_not_allowed',
      error: getUsageRoleError(profile?.role),
      nextStep: null,
    }
  }

  if (mode === 'private') {
    return {
      ok: true,
      code: null,
      error: null,
      nextStep: null,
    }
  }

  const role = normalizePeerMeshRole(profile?.role)
  if (role === 'client' && !hasPaidAccess(profile)) {
    return {
      ok: false,
      code: 'usage_access_required',
      error: 'Client mode can only connect publicly with a funded USD wallet or contribution credits. Switch to Peer and share, or fund your wallet.',
      nextStep: '/developers/billing',
    }
  }

  if (!hasUsageAccess(profile)) {
    return {
      ok: false,
      code: 'usage_access_required',
      error: 'Public browsing requires an active Peer share, contribution credits, or a funded USD wallet. Private-code sessions are not restricted by this.',
      nextStep: '/developers/billing',
    }
  }

  return {
    ok: true,
    code: null,
    error: null,
    nextStep: null,
  }
}
