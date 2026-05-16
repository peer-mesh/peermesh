'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Country = { code: string; name: string; flag: string; region: string }

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', fontSize: '14px', outline: 'none',
  boxSizing: 'border-box',
}

const PAGE_SIZE = 50

function SignupForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [supabase] = useState(() => createClient())

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [username, setUsername] = useState('')
  const [countryCode, setCountryCode] = useState('RW')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Country picker state
  const [countries, setCountries] = useState<Country[]>([])
  const [countryPage, setCountryPage] = useState(1)
  const [countryPages, setCountryPages] = useState(1)
  const [countryLoading, setCountryLoading] = useState(false)
  const [countryError, setCountryError] = useState(false)
  const [countrySearch, setCountrySearch] = useState('')

  const extId = searchParams.get('ext_id')
  const activate = searchParams.get('activate') === '1' || searchParams.get('source') === 'activate'

  const buildConfirmEmailPath = useCallback((emailForPath?: string) => {
    const qs = new URLSearchParams()
    if (extId) qs.set('ext_id', extId)
    if (activate) qs.set('activate', '1')
    if (emailForPath) qs.set('email', emailForPath)
    qs.set('sent', '1')
    return `/auth/confirm-email?${qs.toString()}`
  }, [activate, extId])

  const loadCountries = useCallback(async (page = 1, search = '') => {
    setCountryLoading(true)
    setCountryError(false)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
      if (search) qs.set('q', search)
      const res = await fetch(`/api/countries?${qs}`)
      if (!res.ok) throw new Error('failed')
      const data = await res.json()
      setCountries(data.countries ?? [])
      setCountryPages(data.pages ?? 1)
      setCountryPage(page)
      // Use IP-detected country as default on first load
      if (page === 1 && !search && data.detectedCountry) {
        const detected = (data.countries as Country[]).find(c => c.code === data.detectedCountry)
        if (detected) setCountryCode(detected.code)
      }
    } catch {
      setCountryError(true)
    } finally {
      setCountryLoading(false)
    }
  }, [])

  // Load countries on mount
  useEffect(() => {
    loadCountries(1, '')
  }, [loadCountries])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => loadCountries(1, countrySearch), 300)
    return () => clearTimeout(t)
  }, [countrySearch, loadCountries])

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email, password,
        options: { data: { username, country_code: countryCode } },
      })

      // If user already exists unconfirmed, signUp returns an error or returns a user with no session.
      const alreadyExists =
        signUpError?.message?.toLowerCase().includes('already registered') ||
        signUpError?.message?.toLowerCase().includes('already been registered') ||
        signUpError?.message?.toLowerCase().includes('email not confirmed') ||
        signUpError?.message?.toLowerCase().includes('user already exists')

      if (signUpError && !alreadyExists) throw signUpError

      // signUp sends the code automatically for new users.
      // For already-existing unconfirmed users, send OTP explicitly.
      if (alreadyExists) {
        const { error: otpError } = await supabase.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false },
        })
        if (otpError) throw otpError
      }

      router.push(buildConfirmEmailPath(email))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ width: '100%', maxWidth: '400px' }}>
      <form onSubmit={handleSignup} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label htmlFor="signup-email" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Email
          </label>
          <input
            id="signup-email"
            type="email"
            placeholder="your@email.com"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={inputStyle}
            disabled={loading}
            required
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label htmlFor="signup-password" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Password
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              id="signup-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••"
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
              disabled={loading}
              required
              minLength={8}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? '👁️' : '👁️‍🗨️'}
            </button>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>Minimum 8 characters</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label htmlFor="signup-username" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Username
          </label>
          <input
            id="signup-username"
            placeholder="your_username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            style={inputStyle}
            disabled={loading}
            required
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label htmlFor="signup-country" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Country
          </label>
          {countryLoading ? (
            <div style={{ padding: '10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              Loading countries...
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
          ) : countryError ? (
            <div style={{ padding: '10px', background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.25)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#ff6060', fontSize: '12px' }}>Could not load countries</span>
              <button type="button" onClick={() => loadCountries(countryPage, countrySearch)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)' }}>RETRY</button>
            </div>
          ) : (
            <>
              <input
                style={{ ...inputStyle, marginBottom: '6px' }}
                placeholder="Search country..."
                value={countrySearch}
                onChange={e => setCountrySearch(e.target.value)}
              />
              <select
                id="signup-country"
                style={{ ...inputStyle, cursor: 'pointer' }}
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                disabled={loading}
              >
                {countries.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                ))}
              </select>
              {countryPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                  <button type="button" disabled={countryPage <= 1} onClick={() => loadCountries(countryPage - 1, countrySearch)} style={{ background: 'none', border: '1px solid var(--border)', color: countryPage <= 1 ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '4px 10px', fontSize: '11px', cursor: countryPage <= 1 ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)' }}>← PREV</button>
                  <span style={{ fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>{countryPage} / {countryPages}</span>
                  <button type="button" disabled={countryPage >= countryPages} onClick={() => loadCountries(countryPage + 1, countrySearch)} style={{ background: 'none', border: '1px solid var(--border)', color: countryPage >= countryPages ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '4px 10px', fontSize: '11px', cursor: countryPage >= countryPages ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)' }}>NEXT →</button>
                </div>
              )}
            </>
          )}
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.2)', borderRadius: '8px', color: 'var(--danger)', fontSize: '12px' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !email || !password || !username}
          style={{
            padding: '13px', background: (loading || !email || !password || !username) ? 'var(--muted)' : 'var(--accent)',
            color: '#000', border: 'none', borderRadius: '10px',
            fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700,
            letterSpacing: '0.5px', cursor: (loading || !email || !password || !username) ? 'not-allowed' : 'pointer', marginTop: '4px'
          }}
        >
          {loading ? 'CREATING ACCOUNT...' : 'CREATE ACCOUNT'}
        </button>
      </form>
    </div>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  )
}
