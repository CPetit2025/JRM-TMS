// Navegador real y Supabase simulado local. Datos del bosquejo solo como fixture, jamás escribe en producción.
const assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs"),
  ts = require("typescript"),
  { spawn } = require("node:child_process");
const { chromium } = require("playwright"),
  { spec: valid, services } = require("./fixtures/outsourcing-wizard-data.cjs");
const m = { exports: {} };
new Function(
  "exports",
  "module",
  ts.transpileModule(fs.readFileSync("src/lib/outsourcing-form.ts", "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
)(m.exports, m);
const model = m.exports,
  copy = (x) => JSON.parse(JSON.stringify(x)),
  oid = "00000000-0000-4000-8000-000000000002",
  uid = "00000000-0000-4000-8000-000000000001";
const user = {
  id: uid,
  email: "qa@example.test",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
};
const token = [
  { alg: "HS256", typ: "JWT" },
  {
    sub: uid,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
  "signature",
]
  .map((x, i) =>
    i < 2 ? Buffer.from(JSON.stringify(x)).toString("base64url") : x,
  )
  .join(".");
const session = {
  access_token: token,
  refresh_token: "qa-refresh",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  token_type: "bearer",
  user,
};
const profile = {
  id: uid,
  is_active: true,
  employee_type: "STAFF",
  full_name: "QA",
  roles: {
    name: "Administrador",
    permissions: [
      "despacho",
      "compras-tercerizaciones",
      "compras-aprobar",
      "cierre-economico",
    ],
  },
};
const request = {
  id: "req-1",
  request_number: "RT-001970",
  requester_name: valid.responsible,
  pickup_address: valid.pickup,
  delivery_address: valid.delivery,
  required_at: "2026-10-28T13:00:00Z",
  status: "APROBADA",
  created_at: "2026-10-25T10:00:00Z",
  contract_id: "ot-1",
  contracts: {
    id: "ot-1",
    code: "16516",
    clients: { business_name: "INKA CROPS S.A." },
    contract_budgets: [],
  },
  transport_request_items: [],
};
const assignments = [];
let record = {
    id: oid,
    number: 1,
    request_id: request.id,
    dispatch_id: null,
    stage: 1,
    version: 2,
    review_status: "ACTIVE",
    revision: 1,
    specification: copy(valid),
    updated_at: new Date().toISOString(),
  },
  events = [],
  calls = [],
  failSave = false,
  permission = "admin";
const queue = () =>
  record
    ? [
        {
          ...record,
          client: "INKA CROPS S.A.",
          transport_requests: {
            request_number: request.request_number,
            contract_id: request.contract_id,
            contracts: { code: "16516" },
          },
        },
      ]
    : [];
function save(p) {
  if (record && p.p_version !== record.version)
    throw Error("La solicitud cambió");
  if (record && record.stage > 0) throw Error("La solicitud ya fue enviada");
  record = {
    id: oid,
    number: 1,
    request_id: request.id,
    dispatch_id: null,
    stage: 0,
    version: record ? record.version + 1 : 1,
    review_status: "ACTIVE",
    revision: 1,
    specification: copy(p.p_spec),
    updated_at: new Date().toISOString(),
  };
  events.push({
    id: String(events.length),
    stage: 0,
    actor_name: valid.responsible,
    note: "Borrador guardado",
    created_at: new Date().toISOString(),
    evidence: null,
  });
  return oid;
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PATCH");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  let body = "";
  for await (const c of req) body += c;
  const path = new URL(req.url, "http://localhost").pathname;
  let p = null;
  try {
    p = body ? JSON.parse(body) : null;
  } catch {}
  calls.push({ path, p });
  let out = [];
  try {
    if (path === "/auth/v1/user") out = user;
    else if (path.includes("/token")) out = session;
    else if (path.endsWith("/profiles")) {
      const next =
        permission === "admin"
          ? profile
          : {
              ...profile,
              roles: { name: "Consulta", permissions: ["despacho:read"] },
            };
      out = req.headers.accept?.includes("object") ? next : [next];
    } else if (path.endsWith("/transport_requests")) out = [request];
    else if (path.endsWith("/transport_outsourcing")) out = record;
    else if (path.endsWith("/transport_outsourcing_events")) out = events;
    else if (path.endsWith("/rpc/outsourcing_queue")) out = queue();
    else if (path.endsWith("/rpc/outsourcing_management_queue"))
      out = {
        total: 1,
        items: [
          {
            id: oid,
            number: 1,
            request_number: request.request_number,
            contract_code: "16516",
            client: "INKA CROPS S.A.",
            service: "FLETE",
            quantity: 2,
            assigned: assignments.length,
            remaining: 2 - assignments.length,
            suppliers: assignments.length ? "Transporte QA" : null,
            state: assignments.length ? "PARCIAL" : "PENDIENTE",
            required_at: request.required_at,
            costs: assignments.length
              ? [
                  {
                    currency: "PEN",
                    amount: 500,
                    confirmed: assignments[0].state === "CONFIRMED",
                  },
                ]
              : null,
          },
        ],
      };
    else if (path.endsWith("/rpc/outsourcing_assignment_context"))
      out = {
        outsourcing: record,
        requirements: [{ service: "FLETE", quantity: 2 }],
        assignments,
        suppliers: [
          {
            id: "supplier-1",
            business_name: "Transporte QA",
            category: "TRANSPORTE",
            tax_id: "20123456789",
            contact_name: "Contacto QA",
          },
        ],
        vehicles: [],
        personnel: [],
      };
    else if (path.endsWith("/rpc/outsourcing_assignment_save")) {
      const a = {
        ...p.p,
        id: "assignment-1",
        outsourcing_id: oid,
        service: "FLETE",
        supplier_name: "Transporte QA",
        version: 1,
        state: "DRAFT",
        dispatch_id: null,
        amount_pen: 500,
      };
      assignments.push(a);
      out = a.id;
    } else if (path.endsWith("/rpc/outsourcing_assignment_action")) {
      assignments[0].state =
        p.p_action === "APPROVE" ? "APPROVED" : "CONFIRMED";
      assignments[0].version++;
      out = null;
    } else if (path.endsWith("/rpc/outsourcing_route_resources"))
      out = assignments
        .filter((a) => a.state === "CONFIRMED")
        .map((a) => ({
          ...a,
          carrier_id: "carrier-1",
          request_id: request.id,
          request_number: request.request_number,
        }));
    else if (path.endsWith("/rpc/outsourcing_route_context"))
      out = {
        request: { ...request, estimated_weight: 100 },
        resource: {
          ...assignments[0],
          carrier_id: "carrier-1",
          request_id: request.id,
          request_number: request.request_number,
        },
      };
    else if (path.endsWith('/carriers'))out=[{id:'carrier-1',business_name:'Transporte QA',supplier_id:'supplier-1',is_active:true,type:'TERCERO'}];
 else if (path.endsWith("/suppliers"))
      out = [
        {
          id: "supplier-1",
          business_name: "Transporte QA",
          is_active: true,
          category: "TRANSPORTE",
        },
      ];
    else if (path.endsWith("/rpc/outsourcing_options"))
      out = { suppliers: [], dispatches: [] };
    else if (path.endsWith("/rpc/outsourcing_form_context"))
      out = { record, request };
    else if (path.endsWith("/rpc/outsourcing_save")) {
      if (failSave) throw Error("Error de persistencia simulado");
      out = save(p);
    } else if (path.endsWith("/rpc/outsourcing_submit")) {
      if (permission !== "admin") throw Error("Sin permiso");
      const issues = model.validateWizard(model.normalizeSpec(p.p_spec));
      if (issues.length) throw Error(issues.map((i) => i.message).join(" | "));
      save(p);
      record.stage = 1;
      record.version++;
      out = record;
      events.push({
        id: "sent",
        stage: 1,
        actor_name: valid.responsible,
        note: "Recibida por Compras",
        created_at: new Date().toISOString(),
        evidence: null,
      });
    } else if (path.includes("/storage/v1/object/outsourcing/"))
      out = { Key: path.split("/object/")[1] };
    else if (path.endsWith("/rpc/get_menu_counters")) out = {};
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ message: e.message, code: "P0001" }));
  }
});

