import { redirect } from 'next/navigation'
import SoporteTablero from '@/components/mantenimiento/SoporteTablero'

// Soporte Mecánico: tablero del equipo (atención de fallas). El informe mensual, el desempeño por técnico y los plazos
// viven en Reportes y Analítica; los enlaces antiguos con ?tab= se redirigen allí.
export default async function SoportePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  if (typeof params.tab === 'string') redirect(`/reportes?section=desempeno&tab=soporte&supportTab=${encodeURIComponent(params.tab)}`)
  return <SoporteTablero />
}
