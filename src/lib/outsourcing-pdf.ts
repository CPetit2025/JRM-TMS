import { jsPDF } from 'jspdf'
import { documentDate, type OutsourcingDocument } from './outsourcing-document'

/** Genera el mismo PDF para previsualización, descarga y futuro adjunto de Microsoft Graph. */
export function renderOutsourcingPdf(d: OutsourcingDocument, logo?: string): jsPDF {
 const doc=new jsPDF({unit:'mm',format:'a4',compress:true})
 const left=16,width=178,bottom=278
 let y=0
 const header=()=>{
  doc.setFillColor(0,43,97);doc.rect(0,0,210,32,'F')
  if(logo){doc.setFillColor(255,255,255);doc.roundedRect(left,8,30,16,2,2,'F');doc.addImage(logo,'PNG',left+2,10,26,10.8)}
  else {doc.setFont('helvetica','bold');doc.setFontSize(23);doc.setTextColor(255,255,255);doc.text('JRM',left,21)}
  doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(16);doc.text('Solicitud de tercerización',52,15)
  doc.setFont('helvetica','normal');doc.setFontSize(9);doc.text('Transporte y Distribución | Requerimiento a Compras',52,22)
  doc.setFillColor(229,29,53);doc.rect(0,32,210,1.2,'F');y=40
 }
 const need=(height:number)=>{if(y+height>bottom){doc.addPage();header()}}
 // jsPDF's standard font supports Spanish; normalize unsupported typographic symbols.
 const printable=(s:string)=>s.replace(/→/g,' > ').replace(/[–—]/g,'-').replace(/\u0000/g,'')
 const lines=(s:string,w=width)=>doc.splitTextToSize(printable(s),w) as string[]
 const paragraph=(s:string,size=9,bold=false)=>{
  doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size)
  const content=lines(s)
  for(const line of content){need(4.7);doc.setTextColor(23,43,70);doc.text(line,left,y);y+=4.7}
 }
 const section=(title:string)=>{
  need(20);doc.setFillColor(235,242,251);doc.rect(left,y-3,width,8,'F');doc.setFont('helvetica','bold');doc.setFontSize(10);doc.setTextColor(0,43,97);doc.text(printable(title),left+3,y+2);y+=12
 }
 const field=(label:string,v:string)=>{
  doc.setFont('helvetica','bold');doc.setFontSize(8);const ls=lines(label,55)
  doc.setFont('helvetica','normal');doc.setFontSize(9);const vs=lines(v,116)
  const count=Math.max(ls.length,vs.length)
  for(let i=0;i<count;i++){
   need(4.6)
   doc.setTextColor(83,103,130);doc.setFont('helvetica','bold');doc.setFontSize(8);if(ls[i])doc.text(ls[i],left,y)
   doc.setTextColor(23,43,70);doc.setFont('helvetica','normal');doc.setFontSize(9);if(vs[i])doc.text(vs[i],left+62,y)
   y+=4.6
  }
  y+=2
 }
 header()
 paragraph(`${d.number} | Revisión ${d.revision} | ${d.status}`,12,true);y+=2
 if(d.draft){paragraph('BORRADOR - Vista previa sin envío. Datos sujetos a validación.',9,true);y+=2}
 section('Identificación y trazabilidad')
 for(const pair of [['Solicitud de transporte',d.identity.request],['Orden de trabajo',d.identity.ot],['Cliente',d.identity.client],['Prioridad',d.priority],['Responsable',d.responsible],['Despacho vinculado (ID)',d.dispatch],['Solicitud de tercerización (ID)',d.id || 'Pendiente de guardar'],['Generado el',documentDate(d.issuedAt)]] as [string,string][])field(...pair)
 d.sections.forEach(s=>{section(s.title);s.rows.forEach(([k,v])=>field(k,v));y+=3})
 section('Alcance y control')
 paragraph('Este requerimiento no constituye una orden de compra ni autoriza costos o contratación. La evaluación, adjudicación y aprobación se registran en el TMS. Los costos contratados se controlan en el presupuesto de la OT vinculada.')
 y+=3;paragraph('Los archivos de referencia se enumeran en esta ficha; sus contenidos se consultan por separado en el TMS con una cuenta autorizada.')
 const pages=doc.getNumberOfPages()
 for(let i=1;i<=pages;i++){
  doc.setPage(i);doc.setDrawColor(213,223,237);doc.line(left,284,194,284);doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(83,103,130)
  doc.text(`${d.identity.request} | OT ${d.identity.ot} | R${d.revision}`,left,290)
  doc.text(`Página ${i} de ${pages}`,194,290,{align:'right'})
 }
 doc.setProperties({title:`Solicitud de tercerización ${d.number}`,subject:`OT ${d.identity.ot} - Revisión ${d.revision}`,creator:'JRM TMS',author:d.responsible})
 return doc
}
export async function createOutsourcingPdf(d: OutsourcingDocument): Promise<Blob> {
 const response=await fetch('/logo-jrm.png')
 if(!response.ok)throw new Error('No se pudo cargar el logo para el PDF. Intente nuevamente.')
 const blob=await response.blob()
 const logo=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('No se pudo leer el logo.'));reader.readAsDataURL(blob)})
 return renderOutsourcingPdf(d,logo).output('blob')
}
