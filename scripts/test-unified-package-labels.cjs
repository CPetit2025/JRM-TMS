const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  ts = require("typescript");
function load(file) {
  const m = { exports: {} };
  new Function(
    "exports",
    "module",
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(m.exports, m);
  return m.exports;
}
const { packageLabelData } = load("src/lib/warehouse/package-label.ts");
const { monochromeRaster, rasterZpl } = load(
  "src/lib/warehouse/label-raster.ts",
);
const row = {
  package_code: "PKG-ORIGINAL-001",
  source_document_no: "IPT-1",
  source_contract_code: "16516",
  source_lot: "L-1",
  source_warehouse: "647-04",
  source_date: "2026-11-09",
  source_product_code: "P-1",
  description: "Mercadería con ñ y acentos",
  quantity: "0.334",
  weight_kg: "2.5",
  sequence_no: 3,
  sequence_total: 3,
  unit: "UND",
};
const receipt = packageLabelData({
  ...row,
  contract_code: "16516",
  customer_name: "Cliente original",
});
const reprint = packageLabelData(row, "Cliente original");
assert.deepEqual(
  receipt,
  reprint,
  "initial, detail, inventory and receipt control normalize the same original fields",
);
assert.equal(
  reprint.quantity,
  0.334,
  "no recalculation or floating point drift on reprint",
);
assert.equal(
  packageLabelData({ ...row, weight_kg: null }).weight_kg,
  null,
  "missing weight is not zero",
);
assert.throws(() => packageLabelData({ ...row, package_code: "" }), /código/);
const data = new Uint8ClampedArray([
  0, 40, 85, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255,
  255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
]);
const { bytes, bytesPerRow } = monochromeRaster(data, 9, 1);
assert.equal(bytesPerRow, 2);
assert.deepEqual(
  [...bytes],
  [0x94, 0x80],
  "white/transparent pixels and padding remain white, navy/black print",
);
const zpl = rasterZpl(data, 9, 1);
assert.match(zpl, /\^PW9\^LL1/);
assert.match(zpl, /\^GFA,2,2,2,9480/);
assert.throws(() => rasterZpl(data, 100, 100), /inválida/);
console.log(
  "PASS: original package identity and data, decimal quantities, customer/OT normalization, missing weight, thermal raster bits, transparent pixels, row padding and ZPL dimensions",
);
;(async()=>{
 const module={exports:{}};new Function('require','exports','module',ts.transpileModule(fs.readFileSync('src/lib/warehouse/load-package-label.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(()=>({packageLabelData}),module.exports,module)
 const {loadPackageLabels,hydratePackageLabel}=module.exports
 const raw=[{...row,source_movement_key:'movement-1'},{...row,package_code:'PKG-ORIGINAL-002',quantity:'0.333',source_movement_key:'movement-1'}]
 const db={from:()=>({select:()=>({in:async()=>({data:[...raw].reverse(),error:null})})}),rpc:async(name)=>({data:name==='wh_package_label_responsibles'?raw.map(r=>({package_code:r.package_code,responsible_name:'Carlos Petit'})):[{source_movement_key:'movement-1',customer_name:'Cliente original'}],error:null})}
 const actual=await loadPackageLabels(db,raw.map(r=>r.package_code))
 assert.deepEqual(actual,[packageLabelData(raw[0],'Cliente original','Carlos Petit'),packageLabelData(raw[1],'Cliente original','Carlos Petit')],'first print reads persisted decimals/customer and preserves requested order')
 await assert.rejects(loadPackageLabels({...db,from:()=>({select:()=>({in:async()=>({data:[],error:null})})})},[row.package_code]),/bulto original/,'missing original is not reconstructed with guessed data')
 await assert.rejects(hydratePackageLabel({...db,rpc:async()=>({data:null,error:new Error('Sin acceso')})},raw[0]),/Sin acceso/,'customer read errors cannot silently change reprint content')
 assert.equal(actual[0].reception_responsible_name,'Carlos Petit','responsible is original creator, never current reprint user');
 await assert.rejects(hydratePackageLabel({...db,rpc:async(name)=>name==='wh_package_label_responsibles'?{data:null,error:new Error('Sin acceso al responsable')}:db.rpc(name)},raw[0]),/Sin acceso al responsable/);
 console.log('PASS: original database values, authoritative customer, requested print order, missing records and access errors')
})().catch(e=>{console.error(e);process.exitCode=1})

const { packageLabelLayout } = load('src/lib/warehouse/package-label-layout.ts');
for (const [w,h] of [[152.4,101.6],[148,210],[210,148],[100,50]]) {
 const layout = packageLabelLayout({width_mm:w,height_mm:h});
 assert.ok(Math.abs(layout.width*layout.scale-w*96/25.4)<1e-9, 'fills full paper width');
 assert.ok(Math.abs(layout.height*layout.scale-h*96/25.4)<1e-9, 'fills full paper height');
}
assert.throws(()=>packageLabelLayout({width_mm:0,height_mm:210}),/no válida/);
assert.throws(()=>packageLabelLayout({width_mm:NaN,height_mm:210}),/no válida/);

const { orientLabel, labelPrintPage, printerSheet, readPrintPreferences, DEFAULT_PRINT_PREFERENCES } = load('src/lib/warehouse/label-print-layout.ts');
for (const [w,h] of [[100,50],[50,100],[148,210],[152.4,101.6],[105,148],[400,600]]) {
 const landscape=orientLabel({width_mm:w,height_mm:h},'LANDSCAPE');
 assert.equal(landscape.width_mm,Math.max(w,h));assert.equal(landscape.height_mm,Math.min(w,h));
 packageLabelLayout(landscape);
 const portrait=orientLabel({width_mm:w,height_mm:h},'PORTRAIT');assert.equal(portrait.width_mm,Math.min(w,h));assert.equal(portrait.height_mm,Math.max(w,h));
}
const fixedLabel={width_mm:100,height_mm:50};
const a4=printerSheet({...DEFAULT_PRINT_PREFERENCES,paper:'A4_PORTRAIT'});
assert.deepEqual(labelPrintPage({...fixedLabel,paper:a4}),{width_mm:210,height_mm:297,margin_mm:5,position:'CENTER'});
assert.deepEqual(fixedLabel,{width_mm:100,height_mm:50},'A4 does not resize the label');
assert.deepEqual(labelPrintPage(fixedLabel),{width_mm:100,height_mm:50,margin_mm:0},'thermal roll remains exact label size');
assert.throws(()=>labelPrintPage({width_mm:210,height_mm:148,paper:a4}),/no cabe/,'oversize labels are not silently shrunk');
assert.throws(()=>labelPrintPage({...fixedLabel,paper:{width_mm:210,height_mm:297,margin_mm:-1}}),/no son válidas/);
assert.equal(readPrintPreferences(null,'paper-a5-portrait').formatId,'paper-a5-portrait','old per-user selection is retained');
assert.equal(readPrintPreferences(null).formatId,'paper-a5-portrait','default label: A5 vertical');
assert.equal(readPrintPreferences('{bad','legacy').paper,'LABEL');
assert.equal(readPrintPreferences(JSON.stringify({paperWidth:-100,paper:'INVALID'})).paperWidth,210);
console.log('PASS: independent label orientation, exact A4/thermal sizes, invalid fit rejected and legacy preferences retained');

assert.equal(readPrintPreferences(null).position,'CENTER','new accounts default to center');
assert.equal(readPrintPreferences(JSON.stringify({formatId:'saved-label',paper:'A4_PORTRAIT'})).position,'CENTER','existing saved sizes gain centered placement');
assert.equal(readPrintPreferences(JSON.stringify({position:'TOP_LEFT'})).position,'TOP_LEFT');
