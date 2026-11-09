'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ArrowRight, ClipboardList, Hourglass, Package, PackageCheck, ScanLine, Tag, TriangleAlert, RefreshCw, Truck } from 'lucide-react'

type Counts = { toLabel: number | null; receipts: number; tasks: number; pending: number; picking: number; packing: number; load: number; packages: number; discrepancies: number }
const empty: Counts = { toLabel: null, receipts: 0, tasks: 0, pending: 0, picking: 0, packing: 0, load: 0, packages: 0, discrepancies: 0 }
const CLOSED = '("LOADED","RECONCILED","CANCELLED")'

export default function WarehouseHome() {
  const [counts,setCounts]=useState(empty); const [loading,setLoading]=useState(true); const [error,setError]=useState('')
  useEffect(()=>{ let live=true; const load=async()=>{
    const db=createClient()
    // Conteos en la base (head): no descargan filas ni se cortan en el máximo de 1.000 de la API.
    const tasks=()=>db.from('wh_tasks').select('id',{count:'exact',head:true})
    const [results,inbox]=await Promise.all([Promise.all([
      db.from('wh_receipt_sources').select('source_key',{count:'exact',head:true}).eq('active',true),
      tasks().not('status','in',CLOSED),
      tasks().in('status',['PENDING','PARTIAL']),
      tasks().eq('status','PICKING'),
      tasks().eq('status','PACKING'),
      tasks().eq('status','READY_FOR_LOAD'),
      db.from('wh_packages').select('id',{count:'exact',head:true}).neq('status','VOID'),
      db.from('wh_reconciliation').select('id',{count:'exact',head:true}).in('status',['OPEN','SHORT','OVER']),
    ]),
    // Solo quien etiqueta puede consultar la bandeja; sin ese permiso se muestra el total de ingresos.
    db.rpc('wh_receipt_candidates',{p_query:''})])
    if(!live)return
    const e=results.find(r=>r.error)?.error
    if(e){setError(/does not exist|schema cache/i.test(e.message)?'La estructura de datos del Portal WMS no está disponible. Avise a soporte para revisar las migraciones de esta base.':'No se pudieron cargar los indicadores del almacén. Actualice la página; si persiste, avise a soporte.');setLoading(false);return}
    const [receipts,active,pending,picking,packing,ready,pkg,diff]=results.map(r=>r.count||0)
    const toLabel=inbox.error||!Array.isArray(inbox.data)?null:(inbox.data as {label_status?:string}[]).filter(x=>x.label_status==='NOT_LABELED').length
    setCounts({toLabel,receipts,tasks:active,pending,picking,packing,load:ready,packages:pkg,discrepancies:diff});setLoading(false)
  };void load();return()=>{live=false}},[])
  const reception=counts.toLabel===null?['Ingresos ERP vigentes',counts.receipts,Tag] as const:['Ingresos por etiquetar',counts.toLabel,Tag] as const
  const kpis=[reception,['Tareas activas',counts.tasks,ClipboardList],['Tareas pendientes',counts.pending,Hourglass],['En picking',counts.picking,ScanLine],['En packing',counts.packing,Package],['Listas para carga',counts.load,Truck]] as const
  const quick=[['Actualizaciones de datos','/almacen/actualizaciones','Cargas del ERP (stock y contratos) e ingresos para etiquetado, en un solo lugar.',RefreshCw],['01 · Recepción por IPT','/almacen/etiquetado','Selecciona un ingreso vigente del actualizable y genera paquetes trazables.',ScanLine],['Tareas','/almacen/tareas','Consulta solicitudes, picking, packing y carga.',ClipboardList],['Paquetes y LPN','/almacen/paquetes','Ubica estado, tarea, movimientos y lecturas.',PackageCheck],['Conciliación','/almacen/conciliacion','Compara las salidas ERP activas con los paquetes WMS cargados.',TriangleAlert]] as const
  const dash=(n:number)=>loading||error?'—':n
  return <div className="space-y-4 sm:space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-blue-700">Operaciones de almacén · WMS</p><h1 className="mt-1 text-3xl font-black tracking-tight text-[#002855]">Centro de operaciones</h1><p className="mt-1 text-sm text-slate-600">Recepción, preparación y despacho con trazabilidad por paquete y pallet.</p></div><Link href="/almacen/tareas" className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white">Ver tareas <ArrowRight size={16}/></Link></div>
    {error&&<div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{error}</div>}
    <section className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-6">{kpis.map(([name,value,Icon])=><article key={name} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4"><div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500 sm:text-sm">{name}</span><Icon size={18} className="shrink-0 text-blue-700"/></div><div className="mt-1 text-2xl font-black sm:mt-2 sm:text-3xl text-[#002855]">{dash(value)}</div></article>)}</section>
    {/* 3 accesos arriba y 2 abajo a lo ancho, sin huecos */}
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">{quick.map(([name,href,desc,Icon],i)=><Link key={href} href={href} className={`group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow ${i<3?'lg:col-span-2':'lg:col-span-3'} ${i===4?'sm:col-span-2 lg:col-span-3':''}`}><span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-50 text-[#005a9c]"><Icon size={20}/></span><h2 className="mt-4 flex items-center justify-between font-bold text-[#002855]">{name}<ArrowRight size={16} className="opacity-50 transition group-hover:translate-x-1"/></h2><p className="mt-2 text-sm leading-6 text-slate-600">{desc}</p></Link>)}</section>
    <section className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]"><article className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-bold text-[#002855]">Flujo de operación</h2><div className="mt-5 flex flex-wrap items-center gap-2 text-sm">{['Recepción','Etiquetado','Ubicación','Picking','Packing / LPN','Carga','Conciliación'].map((step,i)=><span key={step} className="flex items-center gap-2"><span className="rounded-full bg-blue-50 px-3 py-2 font-semibold text-blue-900">{step}</span>{i<6&&<span className="text-slate-400">→</span>}</span>)}</div><p className="mt-4 text-xs text-slate-500">Cada lectura registra quién, cuándo, qué código y en qué tarea. La carga de datos ERP se concilia sin reemplazar el libro de origen.</p></article><article className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-bold text-[#002855]">Estado de datos</h2><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-slate-50 p-3"><span className="text-slate-500">Ingresos ERP vigentes</span><b className="mt-1 block text-xl">{dash(counts.receipts)}</b></div><div className="rounded-lg bg-slate-50 p-3"><span className="text-slate-500">Paquetes activos</span><b className="mt-1 block text-xl">{dash(counts.packages)}</b></div><div className={`col-span-2 rounded-lg p-3 ${counts.discrepancies?'bg-amber-50':'bg-slate-50'}`}><span className="text-slate-500">Diferencias abiertas</span><b className="mt-1 block text-xl">{dash(counts.discrepancies)}</b></div></div><Link href="/almacen/conciliacion" className="mt-4 inline-flex text-sm font-semibold text-blue-800 underline">Revisar conciliación</Link></article></section>
  </div>
}