(async () => {
  await new Promise((r) => server.listen(54329, "127.0.0.1", r));
  const log = fs.openSync("/tmp/tms-resources-dev.log", "w"),
    next = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3020",
      ],
      {
        env: {
          ...process.env,
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "qa-public-key",
        },
        stdio: ["ignore", log, log],
      },
    );
  let browser;
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch("http://127.0.0.1:3020/login")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--lang=es-PE"],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1536, height: 1024 },
      timezoneId: "America/Lima",
      locale: "es-PE",
    });
    await ctx.addCookies([
      {
        name: "sb-127-auth-token",
        value:
          "base64-" +
          Buffer.from(JSON.stringify(session)).toString("base64url"),
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    const page = await ctx.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept("Sustento de aprobación QA"));
    const out = "/workspace/artifacts/tercerizaciones-recursos";
    fs.mkdirSync(out, { recursive: true });
    await page.goto("http://127.0.0.1:3020/despacho/tercerizaciones");
    await page
      .getByRole("button", { name: "Ver / gestionar", exact: true })
      .waitFor({ timeout: 90000 });
    await page.screenshot({
      path: out + "/01-bandeja.png",
      fullPage: true,
      style: "nextjs-portal{display:none}",
    });
    await page
      .getByRole("button", { name: "Ver / gestionar", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Asignar proveedor / recurso" })
      .click();
    await page.getByRole("dialog", { name: /^Asignar/ }).waitFor();
    const dialog = page.getByRole("dialog", { name: /^Asignar/ });
    await dialog
      .getByLabel("Proveedor", { exact: true })
      .selectOption("supplier-1");
    await dialog
      .getByLabel("Fin de disponibilidad (Lima)")
      .fill("2026-10-28T20:00");
    const fields = {
      Placa: "ABC-123",
      "Tipo / configuración": "Plataforma",
      "Capacidad (t)": "10",
      "Largo útil (m)": "10",
      "Ancho útil (m)": "3",
      "Alto útil (m)": "4",
      "Peso asignado a esta unidad (kg)": "100",
      "Volumen asignado (m³)": "1",
      Conductor: "Conductor QA",
      "Documento del conductor": "12345678",
      Teléfono: "999999999",
      Licencia: "A12345678",
      "Categoría de licencia": "AIIIB",
      "Vencimiento de licencia": "2027-01-01",
      "Documentación de unidad / vigencias": "SOAT vigente",
      "Documentación del conductor": "Licencia vigente",
      "Monto total cotizado": "500",
      "Monto total confirmado": "500",
      "Unidad de cobro, alcance, impuestos, inclusiones y exclusiones":
        "Por servicio, incluye IGV y peajes",
      "Motivo de registro / cambio": "Registro de plataforma para programación",
    };
    for (const [label, value] of Object.entries(fields))
      await dialog.getByLabel(label, { exact: true }).fill(value);
    await dialog.getByRole("checkbox").check();
    await page.screenshot({
      path: out + "/02-asignacion.png",
      fullPage: true,
      style: "nextjs-portal{display:none}",
    });
    await dialog
      .getByRole("button", { name: "Guardar asignación", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Aprobar costo y recurso" })
      .waitFor();
    await page.getByRole("button", { name: "Aprobar costo y recurso" }).click();
    await page.getByRole("button", { name: "Confirmar proveedor" }).click();
    await page
      .getByRole("link", { name: "Armar ruta con este recurso" })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: out + "/03-bandeja-movil.png",
      fullPage: true,
      style: "nextjs-portal{display:none}",
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "responsive page without horizontal overflow",
    );
    await page.setViewportSize({ width: 1536, height: 1024 });
    await page
      .getByRole("link", { name: "Armar ruta con este recurso" })
      .click();
    await page
      .getByText("Recursos confirmados de Compras", { exact: true })
      .waitFor({ timeout: 90000 });
    assert.equal(
      await page.getByLabel("Unidad tercerizada", { exact: true }).inputValue(),
      "assignment-1",
    );
    await page.screenshot({
      path: out + "/04-armado-ruta.png",
      fullPage: true,
      style: "nextjs-portal{display:none}",
    });
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].resource.plate, "ABC-123");
    assert.ok(calls.some((c) => c.path.endsWith("/outsourcing_route_context")));
    assert.deepEqual(errors, []);
    console.log(
      "PASS browser: executive table, assignment modal, catalog supplier, technical and economic persistence, approval/confirmation, route prefill, mobile no overflow, screenshots",
    );
  } finally {
    if (browser) await browser.close();
    next.kill("SIGTERM");
    server.close();
    fs.closeSync(log);
  }
})().catch((e) => {
  console.error(e);
  server.close();
  process.exitCode = 1;
});
