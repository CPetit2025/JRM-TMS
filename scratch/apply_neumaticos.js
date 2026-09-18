const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/app/(dashboard)/mantenimiento/neumaticos/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add Filter
content = content.replace(
  "Settings2, ShieldCheck, MapPin } from 'lucide-react'",
  "Settings2, ShieldCheck, MapPin, Filter } from 'lucide-react'"
);

// 2. Add State inside component
const stateHook = `  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const filteredTires = tires.filter((t: any) => {
    const matchSearch = searchTerm === '' || 
      t.internal_code?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      t.brand?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      t.current_vehicle_plate?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || t.status === filterStatus;
    return matchSearch && matchStatus;
  })`;

content = content.replace(
  `  const [searchTerm, setSearchTerm] = useState('')`,
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
              placeholder="Buscar por código, marca o placa..."
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
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Estado</label>
              <select
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none text-slate-900"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="TODOS">Todos</option>
                <option value="ALMACEN">Almacén</option>
                <option value="INSTALADO">Instalado</option>
                <option value="REPARACION">Reparación</option>
                <option value="DESECHADO">Desechado</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">`;

content = content.replace(
  `      <div className="bg-white rounded-xl shadow-sm border border-slate-200">\n        <div className="p-4 border-b border-slate-200 flex gap-4">\n          <div className="relative flex-1 max-w-md">\n            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />\n            <input \n              type="text" \n              placeholder="Buscar por código, marca o placa..." \n              value={searchTerm}\n              onChange={(e) => setSearchTerm(e.target.value)}\n              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"\n            />\n          </div>\n        </div>`,
  uiBlock
);

// 4. Update map to use filteredTires and add empty state
content = content.replace(
  "                  tires.filter(t => \n                    t.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) ||\n                    t.brand?.toLowerCase().includes(searchTerm.toLowerCase()) ||\n                    t.current_vehicle_plate?.toLowerCase().includes(searchTerm.toLowerCase())\n                  ).map((t) => (",
  "                  filteredTires.length === 0 ? (\n                    <tr>\n                      <td colSpan={5} className=\"p-8 text-center text-slate-500\">\n                        No hay neumáticos registrados.\n                      </td>\n                    </tr>\n                  ) : (\n                  filteredTires.map((t) => ("
);

// Close the wrapper
content = content.replace(
  "                  ))\n                }\n              </tbody>",
  "                  ))\n                )}\n              </tbody>"
);


fs.writeFileSync(filePath, content);
console.log("Done patching neumaticos/page.tsx");
