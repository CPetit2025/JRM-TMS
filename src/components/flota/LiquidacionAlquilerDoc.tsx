'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, Check, Copy, Download, Loader2, Mail, Printer, Send, Share2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'

// Liquidación de alquiler seco: documento A4 para presentar y enviar al arrendador (migración 20261005130000).
// Página 1: partes, resumen, condiciones, cálculo con fórmula, control de recorrido y firmas. Anexo: detalle de viajes.
// El PDF se arma con las mismas páginas (html-to-image + jsPDF) y el envío registra fecha, destinatarios y usuario.

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const NAVY = '#002855'
const ORANGE = '#f5a000'
const INK = '#1e293b'
const MUTED = '#64748b'
const LINE = '#e2e8f0'
const SOFT = '#f1f5f9'
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']
const VIAJES_POR_PAGINA = 32

const num = (n: unknown, d = 2) => Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
const soles = (n: unknown) => `S/ ${num(n)}`
const km = (n: unknown) => Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 2 })
const fecha = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—')
const fechaHora = (d?: string | null) => (d ? new Date(d).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
export const mesDe = (d: string) => { const [y, m] = d.slice(0, 7).split('-').map(Number); return `${MESES[m - 1]} ${y}` }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const titulo = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase())

// ------------------------------------------------------------
// Importe en letras (comprobantes peruanos: "SON: ... CON 46/100 SOLES")
// ------------------------------------------------------------
const U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE',
  'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO',
  'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE']
const D = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA']
const C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS']
function menorMil(n: number): string {
  if (n === 100) return 'CIEN'
  const c = Math.floor(n / 100), r = n % 100
  const dec = r < 30 ? U[r] : D[Math.floor(r / 10)] + (r % 10 ? ' Y ' + U[r % 10] : '')
  return [C[c], dec].filter(Boolean).join(' ')
}
export function enLetras(monto: number): string {
  const entero = Math.floor(Math.round(monto * 100) / 100)
  const cent = Math.round((monto - entero) * 100)
  const mill = Math.floor(entero / 1_000_000), miles = Math.floor((entero % 1_000_000) / 1000), resto = entero % 1000
  const partes = [
    mill ? (mill === 1 ? 'UN MILLÓN' : `${menorMil(mill)} MILLONES`) : '',
    miles ? (miles === 1 ? 'MIL' : `${menorMil(miles)} MIL`) : '',
    resto ? menorMil(resto) : '',
  ].filter(Boolean)
  const texto = (partes.join(' ') || 'CERO').replace(/UNO MIL/g, 'UN MIL')
  return `${texto} CON ${String(cent).padStart(2, '0')}/100 SOLES`
}

// ------------------------------------------------------------
// Documento
// ------------------------------------------------------------
type Doc = { settlement: Row; calc: Row; contract: Row; vehicle: Row; lessor: Row; company: Row; created_by_name?: string; approved_by_name?: string; signature_url?: string; sends: Row[] }

const FUENTE: Record<string, string> = {
  VALORIZACION: 'Valorización del arrendador (registro de viajes del mes)',
  RUTA: 'Rutas del sistema: odómetro del checklist o GPS de la app por viaje',
  ODOMETRO: 'Lecturas de odómetro del periodo',
}

function Th({ children, right, w }: { children: React.ReactNode; right?: boolean; w?: number }) {
  return <th style={{ textAlign: right ? 'right' : 'left', padding: '6px 8px', fontWeight: 600, fontSize: 10, color: '#fff', background: NAVY, width: w }}>{children}</th>
}
function Td({ children, right, bold, muted, bg, clip }: { children: React.ReactNode; right?: boolean; bold?: boolean; muted?: boolean; bg?: string; clip?: boolean }) {
  return <td style={{ textAlign: right ? 'right' : 'left', padding: '5px 8px', borderBottom: `1px solid ${LINE}`, fontWeight: bold ? 700 : 400, color: muted ? MUTED : INK, background: bg, verticalAlign: 'top',
    ...(clip ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}) }}>{children}</td>
}
function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ background: ORANGE, color: NAVY, fontWeight: 800, fontSize: 10, borderRadius: 3, padding: '1px 6px' }}>{n}</span>
        <span style={{ color: NAVY, fontWeight: 700, fontSize: 12, letterSpacing: 0.3, textTransform: 'uppercase' }}>{title}</span>
        <span style={{ flex: 1, height: 1, background: LINE }} />
      </div>
      {children}
    </div>
  )
}

