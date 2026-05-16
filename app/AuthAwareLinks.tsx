'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type AuthAwareLinksProps = {
  style?: React.CSSProperties
  linkStyle?: React.CSSProperties
  includeTraffic?: boolean
}

export function AuthAwareLinks({ style, linkStyle, includeTraffic = true }: AuthAwareLinksProps) {
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

  return (
    <span style={style}>
      <Link href="/install" style={linkStyle}>INSTALL</Link>
      <Link href="/developers" style={linkStyle}>DEVELOPERS</Link>
      {signedIn && includeTraffic ? <Link href="/provider/sessions" style={linkStyle}>TRAFFIC</Link> : null}
      {signedIn ? <Link href="/dashboard" style={linkStyle}>DASHBOARD</Link> : <Link href="/auth/login" style={linkStyle}>SIGN IN</Link>}
    </span>
  )
}
