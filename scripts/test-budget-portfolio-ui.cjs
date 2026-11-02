const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const portfolio = readFileSync('src/app/(dashboard)/despacho/control-presupuestal/page.tsx', 'utf8')
const detail = readFileSync('src/app/(dashboard)/despacho/control-presupuestal/[ot]/page.tsx', 'utf8')

test('cartera usa posiciones y ejecutado agregado del período con ahorro consolidado', () => {
  assert.match(portfolio, /rpc\('budget_positions'\)/)
  assert.match(portfolio, /rpc\('budget_portfolio_period',\s*\{\s*p_from:\s*from,\s*p_to:\s*to\s*\}\)/)
  assert.match(portfolio, /rpc\('consolidation_savings_classified'/)
  assert.match(portfolio, /\(end - start\) \/ 86400000 > 366/)
})

test('cartera ejecutiva distingue cantidades y montos, y ofrece el análisis financiero', () => {
  for (const label of ['OT monitoreadas', 'Normales', 'En alerta', 'Sobre el límite', 'Presupuesto excedido', 'Ahorro validado']) assert.ok(portfolio.includes(label), `falta indicador: ${label}`)
  for (const label of ['Presupuesto vigente', 'Límite operativo', 'Ejecutado acumulado', 'Comprometido vigente', 'Disponible hasta el límite', 'Ejecutado en período']) assert.ok(portfolio.includes(label), `falta importe: ${label}`)
  for (const label of ['Cliente', 'Presupuesto', 'Límite 80 %', 'Ejecutado', 'Comprometido', 'Disponible al límite', 'Consumo', 'Riesgo', 'Analizar']) assert.ok(portfolio.includes(label), `falta columna: ${label}`)
  assert.match(portfolio, /lg:hidden/)
  assert.match(portfolio, /hidden overflow-x-auto lg:block/)
})

test('proyección de cierre usa costos capturados y deja visibles estimaciones y pendientes', () => {
  assert.match(detail, /Number\(p\.consumed_pen\) \+ Number\(p\.reserved_pen\)/)
  assert.match(detail, /No estima costos que aún no se capturaron/)
  assert.match(detail, /Incluye combustible estimado/)
  assert.match(detail, /pendiente\(s\) de regularización/)
})
