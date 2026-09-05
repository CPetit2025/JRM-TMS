"use client"
import { useState, useRef } from 'react'
import { Modal } from '@/components/ui/modal'
import { Upload, FileSpreadsheet, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'

interface BulkUploadModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function BulkUploadModal({ isOpen, onClose, onSuccess }: BulkUploadModalProps) {
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)

  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['CÓDIGO (OT/Contrato)', 'TIPO (CONTRATO/SUBCONTRATO/OT_INDEPENDIENTE)', 'CLIENTE_RUC (Opcional)', 'PRESUPUESTO_USD'],
      ['CT-2026-001', 'CONTRATO', '20123456789', 5000],
      ['SUB-2026-001', 'SUBCONTRATO', '', 1500]
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'CargaMasiva')
    XLSX.writeFile(wb, 'Plantilla_Saldos_OT.xlsx')
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    const reader = new FileReader()
    
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result
        const wb = XLSX.read(bstr, { type: 'binary' })
        const wsname = wb.SheetNames[0]
        const ws = wb.Sheets[wsname]
        const rawData = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][]
        
        let newCount = 0
        let updatedCount = 0

        // Parse data skipping header (row 0)
        for (let i = 1; i < rawData.length; i++) {
          const row = rawData[i]
          if (!row || !row[0]) continue

          const code = String(row[0]).trim()
          const type = String(row[1]).trim().toUpperCase() || 'OT_INDEPENDIENTE'
          const budgetUsd = parseFloat(row[3]) || 0
          const exchangeRate = 3.75
          const budgetPen = budgetUsd * exchangeRate

          // 1. Check if contract exists
          const { data: existingContract } = await supabase
            .from('contracts')
            .select('id')
            .eq('code', code)
            .single()

          if (existingContract) {
            // Update existing budget
            await supabase
              .from('contract_budgets')
              .update({ 
                allocated_usd: budgetUsd,
                allocated_pen: budgetPen,
                updated_at: new Date().toISOString()
              })
              .eq('contract_id', existingContract.id)
              .eq('concept', 'PARTIDA_TRANSPORTE')
            updatedCount++
          } else {
            // Insert new contract
            const { data: newContract, error: contractErr } = await supabase
              .from('contracts')
              .insert([{ code, type, is_new: true }])
              .select('id')
              .single()

            if (contractErr) throw contractErr

            // Insert new budget
            await supabase
              .from('contract_budgets')
              .insert([{ 
                contract_id: newContract.id,
                allocated_usd: budgetUsd,
                allocated_pen: budgetPen
              }])
            newCount++
          }
        }

        toast.success(`Carga exitosa: ${newCount} nuevos, ${updatedCount} actualizados.`)
        onSuccess()
        onClose()
      } catch (err: any) {
        console.error(err)
        toast.error(`Error al procesar archivo: ${err.message}`)
      } finally {
        setIsUploading(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
    
    reader.readAsBinaryString(file)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Carga Masiva de Saldos / OTs" maxWidth="max-w-md">
      <div className="space-y-6">
        <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg text-sm text-blue-800">
          <p className="mb-2"><strong>Instrucciones:</strong></p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Sube el archivo Excel diario con las OTs o Contratos.</li>
            <li>Si el código es <strong>nuevo</strong>, se creará la billetera.</li>
            <li>Si el código <strong>ya existe</strong>, se actualizará su presupuesto.</li>
          </ul>
        </div>
        
        <div className="flex flex-col gap-3">
          <button
            onClick={downloadTemplate}
            type="button"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-white border-2 border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors"
          >
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
            Descargar Plantilla Excel
          </button>

          <div className="relative">
            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
              id="bulk-upload"
              disabled={isUploading}
            />
            <label
              htmlFor="bulk-upload"
              className={`w-full flex items-center justify-center gap-2 px-4 py-3 ${isUploading ? 'bg-slate-400 cursor-not-allowed' : 'bg-[#002855] hover:bg-[#001d3d] cursor-pointer'} text-white font-medium rounded-lg transition-colors`}
            >
              {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              {isUploading ? 'Procesando archivo...' : 'Subir Archivo de Actualización'}
            </label>
          </div>
        </div>
      </div>
    </Modal>
  )
}
