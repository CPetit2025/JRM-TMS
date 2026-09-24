'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// Setup Supabase client (fallback if env vars missing for mock purposes)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://mock.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'mock-key';
const supabase = createClient(supabaseUrl, supabaseKey);

export default function CopilotoPage() {
  const [vehiclePlate, setVehiclePlate] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);

  const handleAnalyze = async () => {
    if (!vehiclePlate) return;
    setLoading(true);
    setResult(null);

    try {
      // 1. Fetch Context (Mocking the gathering from vw_asset_tco, vw_maintenance_projections, etc.)
      const mockContext = {
        tco_data: { total_cost: 15000, cpk: 1.2 },
        maintenance_projections: { pending_preventive: 2, next_service_km: 150000 },
        vehicle_status: 'Active',
        recent_checklists: { critical_issues: 1 }
      };

      // 2. Mock AI Recommendation
      let recommendation = '';
      if (mockContext.tco_data.total_cost > 10000) {
         recommendation = "Renovar unidad por TCO elevado y revisar estado de mantenimientos preventivos.";
      } else {
         recommendation = "La unidad opera en parámetros aceptables. Mantener plan de mantenimiento regular.";
      }

      // 3. Insert into ai_analysis_logs
      const { data, error } = await supabase
        .from('ai_analysis_logs')
        .insert([
          {
            vehicle_plate: vehiclePlate.toUpperCase(),
            context: mockContext,
            recommendation,
            status: 'completed'
          }
        ])
        .select()
        .single();

      if (error) {
        console.error('Error inserting log:', error);
        // Fallback for UI if DB is not fully accessible in mock
        setResult({ recommendation, context: mockContext });
      } else {
        setResult(data);
      }
      
      // Refresh logs
      fetchLogs();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchLogs = async () => {
    const { data } = await supabase
      .from('ai_analysis_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);
    if (data) setLogs(data);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Copiloto AI de Mantenimiento</h1>
      
      <div className="bg-white p-6 rounded-lg shadow-md mb-8">
        <h2 className="text-xl font-semibold mb-4">Solicitar Análisis</h2>
        <div className="flex gap-4">
          <input
            type="text"
            placeholder="Placa del Vehículo (ej. ABC-123)"
            value={vehiclePlate}
            onChange={(e) => setVehiclePlate(e.target.value)}
            className="flex-1 border p-2 rounded"
          />
          <button
            onClick={handleAnalyze}
            disabled={loading || !vehiclePlate}
            className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
          >
            {loading ? 'Analizando...' : 'Analizar Vehículo'}
          </button>
        </div>

        {result && (
          <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded">
            <h3 className="font-bold text-green-800">Recomendación AI:</h3>
            <p className="mt-2 text-green-900">{result.recommendation}</p>
            <details className="mt-4">
              <summary className="text-sm text-green-700 cursor-pointer">Ver Contexto Analizado</summary>
              <pre className="mt-2 text-xs bg-green-100 p-2 rounded overflow-auto">
                {JSON.stringify(result.context, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>

      <div className="bg-white p-6 rounded-lg shadow-md">
        <h2 className="text-xl font-semibold mb-4">Últimos Análisis</h2>
        <div className="space-y-4">
          {logs.length === 0 && <p className="text-gray-500">No hay análisis recientes.</p>}
          {logs.map((log) => (
            <div key={log.id} className="border-b pb-4">
              <div className="flex justify-between items-center mb-2">
                <span className="font-bold">{log.vehicle_plate}</span>
                <span className="text-sm text-gray-500">{new Date(log.created_at).toLocaleString()}</span>
              </div>
              <p className="text-gray-700">{log.recommendation}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
