const assert = require("node:assert/strict"),
  fs = require("node:fs");
const {
  setupResources,
  id,
} = require("./fixtures/outsourcing-resources-setup.cjs");
const { spec, services } = require("./fixtures/outsourcing-wizard-data.cjs");
const extract = (file, name) => {
  const text = fs.readFileSync("supabase/migrations/" + file, "utf8"),
    start = text.indexOf("CREATE OR REPLACE FUNCTION public." + name + "("),
    end = text.indexOf("END $$;", start);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end + 7);
};
(async () => {
  const db = await setupResources();
  try {
    await db.exec(`ALTER TABLE transport_requests ADD COLUMN service_cost numeric DEFAULT 1000;
 ALTER TABLE transport_unloading_costs ADD COLUMN id uuid DEFAULT gen_random_uuid();
 ALTER TABLE dispatches ALTER COLUMN id SET DEFAULT gen_random_uuid();
 ALTER TABLE dispatches ADD COLUMN driver_name text,ADD COLUMN tercero_conductor text,ADD COLUMN tercero_telefono text,ADD COLUMN tercero_license_number text,ADD COLUMN tercero_license_expiration date;
 ALTER TABLE dispatch_requests ADD COLUMN status text,ADD COLUMN document_type text,ADD COLUMN document_number text,ADD COLUMN leg_planned_km numeric,ADD COLUMN sequence_order integer;
 CREATE TABLE contract_budgets(id uuid DEFAULT gen_random_uuid(),contract_id uuid,concept text,balance_pen numeric,reserved_pen numeric DEFAULT 0,updated_at timestamptz);
 INSERT INTO contract_budgets(contract_id,concept,balance_pen) VALUES('${id(9)}','PARTIDA_TRANSPORTE',10000);
 CREATE TABLE contract_services(id uuid DEFAULT gen_random_uuid(),contract_id uuid,service_type text,description text,amount_pen numeric,service_date date,plate text,driver_name text,category text,created_by uuid,dispatch_id uuid,provider_ruc text,provider_name text);
 CREATE TABLE dispatch_events(dispatch_id uuid,event_type text,description text,created_by text);
 CREATE TABLE hhee_people(id uuid,name text,document_number text,active boolean);
 CREATE TABLE dispatch_freight_stages(dispatch_id uuid,agreed_reason text,updated_at timestamptz);
 ALTER TABLE transport_requests ADD COLUMN cost_center_id uuid;
 ALTER TABLE dispatches ADD COLUMN contract_id uuid,ADD COLUMN cost_center_id uuid;
 ALTER TABLE transport_unloading_costs ADD COLUMN contract_id uuid,ADD COLUMN description text,ADD COLUMN estimated_pen numeric DEFAULT 0,ADD COLUMN created_by uuid,ADD COLUMN origin text,ADD COLUMN cost_center_id uuid,ADD COLUMN billing_unit text,ADD COLUMN agreed_rate numeric,ADD COLUMN agreed_qty numeric,ADD COLUMN workers int,ADD COLUMN min_billable_qty numeric,ADD COLUMN fraction_minutes int,ADD COLUMN agreed_reason text,ADD COLUMN agreed_by uuid,ADD COLUMN agreed_at timestamptz,ADD COLUMN planned_by uuid,ADD COLUMN planned_at timestamptz,ADD COLUMN void_reason text,ADD COLUMN created_at timestamptz DEFAULT now();
 CREATE TABLE route_forklifts(dispatch_id uuid,transport_request_id uuid,supplier_id uuid,hourly_rate numeric,unloading_cost_id uuid);
 CREATE TABLE service_cost_events(unloading_cost_id uuid,transport_request_id uuid,dispatch_id uuid,contract_id uuid,concept text,stage text,old_amount numeric,new_amount numeric,old_status text,new_status text,detail jsonb,reason text,created_by uuid);
 CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql AS $$SELECT true$$;`);
    await db.exec(extract('20261007150000_request_optional_pickup_details.sql','plan_dispatch_unloading'));
    await db.exec(extract('20261105090000_herencia_servicios_especiales.sql','inherit_route_unloading'));
    await db.exec(extract('20261111100000_sustento_unidades_cobro.sql','set_special_service_agreements'));
    const native = extract(
      "20261006160000_despacho_tercerizado.sql",
      "schedule_dispatch_tercero",
    );
    await db.exec(
      native.replace(
        "public.schedule_dispatch_tercero(",
        "public.schedule_dispatch_tercero_attention_legacy(",
      ),
    );
    await db.exec(
      `CREATE FUNCTION schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb) RETURNS uuid LANGUAGE sql AS $$SELECT schedule_dispatch_tercero_attention_legacy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)$$;`,
    );
    await db.exec(
      extract(
        "20261111100000_sustento_unidades_cobro.sql",
        "schedule_route_resources",
      ),
    );
    await db.exec(
      fs.readFileSync(
        "supabase/migrations/20261228090002_outsourcing_route_resources.sql",
        "utf8",
      ),
    );
    await db.exec(
      fs.readFileSync(
        "supabase/migrations/20261228090004_outsourcing_resource_rectification.sql",
        "utf8",
      ),
    );
    await db.exec(fs.readFileSync('supabase/migrations/20261228090005_outsourcing_booking_guards.sql','utf8'));
    await db.exec(fs.readFileSync('supabase/migrations/20261228090006_outsourcing_active_account_policy.sql','utf8'));
    const parent = (
      await db.query("SELECT outsourcing_save($1,$2) id", [
        id(2),
        { ...spec, services: [services.find(x=>x.kind==='GRUA')], unit_count: "2" },
      ])
    ).rows[0].id;
    await db.query("UPDATE transport_outsourcing SET stage=1 WHERE id=$1", [
      parent,
    ]);
    await db.query("INSERT INTO suppliers VALUES($1,true,$2,$3)", [
      id(15),
      "TRANSPORTE",
      "Proveedor B",
    ]);
    await db.query("INSERT INTO carriers VALUES($1,$2)", [id(16), id(15)]);
    const resource = {
      plate: "ABC-123",
      unit_type: "Plataforma",
      capacity_t: "10",
      length_m: "10",
      width_m: "3",
      height_m: "4",
      cargo_weight_kg: "100",
      driver: "Conductor",
      document: "12345678",
      phone: "999999999",
      license: "A123",
      license_category: "AIIIB",
      license_expiration: "2027-01-01",
      vehicle_documents: "SOAT vigente",
      driver_documents: "Licencia vigente",
      origin: "Lima",
      destination: "Callao",
      documents_verified: "true",
    };
    async function assignment(supplier, r, cost) {
      const a = (
        await db.query(
          "SELECT outsourcing_assignment_save($1,$2,$3,null,null,$4) id",
          [
            parent,
            "FLETE",
            {
              supplier_id: supplier,
              quantity: 1,
              starts_at: "2026-12-01T08:00:00-05:00",
              ends_at: "2026-12-01T20:00:00-05:00",
              quoted_amount: cost,
              confirmed_amount: cost,
              currency: "PEN",
              exchange_rate: 1,
              terms: "Incluye impuestos y peajes",
              resource: r,
            },
            "Asignación por unidad",
          ],
        )
      ).rows[0].id;
      await db.query(
        "SELECT outsourcing_assignment_action($1,1,'APPROVE','Aprobación económica')",
        [a],
      );
      await db.query(
        "SELECT outsourcing_assignment_action($1,2,'CONFIRM','Proveedor confirmado')",
        [a],
      );
      return a;
    }
    const a = await assignment(id(4), resource, 500),
      b = await assignment(
        id(15),
        { ...resource, plate: "XYZ-456", document: "87654321" },
        600,
      );
    const context = (
      await db.query("SELECT outsourcing_route_context($1) c", [a])
    ).rows[0].c;
    assert.equal(context.request.estimated_weight, 100);
    assert.equal(context.resource.id, a);
    const schedule = async (aid,supports=[]) =>
      (
        await db.query("SELECT schedule_route_resources($1) id", [
          {
            outsourcing_assignment_id: aid,outsourcing_support_ids:supports,
            mode: "TERCERO",
            p_requests: [{ id: id(2), document_number: "GR-QA" }],
            p_contract_id: id(9),
            p_departure: "2026-12-01T09:00:00-05:00",
            p_estimated_km: 25,
            p_freight_cost: 1,
            p_plate: "FAKE123",
            p_conductor: "Alterado",
            forklift: null,
            auxiliaries: [],
          },
        ])
      ).rows[0].id;
    await db.query("UPDATE transport_outsourcing_assignments SET state='DRAFT' WHERE id=ANY($1::uuid[])",[[a,b]]);
    await assert.rejects(schedule(null),/Confirme y seleccione/,'pending procurement cannot be bypassed');
    await db.query("UPDATE transport_outsourcing_assignments SET state='CONFIRMED' WHERE id=ANY($1::uuid[])",[[a,b]]);
    await db.query("UPDATE transport_requests SET status='ASIGNADA' WHERE id=$1",[id(2)]);
    await assert.rejects(schedule(a),/ya asignada/,'cannot adopt unrelated manual dispatch with second-unit exception');
    await db.query("UPDATE transport_requests SET status='APROBADA' WHERE id=$1",[id(2)]);
    const crane=(await db.query('SELECT outsourcing_assignment_save($1,$2,$3,null,null,$4) id',[parent,'GRUA',{supplier_id:id(8),quantity:1,starts_at:'2026-12-01T08:00:00-05:00',ends_at:'2026-12-01T20:00:00-05:00',quoted_amount:300,confirmed_amount:300,currency:'PEN',exchange_rate:1,terms:'Servicio completo con operador',resource:{equipment:'GR-001',capacity:'100',reach:'100',operator:'Gruista',operator_document:'22222222',certificates:'Vigentes',location:'Obra',maneuver_review:'Ingeniero QA: tabla, radio y accesorios revisados para maniobra',documents_verified:'true'}},'Grúa para operación'])).rows[0].id;
    await db.query("SELECT outsourcing_assignment_action($1,1,'APPROVE','Evaluación de grúa y costo')",[crane]);await db.query("SELECT outsourcing_assignment_action($1,2,'CONFIRM','Grúa confirmada por proveedor')",[crane]);
    const d1 = await schedule(a,[crane]);
    assert.equal(Number((await db.query('SELECT planned_pen FROM transport_unloading_costs WHERE dispatch_id=$1',[d1])).rows[0].planned_pen),300,'support uses actual native planning agreement');

    assert.equal(
      Number(
        (
          await db.query(
            "SELECT freight_cost,vehicle_plate FROM dispatches WHERE id=$1",
            [d1],
          )
        ).rows[0].freight_cost,
      ),
      500,
      "cost taken from server assignment",
    );
    assert.equal(
      (await db.query("SELECT vehicle_plate FROM dispatches WHERE id=$1", [d1]))
        .rows[0].vehicle_plate,
      "ABC-123",
    );
    await assert.rejects(schedule(a), /ya programada/);
    const d2 = await schedule(b);
    assert.notEqual(d1, d2);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM dispatch_requests WHERE transport_request_id=$1",
          [id(2)],
        )
      ).rows[0].n,
      3,
      "fixture route plus two genuine source links",
    );
    assert.equal(
      Number(
        (await db.query("SELECT reserved_pen FROM contract_budgets")).rows[0]
          .reserved_pen,
      ),
      1400,
      "real native scheduler reserves each unit exactly once",
    );
    assert.equal(
      Number(
        (await db.query("SELECT sum(amount_pen) total FROM contract_services"))
          .rows[0].total,
      ),
      1100,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM outsourcing_booking_context",
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(
      db.query(
        "SELECT schedule_dispatch_tercero($1,'ZZZ-777','Otro','999','555',now(),1,50,$2,$3)",
        [id(5), id(9), [{ id: id(2) }]],
      ),
      /ya asignada/,
      "exception not available outside wrapper",
    );
    const get = async (a) =>
      (
        await db.query(
          "SELECT * FROM transport_outsourcing_assignments WHERE id=$1",
          [a],
        )
      ).rows[0];
    await assert.rejects(
      db.query("SELECT outsourcing_assignment_rectify($1,$2,$3,$4,false)", [
        a,
        (await get(a)).version,
        { ...resource, plate: "NEW-999" },
        "Sustitución autorizada",
      ]),
      /Confirme/,
    );
    await db.query("SELECT outsourcing_assignment_rectify($1,$2,$3,$4,true)", [
      a,
      (await get(a)).version,
      { ...resource, plate: "NEW-999" },
      "Sustitución autorizada",
    ]);
    assert.equal(
      (await db.query("SELECT vehicle_plate FROM dispatches WHERE id=$1", [d1]))
        .rows[0].vehicle_plate,
      "NEW-999",
    );
    assert.equal(
      Number(
        (await db.query("SELECT reserved_pen FROM contract_budgets")).rows[0]
          .reserved_pen,
      ),
      1400,
      "rectification has no second budget reservation",
    );
    const info = await db.query(
      "SELECT * FROM outsourcing_route_resources(null,$1)",
      [d1],
    );
    assert.equal(info.rows.length, 2);
    console.log(
      "PASS route integration: real native scheduler, two units/two suppliers, original request, authoritative cost/driver, one budget reservation each, duplicates, scoped booking exception, rectification and audit",
    );
  } finally {
    await db.close();
  }
})().catch((e) => {
  console.error(e.message, e.where || "");
  process.exitCode = 1;
});
