'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowRight, Camera, CheckCircle2, Eye, EyeOff, FileCheck2, KeyRound, Loader2, ShieldCheck, Truck } from 'lucide-react'
import { ProviderBrand, ProviderFooter } from '@/components/delivery/ProviderBrand'

const steps = [
  { icon: KeyRound, title: 'Recibe tu acceso', text: 'Transporte de JRM te comparte el enlace, la placa y un código exclusivo para tu servicio.' },
  { icon: Truck, title: 'Consulta tus entregas', text: 'Revisa el cliente y destino. Registra la salida y la llegada cuando correspondan.' },
  { icon: Camera, title: 'Envía la guía firmada', text: 'Adjunta fotos legibles de todas las páginas con la firma o sello de recepción y el número de guía.' },
]

export default function AccesoEntregas() {
  const router = useRouter()
  const [plate, setPlate] = useState(''), [code, setCode] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [showCode, setShowCode] = useState(false)
  return <div className="min-h-dvh bg-[#f3f6fa]">
    <ProviderBrand />
    <main className="mx-auto grid max-w-6xl gap-8 px-5 py-8 sm:px-8 sm:py-12 lg:grid-cols-[1.05fr_1fr] lg:items-start lg:gap-16">
      <section className="space-y-6 lg:pt-5">
        <span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-[#002855]"><FileCheck2 className="h-4 w-4" />Conformidad de entrega</span>
        <div><h1 className="max-w-lg text-3xl font-bold leading-tight text-[#002855] sm:text-4xl">Tu entrega, respaldada con la guía firmada.</h1><p className="mt-4 max-w-lg text-base leading-7 text-slate-600">Registra el sustento de tu servicio para que el Supervisor de Transporte de JRM pueda validar la entrega. Desde tu celular, sin instalar una aplicación ni crear una cuenta.</p></div>
        <ol className="space-y-4" aria-label="Cómo registrar la entrega">{steps.map(({ icon: Icon, title, text }, i) => <li key={title} className="flex gap-4 rounded-xl border border-slate-200 bg-white/80 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-[#002855]"><Icon className="h-5 w-5" /></span><div><h2 className="text-sm font-bold text-[#002855]">{i + 1}. {title}</h2><p className="mt-1 text-sm leading-6 text-slate-600">{text}</p></div>
        </li>)}</ol>
      </section>
      <section aria-labelledby="access-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg shadow-slate-200/50">
        <div className="border-b border-slate-100 px-6 py-6 sm:px-8"><p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500"><ShieldCheck className="h-4 w-4" />Acceso a tu servicio</p><h2 id="access-title" className="mt-3 text-2xl font-bold text-[#002855]">Ingresa con tu placa y código</h2><p className="mt-2 text-sm leading-6 text-slate-600">Usa los datos enviados por el equipo de Transporte de JRM. El código corresponde a este servicio.</p></div>
        <div className="space-y-5 p-6 sm:p-8">
          <form className="space-y-5" onSubmit={async e => {
            e.preventDefault(); if (busy) return; setBusy(true); setError('')
            try {
              const response = await fetch('/api/entregas/acceso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ placa: plate.trim(), codigo: code.trim() }) })
              const result = await response.json()
              if (!response.ok || !result.success || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error(result.error || 'Acceso no válido. Verifica los datos con Transporte de JRM.')
              router.push(`/tracking/entrega/${result.token}`)
            } catch (err) { setError(err instanceof Error ? err.message : 'Sin conexión. Intenta nuevamente.'); setBusy(false) }
          }}>
            <label className="block text-sm font-semibold text-slate-700" htmlFor="provider-plate">Placa de la unidad<input id="provider-plate" required disabled={busy} autoComplete="off" autoCapitalize="characters" spellCheck={false} minLength={5} maxLength={12} value={plate} onChange={e => setPlate(e.target.value.toUpperCase())} className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 text-base uppercase tracking-wide text-[#002855] outline-none focus:border-[#002855] focus:ring-2 focus:ring-blue-100" placeholder="Ej.: AXG-776" /></label>
            <div><label htmlFor="provider-code" className="text-sm font-semibold text-slate-700">Código de acceso</label><div className="relative mt-2"><input id="provider-code" required disabled={busy} type={showCode ? 'text' : 'password'} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={18} value={code} onChange={e => setCode(e.target.value.toUpperCase())} aria-describedby="code-help" className="min-h-12 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 pr-12 text-base tracking-widest text-[#002855] outline-none focus:border-[#002855] focus:ring-2 focus:ring-blue-100" placeholder="Código enviado por JRM" /><button type="button" disabled={busy} aria-label={showCode ? 'Ocultar código' : 'Mostrar código'} onClick={() => setShowCode(v => !v)} className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">{showCode ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}</button></div><p id="code-help" className="mt-2 text-xs leading-5 text-slate-500">¿No tienes el código o venció? Solicítalo al responsable de Transporte de JRM que coordinó tu servicio.</p></div>
            {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            <button disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#002855] px-4 font-bold text-white transition hover:bg-[#003b78] disabled:opacity-60">{busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowRight className="h-5 w-5" />}{busy ? 'Consultando servicio…' : 'Consultar mi servicio'}</button>
          </form>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="flex items-center gap-2 text-sm font-bold text-amber-900"><FileCheck2 className="h-5 w-5 shrink-0" />La guía es obligatoria</h3><p className="mt-2 text-sm leading-6 text-amber-900">Sin la guía firmada y aprobada por el Supervisor de Transporte, el servicio no puede avanzar.</p></div>
          <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />Al enviarla, esa entrega queda bloqueada mientras se valida. Solo una observación o rechazo permite corregirla; las demás entregas pendientes siguen disponibles.</p>
        </div>
      </section>
    </main>
    <ProviderFooter />
  </div>
}
