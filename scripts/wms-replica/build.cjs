// Arma la migración de la fase 4 a partir de esquema.json (extract.cjs).
const o = require('./esquema.json')
const fs = require('fs')
const L = []
L.push('-- Fase 4 (docs/plan-wms-inventario-apt.md): réplica del modelo de almacén del TMS en la base WMS.')
L.push('-- Generada desde producción del TMS (no desde las migraciones del repo, que no coinciden con producción).')
L.push('-- Incluye APT (apt_*), inventario multialmacén (inv_*), analítica APT (apa_*) y la derivación ERP (erp_derive_*).')
L.push('-- Excluye contratos y clientes (siguen en el TMS) y apt_flow_tms / apt_vinculacion_estado (leen despachos del TMS).')
L.push('-- Las funciones que el WMS define a su manera (permisos y carga del ERP) no se reemplazan.')
L.push('SET check_function_bodies = off;', '')
L.push('-- Secuencias', ...[...new Set(o.sequences)], '')
L.push('-- Tablas')
for (const t of o.tables) { L.push(t.ddl); L.push(...t.alters) }
L.push('', '-- Restricciones', ...o.constraints, '', '-- Claves foráneas', ...o.fks, '', '-- Índices', ...o.indexes, '')

const viewName = v => /VIEW public\.(\w+)/.exec(v)[1]
const viewNames = o.views.map(viewName)
const word = n => new RegExp(`\\b${n}\\b`)
// Una función que devuelve el tipo de fila de una vista se crea después de la vista
const head = f => f.sql.split(/\bAS \$/)[0]
const late = f => viewNames.some(n => word(n).test(head(f)))
L.push('-- Funciones')
for (const f of o.functions.filter(f => !late(f))) L.push(f.sql, '')

// Vistas en orden de dependencia
const left = o.views.map(v => ({ n: viewName(v), v }))
const done = []
while (left.length) {
  const i = left.findIndex(x => !left.some(y => y !== x && word(y.n).test(x.v)))
  if (i < 0) throw Error('ciclo en vistas')
  done.push(left.splice(i, 1)[0])
}
L.push('-- Vistas (orden de dependencia)')
for (const { n } of [...done].reverse()) L.push(`DROP VIEW IF EXISTS public.${n};`)
for (const { n, v } of done) L.push(v.trim().replace(/;?$/, ';'), `REVOKE ALL ON public.${n} FROM PUBLIC, anon, authenticated;`, '')
L.push('-- Funciones que usan vistas en su firma')
for (const f of o.functions.filter(late)) L.push(f.sql, '')
L.push('-- Disparadores', ...o.triggers, '', '-- Seguridad', ...o.security, '')
L.push('-- Permisos del WMS: las funciones del TMS preguntan por roles y permisos apt-* que el WMS no usa')
L.push(`CREATE OR REPLACE FUNCTION public.apt_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  SELECT public.is_active_tms_user() AND (public.wh_any_warehouse_permission() OR public.wh_has_permission(ARRAY['almacen-etiquetado']));
$f$;
CREATE OR REPLACE FUNCTION public.apa_can_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  SELECT public.is_active_tms_user() AND public.wh_has_permission(ARRAY['almacen-supervisor']);
$f$;`, '', 'RESET check_function_bodies;')
fs.writeFileSync(process.argv[2], L.join('\n') + '\n')
console.log('vistas:', done.map(x => x.n).join(' > '), '| funciones tardías:', o.functions.filter(late).map(f => f.name).join(' '))
