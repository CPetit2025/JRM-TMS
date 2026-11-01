// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Control presupuestal · etapa 2: comprometer sigue bloqueado sobre el tope y ejecutar nunca; gastos de Caja aprobados
// imputados a la OT (directo, por peso o partes iguales), ruta propia: tarifa reemplazada por costos reales al cerrar,
// combustible estimado y reemplazado por la carga real, tercero directo, reverso al desaprobar, sin duplicados y solo
// rutas desde la activación.
const assert = require('node:assert/strict')
const { setupBudget, read, id } = require('./fixtures/budget-setup.cjs')
;(async () => {
 const db = await setupBudget()
 try {
  const used = async c => (await db.query(`SELECT round(reserved_pen,2)::float r, round(consumed_pen,2)::float c FROM contract_budgets WHERE contract_id=$1`,[c])).rows[0]

  // Antes: ejecutar sobre el tope también se bloqueaba
  await db.exec(`UPDATE contract_budgets SET reserved_pen = 700 WHERE contract_id='${id(30)}'`)
  await assert.rejects(db.exec(`UPDATE contract_budgets SET consumed_pen = 200 WHERE contract_id='${id(30)}'`), /Saldo insuficiente/, 'before: executed spend blocked')

  const migration = read('supabase/migrations/20261126090000_control_presupuestal_imputacion.sql')
  await db.exec(migration); await db.exec(migration)
  // Después: comprometer sigue bloqueado; ejecutar no (R5)
  await db.exec(`UPDATE contract_budgets SET consumed_pen = 200 WHERE contract_id='${id(30)}'`)
  assert.deepEqual(await used(id(30)), { r: 700, c: 200 }, 'executed spend over the cap is recorded')
  await assert.rejects(db.exec(`UPDATE contract_budgets SET reserved_pen = 800 WHERE contract_id='${id(30)}'`), /Saldo insuficiente/, 'new commitment over the cap still blocked')
  await db.exec(`UPDATE contract_budgets SET reserved_pen = 100, consumed_pen = 800 WHERE contract_id='${id(30)}'`)  // pasar de comprometido a ejecutado sigue permitido
  // Gasto registrado en un subcontrato: la verificación de la familia tampoco lo bloquea
  await db.exec(`INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES ('${id(31)}','PARTIDA_TRANSPORTE',0);
   UPDATE contract_budgets SET consumed_pen = 50 WHERE contract_id='${id(31)}'`)
  await assert.rejects(db.exec(`UPDATE contract_budgets SET reserved_pen = 10 WHERE contract_id='${id(31)}'`), /Saldo insuficiente/, 'commitment on a subcontract still blocked')
  await db.exec(`DELETE FROM contract_budgets WHERE contract_id='${id(31)}'; UPDATE contract_budgets SET reserved_pen = 0, consumed_pen = 0 WHERE contract_id='${id(30)}'`)

  // --- Ruta propia de una OT (flete 300 comprometido), salida después de la activación ---
  await db.exec(`INSERT INTO transport_requests VALUES ('${id(40)}','S-1','${id(10)}',NULL),('${id(41)}','S-2','${id(10)}',3000),('${id(42)}','S-3','${id(20)}',1000),
    ('${id(43)}','S-4',NULL,NULL),('${id(44)}','S-5','${id(30)}',NULL),('${id(45)}','S-6','${id(10)}',NULL);
   INSERT INTO dispatches(id,status,contract_id,freight_cost,vehicle_plate,scheduled_departure,actual_distance_km) VALUES
    ('${id(60)}','EN RUTA','${id(10)}',300,'PRO-1',now() + interval '1 hour',0),
    ('${id(61)}','EN RUTA',NULL,500,'PRO-1',now() + interval '1 hour',0),
    ('${id(62)}','EN RUTA','${id(30)}',800,'TER-1',now() + interval '1 hour',0),
    ('${id(63)}','EN RUTA','${id(10)}',100,'PRO-1',now() - interval '10 days',0);
   UPDATE dispatches SET modalidad='TERCERO' WHERE id='${id(62)}';
   INSERT INTO dispatch_requests VALUES ('${id(60)}','${id(40)}'),('${id(61)}','${id(41)}'),('${id(61)}','${id(42)}'),('${id(61)}','${id(43)}'),('${id(62)}','${id(44)}'),('${id(63)}','${id(45)}');
   INSERT INTO dispatch_request_freight VALUES ('${id(61)}','${id(41)}','${id(10)}',350),('${id(61)}','${id(42)}','${id(20)}',150);
   UPDATE contract_budgets SET reserved_pen = 300 + 350 + 100 WHERE contract_id='${id(10)}';
   UPDATE contract_budgets SET reserved_pen = 150 WHERE contract_id='${id(20)}';
   UPDATE contract_budgets SET reserved_pen = 800 WHERE contract_id='${id(30)}';`)
  const expense = (n, d, type, amount, req = null) => db.query(`INSERT INTO dispatch_expenses(id,dispatch_id,transport_request_id,expense_type,amount) VALUES ($1,$2,$3,$4,$5)`,[id(n),d,req,type,amount])
  const approve = (n, amount = null) => db.query(`UPDATE dispatch_expenses SET status='APROBADO', approved_amount=$2 WHERE id=$1`,[id(n),amount])
  const allocs = async d => (await db.query(`SELECT kind, status, amount_pen::float a, basis, request_id FROM cost_allocations WHERE dispatch_id=$1 ORDER BY kind, request_id, amount_pen`,[d])).rows
  // Cierre de ruta como close_dispatch_route: la tarifa pasa de comprometido a ejecutado y cambia el estado (misma transacción)
  const close = async (d, moves) => { await db.exec('BEGIN'); for (const [c, amt] of moves) await db.query(`UPDATE contract_budgets SET reserved_pen = reserved_pen - $2, consumed_pen = consumed_pen + $2 WHERE contract_id=$1`,[c,amt])
   await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[d]); await db.exec('COMMIT') }

  // Combustible y peaje aprobados con la ruta abierta: pendientes (la tarifa sigue comprometida, sin doble conteo)
  await expense(500, id(60), 'COMBUSTIBLE', 120); await approve(500)
  await expense(501, id(60), 'PEAJE', 40); await approve(501, 35)
  await expense(502, id(60), 'ALQUILER_EQUIPO', 90); await approve(502)  // va por su servicio, no aquí
  assert.deepEqual(await used(id(10)), { r: 750, c: 0 })
  assert.deepEqual((await allocs(id(60))).map(x => [x.kind, x.status, x.a]), [['CAJA','PENDIENTE',35],['CAJA','PENDIENTE',120]])
  await close(id(60), [[id(10), 300]])
  assert.deepEqual(await used(id(10)), { r: 450, c: 155 }, 'own route: tariff 300 replaced by real costs 120 + 35; no fuel estimate (real load)')
  assert.deepEqual((await allocs(id(60))).map(x => [x.kind, x.status, x.a]), [['CAJA','APLICADO',35],['CAJA','APLICADO',120],['TARIFA_PROPIA','APLICADO',-300]])
  // Gasto aprobado después del cierre: se aplica de inmediato; corregido y luego rechazado: se revierte
  await expense(503, id(60), 'VIATICOS', 50); await approve(503)
  assert.deepEqual(await used(id(10)), { r: 450, c: 205 })
  await approve(503, 45)
  assert.deepEqual(await used(id(10)), { r: 450, c: 200 }, 'amount corrected: old allocation voided, new one applied')
  await db.query(`UPDATE dispatch_expenses SET status='RECHAZADO' WHERE id=$1`,[id(503)])
  assert.deepEqual(await used(id(10)), { r: 450, c: 155 })

  // --- Ruta propia mixta (dos OT + una solicitud sin OT): sin carga de combustible → estimado por peso ---
  await db.exec(`UPDATE dispatches SET actual_distance_km = 100 WHERE id='${id(61)}'`)
  await expense(510, id(61), 'PEAJE', 30, id(42)); await approve(510)  // asignado a la solicitud de OT-B: directo
  await close(id(61), [[id(10), 350], [id(20), 150]])
  // Estimado: 100 km / 20 km/gal × 16 = 80. Pesos 3000/1000/— → partes iguales (no todas tienen peso): 26.67 · 26.67 · 26.66
  const mixed = await allocs(id(61))
  assert.deepEqual(mixed.filter(x => x.kind === 'TARIFA_PROPIA').map(x => x.a), [-350, -150])
  assert.deepEqual(mixed.filter(x => x.kind === 'COMBUSTIBLE_ESTIMADO').map(x => [x.basis, x.a]), [['IGUAL',26.67],['IGUAL',26.67],['IGUAL',26.66]])
  assert.deepEqual(mixed.filter(x => x.kind === 'CAJA').map(x => [x.basis, x.a, x.request_id]), [['DIRECTO',30,id(42)]])
  assert.deepEqual([await used(id(10)), await used(id(20))], [{ r: 100, c: 181.67 }, { r: 0, c: 56.67 }], 'no-OT share (S-4) is not charged')
  // Carga real posterior: reemplaza al estimado
  await expense(511, id(61), 'COMBUSTIBLE', 100); await approve(511)
  assert.deepEqual([await used(id(10)), await used(id(20))], [{ r: 100, c: 188.33 }, { r: 0, c: 63.33 }], 'estimate voided; real load split equally (33.33 each)')
  // Con peso en todas las solicitudes con OT el reparto es por peso
  await db.exec(`UPDATE transport_requests SET estimated_weight = 1000 WHERE id='${id(43)}'`)
  assert.deepEqual((await db.query(`SELECT basis, round(share::numeric,2)::float s FROM budget_route_shares($1) ORDER BY request_id`,[id(61)])).rows.map(r => [r.basis, r.s]), [['PESO',0.6],['PESO',0.2],['PESO',0.2]])

  // --- Tercero: gasto extraordinario directo a la OT, sin tocar la tarifa contratada ---
  await expense(520, id(62), 'PEAJE', 60); await approve(520)
  assert.deepEqual(await used(id(30)), { r: 800, c: 60 }, 'over the cap: executed still recorded')
  await close(id(62), [[id(30), 800]])
  assert.deepEqual(await used(id(30)), { r: 0, c: 860 }, 'third-party freight stays as executed')

  // --- Ruta anterior a la activación: no se imputa nada (D7) ---
  await expense(530, id(63), 'COMBUSTIBLE', 70); await approve(530)
  await close(id(63), [[id(10), 100]])
  assert.deepEqual(await allocs(id(63)), [])
  // Sin duplicados: reaprobar el mismo gasto no crea otra imputación
  await db.query(`UPDATE dispatch_expenses SET status='APROBADO' WHERE id=$1`,[id(500)])
  assert.equal((await allocs(id(60))).filter(x => x.kind === 'CAJA' && x.status !== 'ANULADO').length, 2)

  const detail = (await db.query(`SELECT budget_route_allocations($1) AS v`,[id(61)])).rows[0].v
  assert.equal(detail.success, true); assert.ok(detail.rows.some(r => r.kind === 'COMBUSTIBLE_ESTIMADO' && r.status === 'ANULADO'))

  await assert.rejects(db.exec(read('supabase/tests/caja_c199_control_presupuestal_imputacion.test.sql')), /CAJA C199 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS control presupuestal etapa 2: ejecutar nunca se bloquea y comprometer sí; Caja imputada (directo, peso, iguales), tarifa propia reemplazada por costos reales al cerrar, combustible estimado y reemplazado, tercero directo, reversos, sin duplicados y desde la activación')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
