#!/usr/bin/env node
// Importación del historial de mantenimiento de flota (Excel v5, hoja CONSOLIDADO) al registro único `mant_registros`.
// Por defecto es una SIMULACIÓN (dry run): solo lee el Excel y escribe el reporte de cuadre y de problemas.
// Con --apply escribe en la base indicada por --db (o MANT_DB_URL). Es idempotente: la clave natural evita duplicados.
// Producción solo con confirmación explícita del dueño del sistema. Ver docs/mantenimiento-flota.md.
//
//   node scripts/mant-import.cjs --file Mantenimiento_Flota_v5_Analisis_360.xlsx [--out reportes/] [--equivalencias eq.json]
//   node scripts/mant-import.cjs --file ... --apply --db postgres://usuario@host:puerto/base
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const core = require('./lib/mant-import-core.cjs')

function args(argv) {
  const a = { out: 'mant-import-reportes', sheet: 'CONSOLIDADO' }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--apply') a.apply = true
    else if (k === '--file') a.file = argv[++i]
    else if (k === '--db') a.db = argv[++i]
    else if (k === '--out') a.out = argv[++i]
    else if (k === '--sheet') a.sheet = argv[++i]
    else if (k === '--equivalencias') a.equivalencias = argv[++i]
    else if (k === '--help' || k === '-h') a.help = true
  }
  a.db = a.db || process.env.MANT_DB_URL
  return a
}

async function applyToDb(db, res, meta) {
  const { Client } = require('pg')
  const client = new Client({ connectionString: db })
  await client.connect()
  try {
    const q = async (sql, params) => (await client.query(sql, params)).rows[0]
    const ok = res.parsed.rows.filter(r => r.estado !== 'RECHAZADO')
    const imp = (await q('select public.mant_import_begin($1::jsonb) as id', [JSON.stringify({ archivo: meta.archivo, huella: meta.huella, hoja: res.parsed.sheet, filas: res.parsed.rows.length })])).id
    const activos = [...new Set(ok.map(r => r.activo_original))].map(nombre => ({ nombre }))
    const proveedores = res.grupos.flatMap(g => g.miembros.map(nombre => ({ nombre, canonico: g.canonico, nota: g.fuente === 'único' ? '' : `Agrupado por ${g.fuente}` })))
    await q('select public.mant_import_alias($1::jsonb, $2::jsonb) as r', [JSON.stringify(activos), JSON.stringify(proveedores)])
    const sums = { insertados: 0, actualizados: 0, sin_cambio: 0 }
    const fields = ['clave_natural', 'hoja', 'fila', 'fila_original', 'activo_original', 'clase_activo', 'fecha', 'proveedor_original', 'factura', 'rq', 'monto', 'moneda',
      'incluye_igv', 'tipo_cambio', 'monto_pen', 'descripcion', 'tipo', 'tipo_origen', 'criterio_tipo', 'area', 'categoria_costo', 'intervencion_mayor', 'ingreso_at',
      'salida_at', 'dias_fuera', 'autorizado_por', 'km_hrs_original', 'km_hrs_validado', 'obs_medidor', 'prox_mantto', 'dia_con_correctivo', 'anio_fabricacion', 'faltantes', 'observaciones']
    for (let i = 0; i < ok.length; i += 300) {
      const batch = ok.slice(i, i + 300).map(r => Object.fromEntries(fields.map(f => [f, r[f] ?? null])))
      const r = (await q('select public.mant_import_rows($1::uuid, $2::jsonb) as r', [imp, JSON.stringify(batch)])).r
      for (const k of Object.keys(sums)) sums[k] += r[k]
      process.stdout.write(`\r  Enviando ${Math.min(ok.length, i + 300)} / ${ok.length}…`)
    }
    process.stdout.write('\n')
    const est = s => res.parsed.rows.filter(r => r.estado === s).length
    const fin = (await q('select public.mant_import_finish($1::uuid, $2::jsonb) as r', [imp, JSON.stringify({ ...sums, rechazados: est('RECHAZADO'), dudosos: est('DUDOSO'),
      controles: core.controles(res.totales) })])).r
    // Cuadre: lo que quedó en la base frente al Excel (por clase de activo y por año)
    const base = (await client.query(`select coalesce(clase_activo, '(sin dato)') clase, extract(year from fecha)::int anio, count(*)::int n, round(sum(monto_pen), 2)::float monto
      from public.mant_registros where origen = 'EXCEL' group by 1, 2`)).rows
    const agg = key => { const m = {}; for (const b of base) { const k = String(b[key] ?? '(sin dato)'); m[k] = m[k] ?? { registros: 0, monto: 0 }; m[k].registros += b.n; m[k].monto = Math.round((m[k].monto + b.monto) * 100) / 100 } return m }
    const cmp = (label, exc, bas) => Object.keys({ ...exc, ...bas }).sort().map(k => ({ concepto: `${label} ${k}`, excel: exc[k] ? `${exc[k].registros} / ${exc[k].monto}` : '—',
      base: bas[k] ? `${bas[k].registros} / ${bas[k].monto}` : '—', ok: !!exc[k] && !!bas[k] && exc[k].registros === bas[k].registros && Math.abs(exc[k].monto - bas[k].monto) < 0.005 }))
    const cuadreBase = [...cmp('Clase', res.totales.por_clase, agg('clase')), ...cmp('Año', res.totales.por_anio, agg('anio'))]
    return { import_id: imp, ...sums, fin, cuadreBase }
  } finally { await client.end() }
}

