"use client"
import { useState, useEffect, useRef } from 'react'
import { Plus, Search, Loader2, Edit2, Trash2, FileSpreadsheet, Upload, Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import * as XLSX from 'xlsx'
import ExcelJS from 'exceljs'

interface Product {
  id: string
  sku: string
  description: string
  category: string
  color: string
  length_m: number
  width_m: number
  thickness_m: number
  weight: number
  volume_m3: number
  is_active: boolean
}

export default function MaestroProductosPage() {
  const supabase = createClient()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  
  const [newProduct, setNewProduct] = useState({
    sku: '',
    description: '',
    category: '',
    color: '',
    length_m: '',
    width_m: '',
    thickness_m: '',
    weight: '',
    volume_m3: ''
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)

  useEffect(() => {
    fetchProducts()
  }, [])

  const fetchProducts = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('description', { ascending: true })

      if (error) throw error
      setProducts(data || [])
    } catch (error: any) {
      toast.error('Error al cargar productos: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      const productData = {
        sku: newProduct.sku,
        description: newProduct.description,
        category: newProduct.category || null,
        color: newProduct.color || null,
        length_m: parseFloat(newProduct.length_m) || 0,
        width_m: parseFloat(newProduct.width_m) || 0,
        thickness_m: parseFloat(newProduct.thickness_m) || 0,
        weight: parseFloat(newProduct.weight) || 0,
        volume_m3: parseFloat(newProduct.volume_m3) || 0,
        is_active: true
      }

      if (editingId) {
        const { error } = await supabase
          .from('products')
          .update(productData)
          .eq('id', editingId)
        
        if (error) throw error
        toast.success('Producto actualizado correctamente')
      } else {
        const { error } = await supabase
          .from('products')
          .insert([productData])
        
        if (error) throw error
        toast.success('Producto creado correctamente')
      }

      setIsModalOpen(false)
      resetForm()
      fetchProducts()
    } catch (error: any) {
      toast.error('Error al guardar el producto: ' + (error.message || 'El SKU podría estar duplicado'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleEdit = (product: Product) => {
    setEditingId(product.id)
    setNewProduct({
      sku: product.sku,
      description: product.description,
      category: product.category || '',
      color: product.color || '',
      length_m: product.length_m.toString(),
      width_m: product.width_m.toString(),
      thickness_m: product.thickness_m.toString(),
      weight: product.weight.toString(),
      volume_m3: product.volume_m3.toString()
    })
    setIsModalOpen(true)
  }

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from('products')
        .update({ is_active: !currentStatus })
        .eq('id', id)
      
      if (error) throw error
      toast.success(currentStatus ? 'Producto desactivado' : 'Producto activado')
      fetchProducts()
    } catch (error: any) {
      toast.error('Error al cambiar el estado: ' + error.message)
    }
  }

  const downloadTemplate = async () => {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Maestro de Productos');

      // Estilo de título
      worksheet.mergeCells('C1:H3');
      const titleCell = worksheet.getCell('C1');
      titleCell.value = 'PLANTILLA DE CARGA MASIVA - MAESTRO DE PRODUCTOS';
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

      worksheet.mergeCells('A4:H4');
      const instructions = worksheet.getCell('A4');
      instructions.value = 'Instrucciones: Llenar a partir de la fila 7. Los campos con (*) son obligatorios. El volumen se calculará en sistema si se envían dimensiones.';
      instructions.font = { italic: true, color: { argb: 'FF555555' } };
      
      // Filas vacías para espaciado
      worksheet.getRow(5).height = 10;

      // Headers (Fila 6)
      const headers = [
        'ID (SKU) (*)',
        'Descripción o Glosa (*)',
        'Categoría',
        'Color',
        'Peso Unitario (kg)',
        'Largo (m)',
        'Ancho (m)',
        'Espesor (m)'
      ];
      const headerRow = worksheet.getRow(6);
      headerRow.values = headers;
      
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } }; // Azul claro
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'}
        };
      });

      // Anchos de columna
      worksheet.getColumn(1).width = 20; // SKU
      worksheet.getColumn(2).width = 40; // Desc
      worksheet.getColumn(3).width = 20; // Cat
      worksheet.getColumn(4).width = 15; // Color
      worksheet.getColumn(5).width = 15; // Peso
      worksheet.getColumn(6).width = 15; // Largo
      worksheet.getColumn(7).width = 15; // Ancho
      worksheet.getColumn(8).width = 15; // Espesor

      // Data de ejemplo (Fila 7)
      const exampleRow = worksheet.getRow(7);
      exampleRow.values = ['PROD-001', 'Tubo Acero Inoxidable 2"', 'Tubería', 'Plateado', 5.5, 6, 0.05, 0.05];
      exampleRow.font = { italic: true, color: { argb: 'FF888888' } };

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Plantilla_Maestro_Productos_${new Date().getTime()}.xlsx`;
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
      
      // La data empieza en la fila 7. Saltamos las primeras 5 filas (headers en la 6).
      const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false });
      
      const productsToInsert = [];
      let skippedCount = 0;

      // Iteramos a partir del índice 6 (fila 7 real), asumiendo que 0-4 son cabeceras extra y 5 es header de columnas
      for (let i = 6; i < rawData.length; i++) {
        const row = rawData[i] as any[];
        // Verificamos campos obligatorios (SKU y Desc)
        if (!row || row.length < 2 || !row[0] || !row[1]) {
          skippedCount++;
          continue;
        }

        const length_m = parseFloat(row[5]) || 0;
        const width_m = parseFloat(row[6]) || 0;
        const thickness_m = parseFloat(row[7]) || 0;
        const calc_volume = length_m * width_m * thickness_m;

        productsToInsert.push({
          sku: String(row[0]).trim(),
          description: String(row[1]).trim(),
          category: row[2] ? String(row[2]).trim() : null,
          color: row[3] ? String(row[3]).trim() : null,
          weight: parseFloat(row[4]) || 0,
          length_m: length_m,
          width_m: width_m,
          thickness_m: thickness_m,
          volume_m3: calc_volume,
          is_active: true
        });
      }

      if (productsToInsert.length === 0) {
        toast.error('No se encontraron registros válidos para importar');
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }

      // Upsert para actualizar si el SKU existe
      const { error } = await supabase
        .from('products')
        .upsert(productsToInsert, { onConflict: 'sku' });

      if (error) throw error;

      toast.success(`Carga exitosa: ${productsToInsert.length} productos procesados (Omitidos: ${skippedCount})`);
      fetchProducts();
    } catch (error: any) {
      toast.error('Error procesando el archivo: ' + error.message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const resetForm = () => {
    setEditingId(null)
    setNewProduct({
      sku: '',
      description: '',
      category: '',
      color: '',
      length_m: '',
      width_m: '',
      thickness_m: '',
      weight: '',
      volume_m3: ''
    })
  }

  const filteredProducts = products.filter(p => 
    p.sku.toLowerCase().includes(searchTerm.toLowerCase()) || 
    p.description.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Maestro de Productos</h1>
          <p className="text-sm text-slate-500">Administra el catálogo central de ítems para solicitudes y OT</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Oculto input para archivo */}
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
            onClick={() => {
              resetForm()
              setIsModalOpen(true)
            }}
            className="flex items-center gap-2 bg-[#002855] text-white px-4 py-2 rounded-lg hover:bg-[#002855]/90 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            Nuevo Producto
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text"
              placeholder="Buscar por SKU o descripción..."
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#002855]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
                <th className="px-6 py-4 font-medium">SKU</th>
                <th className="px-6 py-4 font-medium">Descripción</th>
                <th className="px-6 py-4 font-medium">Categoría</th>
                <th className="px-6 py-4 font-medium">Color</th>
                <th className="px-6 py-4 font-medium">Largo (m)</th>
                <th className="px-6 py-4 font-medium">Ancho (m)</th>
                <th className="px-6 py-4 font-medium">Espesor (m)</th>
                <th className="px-6 py-4 font-medium">Peso (kg)</th>
                <th className="px-6 py-4 font-medium">Volumen (m³)</th>
                <th className="px-6 py-4 font-medium">Estado</th>
                <th className="px-6 py-4 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-6 py-8 text-center text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando productos...
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-6 py-8 text-center text-slate-500">
                    No se encontraron productos en el catálogo
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                  <tr key={product.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-900">{product.sku}</td>
                    <td className="px-6 py-4">{product.description}</td>
                    <td className="px-6 py-4">{product.category || '-'}</td>
                    <td className="px-6 py-4">{product.color || '-'}</td>
                    <td className="px-6 py-4">{product.length_m || '0'}</td>
                    <td className="px-6 py-4">{product.width_m || '0'}</td>
                    <td className="px-6 py-4">{product.thickness_m || '0'}</td>
                    <td className="px-6 py-4">{product.weight}</td>
                    <td className="px-6 py-4">{product.volume_m3}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        product.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {product.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={() => handleEdit(product)}
                        className="text-blue-600 hover:bg-blue-50 p-1.5 rounded mr-2"
                        title="Editar"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleToggleActive(product.id, product.is_active)}
                        className={`${product.is_active ? 'text-red-600 hover:bg-red-50' : 'text-green-600 hover:bg-green-50'} p-1.5 rounded`}
                        title={product.is_active ? "Desactivar" : "Activar"}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false)
          resetForm()
        }}
        title={editingId ? "Editar Producto" : "Nuevo Producto"}
        maxWidth="max-w-3xl"
      >
        <form onSubmit={handleSaveProduct} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">SKU / Código</label>
            <input 
              type="text" 
              required
              placeholder="Ej. MAT-001"
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newProduct.sku}
              onChange={(e) => setNewProduct({...newProduct, sku: e.target.value.toUpperCase()})}
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
            <input 
              type="text" 
              required
              className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
              value={newProduct.description}
              onChange={(e) => setNewProduct({...newProduct, description: e.target.value})}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Categoría (Opcional)</label>
              <input 
                type="text" 
                placeholder="Ej. Repuestos..."
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newProduct.category}
                onChange={(e) => setNewProduct({...newProduct, category: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Color (Opcional)</label>
              <input 
                type="text" 
                placeholder="Ej. Plateado"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newProduct.color}
                onChange={(e) => setNewProduct({...newProduct, color: e.target.value})}
              />
            </div>
          </div>

          <div className="grid grid-cols-5 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Largo (m)</label>
              <input 
                type="number" 
                min="0" step="0.01"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newProduct.length_m}
                onChange={(e) => {
                  const val = parseFloat(e.target.value) || 0;
                  const w = parseFloat(newProduct.width_m) || 0;
                  const t = parseFloat(newProduct.thickness_m) || 0;
                  setNewProduct({...newProduct, length_m: e.target.value, volume_m3: (val * w * t).toFixed(4)})
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Ancho (m)</label>
              <input 
                type="number" 
                min="0" step="0.01"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newProduct.width_m}
                onChange={(e) => {
                  const val = parseFloat(e.target.value) || 0;
                  const l = parseFloat(newProduct.length_m) || 0;
                  const t = parseFloat(newProduct.thickness_m) || 0;
                  setNewProduct({...newProduct, width_m: e.target.value, volume_m3: (l * val * t).toFixed(4)})
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Espesor (m)</label>
              <input 
                type="number" 
                min="0" step="0.01"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newProduct.thickness_m}
                onChange={(e) => {
                  const val = parseFloat(e.target.value) || 0;
                  const l = parseFloat(newProduct.length_m) || 0;
                  const w = parseFloat(newProduct.width_m) || 0;
                  setNewProduct({...newProduct, thickness_m: e.target.value, volume_m3: (l * w * val).toFixed(4)})
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Peso (kg)</label>
              <input 
                type="number" 
                min="0" step="0.01"
                className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                value={newProduct.weight}
                onChange={(e) => setNewProduct({...newProduct, weight: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Volumen (m³)</label>
              <input 
                type="number" 
                min="0" step="0.01"
                className="w-full px-3 py-2 bg-slate-100 text-slate-500 border border-slate-300 rounded-lg outline-none"
                value={newProduct.volume_m3}
                readOnly
              />
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-3 border-t">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              disabled={isSubmitting}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 bg-[#002855] text-white px-6 py-2 rounded-lg hover:bg-[#002855]/90 transition-colors disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {editingId ? 'Actualizar' : 'Guardar'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
