"use client"

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { 
  Home, Users, FileText, Truck, Map as MapIcon, Settings, 
  LogOut, ShieldCheck, BarChart3, Send, DollarSign, 
  ArchiveRestore, Zap, ChevronRight, Wrench, Clock, BarChart2, CheckCircle, Settings2,
  Building2, FileSignature, ClipboardList, PackageCheck, Activity, HardHat, BadgeDollar,
  PackageSearch, Wallet
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePermissions } from '@/hooks/usePermissions'

export function Sidebar() {
  const { role, hasAccess: hasPermission } = usePermissions()
  const pathname = usePathname()

  const NavItem = ({ href, icon: Icon, label, isActive }: { href: string, icon: any, label: string, isActive?: boolean }) => {
    const active = isActive ?? pathname === href;
    return (
      <Link 
        href={href} 
        className={`group flex items-center justify-between px-4 py-2.5 my-0.5 rounded-lg transition-all duration-300 relative overflow-hidden ${
          active 
            ? 'bg-gradient-to-r from-[#002855] to-transparent text-white border-l-4 border-[#cf152d] shadow-md' 
            : 'text-slate-400 hover:text-white hover:bg-white/5'
        }`}
      >
        <div className="flex items-center gap-3">
          <Icon className={`w-4 h-4 transition-transform duration-300 ${active ? 'text-[#cf152d]' : 'group-hover:scale-110 group-hover:text-blue-300'}`} />
          <span className={`text-sm tracking-wide ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>
        </div>
        {active && <ChevronRight className="w-4 h-4 text-[#cf152d] opacity-80" />}
      </Link>
    )
  }

  return (
    <div className="flex flex-col w-[280px] h-screen bg-[#0a0f1c] border-r border-slate-800 shadow-2xl relative z-50">
      
      {/* Brand Header */}
      <div className="flex items-center justify-center h-28 p-6 relative bg-[#060913]">
        <div className="absolute inset-0 bg-gradient-to-b from-[#002855]/20 to-transparent opacity-50"></div>
        <div className="flex flex-col items-center gap-2 relative z-10 w-full">
          <img 
            src="/logo-jrm.png" 
            alt="JRM Logo" 
            className="h-10 object-contain drop-shadow-lg"
          />
          <div className="w-full flex items-center justify-center gap-2 mt-2">
            <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-[#cf152d]/50 to-transparent"></div>
            <h1 className="text-[9px] font-bold tracking-[0.25em] text-slate-300 uppercase">
              TMS Control Tower
            </h1>
            <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-[#cf152d]/50 to-transparent"></div>
          </div>
        </div>
      </div>
      
      {/* Navigation */}
      <div className="flex flex-col flex-1 overflow-y-auto mt-4 px-3 pb-6 custom-scrollbar">
        <nav className="flex-1 space-y-1">
          <NavItem href="/" icon={role === 'admin' ? BarChart3 : Home} label={role === 'admin' ? 'Dashboard Ejecutivo' : 'Inicio'} />

          {/* Generación de Demanda */}
          {(hasPermission('clientes') || hasPermission('ot') || hasPermission('solicitudes')) && (
            <>
              <div className="mt-6 mb-2 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Demanda & Comercial</p>
              </div>
              {hasPermission('clientes') && <NavItem href="/clientes" icon={Building2} label="Directorio Clientes" />}
              {hasPermission('ot') && <NavItem href="/contratos" icon={FileSignature} label="Contratos y OTs" />}
              {hasPermission('solicitudes') && <NavItem href="/solicitudes" icon={ClipboardList} label="Solicitudes de Carga" />}
            </>
          )}

          {/* Operación Logística */}
          {(hasPermission('despacho') || hasPermission('monitoreo') || hasPermission('torre-control') || hasPermission('operaciones-live')) && (
            <>
              <div className="mt-6 mb-2 px-4 flex items-center justify-between">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Operación Logística</p>
                <span className="text-[8px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-full font-bold uppercase border border-blue-500/20">LIVE</span>
              </div>
              {hasPermission('despacho') && <NavItem href="/despacho" icon={PackageCheck} label="Gestión de Despachos" />}
              {hasPermission('monitoreo') && <NavItem href="/monitoreo" icon={MapIcon} label="Monitoreo GPS" />}
              {(hasPermission('monitoreo') || hasPermission('despacho') || hasPermission('torre-control')) && <NavItem href="/torre-control" icon={Activity} label="Torre de Control" />}
            </>
          )}

          {/* Mantenimiento de Flota (CMMS) */}
          {(hasPermission('mantenimiento-dashboard') || hasPermission('mantenimiento-flota') || hasPermission('mantenimiento-fallas') || hasPermission('mantenimiento-ot') || hasPermission('mantenimiento-planes')) && (
            <>
              <div className="mt-6 mb-2 px-4 flex items-center justify-between">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mantenimiento CMMS</p>
                <span className="text-[8px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded-full font-bold uppercase border border-amber-500/20">PRO</span>
              </div>
              {hasPermission('mantenimiento-dashboard') && <NavItem href="/mantenimiento" icon={BarChart3} label="Centro de Control" />}
              {hasPermission('mantenimiento-flota') && <NavItem href="/mantenimiento/flota" icon={Truck} label="Flota 360°" />}
              {hasPermission('mantenimiento-ot') && <NavItem href="/mantenimiento/gestor-ot" icon={Wrench} label="Órdenes de Trabajo" />}
              {hasPermission('mantenimiento-planes') && <NavItem href="/mantenimiento/preventivos" icon={Clock} label="Preventivos" />}
              {hasPermission('mantenimiento-ot') && <NavItem href="/mantenimiento/inventario" icon={PackageSearch} label="Repuestos" />}
              {hasPermission('mantenimiento-flota') && <NavItem href="/mantenimiento/neumaticos" icon={Settings2} label="Neumáticos" />}
            </>
          )}

          {/* Finanzas y Caja */}
          <div className="mt-6 mb-2 px-4 flex items-center justify-between">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Finanzas y Caja</p>
            <span className="text-[8px] bg-green-500/10 text-green-400 px-2 py-0.5 rounded-full font-bold uppercase border border-green-500/20">TEST</span>
          </div>
          <NavItem href="/caja" icon={Wallet} label="Dashboard Financiero" />
          <NavItem href="/caja/fondos" icon={ArchiveRestore} label="Entrega de Fondos" />
          <NavItem href="/caja/gastos" icon={FileText} label="Gastos (Mobile)" />
          <NavItem href="/caja/liquidaciones" icon={CheckCircle} label="Liquidaciones" />

          {/* Maestros y Costos */}
          {(hasPermission('tarifas') || hasPermission('usuarios')) && (
            <>
              <div className="mt-6 mb-2 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Catálogos</p>
              </div>
              {hasPermission('usuarios') && <NavItem href="/maestros/trabajadores" icon={HardHat} label="Trabajadores" />}
              {hasPermission('tarifas') && <NavItem href="/maestros/tarifas" icon={BadgeDollar} label="Tarifas de Flete" />}
            </>
          )}

          {/* Administración */}
          {(hasPermission('usuarios') || hasPermission('permisos') || hasPermission('configuracion')) && (
            <>
              <div className="mt-6 mb-2 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Administración</p>
              </div>
              {hasPermission('usuarios') && <NavItem href="/usuarios" icon={Users} label="Usuarios del Sistema" />}
              {hasPermission('permisos') && <NavItem href="/permisos" icon={ShieldCheck} label="Roles y Permisos" />}
              {hasPermission('configuracion') && <NavItem href="/configuracion/ubicaciones" icon={MapIcon} label="Geocercas (Bases)" />}
              {hasPermission('configuracion') && <NavItem href="/configuracion" icon={Settings} label="Configuración General" />}
            </>
          )}
          
        </nav>
      </div>

      {/* Footer Profile */}
      <div className="p-4 bg-slate-900/50 border-t border-slate-800 backdrop-blur-sm">
        <Link 
          href="/perfil" 
          className="group flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all duration-300 border border-transparent hover:border-slate-700/50 cursor-pointer"
        >
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-[#002855] flex items-center justify-center border border-blue-500/30 shadow-inner">
            <span className="text-sm font-bold text-white uppercase">{role.substring(0, 2)}</span>
          </div>
          <div className="flex-1">
            <p className="text-xs font-medium text-slate-400">Sesión Activa</p>
            <p className="text-sm font-semibold text-white capitalize group-hover:text-blue-400 transition-colors">{role}</p>
          </div>
          <Settings className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors group-hover:rotate-90 duration-500" />
        </Link>
        
        <button 
          onClick={async () => {
            try {
              const { createClient } = await import('@/lib/supabase/client')
              const supabase = createClient()
              await supabase.auth.signOut()
              localStorage.removeItem('userRole')
              localStorage.removeItem('userPermissions')
              window.location.href = '/login'
            } catch (err) {
              console.error('Error al cerrar sesión', err)
            }
          }}
          className="mt-2 flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors group text-sm font-medium"
        >
          <LogOut className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          <span>Cerrar Sesión</span>
        </button>
      </div>
      
      {/* Global Style for scrollbar in sidebar */}
      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb { background: #334155; }
      `}} />
    </div>
  )
}
