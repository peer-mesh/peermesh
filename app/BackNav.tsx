'use client'

import { useRouter } from 'next/navigation'

export function BackNav() {
  const router = useRouter()

  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: '24px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
      <button
        type="button"
        onClick={() => router.back()}
        style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', borderRadius: '7px', padding: '8px 11px', cursor: 'pointer', font: 'inherit' }}
      >
        &lt;- BACK
      </button>
    </div>
  )
}
