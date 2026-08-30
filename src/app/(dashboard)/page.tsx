export default function Home() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* KPI Cards */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-sm font-medium text-slate-500">OTs Programadas</p>
          <p className="text-3xl font-bold text-slate-800 mt-2">124</p>
          <p className="text-xs text-green-600 font-medium mt-2">+12% vs ayer</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-sm font-medium text-slate-500">En Ruta</p>
          <p className="text-3xl font-bold text-blue-600 mt-2">45</p>
          <p className="text-xs text-slate-400 font-medium mt-2">Unidades activas</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-sm font-medium text-slate-500">Entregas Pendientes</p>
          <p className="text-3xl font-bold text-amber-600 mt-2">18</p>
          <p className="text-xs text-slate-400 font-medium mt-2">Para hoy</p>
        </div>
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <p className="text-sm font-medium text-slate-500">Incidencias</p>
          <p className="text-3xl font-bold text-red-600 mt-2">3</p>
          <p className="text-xs text-red-600 font-medium mt-2">Requieren atención</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <h3 className="text-lg font-bold text-slate-800 mb-4">Despachos Recientes</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 text-sm text-slate-500">
                <th className="pb-3 font-medium">N° Despacho</th>
                <th className="pb-3 font-medium">Fecha</th>
                <th className="pb-3 font-medium">Conductor</th>
                <th className="pb-3 font-medium">Placa</th>
                <th className="pb-3 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody className="text-sm text-slate-700">
              <tr className="border-b border-slate-100 last:border-0">
                <td className="py-4">DSP-20260827-01</td>
                <td className="py-4">Hoy, 08:00 AM</td>
                <td className="py-4">Juan Pérez</td>
                <td className="py-4 font-mono text-xs">ABC-123</td>
                <td className="py-4">
                  <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-md text-xs font-medium">En Tránsito</span>
                </td>
              </tr>
              <tr className="border-b border-slate-100 last:border-0">
                <td className="py-4">DSP-20260827-02</td>
                <td className="py-4">Hoy, 08:30 AM</td>
                <td className="py-4">Carlos Gómez</td>
                <td className="py-4 font-mono text-xs">XYZ-987</td>
                <td className="py-4">
                  <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded-md text-xs font-medium">Asignado</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
