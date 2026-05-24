import { redirect } from 'next/navigation'

export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const entry of value) qs.append(key, entry)
    } else if (value !== undefined) {
      qs.set(key, value)
    }
  }
  redirect(`/auth/login${qs.size ? `?${qs.toString()}` : ''}`)
}
