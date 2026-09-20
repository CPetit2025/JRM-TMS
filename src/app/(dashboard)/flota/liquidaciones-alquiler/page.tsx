'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Calculator, Search, Calendar, FileText, CheckCircle2, AlertCircle, Download, ExternalLink, Printer } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'

export default function LiquidacionAlquilerPage() {
  const [contracts, setContracts] = useState<any[]>([])
  const [selectedContractId, setSelectedContractId] = useState('')
  const [month, setMonth] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })
  const [isLoading, setIsLoading] = useState(false)
  const [report, setReport] = useState<any>(null)
  const [signatureUrl, setSignatureUrl] = useState<string>('')

  const supabase = createClient()

  useEffect(() => {
    fetchContracts()
    fetchSignature()
  }, [])

  const fetchSignature = async () => {
    try {
      // 1. Intentar desde BD
      const { data } = await supabase.from('system_settings').select('value').eq('key', 'admin_signature_url').single()
      if (data?.value) {
        setSignatureUrl(data.value)
        return
      }
    } catch(e) {}
    // 2. Fallback a LocalStorage
    const saved = localStorage.getItem('jrm_sys_config')
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed.adminSignatureUrl) setSignatureUrl(parsed.adminSignatureUrl)
    }
  }

  const fetchContracts = async () => {
    try {
      const { data } = await supabase.from('vehicle_lease_contracts')
        .select('*, vehicles(plate), carriers(business_name)')
        .eq('status', 'ACTIVO')
      setContracts(data || [])
    } catch (e) {
      toast.error('Error al cargar contratos')
    }
  }

  const generateLiquidation = async () => {
    if (!selectedContractId || !month) return toast.error('Selecciona contrato y mes')
    
    setIsLoading(true)
    try {
      const contract = contracts.find(c => c.id === selectedContractId)
      if (!contract) throw new Error('Contrato no encontrado')

      // 1. Get start and end dates of the selected month
      const [y, m] = month.split('-')
      const startDate = new Date(Number(y), Number(m) - 1, 1).toISOString()
      const endDate = new Date(Number(y), Number(m), 0, 23, 59, 59).toISOString()

      // 2. Fetch dispatches for that vehicle in that month
      const { data: dispatches, error } = await supabase.from('dispatches')
        .select('*')
        .eq('vehicle_id', contract.vehicle_id)
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: true })

      if (error) throw error

      // 3. Calculate total KM
      const totalKm = dispatches?.reduce((sum, d) => sum + Number(d.estimated_distance_km || 0), 0) || 0

      // 4. Calculate financials
      const baseFee = Number(contract.monthly_base_fee)
      const includedKm = Number(contract.included_km)
      const excessRate = Number(contract.excess_km_rate)
      const guaranteedKm = Number(contract.guaranteed_km)

      const excessKm = Math.max(0, totalKm - includedKm)
      const excessCost = excessKm * excessRate
      
      const subtotal = baseFee + excessCost
      const tax = subtotal * 0.18 // IGV 18%
      const total = subtotal + tax

      setReport({
        contract,
        month,
        dispatches: dispatches || [],
        summary: {
          totalKm,
          baseFee,
          includedKm,
          excessKm,
          excessCost,
          guaranteedKm,
          subtotal,
          tax,
          total
        }
      })

      toast.success('Liquidación generada con éxito')
    } catch (e: any) {
      toast.error('Error: ' + e.message)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-4 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Calculator className="w-8 h-8 text-blue-600" />
            Liquidación de Alquiler en Seco
          </h1>
          <p className="text-slate-500">
            Genera el reporte mensual de KMs y pagos por vehículos subcontratados.
          </p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">Contrato / Vehículo</label>
          <select 
            value={selectedContractId} 
            onChange={(e) => setSelectedContractId(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none"
          >
            <option value="">Seleccione...</option>
            {contracts.map(c => (
              <option key={c.id} value={c.id}>
                {c.vehicles?.plate} - {c.carriers?.business_name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">Mes a Liquidar</label>
          <input 
            type="month" 
            value={month} 
            onChange={(e) => setMonth(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg focus:ring-2 outline-none"
          />
        </div>
        <div className="md:col-span-2 flex justify-end">
          <button 
            onClick={generateLiquidation}
            disabled={isLoading}
            className="px-6 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-50 w-full md:w-auto justify-center"
          >
            {isLoading ? 'Calculando...' : 'Generar Liquidación'}
          </button>
        </div>
      </div>

      {report && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex justify-end print:hidden">
            <button 
              onClick={() => window.print()}
              className="px-4 py-2 bg-slate-800 text-white rounded-lg flex items-center gap-2 hover:bg-slate-700"
            >
              <Printer className="w-4 h-4" /> Imprimir Liquidación
            </button>
          </div>

          {/* Plantilla A4 Printable */}
          <div className="bg-white border border-slate-200 shadow-sm mx-auto p-8 md:p-12 print:shadow-none print:border-none print:p-0 print:m-0" style={{ maxWidth: '210mm', minHeight: '297mm' }}>
            
            {/* Header / Membrete Corporativo */}
            <div 
              className="flex justify-between items-center bg-[#002855] text-white p-6 md:p-8 rounded-t-lg mb-8 print:rounded-none" 
              style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}
            >
              <div className="flex items-center gap-6">
                <div className="bg-white p-2 rounded-lg shadow-sm">
                  <img src="/logo-jrm.png" alt="JRM S.A.C." className="h-12 w-auto object-contain" />
                </div>
                <div>
                  <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white">JRM S.A.C.</h1>
                  <p className="text-sm text-blue-200 mt-1">Servicios de Transporte y Logística</p>
                  <p className="text-xs text-blue-300">RUC: 20601234567</p>
                </div>
              </div>
              <div className="text-right">
                <h2 className="text-xl font-bold text-white mb-1">LIQUIDACIÓN DE ALQUILER</h2>
                <p className="text-sm font-medium text-blue-200">N° LIQ-{report.month.replace('-','')}-{report.contract.id.substring(0,4).toUpperCase()}</p>
                <div className="inline-block bg-white/20 px-3 py-1 rounded mt-2">
                  <p className="text-sm text-blue-100">Mes Liquidado: <span className="font-bold text-white">{report.month}</span></p>
                </div>
              </div>
            </div>

            {/* Datos del Contrato */}
            <div className="grid grid-cols-2 gap-8 mb-8 text-sm">
              <div>
                <h3 className="font-bold text-slate-800 border-b border-slate-200 pb-2 mb-3">Datos del Proveedor</h3>
                <p><span className="text-slate-500 inline-block w-24">Razón Social:</span> <span className="font-medium">{report.contract.carriers?.business_name}</span></p>
                <p><span className="text-slate-500 inline-block w-24">Vehículo:</span> <span className="font-medium">{report.contract.vehicles?.plate}</span></p>
                <p><span className="text-slate-500 inline-block w-24">Tipo Contrato:</span> <span className="font-medium">{report.contract.contract_type}</span></p>
              </div>
              <div>
                <h3 className="font-bold text-slate-800 border-b border-slate-200 pb-2 mb-3">Condiciones Acordadas</h3>
                <p><span className="text-slate-500 inline-block w-32">Tarifa Base:</span> <span className="font-medium">S/ {report.summary.baseFee.toFixed(2)}</span></p>
                <p><span className="text-slate-500 inline-block w-32">KM Incluidos:</span> <span className="font-medium">{report.summary.includedKm} km</span></p>
                <p><span className="text-slate-500 inline-block w-32">Tarifa Exceso/KM:</span> <span className="font-medium">S/ {report.contract.excess_km_rate}</span></p>
                <p><span className="text-slate-500 inline-block w-32">Garantía Mínima:</span> <span className="font-medium">{report.summary.guaranteedKm} km</span></p>
              </div>
            </div>

            {/* Detalle de Operaciones */}
            <div className="mb-8">
              <h3 className="font-bold text-slate-800 border-b border-slate-200 pb-2 mb-4">Detalle de Operaciones en el Mes</h3>
              
              {report.summary.totalKm < report.summary.guaranteedKm && (
                <div className="bg-amber-50 border border-amber-200 p-3 rounded-lg flex items-start gap-2 mb-4 text-sm print:border-gray-300 print:bg-white">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 print:text-black" />
                  <p className="text-amber-800 print:text-black">
                    El kilometraje total del mes ({report.summary.totalKm.toFixed(2)} km) no superó la garantía mínima ({report.summary.guaranteedKm} km). Se facturará la tarifa base completa sin deducciones.
                  </p>
                </div>
              )}

              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 font-medium text-slate-700 print:bg-slate-200 border-b-2 border-slate-300">
                  <tr>
                    <th className="py-2 px-3">Fecha</th>
                    <th className="py-2 px-3">OT / Despacho</th>
                    <th className="py-2 px-3">Conductor</th>
                    <th className="py-2 px-3 text-right">KM Recorridos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {report.dispatches.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-slate-500">No se registraron rutas en este periodo.</td>
                    </tr>
                  ) : (
                    report.dispatches.map((d: any) => (
                      <tr key={d.id}>
                        <td className="py-2 px-3">{new Date(d.created_at).toLocaleDateString()}</td>
                        <td className="py-2 px-3 font-medium">{d.dispatch_number}</td>
                        <td className="py-2 px-3">{d.driver_name || '-'}</td>
                        <td className="py-2 px-3 text-right">{Number(d.estimated_distance_km || 0).toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="bg-slate-50 font-bold border-t-2 border-slate-300 print:bg-transparent">
                  <tr>
                    <td colSpan={3} className="py-3 px-3 text-right">TOTAL KILOMETRAJE MENSUAL:</td>
                    <td className="py-3 px-3 text-right text-blue-700 print:text-black">{report.summary.totalKm.toFixed(2)} km</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Resumen Financiero */}
            <div className="flex justify-end mb-16">
              <div className="w-72 bg-slate-50 p-4 rounded-lg border border-slate-200 print:bg-transparent print:border-none print:p-0">
                <h3 className="font-bold text-slate-800 border-b border-slate-200 pb-2 mb-3 print:hidden">Liquidación Financiera</h3>
                
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Tarifa Base:</span>
                    <span className="font-medium">S/ {report.summary.baseFee.toFixed(2)}</span>
                  </div>
                  
                  <div className="flex justify-between">
                    <span className="text-slate-500">Exceso KM ({report.summary.excessKm.toFixed(2)} km):</span>
                    <span className="font-medium">S/ {report.summary.excessCost.toFixed(2)}</span>
                  </div>

                  <div className="border-t border-slate-200 pt-2 flex justify-between font-bold">
                    <span>Subtotal:</span>
                    <span>S/ {report.summary.subtotal.toFixed(2)}</span>
                  </div>
                  
                  <div className="flex justify-between">
                    <span className="text-slate-500">IGV (18%):</span>
                    <span className="font-medium">S/ {report.summary.tax.toFixed(2)}</span>
                  </div>
                  
                  <div className="border-t-2 border-slate-800 pt-2 flex justify-between text-lg font-black text-[#002855] print:text-black mt-2">
                    <span>TOTAL A PAGAR:</span>
                    <span>S/ {report.summary.total.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Firmas */}
            <div className="grid grid-cols-2 gap-16 mt-20 pt-8">
              <div className="text-center flex flex-col items-center">
                <div className="h-24 w-full flex items-end justify-center mb-2">
                  {signatureUrl ? (
                    <img src={signatureUrl} alt="Firma Admin" className="max-h-full object-contain" />
                  ) : (
                    <div className="text-slate-300 text-xs italic">Firma Digital no configurada</div>
                  )}
                </div>
                <div className="w-48 border-t border-slate-400 pt-2">
                  <p className="font-bold text-sm text-slate-800">Aprobado por</p>
                  <p className="text-xs text-slate-500">JRM S.A.C.</p>
                </div>
              </div>
              <div className="text-center flex flex-col items-center">
                <div className="h-24 w-full flex items-end justify-center mb-2">
                  <div className="text-slate-200 text-xs italic">Sello / Firma Proveedor</div>
                </div>
                <div className="w-48 border-t border-slate-400 pt-2">
                  <p className="font-bold text-sm text-slate-800">Conformidad del Proveedor</p>
                  <p className="text-xs text-slate-500">{report.contract.carriers?.business_name}</p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-16 text-center text-[10px] text-slate-400 border-t border-slate-100 pt-4">
              Documento generado electrónicamente el {new Date().toLocaleString()} a través del sistema TMS.
            </div>
            
          </div>
        </div>
      )}
      
      {/* Ocultar la configuración global en modo impresión */}
      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          body * {
            visibility: hidden;
          }
          .animate-in {
            animation: none !important;
          }
          .print\\:hidden {
            display: none !important;
          }
          #print-area, #print-area * {
            visibility: visible;
          }
          #print-area {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
        }
      `}} />
    </div>
  )
}
