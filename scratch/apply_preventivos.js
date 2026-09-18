const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/app/(dashboard)/mantenimiento/preventivos/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add Filter, Search
content = content.replace(
  "Trash2, Truck, Wrench, AlertTriangle, Clock } from 'lucide-react'",
  "Trash2, Truck, Wrench, AlertTriangle, Clock, Filter } from 'lucide-react'"
);

// 2. Add State inside component
const stateHook = `  const [form, setForm] = useState({
    name: '',
    vehicle_type: 'CAMION',
    activity_description: '',
    frequency_km: '',
    frequency_days: '',
    criticality: 'MEDIA',
    responsible_role: 'MECANICO',
    tasks: [] as string[]
  })

  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterCriticality, setFilterCriticality] = useState('TODOS')

  const filteredProjections = projections.filter((proj: any) => {
    const matchSearch = searchTerm === '' || 
      proj.plate?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      proj.plan_name?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchCriticality = filterCriticality === 'TODOS' || proj.criticality === filterCriticality;
    return matchSearch && matchCriticality;
  })`;

content = content.replace(
  `  const [form, setForm] = useState({
    name: '',
    vehicle_type: 'CAMION',
    activity_description: '',
    frequency_km: '',
    frequency_days: '',
    criticality: 'MEDIA',
    responsible_role: 'MECANICO',
    tasks: [] as string[]
  })`,
  stateHook
);

// 3. Add UI inside activeTab === 'proyeccion'
const uiBlock = `        /* TAB: PROYECCIONES */
        <div className="space-y-6">

          {/* Filtros y Búsqueda */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
              <div className="relative w-full md:w-96">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-4 w-4 text-slate-400" />
                </div>
                <input
                  type="text"
                  placeholder="Buscar por placa o plan..."
                  className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm text-slate-900"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={\`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors border \${showFilters ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}\`}
              >
                <Filter className="w-4 h-4" />
                Filtros Avanzados
              </button>
            </div>
            {showFilters && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Criticidad</label>
                  <select
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none text-slate-900"
                    value={filterCriticality}
                    onChange={(e) => setFilterCriticality(e.target.value)}
                  >
                    <option value="TODOS">Todos</option>
                    <option value="ALTA">Alta</option>
                    <option value="MEDIA">Media</option>
                    <option value="BAJA">Baja</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start gap-3">`;

content = content.replace(
  `        /* TAB: PROYECCIONES */\n        <div className="space-y-6">\n          <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-start gap-3">`,
  uiBlock
);

// 4. Replace mapping
content = content.replace(
  "{projections.length === 0 ? (",
  `{filteredProjections.length === 0 ? (`
);

content = content.replace(
  "                  projections.map((proj) => (",
  "                  filteredProjections.map((proj) => ("
);

fs.writeFileSync(filePath, content);
console.log("Done patching preventivos/page.tsx");
