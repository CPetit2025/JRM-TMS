import { redirect } from 'next/navigation'

// Preserve old bookmarks; the auditor now has a single document workspace.
export default async function DispatchPlanningPage({ searchParams }: {
  searchParams: Promise<{ despacho?: string }>
}) {
  const { despacho } = await searchParams
  const query = new URLSearchParams({ vista: 'salida' })
  if (despacho) query.set('despacho', despacho)
  redirect(`/despacho/documentos?${query.toString()}`)
}
