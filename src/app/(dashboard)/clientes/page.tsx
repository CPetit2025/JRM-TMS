"use client"
import { useState, useEffect, useRef, useMemo } from 'react'
import { Plus, Building2, Search, Loader2, Edit2, CheckCircle2, XCircle, Upload, Download, ChevronUp, ChevronDown, ChevronsUpDown, Trash2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { ClientFormModal, ClientData } from '@/components/forms/ClientFormModal'

interface Client extends ClientData {}

type SortField = 'business_name' | 'tax_id' | 'contact_name' | 'is_active'
type SortDir = 'asc' | 'desc'

export default function ClientesPage() {
  const supabase = createClient()
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingClient, setEditingClient] = useState<Client | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [sortField, setSortField] = useState<SortField>('business_name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  useEffect(() => { fetchClients() }, [])

  const fetchClients = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.from('clients').select('*').order('created_at', { ascending: false })
      if (error) throw error
      setClients(data || [])
    } catch (error: any) {
      toast.error('Error al cargar clientes: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    let list = [...clients]
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(c =>
        c.business_name?.toLowerCase().includes(q) ||
        c.tax_id?.toLowerCase().includes(q) ||
        c.contact_name?.toLowerCase().includes(q)
      )
    }
    if (filterStatus === 'active')   list = list.filter(c => c.is_active)
    if (filterStatus === 'inactive') list = list.filter(c => !c.is_active)
    list.sort((a: any, b: any) => {
      const va = (a[sortField] ?? '').toString().toLowerCase()
      const vb = (b[sortField] ?? '').toString().toLowerCase()
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
    })
    return list
  }, [clients, search, filterStatus, sortField, sortDir])

  const handleSort = (field: SortField) => {
    if (sortField === field) { setSortDir(d => d === 'asc' ? 'desc' : 'asc') }
    else { setSortField(field); setSortDir('asc') }
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronsUpDown className="w-3 h-3 ml-1 text-slate-400 inline" />
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3 ml-1 text-[#002855] inline" /> : <ChevronDown className="w-3 h-3 ml-1 text-[#002855] inline" />
  }

  const handleEdit = (client: Client) => { setEditingClient(client); setIsModalOpen(true) }

  const toggleStatus = async (client: Client) => {
    try {
      const { error } = await supabase.from('clients').update({ is_active: !client.is_active }).eq('id', client.id)
      if (error) throw error
      toast.success(`Cliente ${!client.is_active ? 'activado' : 'desactivado'}`)
      fetchClients()
    } catch (error: any) { toast.error('Error al actualizar estado: ' + error.message) }
  }

  const handleDelete = async (client: Client) => {
    if (!window.confirm(`¿Estás seguro de que deseas eliminar permanentemente a "${client.business_name}"? Esta acción no se puede deshacer.`)) return;
    
    try {
      const { error } = await supabase.from('clients').delete().eq('id', client.id);
      if (error) {
        if (error.code === '23503') {
          throw new Error('No se puede eliminar este cliente porque tiene contratos o información asociada.');
        }
        throw error;
      }
      toast.success('Cliente eliminado correctamente');
      fetchClients();
    } catch (error: any) {
      toast.error('Error al eliminar: ' + error.message);
    }
  }

  const closeModal = () => { setIsModalOpen(false); setEditingClient(null) }

  const downloadTemplate = async () => {
    try {
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Clientes')
      worksheet.mergeCells('C1:F3')
      const titleCell = worksheet.getCell('C1')
      titleCell.value = 'PLANTILLA DE CARGA MASIVA - CLIENTES'
      titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FF002855' } }
      titleCell.alignment = { vertical: 'middle', horizontal: 'center' }
      try {
        const response = await fetch('/logo-jrm.png')
        if (response.ok) {
          const imageBuffer = await response.arrayBuffer()
          const imageId = workbook.addImage({ buffer: imageBuffer, extension: 'png' })
          worksheet.addImage(imageId, { tl: { col: 0, row: 0 } as any, br: { col: 2, row: 3 } as any })
        }
      } catch (e) { console.warn('No se pudo cargar el logo', e) }
      worksheet.mergeCells('A4:F4')
      const instructions = worksheet.getCell('A4')
      instructions.value = 'Instrucciones: Llenar a partir de la fila 7. Los campos con (*) son obligatorios.'
      instructions.font = { italic: true, color: { argb: 'FF555555' } }
      worksheet.getRow(5).height = 10
      const headerRow = worksheet.getRow(6)
      headerRow.values = ['Razon Social (*)', 'RUC (Tax ID) (*)', 'Contacto Principal', 'Telefono', 'Email', 'Direccion Fiscal']
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} }
      })
      worksheet.getColumn(1).width = 40; worksheet.getColumn(2).width = 20; worksheet.getColumn(3).width = 30
      worksheet.getColumn(4).width = 20; worksheet.getColumn(5).width = 30; worksheet.getColumn(6).width = 50
      const exampleRow = worksheet.getRow(7)
      exampleRow.values = ['Empresa de Ejemplo S.A.C.', '20123456789', 'Juan Perez', '999888777', 'juan@ejemplo.com', 'Av. Industrial 123, Lima']
      exampleRow.font = { italic: true, color: { argb: 'FF888888' } }
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `Plantilla_Clientes_${new Date().getTime()}.xlsx`; a.click()
      window.URL.revokeObjectURL(url)
    } catch (error) { toast.error('Error al generar la plantilla') }
  }

  const handleBulkUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    setIsUploading(true)
    try {
      const data = await file.arrayBuffer()
      const workbook = XLSX.read(data, { type: 'array' })
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false })
      const clientsToInsert: any[] = []; let skippedCount = 0
      for (let i = 6; i < rawData.length; i++) {
        const row = rawData[i] as any[]
        if (!row || row.length < 2 || !row[0] || !row[1]) { skippedCount++; continue }
        clientsToInsert.push({ business_name: String(row[0]).trim(), tax_id: String(row[1]).trim(), contact_name: row[2] ? String(row[2]).trim() : null, phone: row[3] ? String(row[3]).trim() : null, email: row[4] ? String(row[4]).trim() : null, address: row[5] ? String(row[5]).trim() : null, is_active: true })
      }
      if (clientsToInsert.length === 0) { toast.error('No se encontraron registros validos'); return }
      const { error } = await supabase.from('clients').upsert(clientsToInsert, { onConflict: 'tax_id' })
      if (error) throw error
      toast.success(`Carga exitosa: ${clientsToInsert.length} clientes procesados (Omitidos: ${skippedCount})`)
      fetchClients()
    } catch (error: any) { toast.error('Error procesando el archivo: ' + error.message)
    } finally { setIsUploading(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Clientes</h1>
          <p className="text-sm text-slate-500">Directorio de empresas y solicitantes de servicio</p>
        </div>
        <div className="flex items-center gap-3">
          <input type="file" ref={fileInputRef} onChange={handleBulkUpload} accept=".xlsx, .xls" className="hidden" />
          <button type="button" onClick={downloadTemplate} className="flex items-center gap-2 bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition-colors shadow-sm">
            <Download className="w-4 h-4" /> Plantilla
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-50">
            {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Carga Masiva
          </button>
          <button onClick={() => setIsModalOpen(true)} className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg font-medium hover:bg-[#001d3d] transition-colors shadow-sm">
            <Plus className="w-4 h-4" /> Nuevo Cliente
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-wrap gap-3 items-center bg-slate-50">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por Razon Social, RUC o Contacto..."
              className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]" />
          </div>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm font-medium text-slate-600 bg-white focus:outline-none focus:ring-2 focus:ring-[#002855]">
            <option value="all">Todos los estados</option>
            <option value="active">Solo Activos</option>
            <option value="inactive">Solo Inactivos</option>
          </select>
          <span className="text-xs text-slate-400 ml-auto">{filtered.length} de {clients.length} clientes</span>
        </div>

        <div className="overflow-auto max-h-[calc(100vh-220px)]">
          <table className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10 shadow-[0_1px_0_0_#e2e8f0]">
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider ">
                <th className="p-4 font-semibold cursor-pointer" onClick={() => handleSort('business_name')}>
                  <span className="flex items-center">Razon Social <SortIcon field="business_name" /></span>
                </th>
                <th className="p-4 font-semibold cursor-pointer" onClick={() => handleSort('tax_id')}>
                  <span className="flex items-center">RUC (Tax ID) <SortIcon field="tax_id" /></span>
                </th>
                <th className="p-4 font-semibold cursor-pointer" onClick={() => handleSort('contact_name')}>
                  <span className="flex items-center">Contacto <SortIcon field="contact_name" /></span>
                </th>
                <th className="p-4 font-semibold">Telefono / Email</th>
                <th className="p-4 font-semibold cursor-pointer" onClick={() => handleSort('is_active')}>
                  <span className="flex items-center">Estado <SortIcon field="is_active" /></span>
                </th>
                <th className="p-4 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="p-8 text-center text-slate-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Cargando clientes...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-slate-500">
                  {search || filterStatus !== 'all' ? 'No se encontraron clientes con ese criterio.' : 'No hay clientes registrados en el sistema.'}
                </td></tr>
              ) : (
                filtered.map(client => (
                  <tr key={client.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded bg-blue-50 text-[#002855] flex items-center justify-center border border-blue-100"><Building2 className="w-4 h-4" /></div>
                        <span className="font-semibold text-slate-800">{client.business_name}</span>
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-600 font-medium">{client.tax_id}</td>
                    <td className="p-4 text-sm text-slate-600">{client.contact_name || '-'}</td>
                    <td className="p-4 text-sm text-slate-600">
                      <div className="flex flex-col"><span>{client.phone || '-'}</span><span className="text-xs text-slate-400">{client.email || '-'}</span></div>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-md ${client.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {client.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => handleEdit(client)} title="Editar" className="p-2 text-slate-400 hover:text-[#002855] transition-colors rounded hover:bg-blue-50"><Edit2 className="w-4 h-4" /></button>
                        <button onClick={() => toggleStatus(client)} title={client.is_active ? 'Desactivar' : 'Activar'}
                          className={`p-2 transition-colors rounded ${client.is_active ? 'text-slate-400 hover:text-red-600 hover:bg-red-50' : 'text-slate-400 hover:text-green-600 hover:bg-green-50'}`}>
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

      <ClientFormModal isOpen={isModalOpen} onClose={closeModal} onSuccess={() => fetchClients()} editingClient={editingClient} />
    </div>
  )
}


