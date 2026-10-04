import { redirect } from 'next/navigation'

// Compatibilidad con campana, favoritos y enlaces anteriores.
export default async function DesempenoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const query = new URLSearchParams({ section: 'desempeno' })
  for (const [key, value] of Object.entries(params)) if (typeof value === 'string' && key !== 'section') query.set(key, value)
  redirect(`/reportes?${query}`)
}
