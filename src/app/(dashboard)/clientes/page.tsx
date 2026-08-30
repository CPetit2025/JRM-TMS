"use client"
import { useState, useEffect, useRef } from 'react'
import { Plus, Building2, Search, Filter, Loader2, Edit2, CheckCircle2, XCircle, User, Phone, Mail, MapPin, Hash, Upload, Download } from 'lucide-react'
import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { ClientFormModal, ClientData } from '@/components/forms/ClientFormModal'

interface Client extends ClientData {}

export default function ClientesPage() {
  const supabase = createClient()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error
      setClients(data || [])
    } catch (error: any) {
      toast.error('Error al cargar clientes: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (client: Client) => {
    setEditingClient(client)
    setIsModalOpen(true)
  }

  const toggleStatus = async (client: Client) => {
    try {
      const { error } = await supabase
        .from('clients')
        .update({ is_active: !client.is_active })
        .eq('id', client.id)

      if (error) throw error
      toast.success(`Cliente ${!client.is_active ? 'activado' : 'desactivado'}`)
      fetchClients()
    } catch (error: any) {
      toast.error('Error al actualizar estado: ' + error.message)
    }
  }

  const closeModal = () => {
    setIsModalOpen(false)
    setEditingClient(null)
  }

  const downloadTemplate = async () => {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Clientes');

      // Título y diseño
      worksheet.mergeCells('C1:F3');
      const titleCell = worksheet.getCell('C1');
      titleCell.value = 'PLANTILLA DE CARGA MASIVA - CLIENTES';
      titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF002855' } };
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

      // Insertar Logo Real
      try {
        const response = await fetch('/logo-jrm.png')
        if (response.ok) {
          const imageBuffer = await response.arrayBuffer()
          const imageId = workbook.addImage({
            buffer: imageBuffer,
            extension: 'png',
          });
          // Logo en A1:B3
          worksheet.addImage(imageId, {
            tl: { col: 0, row: 0 } as any,
            br: { col: 2, row: 3 } as any
          });
        }
      } catch (e) {
        console.warn('No se pudo cargar el logo para la plantilla', e)
      }

      worksheet.mergeCells('A4:F4');
      const instructions = worksheet.getCell('A4');
      instructions.value = 'Instrucciones: Llenar a partir de la fila 7. Los campos con (*) son obligatorios.';
      instructions.font = { italic: true, color: { argb: 'FF555555' } };
      
      // Filas vacías para espaciado
      worksheet.getRow(5).height = 10;

      // Headers (Fila 6)
      const headers = [
        'Razón Social (*)',
        'RUC (Tax ID) (*)',
        'Contacto Principal',
        'Teléfono',
        'Email',
        'Dirección Fiscal'
      ];
      const headerRow = worksheet.getRow(6);
      headerRow.values = headers;
      
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } }; 
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'}
        };
      });

      // Anchos de columna
      worksheet.getColumn(1).width = 40; // Razon Social
      worksheet.getColumn(2).width = 20; // RUC
      worksheet.getColumn(3).width = 30; // Contacto
      worksheet.getColumn(4).width = 20; // Telefono
      worksheet.getColumn(5).width = 30; // Email
      worksheet.getColumn(6).width = 50; // Direccion

      // Data de ejemplo (Fila 7)
      const exampleRow = worksheet.getRow(7);
      exampleRow.values = ['Empresa de Ejemplo S.A.C.', '20123456789', 'Juan Pérez', '999888777', 'juan@ejemplo.com', 'Av. Industrial 123, Lima'];
      exampleRow.font = { italic: true, color: { argb: 'FF888888' } };

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Plantilla_Clientes_${new Date().getTime()}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      toast.error('Error al generar la plantilla');
    }
  }

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      
      const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false });
      
      const clientsToInsert = [];
      let skippedCount = 0;

      for (let i = 6; i < rawData.length; i++) {
        const row = rawData[i] as any[];
        // Verificamos campos obligatorios (Razón Social y RUC)
        if (!row || row.length < 2 || !row[0] || !row[1]) {
          skippedCount++;
          continue;
        }

        clientsToInsert.push({
          business_name: String(row[0]).trim(),
          tax_id: String(row[1]).trim(),
          contact_name: row[2] ? String(row[2]).trim() : null,
          phone: row[3] ? String(row[3]).trim() : null,
          email: row[4] ? String(row[4]).trim() : null,
          address: row[5] ? String(row[5]).trim() : null,
          is_active: true
        });
      }

      if (clientsToInsert.length === 0) {
        toast.error('No se encontraron registros válidos para importar');
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      // As tax_id is unique, we upsert based on it
      const { error } = await supabase
        .from('clients')
        .upsert(clientsToInsert, { onConflict: 'tax_id' });

      if (error) throw error;

      toast.success(`Carga exitosa: ${clientsToInsert.length} clientes procesados (Omitidos: ${skippedCount})`);
      fetchClients();
    } catch (error: any) {
      toast.error('Error procesando el archivo: ' + error.message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Clientes</h1>
          <p className="text-sm text-slate-500">Directorio de empresas y solicitantes de servicio</p>
        </div>
        <div className="flex items-center gap-3">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleBulkUpload} 
            accept=".xlsx, .xls"
            className="hidden" 
          />
          <button 
            type="button" 
            onClick={downloadTemplate}
            className="flex items-center gap-2 bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm"
          >
            <Download className="w-4 h-4" />
            Plantilla
          </button>
          
          <button 
            type="button" 
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-50"
          >
            {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Carga Masiva
          </button>

          <button 
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nuevo Cliente
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input 
              type="text" 
              placeholder="Buscar por Razón Social o RUC..." 
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
            />
          </div>
          <button className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">
            <Filter className="w-4 h-4" />
            Filtrar
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider border-b">
                <th className="p-4 font-semibold">Razón Social</th>
                <th className="p-4 font-semibold">RUC (Tax ID)</th>
                <th className="p-4 font-semibold">Contacto</th>
                <th className="p-4 font-semibold">Teléfono / Email</th>
                <th className="p-4 font-semibold">Estado</th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando clientes...
                  </td>
                </tr>
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    No hay clientes registrados en el sistema.
                  </td>
                </tr>
              ) : (
                clients.map(client => (
                  <tr key={client.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-blue-50 text-[#002855] flex items-center justify-center border border-blue-100">
                          <Building2 className="w-4 h-4" />
                        </div>
                        <span className="font-semibold text-slate-800">{client.business_name}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 font-medium">{client.tax_id}</td>
                    <td className="p-4 text-sm text-slate-600">{client.contact_name || '-'}</td>
                    <td className="p-4 text-sm text-slate-600">
                      <div className="flex flex-col">
                        <span>{client.phone || '-'}</span>
                        <span className="text-xs text-slate-400">{client.email || '-'}</span>
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-md ${
                        client.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {client.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={() => handleEdit(client)}
                          title="Editar"
                          className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => toggleStatus(client)}
                          title={client.is_active ? 'Desactivar' : 'Activar'}
                          className={`p-2 transition-colors rounded ${client.is_active ? 'text-slate-400 hover:text-red-600 hover:bg-red-50' : 'text-slate-400 hover:text-green-600 hover:bg-green-50'}`}
                        >
                          {client.is_active ? <XCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ClientFormModal 
        isOpen={isModalOpen}
        onClose={closeModal}
        onSuccess={() => fetchClients()}
        editingClient={editingClient}
      />
    </div>
  )
}
