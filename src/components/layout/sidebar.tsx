"use client"

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { 
  Home, Users, FileText, Truck, Map as MapIcon, Settings, 
  LogOut, ShieldAlert, BarChart3, Send, DollarSign, 
  ArchiveRestore, Zap, ChevronRight, Wrench, Clock, BarChart2, CheckCircle, Settings2
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
        className={`group flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-300 relative overflow-hidden ${
          active 
            ? 'bg-gradient-to-r from-blue-600/20 to-transparent text-white border-l-4 border-blue-500' 
            : 'text-slate-400 hover:text-white hover:bg-white/5'
        }`}
      >
        <div className="flex items-center gap-3">
          <Icon className={`w-5 h-5 transition-transform duration-300 ${active ? 'text-blue-400' : 'group-hover:scale-110 group-hover:text-blue-300'}`} />
          <span className={`font-medium tracking-wide ${active ? 'font-semibold' : ''}`}>{label}</span>
        </div>
        {active && <ChevronRight className="w-4 h-4 text-blue-500 opacity-70" />}
      </Link>
    )
  }

  return (
    <div className="flex flex-col w-[280px] h-screen bg-[#070b14] border-r border-slate-800 shadow-2xl relative z-50">
      
      {/* Brand Header */}
      <div className="flex items-center justify-center h-28 p-6 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-[#002855]/40 to-transparent opacity-50"></div>
        <div className="flex flex-col items-center gap-2 relative z-10 w-full">
          <img 
            src="https://jrmsac.com.pe/wp-content/themes/JRMTheme/static/img/logo-jrm-borde-blaco-lema.png" 
            alt="JRM Logo" 
            className="h-12 object-contain drop-shadow-lg"
          />
          <div className="w-full flex items-center justify-center gap-2 mt-1">
            <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>
            <h1 className="text-[10px] font-bold tracking-[0.2em] text-blue-200/80 uppercase">
              TMS Control Tower
            </h1>
            <div className="h-[1px] flex-1 bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>
          </div>
        </div>
      </div>
      
      {/* Navigation */}
      <div className="flex flex-col flex-1 overflow-y-auto mt-2 px-3 pb-6 custom-scrollbar">
        <nav className="flex-1 space-y-1">
          <NavItem href="/" icon={role === 'admin' ? BarChart3 : Home} label={role === 'admin' ? 'Analítica / KPIs' : 'Dashboard'} />

          {/* FORZADO: Caja Chica y Liquidaciones siempre visible */}
          <div className="mt-8 mb-3 px-4 flex items-center justify-between">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Finanzas y Caja (TEST)</p>
            <span className="text-[8px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-bold uppercase">NUEVO</span>
          </div>
          <NavItem href="/caja" icon={DollarSign} label="Dashboard Financiero" />
          <NavItem href="/caja/fondos" icon={ArchiveRestore} label="Entrega de Fondos" />
          <NavItem href="/caja/gastos" icon={FileText} label="Registro de Gastos (Mobile)" />
          <NavItem href="/caja/liquidaciones" icon={CheckCircle} label="Liquidaciones y Aprobaciones" />

          {/* Generación de Demanda */}
          {(hasPermission('clientes') || hasPermission('ot') || hasPermission('solicitudes')) && (
            <>
              <div className="mt-8 mb-3 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Generación de Demanda</p>
              </div>
              {hasPermission('clientes') && <NavItem href="/clientes" icon={Users} label="Clientes" />}
              {hasPermission('ot') && <NavItem href="/contratos" icon={FileText} label="Contratos y OTs" />}
              {hasPermission('solicitudes') && <NavItem href="/solicitudes" icon={Send} label="Solicitudes" />}
            </>
          )}

          {/* Operación Logística */}
          {(hasPermission('despacho') || hasPermission('monitoreo') || hasPermission('torre-control') || hasPermission('operaciones-live')) && (
            <>
              <div className="mt-8 mb-3 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Operación Logística</p>
              </div>
              {hasPermission('despacho') && <NavItem href="/despacho" icon={Truck} label="Despacho" />}
              {hasPermission('monitoreo') && <NavItem href="/monitoreo" icon={MapIcon} label="Monitoreo GPS" />}
              {(hasPermission('monitoreo') || hasPermission('despacho') || hasPermission('torre-control')) && <NavItem href="/torre-control" icon={Clock} label="Torre de Control" />}
            </>
          )}

          {/* Mantenimiento de Flota (CMMS) */}
          {(hasPermission('mantenimiento-dashboard') || hasPermission('mantenimiento-flota') || hasPermission('mantenimiento-fallas') || hasPermission('mantenimiento-ot') || hasPermission('mantenimiento-planes')) && (
            <>
              <div className="mt-8 mb-3 px-4 flex items-center justify-between">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mantenimiento CMMS</p>
                <span className="text-[8px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-bold uppercase">PRO</span>
              </div>
              {hasPermission('mantenimiento-dashboard') && <NavItem href="/mantenimiento" icon={BarChart3} label="Centro de Control" />}
              {hasPermission('mantenimiento-flota') && <NavItem href="/mantenimiento/flota" icon={Truck} label="Flota 360°" />}
              {hasPermission('mantenimiento-ot') && <NavItem href="/mantenimiento/gestor-ot" icon={Wrench} label="Órdenes de Trabajo" />}
              {hasPermission('mantenimiento-planes') && <NavItem href="/mantenimiento/preventivos" icon={Clock} label="Preventivos y Proyección" />}
              {hasPermission('mantenimiento-ot') && <NavItem href="/mantenimiento/inventario" icon={ArchiveRestore} label="Inventario y Repuestos" />}
              {hasPermission('mantenimiento-flota') && <NavItem href="/mantenimiento/neumaticos" icon={Settings2} label="Gestión de Neumáticos" />}
              {hasPermission('mantenimiento-dashboard') && <NavItem href="/mantenimiento/proveedores" icon={Users} label="Talleres y Proveedores" />}
              {hasPermission('mantenimiento-dashboard') && <NavItem href="/mantenimiento/analitica" icon={DollarSign} label="Analítica y Costos" />}
            </>
          )}

          {/* Maestros y Costos */}
          {(hasPermission('tarifas') || hasPermission('usuarios')) && (
            <>
              <div className="mt-8 mb-3 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Maestros y Costos</p>
              </div>
              {hasPermission('usuarios') && <NavItem href="/maestros/trabajadores" icon={Users} label="Maestro de Trabajadores" />}
              {hasPermission('tarifas') && <NavItem href="/maestros/tarifas" icon={Zap} label="Tarifas de Flete" />}
            </>
          )}

          {/* Administración */}
          {(hasPermission('usuarios') || hasPermission('permisos') || hasPermission('configuracion')) && (
            <>
              <div className="mt-8 mb-3 px-4">
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Administración</p>
              </div>
              {hasPermission('usuarios') && <NavItem href="/usuarios" icon={Users} label="Usuarios" />}
              {hasPermission('permisos') && <NavItem href="/permisos" icon={ShieldAlert} label="Roles y Permisos" />}
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
