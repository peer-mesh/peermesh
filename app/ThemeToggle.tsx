'use client'

import { useEffect } from 'react'

type Theme = 'dark' | 'light'

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const saved = window.localStorage.getItem('peermesh-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ThemeToggle() {
  useEffect(() => {
    const initial = getInitialTheme()
    document.documentElement.dataset.theme = initial
  }, [])

  function toggleTheme() {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    const next = current === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    window.localStorage.setItem('peermesh-theme', next)
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle light or dark mode"
      title="Toggle light or dark mode"
      className="theme-toggle"
    >
      THEME
    </button>
  )
}
