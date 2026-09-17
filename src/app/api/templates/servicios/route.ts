import { NextResponse } from 'next/server'
import * as ExcelJS from 'exceljs'

export async function GET() {
  try {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Servicios')

    // Define columns
    worksheet.columns = [
      { header: 'Fecha', key: 'fecha', width: 15 },
      { header: 'Contrato', key: 'contrato', width: 20 },
      { header: 'Cliente', key: 'cliente', width: 30 },
      { header: 'Servicio', key: 'servicio', width: 20 },
      { header: 'Placa', key: 'placa', width: 15 },
      { header: 'KG', key: 'kg', width: 15 },
      { header: 'Monto (PEN)', key: 'monto_pen', width: 15 },
      { header: 'Saldo (PEN)', key: 'saldo_pen', width: 15 },
      { header: 'Estado', key: 'estado', width: 15 }
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
      fecha: '2026-10-01',
      contrato: 'CON-001',
      cliente: 'Empresa Ejemplo S.A.C.',
      servicio: 'FLETE',
      kg: '15000',
      monto_pen: 1500.50,
      saldo_pen: '', // Automático del sistema
      estado: '' // Automático del sistema
    })

    // Add Data Validations for Servicio (Column D)
    for (let i = 2; i <= 1000; i++) {
      worksheet.getCell(`D${i}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"FLETE,MONTACARGA,ESTIBA,MANIOBRA,PEAJE,PENALIDAD,ERROR,OTROS"']
      }
    }

    // Add Data Validations for Fecha (Column A)
    worksheet.getColumn('A').numFmt = 'yyyy-mm-dd'

    // Add Data Validations for Monto (Column F)
    worksheet.getColumn('F').numFmt = '"S/"#,##0.00'

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
