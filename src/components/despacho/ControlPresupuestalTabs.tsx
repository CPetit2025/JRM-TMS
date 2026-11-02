import Link from 'next/link'

// Control presupuestal: la posición de cada OT, los movimientos que la explican, lo pendiente (con desvíos y autorizaciones)
// y los costos finales por ruta (el antiguo Cierre económico, que conserva su dirección para los enlaces existentes).
type Tab = 'ot' | 'movimientos' | 'pendientes' | 'ahorro' | 'rutas'
export function ControlPresupuestalTabs({ active, ot }: { active: Tab; ot?: string | null }) {
  const keep = ot ? `?ot=${ot}` : ''
  const tab = (key: Tab, href: string, label: string) => <Link href={href} aria-current={active === key ? 'page' : undefined}
    className={`min-h-9 whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold ${active === key ? 'bg-[#002855] text-white' : 'text-slate-600 hover:text-[#002855]'}`}>{label}</Link>
  return <nav aria-label="Control presupuestal" className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 sm:w-fit">
    {tab('ot', '/despacho/control-presupuestal', 'Resumen por OT')}
    {tab('movimientos', `/despacho/control-presupuestal/movimientos${keep}`, 'Movimientos')}
    {tab('pendientes', '/despacho/control-presupuestal/pendientes', 'Pendientes y autorizaciones')}
    {tab('ahorro', '/despacho/control-presupuestal/ahorro', 'Ahorro por consolidación')}
    {tab('rutas', '/despacho/documentos/economico', 'Costos por ruta')}
  </nav>
}
