import Link from 'next/link'
import { redirect } from 'next/navigation'
import { MiAvanceWidget } from '@/components/kpi/MiAvance'

export default async function SoportePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  if (typeof params.tab === 'string') redirect(`/reportes?section=desempeno&tab=soporte&supportTab=${encodeURIComponent(params.tab)}`)
  return <div className="space-y-4"><h1 className="text-2xl font-bold text-[#002855]">Soporte Mecánico</h1><p className="text-sm text-slate-500">Su avance del mes en lectura. Los informes, la revisión de equipo y los plazos están en Reportes y Analítica.</p><MiAvanceWidget /><div className="flex gap-4 text-sm font-semibold text-[#002855]"><Link href="/mantenimiento/fallas">Atender fallas →</Link><Link href="/reportes?section=desempeno&tab=soporte">Informes y seguimiento →</Link></div></div>
}
