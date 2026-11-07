import { jsPDF } from 'jspdf'
import { documentDate, type OutsourcingDocument } from './outsourcing-document'

/** Genera el mismo PDF para previsualización, descarga y futuro adjunto de Microsoft Graph. */
export function renderOutsourcingAnnexPdf(d: OutsourcingDocument, logo?: string): jsPDF {
 const doc=new jsPDF({unit:'mm',format:'a4',compress:true})
 const left=16,width=178,bottom=278
 let y=0
 const header=()=>{
  doc.setFillColor(0,43,97);doc.rect(0,0,210,32,'F')
  if(logo){doc.setFillColor(255,255,255);doc.roundedRect(left,8,30,16,2,2,'F');doc.addImage(logo,'PNG',left+2,10,26,10.8)}

  doc.setTextColor(255,255,255);doc.setFont('helvetica','bold');doc.setFontSize(16);doc.text('Anexo técnico de tercerización',logo?52:left,15)
  doc.setFont('helvetica','normal');doc.setFontSize(9);doc.text('Transporte y Distribución | Requerimiento a Compras',logo?52:left,22)
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
 for(const pair of [['Solicitud de transporte',d.identity.request],['Orden de trabajo',d.identity.ot],['Cliente',d.identity.client],['Prioridad',d.priority],['Responsable',d.responsible],['Generado el',documentDate(d.issuedAt)]] as [string,string][])field(...pair)
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

export const annexFilename=(d:OutsourcingDocument)=>d.filename.replace(/\.pdf$/,'-ANEXO-TECNICO.pdf')
/** Resumen ejecutivo independiente: una página A4 horizontal. El anexo conserva TODO el detalle. */
export function renderOutsourcingPdf(d:OutsourcingDocument,logo?:string):jsPDF {
 const doc=new jsPDF({unit:'mm',format:'a4',orientation:'landscape',compress:true})
 const clean=(s:string)=>s.replace(/→/g,' > ').replace(/[–—]/g,'-').replace(/\u0000/g,'')
 const text=(s:string,x:number,y:number,size=9,bold=false)=>{doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(23,43,70);doc.text(clean(s),x,y)}
 const fit=(s:string,w:number,maxLines:number,size=9)=>{
  doc.setFont('helvetica','normal');doc.setFontSize(size)
  const lines=doc.splitTextToSize(clean(s),w) as string[]
  if(lines.length<=maxLines)return lines
  const out=lines.slice(0,maxLines);let last=out[maxLines-1]
  while(last&&doc.getTextWidth(last+'… [ver anexo]')>w)last=last.slice(0,-1)
  out[maxLines-1]=last+'… [ver anexo]';return out
 }
 const title=(s:string,x:number,y:number,w=133)=>{doc.setFillColor(235,242,251);doc.roundedRect(x,y-4,w,7,1,1,'F');text(s,x+2,y+1,10,true)}
 const fields=(rs:[string,string][],x:number,y:number,rowHeight:number,maxLines=1)=>rs.forEach(([k,v],i)=>{
  const top=y+i*rowHeight
  fit(k,32,2,8).forEach((line,n)=>text(line,x,top+n*3.3,8,true))
  fit(v,98,maxLines,9).forEach((line,n)=>text(line,x+35,top+n*3.5,9))
 })
 doc.setFillColor(0,43,97);doc.rect(0,0,297,25,'F')
 if(logo){doc.setFillColor(255,255,255);doc.roundedRect(12,4,30,16,2,2,'F');doc.addImage(logo,'PNG',14,6,26,10.8)}
 doc.setFont('helvetica','bold');doc.setFontSize(18);doc.setTextColor(255,255,255);doc.text('Solicitud de tercerización',logo?49:12,12)
 doc.setFont('helvetica','normal');doc.setFontSize(9);doc.text('Transporte y Distribución | Requerimiento para cotización',logo?49:12,19)
 text(`${d.number} · ${d.identity.request} · OT ${d.identity.ot} · R${d.revision}`,12,32,10,true)
 text(fit(`Prioridad: ${d.priority} | Estado: ${d.status}`,133,1,9)[0],153,32,9,true)
 text(fit(`Cliente: ${d.identity.client}`,133,1,9)[0],12,40,9)
 text(fit(`Responsable: ${d.responsible}`,133,1,9)[0],153,40,9)
 title('01. Servicio requerido',12,50)
 fields(d.executive.service,12,60,7.5,2)
 title('02. Características de carga',12,101)
 fields(d.executive.cargo,12,111,7.5,2)
 title('03. Recursos complementarios',153,50)
 const widths=[29,10,47,25,22],xs=[153,182,192,239,264]
 doc.setFillColor(245,248,252);doc.rect(153,57,133,7,'F')
 ;['Recurso','Cant.','Especificaciones','Lugar / uso','Horario'].forEach((v,i)=>text(v,xs[i]+1,61.5,8,true))
 if(!d.executive.resources.length)text('No se requieren recursos complementarios.',155,71,9)
 d.executive.resources.forEach((r,row)=>{
  r.forEach((v,col)=>fit(v,widths[col]-2,2,8).forEach((line,n)=>text(line,xs[col]+1,68+row*9+n*3.3,8)))
  doc.setDrawColor(222,230,241);doc.line(153,73+row*9,286,73+row*9)
 })
 if(d.executive.resources.some(r=>r[0]==='Grúa'))text('Capacidad nominal no valida maniobras; verificar condiciones en el anexo.',155,113,8)
 title('04. Condiciones operativas',153,120)
 fields(d.executive.operations,153,128,5.5,1)
 title('05. Condiciones para cotización',153,169)
 const quotation='Solicitar precio por servicio, recursos y operadores incluidos, duración, espera y horas adicionales, exclusiones y disponibilidad. Son requisitos para cotizar; no constituyen condiciones comerciales acordadas.'
 fit(quotation,129,5,9).forEach((line,i)=>text(line,155,179+i*3.8,9))
 title('06. Documentos adjuntos / referencia',12,169)
 const files=d.executive.attachments.length?d.executive.attachments.map((name,i)=>`${i+1}. ${name}`).join('; '):'Sin archivos de referencia vinculados.'
 fit(files,129,2,9).forEach((line,i)=>text(line,14,179+i*3.8,9))
 const pending=d.executive.pending.length?`Pendiente de guardar: ${d.executive.pending.join('; ')}`:'Referencias disponibles en el TMS; se consultan o descargan por separado.'
 fit(pending,129,1,8).forEach(line=>text(line,14,190,8))
 doc.setDrawColor(207,219,237);doc.line(12,196,285,196)
 text('Leer junto con el anexo técnico: contiene bultos, restricciones y requisitos completos. No autoriza contratación ni costos.',12,201,8)
 text('Página 1 de 1',267,206,8)
 doc.setProperties({title:`Solicitud de tercerización ${d.number}`,subject:`OT ${d.identity.ot} | Ejecutivo y anexo técnico`,creator:'JRM TMS',author:d.responsible})
 return doc
}
export type OutsourcingPdfBundle={executive:Blob;annex:Blob}
export async function createOutsourcingPdfBundle(d:OutsourcingDocument):Promise<OutsourcingPdfBundle> {
 const response=await fetch('/logo-jrm.png')
 if(!response.ok)throw new Error('No se pudo cargar el logo oficial para el PDF. Intente nuevamente.')
 const blob=await response.blob()
 const logo=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('No se pudo leer el logo.'));reader.readAsDataURL(blob)})
 return {executive:renderOutsourcingPdf(d,logo).output('blob'),annex:renderOutsourcingAnnexPdf(d,logo).output('blob')}
}
