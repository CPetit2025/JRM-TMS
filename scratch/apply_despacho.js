const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/app/(dashboard)/despacho/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add Filter, Search to imports
content = content.replace(
  "CheckCircle2, DollarSign, Tag } from 'lucide-react'",
  "CheckCircle2, DollarSign, Tag, Search, Filter } from 'lucide-react'"
);

// 2. Add State inside component
const stateHook = `  const [loading, setLoading] = useState(true)

  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const filteredDispatches = dispatches.filter((d: any) => {
    const matchSearch = searchTerm === '' || 
      d.dispatch_number.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.vehicle_plate.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.driver_name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || d.status === filterStatus;
    return matchSearch && matchStatus;
  })`;

content = content.replace(
  "  const [loading, setLoading] = useState(true)",
  stateHook
);

// 3. Add UI and replace mapping
const uiBlock = `      {/* Filtros y Búsqueda */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-6">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
          <div className="relative w-full md:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              placeholder="Buscar por nro, placa o conductor..."
              className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg bg-slate-50 focus:bg-white focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-colors sm:text-sm"
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
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Estado</label>
              <select
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="TODOS">Todos</option>
                <option value="PROGRAMADO">Programado</option>
                <option value="EN RUTA">En Ruta</option>
                <option value="RETORNO">Retorno</option>
                <option value="CERRADO">Cerrado</option>
                <option value="LIQUIDADO">Liquidado</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">`;

content = content.replace(
  "      <div className=\"bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden\">",
  uiBlock
);

// 4. Update map to use filteredDispatches and add empty state
content = content.replace(
  "                  ) : dispatches.length === 0 ? (",
  "                  ) : filteredDispatches.length === 0 ? ("
);

content = content.replace(
  "                  ) : (\n                    dispatches.map(dispatch => (",
  "                  ) : (\n                    filteredDispatches.map(dispatch => ("
);

fs.writeFileSync(filePath, content);
console.log("Done patching despacho/page.tsx");
