import { Suspense } from 'react'
import Reportes from '@/components/analytics/Reportes'

export default function ReportesPage() {
  return <Suspense fallback={<p className="p-8 text-sm text-slate-500">Cargando Reportes y Analítica…</p>}><Reportes /></Suspense>
}
