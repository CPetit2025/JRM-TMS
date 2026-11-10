// Etiquetas reales en Chromium: códigos decodificables y textos dentro del papel.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { chromium } = require('playwright'), sharp = require('sharp');
const { MultiFormatReader, DecodeHintType, BarcodeFormat, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } = require('@zxing/library');
const cache = {};
function load(file) {
  if (cache[file]) return cache[file].exports;
  const m = { exports: {} }; cache[file] = m;
  const req = id => {
    if (id.endsWith('.css')) return {};
    if (id.startsWith('@/') || id.startsWith('.')) {
      const base = id.startsWith('@/') ? path.join('src', id.slice(2)) : path.join(path.dirname(file), id);
      return load(['.ts', '.tsx'].map(e => base + e).find(fs.existsSync));
    }
    return require(id);
  };
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require', 'module', 'exports', out)(req,m,m.exports);
  return m.exports;
}
async function decode(svg, format) {
  const {data, info} = await sharp(await svg.screenshot()).flatten({background:'#fff'}).greyscale().raw().toBuffer({resolveWithObject:true});
  return new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(new Uint8ClampedArray(data),info.width,info.height))), new Map([[DecodeHintType.POSSIBLE_FORMATS,[format]]])).getText();
}
(async()=>{
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || undefined});
  try {
    const page = await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:2});
    const {PackageLabel}=load('src/components/warehouse/PackageLabel.tsx');
    const {GroupedBultoLabel}=load('src/components/warehouse/GroupedBultoLabel.tsx');
    const customer='TIENDAS DEL MEJORAMIENTO DEL HOGAR S.A';
    const output=process.env.LABEL_ARTIFACT_DIR || '/tmp/wms-label-codes';fs.mkdirSync(output,{recursive:true});
    for(const code of ['16573-B-0001','PKG-261102-04B6A4E9','16544-S001-2026-01-B-0001']) for(const grouped of [false,true]) for(const format of grouped ? [{name:'base',width_mm:152.4,height_mm:101.6}] : [{name:'base',width_mm:152.4,height_mm:101.6},{name:'a5-vertical',width_mm:148,height_mm:210},{name:'a5-horizontal',width_mm:210,height_mm:148},{name:'a4-vertical',width_mm:210,height_mm:297}]) {
      const label={package_code:code,customer_name:customer,source_product_code:'E.RVLST.20.0705.1220',source_lot:'16573',description:'VIGA SUPERIOR PORTAMADERA VIPM 7 CM X 1.22M MEDIDA TERMINADO',quantity:10,weight_kg:25,unit:'UND',contract_code:'16573-020',source_warehouse:'647-04',source_date:'2026-11-09',source_document_no:'IPT-001',reception_responsible_name:'Carlos Petit',sequence_no:1,sequence_total:1};
      const items=Array.from({length:4},(_,i)=>({product_code:`SKU-${i}`,lot:'16573',quantity:10,unit:'UND'}));
      const element=grouped?React.createElement(GroupedBultoLabel,{code,customer,contract:'16573',request:'RT-004035',items,packages:4,weightKg:25,preparedBy:'Carlos Petit',date:'2026-11-09'}):React.createElement(PackageLabel,{label,format});
      await page.setContent(`<style>${fs.readFileSync('src/components/warehouse/package-label.css','utf8')}</style>${renderToStaticMarkup(element).replace('src="/logo-jrm.png"', `src="data:image/png;base64,${fs.readFileSync('public/logo-jrm.png').toString('base64')}"`)}`);
      await page.emulateMedia({media:'screen'});
      assert.equal(await decode(page.locator('.wh-package-qr'),BarcodeFormat.QR_CODE),code,'QR contains exactly the bulto identifier');
      assert.equal(await page.locator('.wh-package-barcode').count(),0,'solo QR: la etiqueta ya no imprime Code 128');
      assert.match(await page.locator('.wh-package-meta').innerText(),new RegExp(customer.replaceAll('.','\\.')));
      const geometry = await page.locator('.wh-package-codes').evaluate(n=>{
        const qr=n.querySelector('.wh-package-qr').getBoundingClientRect(), code=n.querySelector('.wh-package-code');
        return {qrWidth:qr.width,qrHeight:qr.height,textFits:code.scrollWidth<=code.clientWidth+1};
      });
      assert.ok(geometry.qrHeight >= (grouped ? 60 : 76)*1.5,'QR al menos 50% mayor que el tamaño fijo anterior');
      assert.ok(Math.abs(geometry.qrWidth-geometry.qrHeight)<1,'el QR conserva su forma cuadrada');
      assert.ok(geometry.textFits,'el identificador completo cabe sin invadir el QR');
      await page.emulateMedia({media:'print'});
      assert.equal(await decode(page.locator('.wh-package-qr'),BarcodeFormat.QR_CODE),code,'QR legible también al imprimir');
      const printGeometry=await page.locator('.wh-package-qr').boundingBox();
      assert.equal(printGeometry.width,geometry.qrWidth,'vista previa e impresión conservan el tamaño del QR');
      await page.emulateMedia({media:'screen'});

      const layout=await page.locator('article').evaluate(n=>{
        const bounds=n.getBoundingClientRect();
        return [...n.querySelectorAll('.wh-package-meta,.wh-package-description,.wh-grouped-wrap,.wh-grouped-items,.wh-package-codes,.wh-package-footer')].every(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.bottom<=bounds.bottom&&(e.classList.contains('wh-package-footer') ? r.top+e.scrollHeight<=bounds.bottom : e.scrollHeight<=e.clientHeight+1)});
      });
      if(!layout) console.log(await page.locator('article').evaluate(n=>[...n.children].map(e=>({class:e.className,height:e.getBoundingClientRect().height,scroll:e.scrollHeight,client:e.clientHeight,bottom:e.getBoundingClientRect().bottom,labelBottom:n.getBoundingClientRect().bottom}))));
      assert.ok(layout,'customer, description/items and footer fit inside the label');
      await page.locator('article').screenshot({path:`${output}/${grouped?'agrupado':'bulto'}-${code}${format.name==='base'?'':'-'+format.name}.png`});
    }
    console.log('PASS: solo QR (sin Code 128), al menos 50% mayor y decodificable en paquete/LPN, A5/A4, horizontal/vertical; identificador, cliente y pie sin recortes; mismo tamaño en pantalla e impresión.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
