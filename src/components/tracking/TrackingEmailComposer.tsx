'use client'

import { useState } from 'react'
import Image from 'next/image'
import { ArrowLeft, Copy, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { trackingEmailTemplate, trackingEmailUrl, type EmailClient } from '@/lib/tracking-email'

export function TrackingEmailComposer({ label, link, pin, onBack }: {
  label: string; link: string; pin: string; onBack: () => void
}) {
  const [draft, setDraft] = useState(() => ({ to: '', cc: '', ...trackingEmailTemplate(label, link, pin) }))
  const [error, setError] = useState('')
  const field = (name: keyof typeof draft, value: string) => { setDraft(p => ({ ...p, [name]: value })); setError('') }
  const openDraft = (client: EmailClient) => {
    try {
      const href = trackingEmailUrl(client, draft)
      setError('')
      if (client === 'default') window.location.href = href
      else window.open(href, '_blank', 'noopener,noreferrer')
    } catch (e) { setError(e instanceof Error ? e.message : 'Revisa los datos del correo.') }
  }
  return <section className="space-y-4">
    <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#002855]"><ArrowLeft className="h-4 w-4" />Volver al acceso</button>
    <div><h3 className="text-lg font-bold text-[#002855]">Compartir por correo</h3><p className="mt-1 text-sm text-slate-600">Revisa la vista previa y abre un borrador para enviarlo desde tu cuenta. No añadimos firma; utiliza la configurada en tu correo.</p></div>
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-3">
        <label className="block text-sm font-semibold text-slate-700">Para *<input value={draft.to} onChange={e => field('to', e.target.value)} placeholder="gerencia@empresa.com" autoComplete="off" className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-normal" /></label>
        <label className="block text-sm font-semibold text-slate-700">CC · opcional<input value={draft.cc} onChange={e => field('cc', e.target.value)} placeholder="logistica@empresa.com" autoComplete="off" className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-normal" /></label>
        <p className="text-xs text-slate-500">Separa varios correos con coma o punto y coma. Comparte el código solo con los destinatarios autorizados.</p>
        <label className="block text-sm font-semibold text-slate-700">Asunto<input value={draft.subject} onChange={e => field('subject', e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-normal" /></label>
        <label className="block text-sm font-semibold text-slate-700">Mensaje<textarea value={draft.body} onChange={e => field('body', e.target.value)} rows={16} className="mt-1 w-full rounded-lg border border-slate-300 p-3 text-sm font-normal leading-6" /></label>
      </div>
      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-3 border-b bg-slate-50 px-5 py-4"><Image src="/logo-jrm.png" alt="JRM" width={100} height={48} className="h-10 w-auto object-contain" /><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Vista previa del mensaje</span></div>
        <div className="border-b px-5 py-3"><p className="text-xs text-slate-500">Asunto</p><p className="break-words text-sm font-semibold text-[#002855]">{draft.subject}</p></div>
        <p className="whitespace-pre-wrap break-words p-5 text-sm leading-6 text-slate-700">{draft.body}</p>
        <p className="border-t bg-slate-50 px-5 py-3 text-xs text-slate-500">El borrador contiene el texto y el enlace. El formato final depende de tu cliente de correo.</p>
      </div>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <button type="button" onClick={() => openDraft('outlook')} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Mail className="h-4 w-4" />Abrir en Outlook</button>
      <button type="button" onClick={() => openDraft('default')} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855]">Abrir en mi correo</button>
      <button type="button" onClick={() => openDraft('gmail')} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855]">Abrir en Gmail</button>
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(draft.body); toast.success('Mensaje copiado') } catch { toast.error('No se pudo copiar el mensaje') } }} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700"><Copy className="h-4 w-4" />Copiar texto</button>
    </div>
  </section>
}