function Page({ children, n, total, docNo, draft }: { children: React.ReactNode; n: number; total: number; docNo: string; draft: boolean }) {
  return (
    <div data-page style={{ width: 794, minHeight: 1123, background: '#fff', color: INK, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 11, lineHeight: 1.35,
      padding: '34px 40px 28px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }} className="liq-page">
      {draft && (
        <div style={{ position: 'absolute', top: 430, left: -40, width: 900, textAlign: 'center', transform: 'rotate(-30deg)', fontSize: 110, fontWeight: 800,
          color: 'rgba(207,21,45,0.07)', letterSpacing: 12, pointerEvents: 'none' }}>BORRADOR</div>
      )}
      <div style={{ flex: 1, position: 'relative' }}>{children}</div>
      <div style={{ borderTop: `1px solid ${LINE}`, marginTop: 12, paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: MUTED }}>
        <span>{docNo} · Documento generado por JRM TMS</span><span>Página {n} de {total}</span>
      </div>
    </div>
  )
}

function Header({ d, docNo, small }: { d: Doc; docNo: string; small?: boolean }) {
  const s = d.settlement
  const estado = s.status === 'APROBADA' ? ['APROBADA', '#047857', '#d1fae5'] : s.status === 'ANULADA' ? ['ANULADA', '#475569', SOFT] : ['BORRADOR · por aprobar', '#b45309', '#fef3c7']
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', borderBottom: `3px solid ${NAVY}`, paddingBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-jrm.png" alt="JRM" style={{ height: small ? 34 : 46, width: small ? 70 : 96, objectFit: 'cover', objectPosition: 'left center' }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: small ? 11 : 13, color: NAVY }}>{d.company.name}</div>
          {d.company.ruc && <div style={{ fontSize: 10, color: MUTED }}>RUC {d.company.ruc}</div>}
          {d.company.address && !small && <div style={{ fontSize: 10, color: MUTED }}>{d.company.address}</div>}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontWeight: 800, fontSize: small ? 12 : 15, color: NAVY, letterSpacing: 0.3 }}>{small ? 'ANEXO · DETALLE DE VIAJES' : 'VALORIZACIÓN Y LIQUIDACIÓN DE ALQUILER'}</div>
        <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>N.° <b style={{ color: INK }}>{docNo}</b> · Emitido {fecha(new Date().toISOString())}</div>
        {!small && <span style={{ display: 'inline-block', marginTop: 5, fontSize: 9, fontWeight: 700, color: estado[1], background: estado[2], borderRadius: 10, padding: '2px 8px' }}>{estado[0]}</span>}
      </div>
    </div>
  )
}

