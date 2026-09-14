import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';

export async function GET() {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Plantilla_Contratos');

    // Define columns
    worksheet.columns = [
      { header: 'Tipo', key: 'tipo', width: 20 },
      { header: 'Codigo', key: 'codigo', width: 25 },
      { header: 'CodigoMadre', key: 'codigoMadre', width: 25 },
      { header: 'Presupuesto_Soles', key: 'presupuesto', width: 20 },
      { header: 'Peso_Total_KG', key: 'peso', width: 18 },
      { header: 'Volumen_Total_M3', key: 'volumen', width: 18 },
      { header: 'Destino_Departamento', key: 'dep', width: 22 },
      { header: 'Destino_Provincia', key: 'prov', width: 22 },
      { header: 'Destino_Distrito', key: 'dist', width: 22 },
      { header: 'Destino_Direccion', key: 'dir', width: 35 },
    ];

    // Style the header row
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF002855' } // Navy blue
    };
    worksheet.getRow(1).alignment = { horizontal: 'center' };

    // Add instructions row
    const instructions = [
      'Valores: CONTRATO, SUBCONTRATO, ERROR',
      'Código único del contrato/sub',
      'Dejar vacío para CONTRATO',
      'Saldo inicial de partida',
      'Peso en KG (Opcional)',
      'Volumen en M3 (Opcional)',
      'Ej. LIMA (Obligatorio)',
      'Ej. LIMA (Obligatorio)',
      'Ej. ATE (Obligatorio)',
      'Dirección exacta (Obligatorio)'
    ];
    worksheet.addRow(instructions);
    
    // Style instructions
    worksheet.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
    worksheet.getRow(2).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF5F5F5' }
    };

    // Add example rows
    worksheet.addRow({
      tipo: 'CONTRATO',
      codigo: '16584',
      codigoMadre: '',
      presupuesto: 5000,
      peso: 10000,
      volumen: 25,
      dep: 'LIMA',
      prov: 'LIMA',
      dist: 'LURIN',
      dir: 'Av. Industrial 123'
    });
    worksheet.addRow({
      tipo: 'SUBCONTRATO',
      codigo: 'S001',
      codigoMadre: '16584',
      presupuesto: 1000,
      peso: 500,
      volumen: 2.5,
      dep: 'CUSCO',
      prov: 'CUSCO',
      dist: 'WANCHAQ',
      dir: 'Calle Principal 456'
    });

    // Add Data Validation for "Tipo" column
    for (let i = 3; i <= 100; i++) {
      worksheet.getCell(`A${i}`).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: ['"CONTRATO,SUBCONTRATO,ERROR"'],
        showErrorMessage: true,
        errorTitle: 'Tipo Inválido',
        error: 'El tipo debe ser CONTRATO, SUBCONTRATO o ERROR'
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Disposition': 'attachment; filename="plantilla_contratos_homologada.xlsx"',
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }
    });

  } catch (error) {
    console.error('Error generating template:', error);
    return new NextResponse('Error generating template', { status: 500 });
  }
}
