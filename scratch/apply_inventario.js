const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/app/(dashboard)/mantenimiento/inventario/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add Filter
content = content.replace(
  "Plus, Search, BookOpen, Truck } from 'lucide-react'",
  "Plus, Search, BookOpen, Truck, Filter } from 'lucide-react'"
);

// 2. Add State inside component
const stateHook = `  const [showFilters, setShowFilters] = useState(false)
  const [filterCategory, setFilterCategory] = useState('TODOS')

  const filtered = parts.filter(p => {
    const matchSearch = searchTerm === '' || 
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
      p.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchCategory = filterCategory === 'TODOS' || p.category === filterCategory;
    return matchSearch && matchCategory;
  })`;

content = content.replace(
  `  const filtered = parts.filter(p => \n    p.name.toLowerCase().includes(searchTerm.toLowerCase()) || \n    p.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) ||\n    (p.category && p.category.toLowerCase().includes(searchTerm.toLowerCase()))\n  )`,
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
              placeholder="Buscar código, nombre, categoría..."
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
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Categoría</label>
              <select
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#002855] outline-none text-slate-900"
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
              >
                <option value="TODOS">Todos</option>
                <option value="LUBRICANTES">Lubricantes</option>
                <option value="FILTROS">Filtros</option>
                <option value="FRENOS">Frenos</option>
                <option value="MOTOR">Motor</option>
                <option value="SUSPENSION">Suspensión</option>
                <option value="SERVICIO">Servicios Externos</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">`;

content = content.replace(
  `      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">\n        <div className="p-4 border-b border-slate-200 bg-slate-50/50">\n          <div className="relative max-w-md">\n            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />\n            <input \n              type="text"\n              placeholder="Buscar código, nombre, categoría..."\n              className="w-full pl-9 pr-4 py-2 rounded-lg border-slate-300 text-sm focus:ring-[#002855]"\n              value={searchTerm}\n              onChange={(e) => setSearchTerm(e.target.value)}\n            />\n          </div>\n        </div>`,
  uiBlock
);

fs.writeFileSync(filePath, content);
console.log("Done patching inventario/page.tsx");
