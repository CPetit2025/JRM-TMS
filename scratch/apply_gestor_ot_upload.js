const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../src/app/(dashboard)/mantenimiento/gestor-ot/page.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add Filter, Search to imports
content = content.replace(
  "Wand2, FileImage } from 'lucide-react'",
  "Wand2, FileImage, Filter, Search } from 'lucide-react'"
);

// 2. Add State inside component
const stateHook = `  const [isExtracting, setIsExtracting] = useState(false)

  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStatus, setFilterStatus] = useState('TODOS')

  const filteredOts = ots.filter((ot: any) => {
    const matchSearch = searchTerm === '' || 
      ot.ot_number?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      ot.vehicle_plate?.toLowerCase().includes(searchTerm.toLowerCase()) || 
      ot.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchStatus = filterStatus === 'TODOS' || ot.status === filterStatus;
    return matchSearch && matchStatus;
  })`;

content = content.replace(
  "  const [isExtracting, setIsExtracting] = useState(false)",
  stateHook
);

// 3. Add UI and replace mapping
const uiBlock = `      </div>

      {/* Filtros y Búsqueda */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-6">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
          <div className="relative w-full md:w-96">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              placeholder="Buscar por OT, placa o descripción..."
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
                <option value="PENDIENTE">Pendiente</option>
                <option value="EN_PROCESO">En Proceso</option>
                <option value="FINALIZADA">Finalizada</option>
                <option value="CANCELADA">Cancelada</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">`;

content = content.replace(
  "      </div>\n\n      <div className=\"bg-white rounded-xl shadow-sm border border-slate-200\">",
  uiBlock
);

// 4. Update map to use filteredOts and add empty state
content = content.replace(
  "{ots.map((ot) => {",
  `{filteredOts.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500">
                      No hay OTs registradas.
                    </td>
                  </tr>
                ) : (
                filteredOts.map((ot) => {`
);

const lines = content.split('\\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('                })}') && lines[i+1] && lines[i+1].includes('              </tbody>')) {
    lines[i] = '                }))}';
  }
}
content = lines.join('\\n');

// 5. Replace File Upload Input
const fileInputOld = `<input \n                        type="file" \n                        accept="image/*,.pdf"\n                        onChange={e => setCostFile(e.target.files ? e.target.files[0] : null)}\n                        className="text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 flex-1"\n                      />`;

const fileInputNew = `<label className="cursor-pointer bg-white border border-slate-300 text-slate-700 px-3 py-2 rounded-lg text-xs font-semibold hover:bg-slate-50 flex items-center gap-2 flex-1 justify-center transition-colors truncate">\n                        <FileImage className="w-4 h-4 shrink-0" />\n                        <span className="truncate">{costFile ? costFile.name : 'Subir Evidencia'}</span>\n                        <input \n                          type="file" \n                          accept="image/*,.pdf"\n                          onChange={e => setCostFile(e.target.files ? e.target.files[0] : null)}\n                          className="hidden"\n                        />\n                      </label>`;

content = content.replace(fileInputOld, fileInputNew);

fs.writeFileSync(filePath, content);
console.log("Done patching gestor-ot/page.tsx");
