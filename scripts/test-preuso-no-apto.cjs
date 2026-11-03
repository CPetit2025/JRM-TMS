// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Checklist FR-DT 007 No apto ⇒ falla en Mantenimiento, unidad OBSERVADA, motivo del motor, aviso, Torre y
// reinspección habilitada al cerrar la falla (migración 20261222090000).
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { PGlite } = require('@electric-sql/pglite')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const DRIVER = id(1), MECHANIC = id(2), DRIVER_PROFILE = id(3)
;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
      CREATE TABLE public.vehicles(plate text PRIMARY KEY, status text);
      CREATE TABLE public.vehicle_history_logs(vehicle_plate text, changed_by uuid, field_changed text, old_value text, new_value text, change_reason text);
      CREATE TABLE public.driver_preuse_inspections(operation_id uuid PRIMARY KEY, record_sequence bigint GENERATED ALWAYS AS IDENTITY, inspection_id uuid,
        driver_id uuid, submitted_by uuid, vehicle_plate text, site_id uuid, operation_date date, captured_at timestamptz, driver_name text,
        soat_expiration date, technical_review_expiration date, answers jsonb, vehicle_operational boolean, can_operate boolean, observation text);
      CREATE TABLE public.inspection_results(id uuid PRIMARY KEY, inspection_id uuid);
      CREATE TABLE public.maintenance_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_plate text, driver_id uuid, description text,
        severity text, status text, source text, source_ref_id uuid, notes text, reported_at timestamptz DEFAULT now(), reported_by uuid, site_id uuid);
      CREATE UNIQUE INDEX uq_maintenance_requests_source_ref ON public.maintenance_requests (source, source_ref_id) WHERE source_ref_id IS NOT NULL;
      CREATE TABLE public.driver_preuse_repeat_authorizations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL, vehicle_key text NOT NULL,
        operation_date date NOT NULL, previous_operation uuid NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
        authorized_by uuid NOT NULL, authorized_at timestamptz NOT NULL DEFAULT now(), consumed_by uuid);
      CREATE UNIQUE INDEX preuse_one_pending_repeat ON public.driver_preuse_repeat_authorizations(driver_id,vehicle_key,operation_date) WHERE consumed_by IS NULL;
      CREATE TABLE public.notif_reglas(evento text PRIMARY KEY, categoria text, descripcion text, severidad text, permisos text[], al_solicitante boolean);
      CREATE TABLE public.notifications(evento text, dedupe_key text UNIQUE, titulo text, cuerpo text);
      CREATE FUNCTION public.notif_emit(p_evento text, p_dedupe text, p_titulo text, p_cuerpo text, p_link text, p_target uuid DEFAULT NULL) RETURNS bigint
        LANGUAGE sql AS $$ INSERT INTO public.notifications VALUES (p_evento, p_dedupe, p_titulo, p_cuerpo) ON CONFLICT DO NOTHING RETURNING 1::bigint $$;
      CREATE FUNCTION public.driver_preuse_format() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
        SELECT '{"items":[{"code":"i01","text":"Sistema de Frenos"},{"code":"i11","text":"Nivel de aceite del motor"},{"code":"i15","text":"Bocina"}]}'::jsonb $$;
      CREATE FUNCTION public.preuse_plate_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(regexp_replace($1, '[^A-Za-z0-9]', '', 'g')) $$;
      CREATE FUNCTION public.check_asset_eligibility(p_plate text, p_context text DEFAULT 'RELEASE') RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE v_motives jsonb := '[]'::jsonb; v_open_faults int;
      BEGIN
        SELECT count(*) INTO v_open_faults FROM public.maintenance_requests
        WHERE vehicle_plate = p_plate AND severity = 'CRITICA' AND status NOT IN ('CERRADA', 'DESCARTADA', 'CONVERTIDA_OT');
        IF v_open_faults > 0 THEN
          v_motives := v_motives || jsonb_build_array(v_open_faults || ' falla(s) crítica(s) sin resolver');
        END IF;
        RETURN jsonb_build_object('status', CASE WHEN jsonb_array_length(v_motives) > 0 THEN 'NO_APTO' ELSE 'APTO' END, 'motives', v_motives);
      END $$;
      CREATE FUNCTION public.get_tower_dispatches(p_date date, p_site uuid, p_status text) RETURNS bigint LANGUAGE sql STABLE AS $$
        SELECT count(*) FROM public.maintenance_requests mr WHERE mr.vehicle_plate IS NOT NULL
          AND (mr.status IN ('PENDIENTE', 'OBSERVADO') OR mr.severity IN ('ALTA', 'CRITICA')) $$;
      INSERT INTO public.vehicles VALUES ('AAA-111','DISPONIBLE'),('BBB-222','DISPONIBLE'),('CCC-333','BLOQUEADA'),('DDD-444','DISPONIBLE'),('EEE-555','EN_OPERACION');`)
    await db.exec(readFileSync('supabase/migrations/20261222090000_preuso_no_apto_mantenimiento.sql', 'utf8'))
    await db.exec(readFileSync('supabase/migrations/20261222093000_preuso_fk_indice.sql', 'utf8'))
    // Caja C55: la FK nueva queda cubierta por un índice completo
    assert.equal((await db.query(`SELECT count(*)::int n FROM pg_constraint c WHERE c.conrelid='public.maintenance_requests'::regclass AND c.contype='f'
      AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)`)).rows[0].n, 0)

    const today = (await db.query(`SELECT (now() AT TIME ZONE 'America/Lima')::date::text d`)).rows[0].d
    let seq = 100
    const answers = marks => JSON.stringify(['i01', 'i11', 'i15'].map(code => ({ code, response: marks[code] || 'B', comment: marks[code] === 'M' ? 'fuga visible' : '' })))
    const submit = async (plate, marks, { operational = true, soat = '2099-01-01', canOperate } = {}) => {
      const op = id(++seq), insp = id(++seq)
      const bad = Object.values(marks).includes('M')
      await db.query(`SELECT set_config('test.uid', $1, false)`, [DRIVER_PROFILE])
      await db.query(`INSERT INTO public.driver_preuse_inspections(operation_id, inspection_id, driver_id, submitted_by, vehicle_plate, operation_date, captured_at,
        driver_name, soat_expiration, technical_review_expiration, answers, vehicle_operational, can_operate, observation)
        VALUES ($1,$2,$3,$4,$5,$6::date,now(),'JUAN PEREZ',$7::date,'2099-01-01',$8::jsonb,$9,$10,'')`,
        [op, insp, DRIVER, DRIVER_PROFILE, plate, today, soat, answers(marks), operational, canOperate ?? (operational && !bad && soat >= today)])
      return { op, insp }
    }
    const requests = async plate => (await db.query(`SELECT * FROM public.maintenance_requests WHERE vehicle_plate=$1 ORDER BY reported_at`, [plate])).rows
    const status = async plate => (await db.query(`SELECT status FROM public.vehicles WHERE plate=$1`, [plate])).rows[0].status
    const elig = async plate => (await db.query(`SELECT public.check_asset_eligibility($1,'DISPATCH') e`, [plate])).rows[0].e

    // 1. M en un ítem no crítico ⇒ falla MEDIA, unidad OBSERVADA, motivo del motor y aviso
    const a1 = await submit('AAA-111', { i11: 'M' })
    let reqs = await requests('AAA-111')
    assert.equal(reqs.length, 1)
    assert.equal(reqs[0].severity, 'MEDIA'); assert.equal(reqs[0].preuse_operation_id, a1.op); assert.equal(reqs[0].source, 'INSPECCION')
    assert.match(reqs[0].description, /Nivel de aceite del motor \(fuga visible\)/)
    assert.equal(await status('AAA-111'), 'OBSERVADA')
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.vehicle_history_logs WHERE vehicle_plate='AAA-111' AND new_value='OBSERVADA'`)).rows[0].n, 1)
    let e = await elig('AAA-111')
    assert.equal(e.status, 'NO_APTO'); assert.ok(e.motives.some(m => m.startsWith('Checklist pre-uso No apto')), JSON.stringify(e))
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.notifications WHERE dedupe_key=$1`, ['preuso-' + a1.op])).rows[0].n, 1)

    // 2. Otro No apto de la misma unidad se suma a la falla abierta; «no operativo» la sube a ALTA
    await submit('AAA-111', { i15: 'M' }, { operational: false })
    reqs = await requests('AAA-111')
    assert.equal(reqs.length, 1, 'sin fallas duplicadas'); assert.equal(reqs[0].severity, 'ALTA'); assert.match(reqs[0].notes, /Nuevo No apto: .*Vehículo declarado no operativo/)

    // 3. Solo Regular ⇒ observación BAJA, la unidad sigue disponible y sin aviso
    const b1 = await submit('BBB-222', { i15: 'R' })
    reqs = await requests('BBB-222')
    assert.equal(reqs.length, 1); assert.equal(reqs[0].severity, 'BAJA'); assert.equal(await status('BBB-222'), 'DISPONIBLE')
    assert.equal((await elig('BBB-222')).status, 'APTO')
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.notifications WHERE dedupe_key=$1`, ['preuso-' + b1.op])).rows[0].n, 0)
    await submit('BBB-222', { i11: 'R' })
    reqs = await requests('BBB-222'); assert.equal(reqs.length, 1); assert.match(reqs[0].notes, /Regular: Nivel de aceite/)

    // 4. Ítem crítico: la falla CRÍTICA por ítem (creada por la inspección) se enlaza; no se crea otra
    const opC = id(900), inspC = id(901), resultC = id(902)
    await db.query(`INSERT INTO public.inspection_results VALUES ($1,$2)`, [resultC, inspC])
    await db.query(`INSERT INTO public.maintenance_requests(vehicle_plate, description, severity, status, source, source_ref_id) VALUES ('CCC-333','Fallo crítico en inspección: Sistema de Frenos','CRITICA','REPORTADA','INSPECCION',$1)`, [resultC])
    await db.query(`INSERT INTO public.driver_preuse_inspections(operation_id, inspection_id, driver_id, submitted_by, vehicle_plate, operation_date, captured_at, driver_name,
      soat_expiration, technical_review_expiration, answers, vehicle_operational, can_operate, observation)
      VALUES ($1,$2,$3,$4,'CCC-333',$5::date,now(),'JUAN PEREZ','2099-01-01','2099-01-01',$6::jsonb,true,false,'')`, [opC, inspC, DRIVER, DRIVER_PROFILE, today, answers({ i01: 'M' })])
    reqs = await requests('CCC-333')
    assert.equal(reqs.length, 1); assert.equal(reqs[0].severity, 'CRITICA'); assert.equal(reqs[0].preuse_operation_id, opC); assert.equal(await status('CCC-333'), 'BLOQUEADA')

    // 5. Documentos vencidos sin fallas mecánicas ⇒ solo aviso
    const d1 = await submit('DDD-444', {}, { soat: '2000-01-01' })
    assert.equal((await requests('DDD-444')).length, 0); assert.equal(await status('DDD-444'), 'DISPONIBLE')
    assert.match((await db.query(`SELECT cuerpo FROM public.notifications WHERE dedupe_key=$1`, ['preuso-' + d1.op])).rows[0].cuerpo, /SOAT o revisión técnica vencidos/)

    // 6. Unidad en operación: se registra la falla pero no se cambia un estado que no corresponde
    await submit('EEE-555', { i11: 'M' })
    assert.equal(await status('EEE-555'), 'EN_OPERACION'); assert.equal((await requests('EEE-555'))[0].severity, 'MEDIA')
    assert.equal((await elig('EEE-555')).status, 'NO_APTO')

    // 7. Mantenimiento cierra la falla ⇒ unidad DISPONIBLE y reinspección del día habilitada
    await db.query(`SELECT set_config('test.uid', $1, false)`, [MECHANIC])
    await db.query(`UPDATE public.maintenance_requests SET status='CERRADA' WHERE vehicle_plate='AAA-111'`)
    assert.equal(await status('AAA-111'), 'DISPONIBLE'); assert.equal((await elig('AAA-111')).status, 'APTO')
    const grant = (await db.query(`SELECT * FROM public.driver_preuse_repeat_authorizations WHERE vehicle_key='AAA111'`)).rows
    assert.equal(grant.length, 1); assert.equal(grant[0].authorized_by, MECHANIC); assert.equal(grant[0].driver_id, DRIVER)
    // Cerrar la observación BAJA no toca la unidad ni habilita reinspecciones
    await db.query(`UPDATE public.maintenance_requests SET status='CERRADA' WHERE vehicle_plate='BBB-222'`)
    assert.equal((await db.query(`SELECT count(*)::int n FROM public.driver_preuse_repeat_authorizations WHERE vehicle_key='BBB222'`)).rows[0].n, 0)

    // 8. Torre de Control: solo fallas abiertas; incluye la falla MEDIA del checklist
    const tower = (await db.query(`SELECT pg_get_functiondef('public.get_tower_dispatches(date,uuid,text)'::regprocedure) d`)).rows[0].d
    assert.match(tower, /mr\.status NOT IN \('CERRADA', 'DESCARTADA'\)/); assert.match(tower, /mr\.preuse_operation_id IS NOT NULL/)
    assert.equal(Number((await db.query(`SELECT public.get_tower_dispatches(null, null, 'TODOS') n`)).rows[0].n), 2, 'CCC-333 crítica y EEE-555 media abiertas')
    console.log('PASS checklist pre-uso No apto: falla única por unidad, OBSERVADA, motivo del motor, observación BAJA, crítica enlazada, aviso, Torre y reinspección al cerrar')
  } finally { await db.close() }
})().catch(error => { console.error(error); process.exit(1) })
