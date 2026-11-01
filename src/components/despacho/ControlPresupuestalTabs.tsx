import Link from 'next/link'

// Control presupuestal en dos vistas: la partida de cada OT (con desvíos y autorizaciones) y los costos finales por ruta
// (el antiguo Cierre económico, que conserva su dirección para los enlaces existentes).
export function ControlPresupuestalTabs({ active }: { active: 'ot' | 'rutas' }) {
  const tab = (key: 'ot' | 'rutas', href: string, label: string) => <Link href={href} aria-current={active === key ? 'page' : undefined}
    className={`min-h-9 rounded-md px-3 py-2 text-sm font-semibold ${active === key ? 'bg-[#002855] text-white' : 'text-slate-600 hover:text-[#002855]'}`}>{label}</Link>
  return <nav aria-label="Control presupuestal" className="flex w-fit gap-1 rounded-lg bg-slate-100 p-1">
    {tab('ot', '/despacho/control-presupuestal', 'Partidas por OT')}
    {tab('rutas', '/despacho/documentos/economico', 'Costos por ruta')}
  </nav>
}
