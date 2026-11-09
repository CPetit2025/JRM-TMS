// Chromium + API local simulada. No imprime ni altera operaciones reales.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  http = require("node:http"),
  { spawn } = require("node:child_process"),
  { chromium } = require("playwright");
const uid = "00000000-0000-4000-8000-000000000001",
  code = "PKG-TEST-000001",
  key = "ERP-IPT-1";
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
  first_name: "QA",
  roles: {
    name: "Administrador",
    permissions: ["almacen-etiquetado", "almacen-supervisor"],
  },
};
const pkg = {
  package_code: code,
  source_document_no: "IPT-001",
  source_contract_code: "16516",
  source_lot: "LOTE-01",
  source_product_code: "SKU-001",
  source_warehouse: "647-04 ALM PT",
  source_date: "2026-11-09",
  description: "Mercadería JRM · ñ y acentos · producto de prueba",
  quantity: 12.5,
  unit: "UND",
  weight_kg: 25,
  sequence_no: 1,
  sequence_total: 1,
  source_movement_key: key,
  label_print_count: 1,
  status: "AVAILABLE",
  created_at: "2026-11-09T13:00:00Z",
  quantity_mismatch: false,
};
const label = {
  ...pkg,
  contract_code: pkg.source_contract_code,
  customer_name: "Cliente de prueba S.A.C.",
};
const receipt = {
  receipt_key: key,
  document_no: pkg.source_document_no,
  fecha: pkg.source_date,
  bodega: pkg.source_warehouse,
  lote: pkg.source_lot,
  product_code: pkg.source_product_code,
  description: pkg.description,
  unit: pkg.unit,
  contract_code: pkg.source_contract_code,
  quantity: 12.5,
  weight_kg: 25,
  customer_name: label.customer_name,
  customer_source: "ERP/OT",
  physical_quantity: 12.5,
  validation_status: "VALIDATED",
  label_count: 1,
  labeled_qty: 12.5,
  unprinted_count: 1,
  pending_labels: [label],
  label_status: "PENDING_PRINT",
};
const calls = [],
  format = {
    id: "format-1",
    name: "Zebra 6 x 4",
    width_mm: 152.4,
    height_mm: 101.6,
    dpi: 203,
    is_active: true,
  };
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  let body = "";
  for await (const c of req) body += c;
  const path = new URL(req.url, "http://localhost").pathname,
    p = body ? JSON.parse(body) : null;
  calls.push({ path, p });
  let out = [];
  if (path.endsWith("/user")) out = user;
  else if (path.endsWith("/token")) out = session;
  else if (path.endsWith("/profiles"))
    out = req.headers.accept?.includes("object") ? profile : [profile];
  else if (path.endsWith("/wh_label_settings")) out = { format };
  else if (path.endsWith("/wh_packages"))
    out = req.headers.accept?.includes("object") ? pkg : [pkg];
  else if (path.endsWith("/rpc/wh_receipt_candidates")) out = [receipt];
  else if (path.endsWith("/rpc/wh_receipt_control_customers"))
    out = [{ source_movement_key: key, customer_name: label.customer_name }];
  else if (path.endsWith("/rpc/wh_receipt_control_operators"))
    out = [
      {
        source_movement_key: key,
        validated_by: uid,
        validated_at: pkg.created_at,
        customer_name: label.customer_name,
        first_name: "QA",
        last_name: "Operador",
      },
    ];
  else if (path.endsWith("/rpc/wh_count_board"))
    out = [
      {
        id: "camp-1",
        code: "INV-001",
        bodega: pkg.source_warehouse,
        zones: [],
        tipo: "BARRIDO",
        productos: [],
        status: "EN_CONTEO",
        created_at: pkg.created_at,
        expected_qty: 12.5,
        expected_lines: 1,
        counted_lines: 1,
        labeled: 1,
        unidentified: 0,
        recounts: 0,
      },
    ];
  else if (path.endsWith("/rpc/wh_count_lines_list"))
    out = [
      {
        id: 1,
        round: 1,
        origin: "ROTULO",
        zone: "A",
        cod_producto: pkg.source_product_code,
        lote_key: pkg.source_lot,
        ot: pkg.source_contract_code,
        quantity: pkg.quantity,
        weight_kg: pkg.weight_kg,
        counted_at: pkg.created_at,
        counted_by_name: "QA",
        mine: true,
        package_code: code,
        description: pkg.description,
        unit: pkg.unit,
      },
    ];
  res.end(JSON.stringify(out));
});
(async () => {
  await new Promise((r) => server.listen(54332, "127.0.0.1", r));
  const log = fs.openSync("/tmp/unified-label-dev.log", "w"),
    next = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3022",
      ],
      {
        env: {
          ...process.env,
          NEXT_PUBLIC_DEPLOYMENT_SYSTEM: "",
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54332",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "qa-public-key",
        },
        stdio: ["ignore", log, log],
      },
    );
  let browser, page;
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch("http://127.0.0.1:3022/login")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:fs.existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium'}:{}),
      args: ["--no-sandbox"],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1536, height: 1000 },
      timezoneId: "America/Lima",
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
    page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept("Reimpresión de prueba autorizada"));
    await page.addInitScript(() => {
      window.__printed = [];
      window.print = () => {
        window.__printed.push(
          document.querySelector("#wh-label-print-root .wh-package-label")
            .outerHTML,
        );
      };
    });
    const out = process.env.LABEL_ARTIFACT_DIR||"/workspace/artifacts/etiqueta-unificada";
    fs.mkdirSync(out, { recursive: true });
    const done = async () =>
      page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    const printed = async () => {
      await page.waitForFunction(() => window.__printed.length > 0);
      return page.evaluate(() => window.__printed.at(-1));
    };
    const reset = async () => page.evaluate(() => (window.__printed = []));
    await page.goto("http://127.0.0.1:3022/almacen/etiquetado");
    await page
      .getByRole("button", { name: "Imprimir pendientes", exact: true })
      .waitFor({ timeout: 90000 });
    await page
      .getByRole("button", { name: "Imprimir pendientes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Vista previa", exact: true })
      .click();
    await page.locator(".wh-package-label").waitFor();
    const preview = await page
      .locator(".wh-package-label")
      .evaluate((n) => n.outerHTML);
    await page.screenshot({
      path: out + "/01-recepcion-vista-previa.png",
      fullPage: true,
      style: "nextjs-portal{display:none}",
    });
    await page
      .getByRole("button", { name: "Imprimir etiqueta", exact: true })
      .click();
    const first = await printed();
    assert.equal(
      first,
      preview,
      "preview and first print use identical markup and content",
    );
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: out + "/etiqueta-canonica.pdf",
      preferCSSPageSize: true,
      printBackground: true,
    });
    await page.screenshot({ path: out + "/02-impresion.png", fullPage: true });
    await page.emulateMedia({ media: "screen" });
    await done();
    await page.goto("http://127.0.0.1:3022/almacen/apt/etiquetas-impresas");
    await page
      .getByRole("button", { name: "Ver detalle", exact: true })
      .click();
    await reset();
    await page.getByRole("button", { name: "Reimprimir", exact: true }).click();
    assert.equal(
      await printed(),
      first,
      "receipt-control reprint is identical",
    );
    await done();
    await page.goto("http://127.0.0.1:3022/almacen/paquetes/" + code);
    await page.locator(".wh-package-label").waitFor();
    assert.equal(
      await page.locator(".wh-package-label").evaluate((n) => n.outerHTML),
      first,
      "package detail uses same preview",
    );
    await reset();
    await page.getByRole("button", { name: "Reimprimir", exact: true }).click();
    assert.equal(await printed(), first, "package detail reprint is identical");
    await done();
    await page.goto("http://127.0.0.1:3022/almacen/inventario/camp-1");
    await reset();
    await page.getByRole("button", { name: "Reimprimir", exact: true }).click();
    assert.equal(
      await printed(),
      first,
      "inventory reprint loads original package, not campaign data",
    );
    await done();
    // Zebra receives an image of that same label (logo and all text), never a second text layout.
    await page.goto("http://127.0.0.1:3022/almacen/paquetes/" + code);
    await page.locator(".wh-package-label").waitFor();
    await page.evaluate(() => {
      window.__zpl = [];
      window.BrowserPrint = {
        getDefaultDevice: (kind, ok) =>
          ok({
            send: (data, success) => {
              window.__zpl.push(data);
              success();
            },
          }),
      };
    });
    await page.getByRole("button", { name: "Reimprimir", exact: true }).click();
    await page.waitForFunction(() => window.__zpl?.length === 1, undefined, {timeout:45000});
    const zpl = await page.evaluate(() => window.__zpl[0]);
    assert.match(zpl, /\^PW1218\^LL812/);
    assert.match(zpl, /\^GFA,/);
    assert.ok(!zpl.includes("^A0N"), "no independently positioned Zebra text");
    fs.writeFileSync(out + "/etiqueta-zebra.zpl", zpl);
    // Compare every thermal bit to rasterizing the canonical browser label at the same DPI.
    const raster = zpl.match(/\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)\^FS/);
    assert.ok(raster);
    assert.equal(Number(raster[1]), 153 * 812);
    assert.ok(/[1-9A-F]/.test(raster[4]), "image is not blank");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: out + "/03-detalle-movil.png",
      fullPage: true,
      style: "nextjs-portal{display:none}",
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "no mobile overflow",
    );
    const enableZebra=()=>page.evaluate(()=>{window.__zpl=[];window.BrowserPrint={getDefaultDevice:(kind,ok)=>ok({send:(data,success)=>{window.__zpl.push(data);success()}})}})
    for(const route of ['control','inventario','recepcion']){
      if(route==='control'){await page.goto('http://127.0.0.1:3022/almacen/apt/etiquetas-impresas');await page.getByRole('button',{name:'Ver detalle',exact:true}).click()}
      else if(route==='inventario'){await page.goto('http://127.0.0.1:3022/almacen/inventario/camp-1');await page.getByRole('button',{name:'Reimprimir',exact:true}).waitFor()}
      else {await page.goto('http://127.0.0.1:3022/almacen/etiquetado');await page.getByRole('button',{name:'Imprimir pendientes',exact:true}).click();await page.getByRole('button',{name:'Vista previa',exact:true}).click()}
      await enableZebra();await page.getByRole('button',{name:route==='recepcion'?'Imprimir etiqueta':'Reimprimir',exact:true}).click();await page.waitForFunction(()=>window.__zpl?.length===1)
      assert.equal(await page.evaluate(()=>window.__zpl[0]),zpl,route+': thermal raster must match byte for byte')
    }
    // Two actual labels must produce exactly two PDF pages, not a cropped lot or a blank page.
    format.width_mm=100;format.height_mm=50;
    receipt.pending_labels=[{...label,sequence_total:2},{...label,package_code:'PKG-TEST-000002',sequence_no:2,sequence_total:2}];receipt.unprinted_count=2;
    await page.goto('http://127.0.0.1:3022/almacen/etiquetado');await page.getByRole('button',{name:'Imprimir pendientes',exact:true}).click();await page.getByRole('button',{name:'Vista previa',exact:true}).click();await page.getByRole('button',{name:'Imprimir lote',exact:true}).click();await printed();
    await page.emulateMedia({media:'print'});const batchPdf=await page.pdf({path:out+'/lote-dos-etiquetas-100x50.pdf',preferCSSPageSize:true,printBackground:true});await page.emulateMedia({media:'screen'});await done();
    const raw=batchPdf.toString('latin1');assert.equal((raw.match(/\/Type \/Page\b/g)||[]).length,2,'one page per label');const box=raw.match(/\/MediaBox\s*\[([\d.\s]+)\]/)[1].trim().split(/\s+/).map(Number);assert.ok(Math.abs(box[2]-100*72/25.4)<1&&Math.abs(box[3]-50*72/25.4)<1,'configured paper dimensions apply to complete lot');
    const reprints = calls.filter((c) => c.path.endsWith("/wh_reprint_label"));
    assert.equal(reprints.length, 6);
    assert.ok(
      reprints.every((c) => c.p.p_package_code === code && c.p.p_reason),
      "same original code and audited reason in every reprint",
    );
    assert.ok(
      !calls.some((c) => c.path.endsWith("/wh_label_package")),
      "reprints do not create packages",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS browser: identical preview/print/reprint markup across reception, control, package detail and inventory; original identity/reasons; identical Zebra raster bytes across four routes; one PDF page per label, configurable size, mobile and screenshots",
    );
  } catch (e) {
    if (page)
      await page
        .screenshot({
          path: (process.env.LABEL_ARTIFACT_DIR||"/workspace/artifacts/etiqueta-unificada")+"/error.png",
          fullPage: true,
        })
        .catch(() => {});
    throw e;
  } finally {
    if (browser) await browser.close();
    next.kill("SIGTERM");
    server.close();
    fs.closeSync(log);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
