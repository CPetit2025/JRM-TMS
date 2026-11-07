const assert = require("node:assert/strict"),
  fs = require("node:fs");
const {
  setupResources,
  id,
} = require("./fixtures/outsourcing-resources-setup.cjs");
const ts = require("typescript");
const moduleSpec = { exports: {} };
new Function(
  "exports",
  "module",
  ts.transpileModule(fs.readFileSync("src/lib/outsourcing-form.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
)(moduleSpec.exports, moduleSpec);
const { spec, services } = require("./fixtures/outsourcing-wizard-data.cjs");
(async () => {
  const db = await setupResources();
  try {
    await db.exec(
      fs.readFileSync(
        "supabase/migrations/20261228090003_outsourcing_service_only.sql",
        "utf8",
      ),
    );
    const required_at = "2026-12-01T08:00:00-05:00",
      full = { ...spec, unit_count: "2", services: services, required_at };
    const parent = (
      await db.query("SELECT outsourcing_save($1,$2) id", [id(2), full])
    ).rows[0].id;
    await db.query("UPDATE transport_outsourcing SET stage=1 WHERE id=$1", [
      parent,
    ]);
    const resource = {
      plate: "ABC-123",
      unit_type: "Plataforma",
      capacity_t: "10",
      length_m: "10",
      width_m: "3",
      height_m: "4",
      cargo_weight_kg: "100",
      driver: "Chofer QA",
      document: "12345678",
      phone: "999999999",
      license: "L12345678",
      license_category: "AIIIB",
      license_expiration: "2027-01-01",
      vehicle_documents: "SOAT y revisión vigentes",
      driver_documents: "Licencia revisada",
      origin: "Lima",
      destination: "Callao",
      documents_verified: "true",
    };
    const data = {
      supplier_id: id(4),
      quantity: 1,
      starts_at: required_at,
      ends_at: "2026-12-01T20:00:00-05:00",
      quoted_amount: 500,
      confirmed_amount: 500,
      currency: "PEN",
      exchange_rate: 1,
      terms: "Servicio total incluye IGV",
      resource,
    };
    const save = async (p = data, assignment = null, version = null) =>
      (
        await db.query(
          "SELECT outsourcing_assignment_save($1,$2,$3,$4,$5,$6) id",
          [parent, "FLETE", p, assignment, version, "Asignación de prueba"],
        )
      ).rows[0].id;
    const get = async (a) =>
      (
        await db.query(
          "SELECT * FROM transport_outsourcing_assignments WHERE id=$1",
          [a],
        )
      ).rows[0];
    const action = async (a, op) =>
      db.query("SELECT outsourcing_assignment_action($1,$2,$3,$4)", [
        a,
        (await get(a)).version,
        op,
        "Sustento de prueba",
      ]);
    const queue = async (p = {}) =>
      (await db.query("SELECT outsourcing_management_queue($1) q", [p])).rows[0]
        .q;
    let a = await save();
    assert.equal((await queue({ service: "FLETE" })).items[0].state, "PARCIAL");
    await assert.rejects(save({ ...data, quantity: 2 }), /supera/);
    await assert.rejects(action(a, "CONFIRM"), /Transición inválida/);
    await db.exec("SELECT set_config('test.permission','reader',false)");
    await assert.rejects(save(), /Sin permiso/);
    await assert.rejects(action(a, "APPROVE"), /Sin permiso/);
    await db.exec("SELECT set_config('test.permission','admin',false)");
    await assert.rejects(save(data, a, 999), /cambió/);
    await action(a, "APPROVE");
    await action(a, "CONFIRM");
    assert.equal((await get(a)).state, "CONFIRMED");
    await assert.rejects(action(a, "COMPLETE"), /Finalice/);
    // Two providers, one original source, one card per unit.
    await db.query("INSERT INTO suppliers VALUES($1,true,$2,$3)", [
      id(15),
      "TRANSPORTE",
      "Proveedor B",
    ]);
    const b = await save({
      ...data,
      supplier_id: id(15),
      resource: { ...resource, plate: "XYZ-456", document: "87654321" },
    });
    await action(b, "APPROVE");
    await action(b, "CONFIRM");
    assert.equal(
      (await queue({ service: "FLETE" })).items[0].state,
      "CONFIRMADA",
    );
    assert.match(
      (await queue({ search: "Proveedor B" })).items[0].suppliers,
      /Proveedor B/,
    );
    assert.equal((await queue({ offset: 1, limit: 1 })).items.length, 1);
    assert.equal((await queue({ from: "2027-01-01" })).total, 0);
    await assert.rejects(
      save({ ...data, resource: { ...resource, plate: "NEW-777" } }),
      /supera/,
    );
    await action(b, "CANCEL");
    const conflict = await save({ ...data, resource });
    await assert.rejects(action(conflict, "APPROVE"), /comprometido/);
    await action(conflict, "CANCEL");
    // Editing resets approvals, old specs cannot keep active bookings.
    await save(
      { ...data, resource: { ...resource, plate: "AAA-888" } },
      a,
      (await get(a)).version,
    );
    assert.equal((await get(a)).state, "DRAFT");
    await action(a, "APPROVE");
    await action(a, "CONFIRM");
    await db.query(
      "UPDATE transport_outsourcing_assignments SET dispatch_id=$1 WHERE id=$2",
      [id(6), a],
    );
    await assert.rejects(save(data, a, (await get(a)).version), /vinculado/);
    await assert.rejects(action(a, "CANCEL"), /Cancele primero/);
    await assert.rejects(
      db.query(
        "UPDATE transport_outsourcing SET revision=revision+1 WHERE id=$1",
        [parent],
      ),
      /programados/,
    );
    await db.query("UPDATE dispatches SET status='CANCELADO' WHERE id=$1", [
      id(6),
    ]);
    await action(a, "CANCEL");
    const g = await db.query(
      "SELECT has_table_privilege('authenticated','transport_outsourcing_assignments','INSERT') AS write,has_function_privilege('anon','outsourcing_assignment_save(uuid,text,jsonb,uuid,integer,text)','EXECUTE') AS anon",
    );
    assert.deepEqual(g.rows[0], { write: false, anon: false });
    await db.exec("SELECT set_config('test.site','no',false)");
    assert.equal((await queue()).total, 0);
    await assert.rejects(
      db.query("SELECT outsourcing_assignment_context($1)", [parent]),
      /Sin acceso/,
    );
    await db.exec("SELECT set_config('test.site','yes',false)");
    // Standalone equipment: no vehicle fields, both client and actual SQL validation.
    const onlyEquipment = {
      ...spec,
      transport_required: "false",
      services: [services.find((x) => x.kind === "MONTACARGAS")],
      packages: [],
    };
    for (const f of moduleSpec.exports.TRANSPORT_FIELDS)
      delete onlyEquipment[f.key];
    assert.deepEqual(
      moduleSpec.exports.validateWizard(
        moduleSpec.exports.normalizeSpec(onlyEquipment),
      ),
      [],
    );
    const serialized = moduleSpec.exports.serializeSpec(
      moduleSpec.exports.normalizeSpec(onlyEquipment),
    );
    assert.deepEqual(
      (
        await db.query("SELECT outsourcing_v2_validate($1) errors", [
          serialized,
        ])
      ).rows[0].errors,
      [],
    );
    await db.query(
      "INSERT INTO transport_requests(id,site_id,contract_id,request_number,status) VALUES($1,$2,$3,$4,$5)",
      [id(20), id(3), id(9), "RT-EQUIPO", "APROBADA"],
    );
    const eqParent = (
      await db.query("SELECT outsourcing_submit($1,$2,null,$3) row", [
        id(20),
        serialized,
        "Equipo sin transporte",
      ])
    ).rows[0].row;
    assert.equal(eqParent.stage, 1);
    await db.query("INSERT INTO suppliers VALUES($1,true,$2,$3)", [
      id(21),
      "MONTACARGA",
      "Equipo QA",
    ]);
    const equipmentData = {
      ...data,
      supplier_id: id(21),
      resource: {
        equipment: "EQ-001",
        capacity: "5",
        height: "10",
        operator: "Operador QA",
        operator_document: "11111111",
        certificates: "Inspección vigente",
        location: "Planta",
        documents_verified: "true",
      },
    };
    const eq = (
      await db.query(
        "SELECT outsourcing_assignment_save($1,$2,$3,null,null,$4) id",
        [eqParent.id, "MONTACARGAS", equipmentData, "Asignación de equipo"],
      )
    ).rows[0].id;
    await action(eq, "APPROVE");
    await action(eq, "CONFIRM");
    assert.equal(
      (await get(eq)).resource.plate,
      undefined,
      "forklift never requires vehicle data",
    );
    // Crane review is independent of nominal capacity.
    const crane = (
      await db.query(
        "SELECT outsourcing_assignment_save($1,$2,$3,null,null,$4) id",
        [
          parent,
          "GRUA",
          {
            ...data,
            supplier_id: id(8),
            resource: {
              equipment: "GR-001",
              capacity: "100",
              reach: "100",
              operator: "Operador",
              operator_document: "22222222",
              certificates: "Vigente",
              location: "Obra",
              documents_verified: "true",
            },
          },
          "Asignación de grúa",
        ],
      )
    ).rows[0].id;
    await assert.rejects(action(crane, "APPROVE"), /evaluación documentada/);
    // No approval writes any native budget ledger.
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM transport_outsourcing_assignments WHERE state='CONFIRMED'",
        )
      ).rows[0].n,
      1,
    );
    const audit = await db.query(
      "SELECT count(*)::int n FROM transport_outsourcing_events WHERE snapshot->>'action' LIKE 'RESOURCE_%'",
    );
    assert.ok(audit.rows[0].n >= 12);
    console.log(
      "PASS resources: quantities, partial, two providers, approval, conflicts, stale edits, cancellation, route guards, audit, pagination, filters, permissions",
    );
  } finally {
    await db.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
