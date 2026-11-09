'use client'

import { useState } from 'react'
import { ErpLoadPanel } from '@/components/warehouse/ErpLoadPanel'
import WmsReceiptImportPage from '@/app/almacen/apt/etiquetado/page'

// Un solo lugar para las actualizaciones de datos del WMS: los Excel del ERP (stock y contratos) y los ingresos para
// etiquetado. Cada una conserva su robot: ERP → #erp-*; ingresos → /almacen/apt/etiquetado.
const TABS = [
  { key: 'erp', label: 'ERP: stock y contratos', hint: 'Referencia del inventario físico y del modelo de almacén.' },
  { key: 'ingresos', label: 'Ingresos WMS', hint: 'Ingresos del ERP pendientes de etiquetar (Recepción por IPT).' },
] as const

export default function WarehouseUpdatesPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('erp')
  return <div className="w-full space-y-4">
    <header>
      <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Configuración</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Actualizaciones de datos</h1>
      <p className="mt-1 text-sm text-slate-600">Las cargas automáticas y manuales del WMS, en un solo lugar.</p>
    </header>
    <nav aria-label="Actualizaciones" className="flex flex-wrap gap-2 border-b border-slate-200">
      {TABS.map(t => <button key={t.key} type="button" onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined} title={t.hint}
        className={`border-b-2 px-3 py-2 text-sm font-bold ${tab === t.key ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t.label}</button>)}
    </nav>
    {/* Las dos pestañas quedan montadas: cambiar de pestaña no corta ni pierde una carga en curso */}
    <div hidden={tab !== 'erp'}><ErpLoadPanel/></div>
    <div hidden={tab !== 'ingresos'}><WmsReceiptImportPage/></div>
  </div>
}
