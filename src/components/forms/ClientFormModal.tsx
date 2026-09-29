"use client"
import { useState, useEffect } from 'react'
import { Building2, Loader2, CheckCircle2, User, Phone, Mail, MapPin, Hash, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'

export interface ClientData {
  id?: string
  business_name: string
  tax_id: string
  address: string
  contact_name: string
  phone: string
  email: string
  is_active?: boolean
}

interface ClientFormModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (client: ClientData) => void
  editingClient?: ClientData | null
}

export function ClientFormModal({ isOpen, onClose, onSuccess, editingClient }: ClientFormModalProps) {
  const supabase = createClient()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSearchingRuc, setIsSearchingRuc] = useState(false)
  
  const initialClient = {
    business_name: '',
    tax_id: '',
    address: '',
    contact_name: '',
    phone: '',
    email: ''
  }
  
  const [newClient, setNewClient] = useState(initialClient)
  // RUC verificado en SUNAT en esta edición (obligatorio para clientes nuevos o cuando cambia el RUC)
  const [sunat, setSunat] = useState<{ ruc: string; status: string } | null>(null)
  const [sunatDown, setSunatDown] = useState(false)

  useEffect(() => {
    if (editingClient) {
      setNewClient({
        business_name: editingClient.business_name || '',
        tax_id: editingClient.tax_id || '',
        address: editingClient.address || '',
        contact_name: editingClient.contact_name || '',
        phone: editingClient.phone || '',
        email: editingClient.email || ''
      })
    } else {
      setNewClient(initialClient)
    }
    setSunat(null)
    setSunatDown(false)
  }, [editingClient, isOpen])

  const handleSaveClient = async (e: React.FormEvent) => {
    e.preventDefault()
    const rucChanged = !editingClient?.id || newClient.tax_id !== (editingClient.tax_id || '')
    const verified = sunat?.ruc === newClient.tax_id
    if (rucChanged && !verified) {
      if (!sunatDown) { toast.error('Consulte el RUC en SUNAT antes de guardar (botón SUNAT).'); return }
      if (!window.confirm('SUNAT no responde en este momento. ¿Guardar el cliente sin verificar el RUC?')) return
    }
    const sunatFields = rucChanged && verified ? { sunat_verified_at: new Date().toISOString(), sunat_status: sunat?.status || null } : {}
    setIsSubmitting(true)

    try {
      if (editingClient?.id) {
        const { data, error } = await supabase
          .from('clients')
          .update({
            business_name: newClient.business_name,
            tax_id: newClient.tax_id,
            address: newClient.address,
            contact_name: newClient.contact_name,
            phone: newClient.phone,
            email: newClient.email,
            ...sunatFields
          })
          .eq('id', editingClient.id)
          .select()
          .single()
          
        if (error) throw error
        toast.success('Cliente actualizado correctamente')
        onSuccess(data)
      } else {
        const { data, error } = await supabase
          .from('clients')
          .insert([{ 
            business_name: newClient.business_name,
            tax_id: newClient.tax_id,
            address: newClient.address,
            contact_name: newClient.contact_name,
            phone: newClient.phone,
            email: newClient.email,
            is_active: true,
            ...sunatFields
          }])
          .select()
          .single()
          
        if (error) throw error
        toast.success('Cliente registrado correctamente')
        onSuccess(data)
      }
      onClose()
    } catch (error: any) {
      toast.error('Error al guardar cliente: ' + error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleConsultarRUC = async () => {
    if (!newClient.tax_id || newClient.tax_id.length !== 11) {
      toast.error('El RUC debe tener 11 dígitos');
      return;
    }
    
    setIsSearchingRuc(true);
    try {
      const res = await fetch(`/api/sunat?ruc=${newClient.tax_id}`);
      if (!res.ok) {
        // 4xx: el RUC no existe en SUNAT; 5xx: el servicio no responde (se permite guardar con confirmación)
        if (res.status >= 500) setSunatDown(true)
        throw new Error(res.status >= 500 ? 'El servicio de SUNAT no responde' : 'RUC no encontrado en SUNAT');
      }
      
      const data = await res.json();
      
      if (data.nombre) {
        setNewClient(prev => ({
          ...prev,
          business_name: data.nombre,
          address: `${data.direccion} - ${data.distrito}, ${data.provincia}, ${data.departamento}`.replace(/ - , , $/g, '')
        }));
        const status = [data.estado, data.condicion].filter(Boolean).join(' / ')
        setSunat({ ruc: newClient.tax_id, status })
        setSunatDown(false)
        if ((data.estado && data.estado !== 'ACTIVO') || (data.condicion && data.condicion !== 'HABIDO')) {
          toast.warning(`RUC verificado, pero en SUNAT figura: ${status}`)
        } else {
          toast.success('RUC verificado en SUNAT');
        }
      } else {
        throw new Error('No se encontraron datos para este RUC');
      }
    } catch (error: any) {
      toast.error(error.message || 'Error al consultar SUNAT');
    } finally {
      setIsSearchingRuc(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editingClient ? "Editar Cliente" : "Registrar Nuevo Cliente"}
      maxWidth="max-w-2xl"
    >
      <form onSubmit={handleSaveClient} className="space-y-6">
        
        {/* Sección: Datos de la Empresa */}
        <div>
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-2 border-b border-slate-200 pb-2">
            <Building2 className="w-4 h-4 text-[#002855]" />
            Datos de la Empresa
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Razón Social</label>
              <div className="relative">
                <Building2 className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                <input 
                  type="text" 
                  required
                  className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newClient.business_name}
                  onChange={(e) => setNewClient({...newClient, business_name: e.target.value})}
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">RUC</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Hash className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                  <input 
                    type="text" 
                    required
                    minLength={11}
                    maxLength={11}
                    pattern="[0-9]{11}"
                    title="El RUC debe tener 11 dígitos numéricos"
                    className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={newClient.tax_id}
                    onChange={(e) => setNewClient({...newClient, tax_id: e.target.value.replace(/\D/g, '').slice(0, 11)})}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleConsultarRUC}
                  disabled={isSearchingRuc || newClient.tax_id.length !== 11}
                  className="px-3 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-50 border border-slate-300 whitespace-nowrap flex items-center gap-2"
                >
                  {isSearchingRuc ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  SUNAT
                </button>
              </div>
              {sunat?.ruc === newClient.tax_id
                ? <p className="text-xs text-emerald-700 mt-1 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Verificado en SUNAT{sunat.status ? ` · ${sunat.status}` : ''}</p>
                : (!editingClient?.id || newClient.tax_id !== (editingClient.tax_id || '')) && <p className="text-xs text-amber-700 mt-1">Consulte SUNAT para verificar el RUC antes de guardar.</p>}
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Dirección Fiscal / Principal</label>
              <div className="relative">
                <MapPin className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                <input 
                  type="text" 
                  className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newClient.address}
                  onChange={(e) => setNewClient({...newClient, address: e.target.value})}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Sección: Datos de Contacto */}
        <div>
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-3 flex items-center gap-2 border-b border-slate-200 pb-2">
            <User className="w-4 h-4 text-[#002855]" />
            Datos de Contacto
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del Contacto principal</label>
              <div className="relative">
                <User className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                <input 
                  type="text" 
                  className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newClient.contact_name}
                  onChange={(e) => setNewClient({...newClient, contact_name: e.target.value})}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
              <div className="relative">
                <Phone className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                <input 
                  type="text" 
                  className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newClient.phone}
                  onChange={(e) => setNewClient({...newClient, phone: e.target.value})}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Correo Electrónico</label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                <input 
                  type="email" 
                  className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                  value={newClient.email}
                  onChange={(e) => setNewClient({...newClient, email: e.target.value})}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="pt-4 flex justify-end gap-3 border-t border-slate-200 mt-6">
          <button 
            type="button" 
            onClick={onClose}
            className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button 
            type="submit" 
            disabled={isSubmitting}
            className="px-4 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {editingClient ? 'Guardar Cambios' : 'Registrar Cliente'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
