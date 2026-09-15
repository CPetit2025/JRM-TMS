import { NextResponse } from 'next/server'
import * as ExcelJS from 'exceljs'

export async function GET() {
  try {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Servicios')

    // Define columns
    worksheet.columns = [
      { header: 'Codigo_Contrato', key: 'codigo_contrato', width: 20 },
      { header: 'Categoria', key: 'categoria', width: 20 },
      { header: 'Tipo_Servicio', key: 'tipo_servicio', width: 20 },
      { header: 'Fecha_Servicio', key: 'fecha_servicio', width: 15 },
      { header: 'Monto', key: 'monto', width: 15 },
      { header: 'Descripcion', key: 'descripcion', width: 30 },
      { header: 'Horas', key: 'horas', width: 10 },
      { header: 'Placa', key: 'placa', width: 15 },
      { header: 'Conductor', key: 'conductor', width: 25 },
      { header: 'Proveedor_RUC', key: 'proveedor_ruc', width: 15 },
      { header: 'Proveedor_Nombre', key: 'proveedor_nombre', width: 30 }
    ]

    // Style headers
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF002855' } // Corporate Blue
    }
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }

    // Add some sample data rows
    worksheet.addRow({
      codigo_contrato: 'CON-001',
      categoria: 'Contrato',
      tipo_servicio: 'FLETE',
      fecha_servicio: '2026-10-01',
      monto: 1500.50,
      descripcion: 'Viaje a Piura',
      placa: 'ABC-123',
      conductor: 'Juan Perez',
      proveedor_ruc: '20987654321',
      proveedor_nombre: 'Transportes XYZ'
    })

    worksheet.addRow({
      codigo_contrato: 'CON-001',
      categoria: 'Subcontrato',
      tipo_servicio: 'MONTACARGA',
      fecha_servicio: '2026-10-02',
      monto: 500,
      descripcion: 'Descarga en almacén',
      horas: 4
    })

    // Add Data Validations for Categoria (Column B)
    for (let i = 2; i <= 1000; i++) {
      worksheet.getCell(`B${i}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"Contrato,Subcontrato,Error"']
      }
    }

    // Add Data Validations for Tipo_Servicio (Column C)
    for (let i = 2; i <= 1000; i++) {
      worksheet.getCell(`C${i}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"FLETE,MONTACARGA,ESTIBA,MANIOBRA,PEAJE,PENALIDAD,ERROR,OTROS"']
      }
    }

    // Add Data Validations for Fecha (Column D) - Optional, just a note or formatting
    worksheet.getColumn('D').numFmt = 'yyyy-mm-dd'

    // Add Data Validations for Monto (Column E)
    worksheet.getColumn('E').numFmt = '"S/"#,##0.00'

    const buffer = await workbook.xlsx.writeBuffer()

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename=Plantilla_Carga_Servicios.xlsx'
      }
    })
  } catch (error) {
    console.error('Error generating excel:', error)
    return NextResponse.json({ error: 'Error generating excel' }, { status: 500 })
  }
}
