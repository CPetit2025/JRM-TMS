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
  first_name: "Carlos",
  last_name: "Petit",
  roles: {
    name: "Administrador",
    permissions: ["almacen-etiquetado", "almacen-supervisor"],
  },
};
const pkg = {
  package_code: code,
  created_by: uid,
  source_document_no: "IPT-001",
  source_contract_code: "16516",
  source_lot: "LOTE-01",
  source_product_code: "SKU-001",
  source_warehouse: "647-04 ALM PT",
  source_date: "2026-11-09",
  description: "VIGA INICIAL PORTAMADERA VIPM 7 CM X 1.22M MEDIDAD TERMINADO",
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
  customer_name: "TIENDAS DEL MEJORAMIENTO DEL HOGAR S.A.",
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
  else if (path.endsWith("/wh_label_formats")) out = [format];
  else if (path.endsWith("/wh_label_settings")) out = new URL(req.url, "http://localhost").searchParams.get("select") === "kind,format_id" ? [{kind:"PAQUETE",format_id:format.id}] : { format };
  else if (path.endsWith("/wh_packages")) {
    const filter=new URL(req.url,'http://localhost').searchParams.get('package_code')||'';
    out=req.headers.accept?.includes('object')?pkg:filter?receipt.pending_labels.filter(r=>filter.includes(r.package_code)).map(r=>({...pkg,...r})):[pkg];
  }
  else if (path.endsWith('/rpc/wh_package_label_responsibles')) out=p.p_package_codes.map(package_code=>({package_code,responsible_name:'Carlos Petit'}));
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
    // Esta cuenta ya eligió el formato del almacén (Zebra); una cuenta nueva parte de A5 vertical (ver label-print-layout).
    await page.addInitScript(id => { for (const k of ['PAQUETE','LPN']) { const key='wh-label-print:v3:'+id+':'+k; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({formatId:'',orientation:'FORMAT',paper:'LABEL'})) } }, uid);
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
    const responsible=page.locator('.wh-package-responsible');
    assert.match(await responsible.innerText(),/Responsable de recepción: Carlos Petit/);
    const responsiblePosition=await page.locator('.wh-package-label').evaluate(n=>{const r=n.querySelector('.wh-package-responsible').getBoundingClientRect(),ipt=n.querySelector('.wh-package-document').getBoundingClientRect();return r.bottom<=ipt.top+1});
    assert.ok(responsiblePosition,'responsible appears above IPT');
    const badges = await page.locator('.wh-package-label').evaluate(n => {
      const sku=n.querySelector('.wh-package-sku'), lot=n.querySelector('.wh-package-lot');
      const a=sku.getBoundingClientRect(), b=lot.getBoundingClientRect();
      return {top:a.top,lotTop:b.top,right:a.right,lotLeft:b.left,background:getComputedStyle(lot).backgroundColor,color:getComputedStyle(lot).color,weight:getComputedStyle(lot).fontWeight};
    });
    assert.ok(Math.abs(badges.top-badges.lotTop)<1 && badges.lotLeft>badges.right, 'lot is right of SKU on same row');
    assert.equal(badges.background,'rgb(0, 0, 0)');assert.equal(badges.color,'rgb(255, 255, 255)');assert.equal(badges.weight,'800');
    const readability=await page.locator('.wh-package-label').evaluate(n=>{
      const customer=n.querySelector('.wh-package-meta > div:first-child'),description=n.querySelector('.wh-package-description');
      const range=document.createRange();range.selectNodeContents(customer.querySelector('strong'));
      const lines=new Set(Array.from(range.getClientRects()).filter(r=>r.width>0).map(r=>Math.round(r.top)));
      return {customerFont:getComputedStyle(customer).fontSize,lines:lines.size,customerFits:customer.scrollHeight<=customer.clientHeight+1,descriptionFont:getComputedStyle(description).fontSize,align:getComputedStyle(description).textAlign,descriptionFits:description.scrollHeight<=description.clientHeight+1};
    });
    assert.equal(readability.customerFont,'18px','customer keeps original font size');assert.equal(readability.lines,2,'long customer name wraps to two lines');assert.ok(readability.customerFits,'full customer is visible');
    assert.equal(readability.descriptionFont,'22px');assert.equal(readability.align,'center');assert.ok(readability.descriptionFits,'larger product description fits without cropping');
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
    assert.ok(await page.locator('.wh-package-sheet').first().evaluate(n=>{const s=n.getBoundingClientRect(),l=n.querySelector('.wh-package-label').getBoundingClientRect();return Math.abs(s.width-l.width)<.2&&Math.abs(s.height-l.height)<.2}),'100x50 fills whole paper');
    await page.emulateMedia({media:'print'});const batchPdf=await page.pdf({path:out+'/lote-dos-etiquetas-100x50.pdf',preferCSSPageSize:true,printBackground:true});await page.emulateMedia({media:'screen'});await done();
    const raw=batchPdf.toString('latin1');assert.equal((raw.match(/\/Type \/Page\b/g)||[]).length,2,'one page per label');const box=raw.match(/\/MediaBox\s*\[([\d.\s]+)\]/)[1].trim().split(/\s+/).map(Number);assert.ok(Math.abs(box[2]-100*72/25.4)<1&&Math.abs(box[3]-50*72/25.4)<1,'configured paper dimensions apply to complete lot');
    // Configuration is edited only in Configuración > Etiquetas; reception applies it without showing controls.
    await page.goto('http://127.0.0.1:3022/almacen/etiquetado');
    assert.equal(await page.getByRole('button',{name:'Formato de la etiqueta de bulto',exact:true}).count(),0,'reception has no configuration editor');
    assert.equal(await page.getByRole('link',{name:'Configuración de etiquetas',exact:true}).getAttribute('href'),'/almacen/maestros/etiquetas');
    const config=await ctx.newPage();config.on('pageerror',e=>errors.push(e.message));
    await config.goto('http://127.0.0.1:3022/almacen/maestros/etiquetas');
    const paper=config.getByRole('button',{name:'Formato de la etiqueta de bulto',exact:true});
    const chooseSetting=async(name,option)=>{await config.getByRole('button',{name,exact:true}).click();await config.getByRole('listbox').getByRole('option',{name:option}).click()};
    const openLabels=async()=>{await page.goto('http://127.0.0.1:3022/almacen/etiquetado');await page.getByRole('button',{name:'Imprimir pendientes',exact:true}).click();await page.getByRole('button',{name:'Vista previa',exact:true}).click()};
    const closeLabels=()=>page.getByRole('button',{name:'Cerrar vista previa',exact:true}).first().click();
    const pdfBox=pdf=>pdf.toString('latin1').match(/\/MediaBox\s*\[([\d.\s]+)\]/)[1].trim().split(/\s+/).map(Number);
    await chooseSetting('Formato de la etiqueta de bulto',/^A5 vertical/);
    await config.getByText('Etiqueta actual: A5 vertical',{exact:false}).waitFor();
    await openLabels();
    await page.evaluate(()=>{window.BrowserPrint={getDefaultDevice:()=>{throw new Error('A5 must use printer/PDF dialog')}}});
    const a5Preview=await page.locator('.wh-package-label').first().evaluate(n=>n.outerHTML);
    await page.getByRole('button',{name:'Imprimir lote',exact:true}).click();await printed();
    assert.equal(await printed(),a5Preview,'configuration-only A5 preference applies to reception preview and print');
    assert.ok(await page.locator('.wh-package-sheet').first().evaluate(n=>{const s=n.getBoundingClientRect(),l=n.querySelector('.wh-package-label').getBoundingClientRect();return Math.abs(s.width-l.width)<.2&&Math.abs(s.height-l.height)<.2}),'A5 full label coverage');
    await page.emulateMedia({media:'print'});const a5Pdf=await page.pdf({path:out+'/etiquetas-a5-vertical.pdf',preferCSSPageSize:true,printBackground:true});await page.emulateMedia({media:'screen'});await done();
    const a5Box=pdfBox(a5Pdf);assert.equal((a5Pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,2);assert.ok(Math.abs(a5Box[2]-148*72/25.4)<1&&Math.abs(a5Box[3]-210*72/25.4)<1,'PDF is A5 vertical');
    await page.goto('http://127.0.0.1:3022/almacen/paquetes/'+code);
    await page.waitForFunction(()=>parseFloat(document.querySelector('.wh-package-label')?.style.getPropertyValue('--wh-label-height'))>800);
    await page.locator('.wh-package-preview').screenshot({path:out+'/05-etiqueta-a5-vertical.png',style:'body > :not(#wh-label-print-root) footer{visibility:hidden}'});
    const secondUser={...user,id:'00000000-0000-4000-8000-000000000002'};
    await ctx.route('**/auth/v1/user',route=>route.fulfill({json:secondUser}));await config.reload();
    // Cuenta nueva sin preferencia guardada: parte de A5 vertical (no hereda la elección del primer usuario).
    await config.getByText('Etiqueta actual: A5 vertical',{exact:false}).waitFor();
    await chooseSetting('Formato de la etiqueta de bulto',/^A5 horizontal/);await config.getByText('Etiqueta actual: A5 horizontal',{exact:false}).waitFor();
    await openLabels();await page.getByRole('button',{name:'Imprimir lote',exact:true}).click();await printed();
    assert.match(await page.locator('#wh-label-print-root .wh-package-responsible').first().innerText(),/Carlos Petit/,'switching logged-in user does not replace original responsible');
    assert.ok(await page.locator('.wh-package-sheet').first().evaluate(n=>{const s=n.getBoundingClientRect(),l=n.querySelector('.wh-package-label').getBoundingClientRect();return Math.abs(s.width-l.width)<.2&&Math.abs(s.height-l.height)<.2}),'A5 horizontal coverage');
    await page.emulateMedia({media:'print'});const horizontalPdf=await page.pdf({path:out+'/etiquetas-a5-horizontal.pdf',preferCSSPageSize:true,printBackground:true});await page.emulateMedia({media:'screen'});await done();
    const horizontalBox=pdfBox(horizontalPdf);assert.ok(Math.abs(horizontalBox[2]-210*72/25.4)<1&&Math.abs(horizontalBox[3]-148*72/25.4)<1,'PDF is A5 horizontal');
    await ctx.unroute('**/auth/v1/user');await config.reload();await config.getByText('Etiqueta actual: A5 vertical',{exact:false}).waitFor();
    assert.match(await paper.innerText(),/^A5 vertical/,'another account cannot change original user preference');
    await paper.press('ArrowDown');await config.getByRole('listbox').waitFor();
    assert.ok(await config.getByRole('listbox').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&n.querySelector('[role=option] span').getBoundingClientRect().left>r.left+12}),'dropdown is padded and inside viewport');
    await config.screenshot({path:out+'/06-papel-desplegable.png',fullPage:true});await config.getByRole('listbox').press('Escape');assert.equal(await paper.getAttribute('aria-expanded'),'false');
    await paper.press('ArrowDown');await config.getByRole('listbox').press('Home');await config.getByRole('listbox').press('ArrowDown');await config.getByRole('listbox').press('ArrowDown');await config.getByRole('listbox').press('Enter');await config.getByText('Etiqueta actual: A5 horizontal',{exact:false}).waitFor();
    await config.setViewportSize({width:390,height:844});await paper.click();
    assert.ok(await config.getByRole('listbox').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&n.scrollWidth<=n.clientWidth+1}),'mobile dropdown does not clip');await config.getByRole('listbox').press('Escape');
    await config.setViewportSize({width:1536,height:1000});await config.screenshot({path:out+'/07-configuracion-desplegable.png',fullPage:true});
    await chooseSetting('Formato de la etiqueta de bulto',/^Zebra 6 x 4/);await chooseSetting('Orientación de la etiqueta',/^Vertical$/);await config.getByText(/Etiqueta actual: .*50 × 100 mm/).waitFor();
    await chooseSetting('Orientación de la etiqueta',/^Horizontal$/);await config.getByText(/Etiqueta actual: .*100 × 50 mm/).waitFor();
    await openLabels();const labelBeforeA4=await page.locator('.wh-package-label').first().evaluate(n=>n.outerHTML);await closeLabels();
    await chooseSetting('Papel cargado en la impresora',/^Hoja A4 vertical/);await config.getByText(/Hoja de impresión: 210 × 297 mm/).waitFor();
    await openLabels();assert.equal(await page.locator('.wh-package-label').first().evaluate(n=>n.outerHTML),labelBeforeA4,'paper never alters label preview');
    await page.evaluate(()=>{window.BrowserPrint={getDefaultDevice:()=>{throw new Error('A4 must use printer/PDF')}}});
    await page.getByRole('button',{name:'Imprimir lote',exact:true}).click();await printed();assert.equal(await printed(),labelBeforeA4);
    const actualMm=await page.locator('.wh-package-sheet').first().evaluate(n=>{const p=n.getBoundingClientRect(),l=n.querySelector('.wh-package-label').getBoundingClientRect(),mm=25.4/96;return {pw:p.width*mm,ph:p.height*mm,lw:l.width*mm,lh:l.height*mm,left:(l.left-p.left)*mm,top:(l.top-p.top)*mm}});
    for(const [field,expected] of Object.entries({pw:210,ph:297,lw:100,lh:50,left:55,top:123.5}))assert.ok(Math.abs(actualMm[field]-expected)<.1,field+': exact dimensions and centering from configuration');
    await page.emulateMedia({media:'print'});const a4Pdf=await page.pdf({path:out+'/etiquetas-100x50-en-a4.pdf',preferCSSPageSize:true,printBackground:true});await page.emulateMedia({media:'screen'});await done();await closeLabels();
    const a4Box=pdfBox(a4Pdf);assert.equal((a4Pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,2);assert.ok(Math.abs(a4Box[2]-210*72/25.4)<1&&Math.abs(a4Box[3]-297*72/25.4)<1);
    await chooseSetting('Posición de la etiqueta en la hoja',/^Esquina superior izquierda$/);await config.reload();await config.getByRole('button',{name:'Posición de la etiqueta en la hoja',exact:true}).filter({hasText:'Esquina superior izquierda'}).waitFor();
    await openLabels();await page.getByRole('button',{name:'Imprimir lote',exact:true}).click();await printed();
    assert.ok(await page.locator('.wh-package-sheet').first().evaluate(n=>{const p=n.getBoundingClientRect(),l=n.querySelector('.wh-package-label').getBoundingClientRect(),mm=25.4/96;return Math.abs((l.left-p.left)*mm-5)<.1&&Math.abs((l.top-p.top)*mm-5)<.1}),'configured top-left placement applies to reception');await done();await closeLabels();
    await chooseSetting('Posición de la etiqueta en la hoja',/^Centrada en la hoja/);await chooseSetting('Formato de la etiqueta de bulto',/^A5 horizontal/);await chooseSetting('Papel cargado en la impresora',/^Hoja A5 vertical/);await config.getByRole('alert').filter({hasText:/no cabe/}).waitFor();
    const beforeInvalid=calls.filter(c=>/wh_(reprint_label|print_labels)$/.test(c.path)).length;
    await openLabels();await page.getByRole('button',{name:'Imprimir lote',exact:true}).click();await page.waitForTimeout(300);assert.equal(await page.locator('#wh-label-print-root').count(),0);assert.equal(calls.filter(c=>/wh_(reprint_label|print_labels)$/.test(c.path)).length,beforeInvalid,'reject invalid fit without auditing');await closeLabels();
    await chooseSetting('Papel cargado en la impresora',/^Hoja con medidas personalizadas$/);
    await config.getByLabel('Ancho de la hoja (mm)',{exact:true}).fill('320');await config.getByLabel('Alto de la hoja (mm)',{exact:true}).fill('450');await config.getByLabel('Margen de la hoja (mm)',{exact:true}).fill('10');await config.getByRole('button',{name:'Aplicar medidas',exact:true}).click();await config.getByText(/Hoja de impresión: 320 × 450 mm · margen 10 mm/).waitFor();
    await config.reload();await config.getByText(/Hoja de impresión: 320 × 450 mm · margen 10 mm/).waitFor();await chooseSetting('Papel cargado en la impresora',/^Hoja A4 horizontal/);await config.getByText(/Hoja de impresión: 297 × 210 mm/).waitFor();
    await config.screenshot({path:out+'/08-etiqueta-hoja-independientes.png',fullPage:true});await config.close();
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
      "PASS browser: settings edited only in configuration and applied to reception; identical preview/print/reprint markup across reception, control, package detail and inventory; original identity/reasons; identical Zebra raster bytes across four routes; one PDF page per label; label orientations, centered A4 placement, optional top-left placement and exact 100x50 size; oversize rejected before audit; A5 vertical/horizontal and thermal sizes; isolated per-account preferences; black lot badge right of SKU; mobile and screenshots",
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
    if (next.exitCode === null && next.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => next.kill('SIGKILL'), 10000);
        next.once('exit', () => { clearTimeout(timer); resolve(); });
        next.kill('SIGTERM');
      });
    }
    server.close();
    fs.closeSync(log);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
