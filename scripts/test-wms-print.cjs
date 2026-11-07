// Renders the actual receipt label preview JSX and print CSS, then prints it with Chromium.
// This checks layout/PDF output; it does not certify any physical printer or scanner.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const {execFileSync} = require('node:child_process')
const React = require('react')
const {renderToStaticMarkup} = require('react-dom/server')
const {chromium} = require('playwright-core')
const source = fs.readFileSync('src/app/almacen/etiquetado/page.tsx','utf8')
function compile(input, extra={}) {
 const context={exports:{},require:name=>name in extra?extra[name]:require(name)}
 vm.runInNewContext(ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context)
 return context.exports
}
async function main(){
 const barcode=compile(fs.readFileSync('src/components/warehouse/Code128Barcode.tsx','utf8'))
 const start=source.indexOf('createPortal(<div id="wms-label-preview"')+'createPortal('.length
 const preview=source.slice(start,source.indexOf(', document.body)',start))
 assert.ok(preview.startsWith('<div id="wms-label-preview"'))
 const component=compile(`import {Code128Barcode} from './barcode'; import {Printer,X} from 'lucide-react'; export function Preview({labels,printTarget=null}) { const setShowPreview=()=>{};const print=()=>{};const labelsPrinted=false;const printedLabelCodes=[];return (${preview}) }`,{'./barcode':barcode}).Preview
 const cssStart=source.indexOf('<style jsx global>{`')+'<style jsx global>{`'.length
 const css=source.slice(cssStart,source.indexOf('`}</style>',cssStart))
 const candidates=[...new Set([...preview.matchAll(/className="([^"]+)"/g)].flatMap(match=>match[1].split(/\s+/)))]
 const compiler=await require('tailwindcss').compile(fs.readFileSync('node_modules/tailwindcss/theme.css','utf8')+'\n@tailwind utilities;')
 const utilities=compiler.build(candidates)
 const folder=path.resolve('artifacts/wms-audit');fs.mkdirSync(folder,{recursive:true})
 const executablePath=process.env.WMS_TEST_CHROMIUM || ['/usr/bin/chromium','/usr/bin/google-chrome','/usr/bin/chromium-browser'].find(p=>fs.existsSync(p))
 if(!executablePath)throw Error('Chromium executable unavailable; set WMS_TEST_CHROMIUM')
 const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
 try {
  const page=await browser.newPage({viewport:{width:1400,height:1000}})
  const label={package_code:'LPN-20261107-000001',source_document_no:'0000140557',source_lot:'16543',source_product_code:'AHC.16.2540.2590',description:'DIAGONAL DE RACK C DE 40mm X 25mm DE 1.6mm X 2.590m DE LARGO C/PERFORACIÓN CENTRAL',quantity:100,weight_kg:325.3,unit:'UND',sequence_no:1,sequence_total:1,source_warehouse:'PT',source_date:'2026-11-07',contract_code:'16543-060',customer_name:'Cliente prueba de impresión'}
  for(const count of [1,10]){
   const labels=Array.from({length:count},(_,i)=>({...label,package_code:`LPN-20261107-${String(i+1).padStart(6,'0')}`,sequence_no:i+1,sequence_total:count}))
   const markup=renderToStaticMarkup(React.createElement(component,{labels}))
   const html=`<!doctype html><html><head><meta charset="utf-8"><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:Arial}button{font:inherit}${utilities}\n${css}</style></head><body><div>APPLICATION CHROME MUST NOT PRINT</div>${markup}</body></html>`
   await page.route('http://wms-print.test/**',route=>route.request().url().endsWith('/logo-jrm.png')?route.fulfill({body:fs.readFileSync('public/logo-jrm.png'),contentType:'image/png'}):route.fulfill({body:html,contentType:'text/html'}))
   await page.goto('http://wms-print.test/',{waitUntil:'networkidle'})
   await page.emulateMedia({media:'print'})
   await page.evaluate(()=>document.fonts.ready)
   assert.equal(await page.locator('.wh-label').count(),count)
   const quantity=await page.locator('.wh-label-quantity').first().evaluate(el=>({weight:getComputedStyle(el).fontWeight,color:getComputedStyle(el).color}))
   assert.equal(quantity.weight,'800');assert.equal(quantity.color,'rgb(0, 0, 0)')
   assert.equal(await page.locator('.wh-label-barcode').first().locator('rect').count(),68)
   const pdf=path.join(folder,`labels-${count}.pdf`)
   await page.pdf({path:pdf,preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false})
   const info=execFileSync('pdfinfo',[pdf],{encoding:'utf8'})
   assert.match(info,new RegExp(`Pages:\\s+${count}\\b`));assert.match(info,/Page size:\s+432 x 288 pts/)
   const text=execFileSync('pdftotext',[pdf,'-'],{encoding:'utf8'})
   assert.ok(text.includes('LPN-20261107-000001'));assert.ok(text.includes('325.3'));assert.ok(text.includes('impresión'));assert.ok(!text.includes('APPLICATION CHROME'))
   if(count===1)await page.locator('.wh-label').screenshot({path:path.join(folder,'label-print.png')})
   await page.unroute('http://wms-print.test/**')
  }
  console.log('PASS: actual preview JSX/print CSS in Chromium; one label = one 6x4 page, ten labels = ten pages, barcode present, bold black quantity, application chrome excluded. Physical printer remains unverified.')
 } finally{await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
