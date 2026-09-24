'use client';

import React, { useEffect, useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

interface TCOData {
  placa: string;
  anio: number;
  mes: number;
  orden_trabajo_id: string;
  ot_number: string;
  status: string;
  fecha: string;
  labor_cost: number;
  services_cost: number;
  repuestos_cost: number;
  costo_total: number;
}

interface GroupedTCO {
  placa: string;
  total_labor: number;
  total_services: number;
  total_repuestos: number;
  total_tco: number;
  ots_count: number;
}

export default function FinanzasPage() {
  const [tcoData, setTcoData] = useState<TCOData[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClientComponentClient();

  const [filterMonth, setFilterMonth] = useState<string>('');
  const [filterYear, setFilterYear] = useState<string>('');

  useEffect(() => {
    fetchTCO();
  }, []);

  const fetchTCO = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('vw_asset_tco')
        .select('*')
        .order('fecha', { ascending: false });
        
      if (error) {
        console.error('Error fetching TCO:', error);
      } else {
        setTcoData(data || []);
      }
    } catch (error) {
      console.error('Error in fetchTCO:', error);
    } finally {
      setLoading(false);
    }
  };

  // Group data by Plate
  const groupedData = tcoData.reduce((acc, curr) => {
    // Apply filters
    if (filterYear && curr.anio.toString() !== filterYear) return acc;
    if (filterMonth && curr.mes.toString() !== filterMonth) return acc;

    if (!acc[curr.placa]) {
      acc[curr.placa] = {
        placa: curr.placa,
        total_labor: 0,
        total_services: 0,
        total_repuestos: 0,
        total_tco: 0,
        ots_count: 0
      };
    }
    
    acc[curr.placa].total_labor += Number(curr.labor_cost);
    acc[curr.placa].total_services += Number(curr.services_cost);
    acc[curr.placa].total_repuestos += Number(curr.repuestos_cost);
    acc[curr.placa].total_tco += Number(curr.costo_total);
    acc[curr.placa].ots_count += 1;
    
    return acc;
  }, {} as Record<string, GroupedTCO>);

  const groupedArray = Object.values(groupedData).sort((a, b) => b.total_tco - a.total_tco);

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' }).format(val);
  };

  return (
    <div className="p-6">
      <div className="mb-8 flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Panel Financiero - TCO</h1>
          <p className="text-gray-500 text-sm mt-1">Costo Total de Propiedad por Vehículo</p>
        </div>
        
        <div className="flex gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Año</label>
            <select 
              value={filterYear} 
              onChange={(e) => setFilterYear(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">Todos</option>
              <option value="2026">2026</option>
              <option value="2025">2025</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Mes</label>
            <select 
              value={filterMonth} 
              onChange={(e) => setFilterMonth(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">Todos</option>
              <option value="1">Enero</option>
              <option value="2">Febrero</option>
              <option value="3">Marzo</option>
              <option value="4">Abril</option>
              <option value="5">Mayo</option>
              <option value="6">Junio</option>
              <option value="7">Julio</option>
              <option value="8">Agosto</option>
              <option value="9">Septiembre</option>
              <option value="10">Octubre</option>
              <option value="11">Noviembre</option>
              <option value="12">Diciembre</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center p-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Placa / Activo
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  OTs Completadas
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Mano de Obra
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Servicios Terceros
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Repuestos
                </th>
                <th scope="col" className="px-6 py-3 text-right text-xs font-bold text-gray-900 uppercase tracking-wider">
                  TCO Total
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {groupedArray.length > 0 ? (
                groupedArray.map((row) => (
                  <tr key={row.placa} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {row.placa}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                      {row.ots_count}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                      {formatCurrency(row.total_labor)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                      {formatCurrency(row.total_services)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                      {formatCurrency(row.total_repuestos)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-bold text-indigo-600">
                      {formatCurrency(row.total_tco)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-sm text-gray-500">
                    No se encontraron registros de TCO para los filtros seleccionados.
                  </td>
                </tr>
              )}
            </tbody>
            {groupedArray.length > 0 && (
              <tfoot className="bg-gray-50 font-bold">
                <tr>
                  <td className="px-6 py-4 text-sm text-gray-900">Total General</td>
                  <td className="px-6 py-4 text-sm text-right text-gray-900">
                    {groupedArray.reduce((acc, curr) => acc + curr.ots_count, 0)}
                  </td>
                  <td className="px-6 py-4 text-sm text-right text-gray-900">
                    {formatCurrency(groupedArray.reduce((acc, curr) => acc + curr.total_labor, 0))}
                  </td>
                  <td className="px-6 py-4 text-sm text-right text-gray-900">
                    {formatCurrency(groupedArray.reduce((acc, curr) => acc + curr.total_services, 0))}
                  </td>
                  <td className="px-6 py-4 text-sm text-right text-gray-900">
                    {formatCurrency(groupedArray.reduce((acc, curr) => acc + curr.total_repuestos, 0))}
                  </td>
                  <td className="px-6 py-4 text-sm text-right text-indigo-700">
                    {formatCurrency(groupedArray.reduce((acc, curr) => acc + curr.total_tco, 0))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
