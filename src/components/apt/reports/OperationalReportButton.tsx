'use client'

import { useState } from 'react'
import { Clipboard, Download, FileText, Mail } from 'lucide-react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Modal } from '@/components/ui/modal'
import { aptApi } from '@/lib/apt/api'
import { buildOperationalReport, exportOperationalReport, loadCompleteOperationalReportSource, operationalReportEmail, operationalReportValue, type OperationalReport, type OperationalReportSource } from '@/lib/apt/operationalReport'

export function OperationalReportButton({ summary, filters = {}, disabled = false }: { summary: OperationalReportSource; filters?: object; disabled?: boolean }) {
  const [report, setReport] = useState<OperationalReport | null>(null)
  const [kind, setKind] = useState<'executive' | 'operational'>('executive')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showEmail, setShowEmail] = useState(false)
  const [progress, setProgress] = useState('')
  const [snapshot, setSnapshot] = useState<{ summary: OperationalReportSource; filters: object; created: Date } | null>(null)
  function open() {
    try {
      const captured = { summary: structuredClone(summary), filters: structuredClone(filters), created: new Date() }
      setSnapshot(captured); setReport(buildOperationalReport(captured.summary, captured.filters, kind, captured.created)); setError(''); setCopied(false); setShowEmail(false)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo preparar el reporte.') }
  }
  function select(next: typeof kind) {
    setKind(next); setCopied(false)
    if (snapshot) setReport(buildOperationalReport(snapshot.summary, snapshot.filters, next, snapshot.created))
  }
  async function download(format: 'pdf' | 'excel') {
    if (!report || busy) return
    setBusy(true); setError('')
    try { await exportOperationalReport(report, format) } catch { setError('No se pudo descargar el reporte. Vuelva a intentarlo.') } finally { setBusy(false) }
  }
  async function loadComplete() {
    if (!snapshot || busy) return
    setBusy(true); setError(''); setProgress('Consultando el detalle autorizado…')
    try {
      const complete = await loadCompleteOperationalReportSource(snapshot.summary, (f, limit, offset) => aptApi.operationalSummary(f, limit, offset), (loaded, total) => setProgress(`Detalle: ${loaded} de ${total} registros`))
      setSnapshot({ ...snapshot, summary: complete }); setKind('operational'); setReport(buildOperationalReport(complete, snapshot.filters, 'operational', snapshot.created)); setCopied(false)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar el detalle completo.') } finally { setBusy(false); setProgress('') }
  }
  const email = report ? operationalReportEmail(report) : null
  async function copyEmail() {
    if (!email) return
    try { await navigator.clipboard.writeText(`Asunto: ${email.subject}\n\n${email.body}`); setCopied(true); setError('') }
    catch { setError('No se pudo copiar. Puede seleccionar el texto del borrador.') }
  }
  return <>
    <button type="button" disabled={disabled} onClick={open} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#002855]/20 bg-white px-4 text-sm font-semibold text-[#002855] hover:bg-slate-50 disabled:opacity-50"><FileText className="h-4 w-4" />Preparar reporte</button>
    {!report && error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <Modal isOpen={!!report} onClose={() => { if (!busy) { setReport(null); setSnapshot(null) } }} title="Reporte APT · Vista previa" maxWidth="max-w-5xl" footer={<div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy} onClick={() => download('pdf')} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50"><Download className="h-4 w-4" />{busy ? 'Preparando…' : 'Descargar PDF'}</button>
      <button type="button" disabled={busy} onClick={() => download('excel')} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50"><Download className="h-4 w-4" />Descargar Excel</button>
      <button type="button" disabled={busy || (!!snapshot && snapshot.summary.offset === 0 && snapshot.summary.rows.length === snapshot.summary.total)} onClick={loadComplete} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50">{snapshot && snapshot.summary.offset === 0 && snapshot.summary.rows.length === snapshot.summary.total ? 'Detalle completo cargado' : 'Cargar detalle completo'}</button>
      <button type="button" onClick={() => setShowEmail(v => !v)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold"><Mail className="h-4 w-4" />Borrador para gerencia</button>
    </div>}>
      {report && <div className="space-y-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tipo de reporte">{([['executive', 'Ejecutivo'], ['operational', 'Operativo']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => select(value)} className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${kind === value ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-700'}`}>{label}</button>)}</div>
        <header className="rounded-xl bg-[#002855] p-5 text-white"><p className="text-xs font-semibold uppercase tracking-widest text-blue-200">Gerencia de Logística · JRM TMS</p><h3 className="mt-2 text-xl font-bold">{report.title}</h3><p className="mt-2 text-sm">Corte: {report.cutoff || 'Sin dato'} · Generado: {report.generatedAt} (Lima)</p></header>
        <div className="space-y-1 text-sm text-slate-600"><p><strong>Fuente:</strong> {report.source}</p><p><strong>Base:</strong> {report.basis}</p><p><strong>Filtros:</strong> {report.filters}</p><p><strong>Cobertura:</strong> {report.coverage}</p><p className="font-semibold">{report.freshness}</p></div>
        <p className="text-xs text-slate-500">Período: {report.period} · Base de antigüedad: {report.ageBasis} · Versión: {report.version}</p>
        {report.series.length > 0 && <section aria-label="Evolución documental del reporte" className="rounded-xl border border-slate-200 p-3"><h4 className="text-sm font-bold text-[#002855]">Evolución documental del período · TN</h4><div className="mt-3 h-64"><ResponsiveContainer width="100%" height="100%"><LineChart data={report.series}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="fecha" fontSize={10} minTickGap={30} /><YAxis fontSize={10} width={50} /><Tooltip /><Legend /><Line type="linear" dataKey="stock_tn" name="Saldo" stroke="#002855" dot={false} connectNulls={false} /><Line type="linear" dataKey="production_tn" name="Producción" stroke="#059669" dot={false} connectNulls={false} /><Line type="linear" dataKey="dispatch_tn" name="Despacho ERP" stroke="#d97706" dot={false} connectNulls={false} /></LineChart></ResponsiveContainer></div></section>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{report.metrics.map(m => <div key={m.label} className="rounded-xl border border-slate-200 p-3"><p className="text-xs text-slate-600">{m.label}</p><p className="mt-1 text-lg font-bold text-[#002855]">{operationalReportValue(m.value, m.unit)}</p><p className="mt-2 text-xs text-slate-500">{m.formula}</p></div>)}</div>
        <section><h4 className="font-bold text-[#002855]">Hallazgos y acciones</h4><div className="mt-2 space-y-2">{report.findings.map(f => <div key={f.title} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm"><p className="font-semibold">{f.title}</p><p className="mt-1">{f.evidence}</p><p className="mt-1"><strong>Acción:</strong> {f.action}</p></div>)}</div></section>
        <section><h4 className="font-bold text-[#002855]">Detalle incluido</h4><p className="my-2 text-sm text-slate-600">{report.detailScope}</p><div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-slate-100 text-xs text-slate-600"><tr>{['Almacén', 'Lote', 'Cliente', 'Saldo TN', 'Edad días'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{report.rows.map((r, i) => <tr key={`${r.almacen}-${r.lote}-${i}`} className="border-t border-slate-100"><td className="p-3">{r.almacen}</td><td className="p-3 font-semibold">{r.lote}</td><td className="p-3">{r.cliente || 'Sin dato'}</td><td className="p-3">{operationalReportValue(r.stock_tn)}</td><td className="p-3">{operationalReportValue(r.age_days)}</td></tr>)}</tbody></table></div></section>
        <section className="rounded-xl bg-slate-50 p-4"><h4 className="text-sm font-bold">Alcance y límites de lectura</h4><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">{report.limitations.map(l => <li key={l}>{l}</li>)}</ul></section>
        {showEmail && email && <section className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-[#002855]">Borrador de correo</h4><button type="button" onClick={copyEmail} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm"><Clipboard className="h-4 w-4" />{copied ? 'Copiado' : 'Copiar borrador'}</button></div><p className="mt-3 text-sm"><strong>Asunto:</strong> {email.subject}</p><textarea readOnly aria-label="Mensaje para gerencia" value={email.body} className="mt-3 min-h-72 w-full rounded-lg border border-slate-200 p-3 text-sm" /><p className="mt-2 text-xs text-slate-500">Revise el mensaje y adjunte el archivo descargado desde su correo. Su firma habitual se conserva en su cliente de correo.</p></section>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {progress && <p role="status" className="text-sm text-[#002855]">{progress}</p>}
      </div>}
    </Modal>
  </>
}