export function LiquidacionDocumento({ d }: { d: Doc }) {
  const s = d.settlement, c = { ...s, ...(d.calc || {}) }
  const docNo = `${d.contract.code || 'LIQ'}-${String(s.period_start).slice(0, 7).replace('-', '')}`
  const draft = s.status !== 'APROBADA'
  const viajes: Row[] = Array.isArray(c.viajes) ? c.viajes : []
  const pagesAnexo: Row[][] = []
  for (let i = 0; i < viajes.length; i += VIAJES_POR_PAGINA) pagesAnexo.push(viajes.slice(i, i + VIAJES_POR_PAGINA))
  const total = 1 + pagesAnexo.length
  const incl = Number(c.included_km || 0), used = Number(c.km_used || 0)
  const pct = incl ? Math.min(used / incl, 1.25) : 0
  const rate = Number(c.excess_km_rate || 0)
  const mensual = d.contract.rate_type === 'MENSUAL'
  const periodo = `${fecha(s.period_start)} al ${fecha(s.period_end)}`
  const [py, pm] = String(s.period_start).slice(0, 7).split('-').map(Number)
  const diasMes = new Date(py, pm, 0).getDate()
  const control = c.km_gps != null ? Number(c.km_gps) : (Number(c.km_odometro || 0) || null)
  const unidad = [d.vehicle.plate, [d.vehicle.brand, d.vehicle.model].filter(Boolean).join(' '), d.vehicle.type].filter(Boolean).join(' · ')

  const calc: Array<[string, string, number, boolean?]> = [
    [`Alquiler ${mensual ? 'mensual' : d.contract.rate_type?.toLowerCase()} sin IGV`,
      mensual ? (Number(s.days) >= diasMes ? `Mes completo (${s.days} días)` : `${soles(d.contract.rate_amount)} × ${s.days} ÷ ${diasMes} días`) : `Tarifa ${soles(d.contract.rate_amount)}`, Number(c.base_amount)],
    ['Km adicionales', incl ? `${km(c.excess_km)} km × S/ ${num(rate, 4)} (sobre ${km(incl)} km incluidos)` : 'Sin km incluidos pactados', Number(c.excess_km_amount)],
  ]
  if (Number(c.excess_hours_amount)) calc.push(['Horas adicionales', `${km(c.excess_hours)} h`, Number(c.excess_hours_amount)])
  if (Number(c.downtime_discount)) calc.push(['Descuento por indisponibilidad', `${km(c.downtime_days)} días × ${soles(c.costo_diario)}`, -Number(c.downtime_discount)])
  if (Number(c.other_discounts)) calc.push(['Otros descuentos', 'Según sustento', -Number(c.other_discounts)])
  if (Number(c.penalties)) calc.push(['Penalidades', 'Según contrato', Number(c.penalties)])
  if (Number(c.consumptions)) calc.push(['Consumos', 'Según sustento', Number(c.consumptions)])
  if (Number(c.additional_costs)) calc.push(['Costos adicionales', 'Según sustento', Number(c.additional_costs)])

  const kpis: Array<[string, string, string]> = [
    ['Km recorridos', km(used), incl ? `de ${km(incl)} incluidos` : FUENTE[c.km_fuente] ? 'en el periodo' : ''],
    ['Km adicionales', km(c.excess_km), rate ? `a S/ ${num(rate, 4)} c/u` : '—'],
    ['Días con viajes', String(c.dias_laborados ?? '—'), `${viajes.length} viajes · ${s.days} días del periodo`],
  ]

  return (
    <div className="liq-doc" style={{ display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center' }}>
      <Page n={1} total={total} docNo={docNo} draft={draft}>
        <Header d={d} docNo={docNo} />

        {/* Partes y periodo */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          {[
            ['Arrendador', d.lessor.name || '—', [d.lessor.ruc ? `RUC ${d.lessor.ruc}` : 'RUC por completar', d.lessor.contact, d.lessor.email].filter(Boolean).join(' · ')],
            ['Arrendatario', d.company.name, [d.company.ruc ? `RUC ${d.company.ruc}` : '', d.company.address].filter(Boolean).join(' · ') || 'Usuario de la unidad'],
            ['Unidad', unidad, `Alquiler seco (sin conductor ni combustible) · Contrato ${d.contract.code}`],
            ['Periodo liquidado', `${cap(mesDe(s.period_start))}`, `${periodo} · ${s.days} días`],
          ].map(([k, v, sub]) => (
            <div key={k} style={{ border: `1px solid ${LINE}`, borderLeft: `3px solid ${NAVY}`, borderRadius: 4, padding: '7px 10px' }}>
              <div style={{ fontSize: 9, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</div>
              <div style={{ fontWeight: 700, fontSize: 12, marginTop: 1 }}>{v}</div>
              <div style={{ fontSize: 9.5, color: MUTED, marginTop: 1 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Resumen */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.25fr', gap: 8, marginTop: 12 }}>
          {kpis.map(([k, v, sub]) => (
            <div key={k} style={{ background: SOFT, borderRadius: 4, padding: '8px 10px' }}>
              <div style={{ fontSize: 9, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: INK, marginTop: 2 }}>{v}</div>
              <div style={{ fontSize: 9, color: MUTED }}>{sub}</div>
              {k === 'Km recorridos' && incl > 0 && (
                <div style={{ marginTop: 5, height: 5, background: '#dbe3ec', borderRadius: 3, position: 'relative' }}>
                  <div style={{ width: `${Math.min(pct, 1) * 80}%`, height: 5, background: NAVY, borderRadius: 3 }} />
                  {pct > 1 && <div style={{ position: 'absolute', left: '80%', top: 0, width: `${(pct - 1) * 80}%`, height: 5, background: ORANGE, borderRadius: 3 }} />}
                  <div style={{ position: 'absolute', left: '80%', top: -2, width: 1, height: 9, background: INK }} />
                </div>
              )}
            </div>
          ))}
          <div style={{ background: NAVY, color: '#fff', borderRadius: 4, padding: '8px 12px' }}>
            <div style={{ fontSize: 9, opacity: 0.8, textTransform: 'uppercase', letterSpacing: 0.4 }}>Total a pagar</div>
            <div style={{ fontWeight: 800, fontSize: 20, marginTop: 2 }}>{soles(c.total)}</div>
            <div style={{ fontSize: 9, opacity: 0.8 }}>Incluye IGV 18% · subtotal {soles(c.subtotal)}</div>
          </div>
        </div>

        {/* Condiciones */}
        <Section n={1} title="Condiciones del contrato">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><Th w={230}>Concepto</Th><Th right w={110}>Valor</Th><Th>Observación</Th></tr></thead>
            <tbody>
              <tr><Td>Alquiler {mensual ? 'mensual' : ''} (sin IGV)</Td><Td right bold>{soles(d.contract.rate_amount)}</Td><Td muted>Valor pactado · alquiler seco</Td></tr>
              {c.dias_base ? <tr><Td>Días base del mes</Td><Td right bold>{c.dias_base}</Td><Td muted>Costo diario = alquiler ÷ {c.dias_base} = {soles(c.costo_diario)}</Td></tr> : null}
              {incl > 0 && <tr><Td>Km incluidos por mes</Td><Td right bold>{km(d.contract.included_km)}</Td><Td muted>Superado, se cobra el km adicional</Td></tr>}
              {rate > 0 && <tr><Td>Precio del km adicional</Td><Td right bold>S/ {num(rate, 4)}</Td><Td muted>{incl ? `Km incluido (${soles(d.contract.rate_amount)} ÷ ${km(incl)} = S/ ${num(Number(d.contract.rate_amount) / incl, 4)}) + S/ 1,00` : 'Según contrato'}</Td></tr>}
              {c.garantia ? <tr><Td>Garantía</Td><Td right bold>{soles(c.garantia)}</Td><Td muted>Según acuerdo contractual</Td></tr> : null}
            </tbody>
          </table>
        </Section>

        {/* Cálculo */}
        <Section n={2} title="Detalle del cálculo">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><Th w={230}>Concepto</Th><Th>Fórmula aplicada</Th><Th right w={110}>Importe</Th></tr></thead>
            <tbody>
              {calc.map(([k, f, v]) => <tr key={k}><Td>{k}</Td><Td muted>{f}</Td><Td right>{v < 0 ? `− ${soles(-v)}` : soles(v)}</Td></tr>)}
              <tr><Td bold bg={SOFT}>Subtotal</Td><Td muted bg={SOFT}>Valor de venta</Td><Td right bold bg={SOFT}>{soles(c.subtotal)}</Td></tr>
              <tr><Td>IGV</Td><Td muted>18 % del subtotal</Td><Td right>{soles(c.tax)}</Td></tr>
              <tr>
                <td colSpan={2} style={{ padding: '7px 8px', background: NAVY, color: '#fff', fontWeight: 800, fontSize: 12 }}>TOTAL A PAGAR</td>
                <td style={{ padding: '7px 8px', background: NAVY, color: '#fff', fontWeight: 800, fontSize: 12, textAlign: 'right' }}>{soles(c.total)}</td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 4, fontSize: 10, color: INK }}><b>SON:</b> {enLetras(Number(c.total || 0))}</div>
        </Section>

        {/* Control */}
        <Section n={3} title="Sustento del recorrido">
          <div style={{ display: 'grid', gridTemplateColumns: control != null && c.km_fuente !== 'ODOMETRO' ? '1fr 1fr' : '1fr', gap: 8 }}>
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 4, padding: '7px 10px', fontSize: 10 }}>
              <div style={{ color: MUTED, fontSize: 9, textTransform: 'uppercase' }}>Fuente de los km</div>
              <div style={{ fontWeight: 600, marginTop: 1 }}>{FUENTE[c.km_fuente] || 'Lecturas de odómetro del periodo'}</div>
              <div style={{ color: MUTED, marginTop: 1 }}>{viajes.length ? `${viajes.length} viajes en ${c.dias_laborados ?? '—'} días · detalle en el anexo` : 'Sin viajes registrados en el periodo'}{c.viajes_sin_km ? ` · ${c.viajes_sin_km} sin km` : ''}</div>
            </div>
            {control != null && c.km_fuente !== 'ODOMETRO' && (
              <div style={{ border: `1px solid ${Number(c.km_fuera_de_ruta) > 0 ? '#fcd34d' : LINE}`, background: Number(c.km_fuera_de_ruta) > 0 ? '#fffbeb' : '#fff', borderRadius: 4, padding: '7px 10px', fontSize: 10 }}>
                <div style={{ color: MUTED, fontSize: 9, textTransform: 'uppercase' }}>Control {c.km_gps != null ? 'GPS del arrendador' : 'odómetro'}</div>
                <div style={{ fontWeight: 600, marginTop: 1 }}>{km(control)} km registrados · {km(used)} km liquidados</div>
                <div style={{ color: Number(c.km_fuera_de_ruta) > 0 ? '#92400e' : MUTED, marginTop: 1 }}>
                  {Number(c.km_fuera_de_ruta) > 0 ? `${km(c.km_fuera_de_ruta)} km sin viaje registrado: no se incluyen en esta liquidación.` : 'Recorrido conciliado con los viajes.'}
                </div>
              </div>
            )}
          </div>
          <div style={{ marginTop: 6, fontSize: 9.5, color: MUTED }}>
            <b style={{ color: INK }}>Nota:</b> los fletes facturados al cliente (venta de fletes) no forman parte del alquiler de la unidad.
            {s.notes ? <> <b style={{ color: INK }}>Observaciones:</b> {String(s.notes).replace(/\n/g, ' · ')}</> : null}
          </div>
        </Section>

        {/* Firmas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginTop: 28 }}>
          {[
            ['Elaborado por', d.created_by_name || '', fechaHora(s.created_at), null],
            ['Aprobado por', s.status === 'APROBADA' ? d.approved_by_name || '' : 'Pendiente de aprobación', s.approved_at ? fechaHora(s.approved_at) : '', s.status === 'APROBADA' ? d.signature_url : null],
            ['Conformidad del arrendador', d.lessor.name || '', 'Firma, nombre y fecha', null],
          ].map(([k, nombre, sub, firma]) => (
            <div key={k as string} style={{ textAlign: 'center' }}>
              <div style={{ height: 46, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {firma ? <img src={firma as string} alt="Firma" crossOrigin="anonymous" style={{ maxHeight: 46, maxWidth: 160, objectFit: 'contain' }} /> : null}
              </div>
              <div style={{ borderTop: `1px solid ${INK}`, paddingTop: 4, fontSize: 10, fontWeight: 700 }}>{k}</div>
              <div style={{ fontSize: 9.5 }}>{nombre}</div>
              <div style={{ fontSize: 9, color: MUTED }}>{sub}</div>
            </div>
          ))}
        </div>
      </Page>

      {pagesAnexo.map((rows, i) => {
        const last = i === pagesAnexo.length - 1
        return (
          <Page key={i} n={i + 2} total={total} docNo={docNo} draft={draft}>
            <Header d={d} docNo={docNo} small />
            <div style={{ margin: '10px 0 6px', fontSize: 10, color: MUTED }}>
              {d.vehicle.plate} · {cap(mesDe(s.period_start))} ({periodo}) · {FUENTE[c.km_fuente] || ''} · km ida y vuelta por viaje
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9.5, tableLayout: 'fixed' }}>
              <thead><tr><Th w={28}>#</Th><Th w={68}>Fecha</Th><Th w={92}>Guía / viaje</Th><Th>Cliente</Th><Th w={118}>Destino</Th><Th w={140}>Conductor</Th><Th right w={44}>Km</Th></tr></thead>
              <tbody>
                {rows.map((v, j) => (
                  <tr key={j} style={{ background: j % 2 ? '#fafbfc' : '#fff' }}>
                    <Td muted>{i * VIAJES_POR_PAGINA + j + 1}</Td><Td clip>{fecha(v.fecha)}</Td>
                    <Td clip>{v.ref && v.ref !== v.tipo ? v.ref : /RECOJO/i.test(v.tipo || '') ? 'Recojo OC' : v.ref || '—'}</Td>
                    <Td clip>{v.cliente || (v.tipo ? cap(String(v.tipo).toLowerCase()) : '—')}</Td><Td clip>{v.destino ? titulo(String(v.destino)) : '—'}</Td>
                    <Td muted clip>{v.conductor ? titulo(String(v.conductor)) : '—'}</Td><Td right>{v.km != null ? km(v.km) : '—'}</Td>
                  </tr>
                ))}
                {last && (
                  <tr>
                    <td colSpan={6} style={{ padding: '6px 8px', background: NAVY, color: '#fff', fontWeight: 700 }}>Total recorrido · {viajes.length} viajes</td>
                    <td style={{ padding: '6px 8px', background: NAVY, color: '#fff', fontWeight: 700, textAlign: 'right' }}>{km(used)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Page>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------
// Vista: documento + PDF + envío
// ------------------------------------------------------------
async function buildPdf(root: HTMLElement): Promise<Blob> {
  const [{ toJpeg }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')])
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const pages = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'))
  for (let i = 0; i < pages.length; i++) {
    const el = pages[i]
    const img = await toJpeg(el, { pixelRatio: 2, quality: 0.92, backgroundColor: '#ffffff', skipFonts: true, cacheBust: false,
      imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })
    if (i > 0) pdf.addPage()
    let w = 210, h = (210 * el.offsetHeight) / el.offsetWidth
    if (h > 297) { w = (w * 297) / h; h = 297 }
    pdf.addImage(img, 'JPEG', (210 - w) / 2, 0, w, h)
  }
  return pdf.output('blob')
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function LiquidacionAlquilerView({ settlementId, onBack, onChanged }: { settlementId: string; onBack: () => void; onChanged?: () => void }) {
  const [d, setD] = useState<Doc | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const [me, setMe] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(() => supabase.rpc('lease_settlement_document', { p_settlement_id: settlementId }).then(({ data, error }) => {
    if (error || !data?.success) setErr(error?.message || data?.error || 'No se pudo cargar'); else setD(data as Doc)
  }), [settlementId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return
      const { data: p } = await supabase.from('profiles').select('first_name, last_name').eq('id', data.user.id).maybeSingle()
      setMe([p?.first_name, p?.last_name].filter(Boolean).join(' ') || data.user.email || '')
    })
  }, [])

  const fileName = useMemo(() => d ? `Liquidacion_alquiler_${d.vehicle.plate}_${String(d.settlement.period_start).slice(0, 7)}.pdf` : 'liquidacion.pdf', [d])
  const pdf = useCallback(async () => {
    if (!ref.current) throw new Error('Documento no listo')
    return buildPdf(ref.current)
  }, [])
  const downloadPdf = async () => {
    setBusy(true)
    try { download(await pdf(), fileName); toast.success('PDF descargado') } catch (e) { toast.error('No se pudo generar el PDF: ' + (e as Error).message) }
    setBusy(false)
  }

  if (err) return <div className="p-6 space-y-3"><button onClick={onBack} className="px-4 py-2 border rounded-lg text-sm">Volver</button><p className="text-red-600 text-sm">{err}</p></div>
  if (!d) return <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
  const sent = d.sends[0]

  return (
    <div className="min-h-full bg-slate-100 print:bg-white">
      <style>{`@media print { @page { size: A4; margin: 0 } .liq-doc { gap: 0 !important } .liq-page { page-break-after: always; box-shadow: none !important } .liq-page:last-child { page-break-after: auto } }`}</style>
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-white px-4 py-3 print:hidden">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1 rounded-lg border px-3 py-2 text-sm"><ArrowLeft className="h-4 w-4" />Volver</button>
          <div className="text-sm">
            <div className="font-semibold text-slate-800">{d.vehicle.plate} · {cap(mesDe(d.settlement.period_start))} · {soles(d.calc?.total ?? d.settlement.total)}</div>
            <div className="text-xs text-slate-500">
              {sent ? <span className="text-emerald-700">Enviada el {fechaHora(sent.sent_at)} a {sent.sent_to}</span> : <span className="text-amber-700">Pendiente de envío al arrendador</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => window.print()} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"><Printer className="h-4 w-4" />Imprimir</button>
          <button disabled={busy} onClick={downloadPdf} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Descargar PDF</button>
          <button onClick={() => setSending(true)} className="flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white"><Mail className="h-4 w-4" />Enviar por correo</button>
        </div>
      </div>
      <div className="overflow-x-auto px-4 py-6 print:p-0 [&_.liq-page]:shadow-md">
        <div ref={ref} className="mx-auto w-fit"><LiquidacionDocumento d={d} /></div>
      </div>
      {d.sends.length > 0 && (
        <div className="mx-auto mb-8 max-w-[794px] rounded-xl border bg-white p-4 text-sm print:hidden">
          <div className="mb-2 font-semibold text-slate-800">Historial de envíos</div>
          {d.sends.map((x, i) => <div key={i} className="border-t py-1.5 text-slate-600 first:border-t-0">{fechaHora(x.sent_at)} · {x.channel.toLowerCase()} a <b>{x.sent_to}</b>{x.cc ? ` (cc ${x.cc})` : ''}{x.by ? ` · por ${x.by}` : ''}{x.note ? ` · ${x.note}` : ''}</div>)}
        </div>
      )}
      {sending && <EnvioModal d={d} me={me} fileName={fileName} makePdf={pdf} onClose={() => setSending(false)} onSent={() => { setSending(false); load(); onChanged?.() }} />}
    </div>
  )
}

function EnvioModal({ d, me, fileName, makePdf, onClose, onSent }: { d: Doc; me: string; fileName: string; makePdf: () => Promise<Blob>; onClose: () => void; onSent: () => void }) {
  const s = d.settlement, c = { ...s, ...(d.calc || {}) }
  const mes = mesDe(s.period_start)
  const [to, setTo] = useState(d.contract.send_to_email || d.lessor.email || '')
  const [cc, setCc] = useState(d.contract.cc_emails || '')
  const [subject, setSubject] = useState(`Liquidación de alquiler ${d.vehicle.plate} – ${cap(mes)} | ${d.company.name}`)
  const [body, setBody] = useState(() => [
    `Estimados señores de ${d.lessor.name || 'la empresa arrendadora'}:`,
    '',
    `Les hacemos llegar la valorización y liquidación del alquiler de la unidad ${[d.vehicle.plate, d.vehicle.brand, d.vehicle.model].filter(Boolean).join(' ')} correspondiente al periodo del ${fecha(s.period_start)} al ${fecha(s.period_end)}.`,
    '',
    'Resumen:',
    `• Alquiler del periodo: ${soles(c.base_amount)}`,
    `• Km recorridos: ${km(c.km_used)}${c.included_km ? ` (incluidos ${km(c.included_km)})` : ''}${Number(c.excess_km) ? ` · adicionales ${km(c.excess_km)} km = ${soles(c.excess_km_amount)}` : ''}`,
    ...(Number(c.downtime_discount) ? [`• Descuento por indisponibilidad: − ${soles(c.downtime_discount)}`] : []),
    `• Subtotal: ${soles(c.subtotal)} · IGV 18 %: ${soles(c.tax)}`,
    `• Total a pagar: ${soles(c.total)}`,
    '',
    'Adjuntamos el documento en PDF con el cálculo y el detalle de viajes. Agradeceremos su conformidad para proceder con la facturación.',
    '',
    'Saludos cordiales,',
    me,
    d.company.name,
  ].join('\n'))
  const [file, setFile] = useState<File | null>(null)
  const [step, setStep] = useState<'' | 'pdf' | 'ok'>('')
  const [saving, setSaving] = useState(false)
  const [channel, setChannel] = useState('CORREO')

  const ensurePdf = async () => {
    if (file) return file
    setStep('pdf')
    const f = new File([await makePdf()], fileName, { type: 'application/pdf' })
    setFile(f); setStep('ok')
    return f
  }
  const canShare = typeof navigator !== 'undefined' && !!navigator.canShare
  const share = async () => {
    try {
      const f = await ensurePdf()
      if (!navigator.canShare?.({ files: [f] })) { download(f, fileName); toast.info('Este equipo no permite compartir archivos: se descargó el PDF'); return }
      await navigator.share({ files: [f], title: subject, text: body })
      setChannel('COMPARTIR')
    } catch (e) { if ((e as Error).name !== 'AbortError') toast.error((e as Error).message) }
  }
  const openMail = async (kind: 'mailto' | 'gmail' | 'outlook') => {
    try { download(await ensurePdf(), fileName) } catch (e) { return toast.error('No se pudo generar el PDF: ' + (e as Error).message) }
    const q = (k: string, v: string) => (v ? `${k}=${encodeURIComponent(v)}` : '')
    const url = kind === 'gmail'
      ? `https://mail.google.com/mail/?view=cm&fs=1&${[q('to', to), q('cc', cc), q('su', subject), q('body', body)].filter(Boolean).join('&')}`
      : kind === 'outlook'
        ? `https://outlook.office.com/mail/deeplink/compose?${[q('to', to), q('cc', cc), q('subject', subject), q('body', body)].filter(Boolean).join('&')}`
        : `mailto:${encodeURIComponent(to)}?${[q('cc', cc), q('subject', subject), q('body', body)].filter(Boolean).join('&')}`
    window.open(url, '_blank')
    toast.success('Se abrió el correo y se descargó el PDF: adjúntelo antes de enviar')
  }
  const copy = async () => { await navigator.clipboard.writeText(body); toast.success('Mensaje copiado') }
  const register = async () => {
    if (!to.trim()) return toast.error('Indique el correo del destinatario')
    setSaving(true)
    const { data, error } = await supabase.rpc('register_lease_settlement_send', { p_settlement_id: s.id, p_to: to, p_cc: cc || null, p_channel: channel, p_note: null })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Envío registrado'); onSent()
  }

  const field = 'w-full rounded-lg border px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title="Enviar liquidación por correo" maxWidth="max-w-2xl">
      <div className="max-h-[78vh] space-y-3 overflow-y-auto pr-1 text-sm">
        {s.status !== 'APROBADA' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">La liquidación aún no está aprobada: el PDF sale con la marca <b>BORRADOR</b>. Apruébela antes de enviarla si es la versión final.</div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <label>Para (correo del arrendador)<input className={field} value={to} onChange={e => setTo(e.target.value)} placeholder="facturacion@arrendador.com" /></label>
          <label>CC<input className={field} value={cc} onChange={e => setCc(e.target.value)} placeholder="separe con comas" /></label>
        </div>
        <label className="block">Asunto<input className={field} value={subject} onChange={e => setSubject(e.target.value)} /></label>
        <label className="block">Mensaje<textarea className={`${field} font-mono text-xs`} rows={13} value={body} onChange={e => setBody(e.target.value)} /></label>

        <div className="rounded-lg border bg-slate-50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-slate-500">1 · Enviar</div>
          <div className="flex flex-wrap gap-2">
            {canShare && <button onClick={share} className="flex items-center gap-2 rounded-lg bg-[#002855] px-3 py-2 text-white"><Share2 className="h-4 w-4" />Compartir PDF (adjunto)</button>}
            <button onClick={() => openMail('outlook')} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Mail className="h-4 w-4" />Outlook web</button>
            <button onClick={() => openMail('gmail')} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Mail className="h-4 w-4" />Gmail</button>
            <button onClick={() => openMail('mailto')} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Send className="h-4 w-4" />Programa de correo</button>
            <button onClick={copy} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2"><Copy className="h-4 w-4" />Copiar mensaje</button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {canShare ? '«Compartir» abre Outlook, Correo o WhatsApp con el PDF ya adjunto. ' : ''}
            {canShare ? 'Las otras opciones' : 'Estas opciones'} abren el correo con destinatario, asunto y mensaje listos y descargan el PDF <b>{fileName}</b> para adjuntarlo.
            {step === 'pdf' && <span className="ml-1 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />generando PDF…</span>}
            {step === 'ok' && <span className="ml-1 text-emerald-700">PDF listo.</span>}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg border p-3">
          <div className="text-xs text-slate-600"><div className="font-semibold uppercase text-slate-500">2 · Confirmar</div>Cuando el correo haya salido, regístrelo: deja de aparecer la alerta del día 1.</div>
          <button disabled={saving} onClick={register} className="flex shrink-0 items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Marcar como enviada</button>
        </div>
      </div>
    </Modal>
  )
}
