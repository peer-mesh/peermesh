'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type DevLink = { href: string; label: string; icon: string; exact?: boolean }

const publicLinks: DevLink[] = [
  { href: '/developers', label: 'Overview', icon: 'PM', exact: true },
  { href: '/developers/api-docs', label: 'API Reference', icon: '</>' },
  { href: '/install', label: 'Install', icon: 'GET' },
]

const privateLinks: DevLink[] = [
  { href: '/developers/keys', label: 'API Keys', icon: 'KEY' },
  { href: '/developers/webhooks', label: 'Webhooks', icon: 'HOOK' },
  { href: '/developers/billing', label: 'Billing', icon: '$' },
  { href: '/provider/sessions', label: 'Provider Traffic', icon: 'LOG' },
]

export function useSignedIn() {
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    let mounted = true
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (mounted) setSignedIn(!!session)
    }).catch(() => {})
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session)
    })
    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  return signedIn
}

export function publicDeveloperLinks(pathname: string, signedIn: boolean) {
  return [...publicLinks, ...(signedIn ? privateLinks : [])].map(({ href, label, icon, exact }) => {
    const active = exact ? pathname === href : pathname.startsWith(href)
    return { href, label, icon, active }
  })
}

export function SignedInDeveloperCards() {
  const signedIn = useSignedIn()
  if (!signedIn) return null

  return (
    <>
      {[
        {
          href: '/developers/keys',
          label: 'API Keys',
          desc: 'Issue, rotate, and deactivate scoped API keys. Each key enforces its own tier and RPM cap.',
          tag: 'KEYS',
        },
        {
          href: '/developers/billing',
          label: 'Billing',
          desc: 'Fund your USD wallet, estimate session cost, and withdraw provider earnings via Flutterwave.',
          tag: 'BILLING',
        },
        {
          href: '/developers/webhooks',
          label: 'Webhooks',
          desc: 'Register outbound endpoints for session lifecycle events with signed deliveries and retry logs.',
          tag: 'HOOKS',
        },
      ].map(card => (
        <Link key={card.href} href={card.href} style={{ textDecoration: 'none' }}>
          <div style={{ padding: '20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', cursor: 'pointer' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '8px' }}>
              {card.tag}
            </div>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px', color: 'var(--text)' }}>{card.label}</div>
            <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.7 }}>{card.desc}</div>
          </div>
        </Link>
      ))}
    </>
  )
}
