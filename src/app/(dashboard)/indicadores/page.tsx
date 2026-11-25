import { redirect } from 'next/navigation'

// Acceso directo: el módulo vive en Reportes como perspectiva «Indicadores por equipo».
export default async function IndicadoresPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const query = new URLSearchParams({ section: 'indicadores' })
  for (const [key, value] of Object.entries(params)) if (typeof value === 'string' && key !== 'section') query.set(key, value)
  redirect(`/reportes?${query}`)
}
