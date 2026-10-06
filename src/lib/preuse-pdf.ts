import type { jsPDF } from 'jspdf'
import { PREUSE_FORMAT, validatePreuseAnswers, type PreuseInspection } from './preuse'

function textBox(doc: jsPDF, text: string, x: number, y: number, width: number, height: number, font = 8, align: 'left' | 'center' = 'left') {
  let size = font, lines: string[] = []
  do { doc.setFontSize(size); lines = doc.splitTextToSize(text || '', width - 2); if (lines.length * size * 0.3528 * 1.12 <= height - 1) break; size -= 0.25 } while (size > 2)
  doc.text(lines, align === 'center' ? x + width / 2 : x + 1, y + size * 0.3528 + 0.5, { align, lineHeightFactor: 1.12 })
}
export function drawPreusePage(doc: jsPDF, row: PreuseInspection, logo?: string) {
  if (!validatePreuseAnswers(row.answers)) throw new Error('El registro no contiene los 34 ítems completos del FR-DT 007')
  doc.setDrawColor(45,64,88); doc.setLineWidth(0.25); doc.setTextColor(25,45,70); doc.setFont('helvetica','normal')
  doc.rect(10,10,190,22); doc.line(50,10,50,32); doc.line(155,10,155,32); doc.line(50,16,155,16)
  if (logo) { const image = doc.getImageProperties(logo); const h = Math.min(18,36 * image.height / image.width); doc.addImage(logo,'PNG',12,21 - h / 2,36,h) }
  else { doc.setFont('helvetica','bold'); textBox(doc,'JRM',10,14,40,14,18,'center') }
  doc.setFont('helvetica','bold'); textBox(doc,'SISTEMA INTEGRADO DE GESTIÓN',50,10,105,6,8.5,'center')
  textBox(doc,'FORMATO:\n'+PREUSE_FORMAT.title,50,17,105,14,8.5,'center')
  doc.setFont('helvetica','normal'); textBox(doc,`CÓDIGO: ${PREUSE_FORMAT.code}\nVERSIÓN N°: ${PREUSE_FORMAT.version}\nFECHA: ${PREUSE_FORMAT.formatDate}\nPágina 1 de 1`,155,11,45,20,8)
  const date = row.operation_date.split('-').reverse().join('/')
  textBox(doc,`Nombres y Apellidos del Conductor: ${row.driver_name}`,10,36,126,7,8)
  textBox(doc,`Placa: ${row.vehicle_plate}`,136,36,30,7,8); textBox(doc,`Fecha: ${date}`,166,36,34,7,8)
  textBox(doc,`Brevete (Clase/catg): ${row.license}`,10,43,58,7,8)
  textBox(doc,`Fecha de vencimiento SOAT: ${row.soat_expiration.split('-').reverse().join('/')}`,68,43,68,7,8)
  textBox(doc,`Fecha de vencimiento Rev. Tec.: ${row.technical_review_expiration.split('-').reverse().join('/')}`,136,43,64,7,8)
  const xs = [10,102,113,124,135,146,200], top = 51, header = 7, h = 5
  doc.setFillColor(227,234,242); doc.rect(10,top,190,header,'F'); doc.rect(10,top,190,header + 34 * h)
  for (const x of xs.slice(1,-1)) doc.line(x,top,x,top + header + 34 * h)
  doc.setFont('helvetica','bold'); ['ÍTEMS A VERIFICAR','B','M','R','N/A','COMENTARIOS'].forEach((label,i) => textBox(doc,label,xs[i],top,xs[i+1] - xs[i],header,7,'center'))
  doc.setFont('helvetica','normal')
  PREUSE_FORMAT.items.forEach((item,index) => {
    const y = top + header + index * h; doc.line(10,y,200,y)
    const answer = row.answers.find(a => a.code === item.code)!
    textBox(doc,item.text,10,y,92,h,7.4)
    const response = ['B','M','R','N/A'].indexOf(answer.response)
    textBox(doc,'X',xs[response+1],y,11,h,8,'center'); textBox(doc,answer.comment,146,y,54,h,7.2)
  })
  textBox(doc,'Nota: Todos los defectos deben ser corregidos antes de poner el vehículo en servicio.',12,231,188,5,8)
  textBox(doc,'Leyenda: "B" (bueno), "R" (regular), "M" (malo), "N/A" (no aplica)',12,236,188,5,8)
  doc.setFont('helvetica','bold'); textBox(doc,'Vehículo Operativo:',16,241,60,7,9)
  doc.setFont('helvetica','normal'); textBox(doc,'SÍ',77,242,8,6,8); doc.rect(86,243,4,4)
  textBox(doc,'NO',110,242,10,6,8); doc.rect(121,243,4,4); textBox(doc,'X',row.vehicle_operational ? 86 : 121,242,4,5,8,'center')
  doc.rect(10,250,190,16); textBox(doc,'Observación: '+row.observation,11,250,188,16,8)
  doc.setDrawColor(25,45,70); doc.setLineWidth(0.35)
  for (const stroke of row.signature) for (let i=1;i<stroke.length;i++) doc.line(26+stroke[i-1].x*48,267+stroke[i-1].y*10,26+stroke[i].x*48,267+stroke[i].y*10)
  doc.line(20,278,90,278); doc.setFont('helvetica','bold'); textBox(doc,'Inspeccionado por',20,279,70,5,8,'center')
  doc.setFont('helvetica','normal'); textBox(doc,'Nombre: '+row.inspector_name,16,284,174,6,8)
  doc.line(10,291,200,291); textBox(doc,'OHSAS 18001',165,292,35,4,7,'center')
}
export async function exportPreusePdf(rows: PreuseInspection[], from: string, to: string) {
  if (!rows.length) throw new Error('No hay inspecciones en el rango seleccionado')
  const { jsPDF } = await import('jspdf')
  const response = await fetch('/logo-jrm.png'); if (!response.ok) throw new Error('No se pudo cargar el logo del formato')
  const logo = await new Promise<string>((resolve,reject) => { response.blob().then(blob => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob) }).catch(reject) })
  const doc = new jsPDF({ orientation:'portrait',unit:'mm',format:'a4',compress:true })
  doc.setProperties({ title: `${PREUSE_FORMAT.code} · ${from} a ${to}`, subject:'Inspección de pre uso de vehículos livianos y pesados', creator:'JRM TMS' })
  rows.forEach((row,i) => { if (i) doc.addPage(); drawPreusePage(doc,row,logo) })
  doc.save(`FR-DT007_${from}_${to}.pdf`)
}
