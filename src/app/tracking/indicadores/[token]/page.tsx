'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { Loader2, LogOut, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { publico, type Frecuencia, type Publico } from '@/lib/indicadores/api'
import { fechaHoraTxt, FRECUENCIAS } from '@/lib/indicadores/format'
import { ResumenEquipos } from '@/components/indicadores/KpiCard'

const NAME_KEY = 'jrm:indicadores-viewer-name'
const msg = (e: unknown) => e instanceof Error ? e.message : 'No se pudo consultar los indicadores.'

export default function IndicadoresPublicosPage() {
  const token = String(useParams<{ token: string }>().token || '')
  const [nombre, setNombre] = useState('')
  const [pin, setPin] = useState('')
  // El PIN vive solo en memoria y se reenvía en cada consulta; el nombre se recuerda en la pestaña.
  const acceso = useRef<{ pin: string; nombre: string } | null>(null)
  const [frecuencia, setFrecuencia] = useState<Frecuencia>('MENSUAL')
  const [data, setData] = useState<Publico | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Se lee tras montar (como /tracking/[token]) para no desalinear la hidratación del formulario.
  useEffect(() => { Promise.resolve().then(() => { try { setNombre(n => n || window.sessionStorage.getItem(NAME_KEY) || '') } catch { /* Sin almacenamiento: se vuelve a pedir el nombre. */ } }) }, [])

  const consultar = async (f: Frecuencia, desde: string | null) => {
    if (!acceso.current) return
    setBusy(true)
    try { const d = await publico(token, acceso.current.pin, acceso.current.nombre, f, desde); setData(d); setFrecuencia(f); setError('') }
    catch (e) { const m = msg(e); toast.error(m); if (!data) { acceso.current = null; setError(m) } }
    finally { setBusy(false) }
  }
  const ingresar = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = nombre.trim().replace(/\s+/g, ' ')
    if ((n.match(/\p{L}/gu) || []).length < 3) return setError('Ingrese su nombre (mínimo 3 letras).')
    if (!/^\d{8}$/.test(pin)) return setError('El código de acceso tiene 8 dígitos.')
    try { window.sessionStorage.setItem(NAME_KEY, n) } catch { /* Opcional. */ }
    acceso.current = { pin, nombre: n }
    await consultar(frecuencia, null)
  }
  const salir = () => { acceso.current = null; setData(null); setPin('') }

  return <div className="min-h-screen overflow-x-hidden bg-slate-50">
    <header className="bg-[#002855] text-white"><div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- mismo logo estático que las demás páginas públicas */}
      <img src="/logo-jrm.png" alt="JRM" className="h-8 shrink-0 rounded bg-white object-contain p-0.5" />
      <h1 className="text-lg font-bold sm:text-xl">Indicadores JRM</h1>
      {data && <button onClick={salir} className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/30 px-3 py-1.5 text-sm"><LogOut className="h-4 w-4" aria-hidden />Salir</button>}
    </div></header>
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      {!data ? <form onSubmit={ingresar} className="mx-auto max-w-sm space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">Ingrese su nombre y el código recibido para consultar los indicadores autorizados.</p>
        <label className="block text-sm font-semibold text-slate-700">Nombre<input autoComplete="name" maxLength={80} value={nombre} onChange={e => setNombre(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#002855]" /></label>
        <label className="block text-sm font-semibold text-slate-700">Código de acceso<input type="password" inputMode="numeric" pattern="\d{8}" autoComplete="off" maxLength={8} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} className="mt-1 w-full rounded-lg border px-3 py-2 tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#002855]" /></label>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#002855] py-2.5 font-semibold text-white disabled:opacity-60">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" aria-hidden />}Ingresar</button>
        <p className="text-center text-xs text-slate-400">Acceso de consulta protegido. Puede ser revocado por JRM.</p>
      </form> : <>
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto min-w-0"><p className="text-xs font-semibold uppercase tracking-wider text-[#cf152d]">{data.etiqueta}</p><p className="text-sm text-slate-500">Solo periodos cerrados · consulta de solo lectura</p></div>
          <label className="text-xs font-semibold text-slate-600">Frecuencia<select className="mt-1 block rounded-lg border bg-white px-3 py-2 text-sm" value={frecuencia} disabled={busy} onChange={e => consultar(e.target.value as Frecuencia, null)}>
            {FRECUENCIAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="min-w-0 text-xs font-semibold text-slate-600">Periodo<select className="mt-1 block max-w-full rounded-lg border bg-white px-3 py-2 text-sm" value={data.periodo?.desde || ''} disabled={busy || !data.periodos.length} onChange={e => consultar(frecuencia, e.target.value)}>
            {!data.periodos.length && <option value="">Sin periodos cerrados</option>}
            {data.periodos.map(p => <option key={p.desde} value={p.desde}>{p.etiqueta}</option>)}</select></label>
          {busy && <Loader2 className="mb-2 h-5 w-5 animate-spin text-slate-500" aria-label="Cargando" />}
        </div>
        {data.periodo ? <ResumenEquipos kpis={data.kpis} />
          : <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">Aún no hay periodos cerrados para esta frecuencia.</p>}
      </>}
    </main>
    {data?.periodo && <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-slate-500 sm:px-6">
      Periodo {data.periodo.etiqueta} · versión {data.periodo.version ?? 1} · cerrado el {fechaHoraTxt(data.periodo.cerrado_at)} (hora de Lima)
    </footer>}
  </div>
}