async function main() {
  const a = args(process.argv)
  if (a.help || !a.file) {
    console.log('Uso: node scripts/mant-import.cjs --file <Excel> [--apply --db <url>] [--out <carpeta>] [--equivalencias <json>]')
    process.exit(a.help ? 0 : 1)
  }
  const buf = fs.readFileSync(a.file)
  const equivalencias = a.equivalencias ? JSON.parse(fs.readFileSync(a.equivalencias, 'utf8')) : {}
  const res = core.analyze(buf, { sheet: a.sheet, equivalencias })
  const meta = { archivo: path.basename(a.file), huella: crypto.createHash('sha256').update(buf).digest('hex') }
  let db = null
  if (a.apply) {
    if (!a.db) { console.error('Falta --db (o MANT_DB_URL) para aplicar. Sin --apply se ejecuta la simulación.'); process.exit(1) }
    console.log(`Aplicando en ${a.db.replace(/:[^:@/]+@/, ':***@')}…`)
    db = await applyToDb(a.db, res, meta)
  }
  fs.mkdirSync(a.out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const md = core.markdownReport(res, { modo: a.apply ? 'APLICAR' : 'SIMULACION', archivo: meta.archivo, db, cuadreBase: db?.cuadreBase })
  const base = path.join(a.out, `mant-import-${a.apply ? 'aplicada' : 'simulacion'}-${stamp}`)
  fs.writeFileSync(`${base}.md`, md)
  fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, modo: a.apply ? 'APLICAR' : 'SIMULACION', totales: res.totales, controles: core.controles(res.totales),
    grupos_proveedores: res.grupos, problemas: res.parsed.rows.filter(r => r.estado !== 'OK').map(r => ({ fila: r.fila, activo: r.activo_original, fecha: r.fecha,
      monto: r.monto, estado: r.estado, motivos: r.motivos, faltantes: r.faltantes })), db }, null, 2))
  const ctl = core.controles(res.totales)
  console.log(`${a.apply ? 'Aplicada' : 'Simulación'}: ${res.parsed.rows.length} filas · ${res.totales.registros} cargables · S/ ${res.totales.monto.toFixed(2)}`)
  for (const c of ctl) console.log(`  ${c.ok === null ? '·' : c.ok ? '✓' : '✗'} ${c.label}: esperado ${c.esperado} · obtenido ${c.obtenido ?? 'no disponible'}`)
  if (db) {
    console.log(`  Base: insertados ${db.insertados}, actualizados ${db.actualizados}, sin cambio ${db.sin_cambio}`)
    const bad = db.cuadreBase.filter(c => !c.ok)
    console.log(bad.length ? `  ✗ Cuadre contra la base con ${bad.length} diferencia(s)` : '  ✓ Cuadre contra la base: por clase y por año sin diferencias')
  }
  console.log(`Reporte: ${base}.md`)
}

main().catch(e => { console.error(e.message || e); process.exit(1) })
