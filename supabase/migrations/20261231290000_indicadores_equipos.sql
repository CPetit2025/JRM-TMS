-- Indicadores por equipo (Transporte, Despacho, Inventario, Auditoría): 24 KPI semanales, quincenales o mensuales.
-- Base funcional: propuesta de KPI por equipo del 18-nov-2026. Complementa a Desempeño (índice mensual por persona,
-- kpi_parametros/kpi_historial) sin modificarlo: aquí la unidad es el equipo y el periodo puede ser semana o quincena.
-- Solo agrega objetos nuevos; no cambia tablas ni funciones operativas. El dato de origen nunca se modifica:
-- las correcciones manuales se guardan aparte (kpi_eq_correcciones) y se aplican al calcular.
-- Columnas de producción que difieren del repo se leen con to_jsonb (regla 2 de CLAUDE.md).
BEGIN;

-- ------------------------------------------------------------
-- 1. Catálogo de KPI (metas y estado de datos editables por el revisor)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_eq_def (
  codigo text PRIMARY KEY,
  equipo text NOT NULL CHECK (equipo IN ('TRANSPORTE','DESPACHO','INVENTARIO','AUDITORIA')),
  nombre text NOT NULL,
  descripcion text NOT NULL,
  formula text NOT NULL,
  fuente text NOT NULL,
  unidad text NOT NULL,
  factor numeric NOT NULL DEFAULT 100,
  sentido text NOT NULL CHECK (sentido IN ('MAYOR','MENOR')),
  meta numeric,
  tolerancia numeric NOT NULL DEFAULT 5 CHECK (tolerancia >= 0),
  cobertura_min numeric NOT NULL DEFAULT 0 CHECK (cobertura_min BETWEEN 0 AND 100),
  responsable text NOT NULL,
  frecuencias text[] NOT NULL CHECK (frecuencias <@ ARRAY['SEMANAL','QUINCENAL','MENSUAL'] AND cardinality(frecuencias) > 0),
  tipo text NOT NULL DEFAULT 'PERIODO' CHECK (tipo IN ('PERIODO','FOTO')),
  estado_datos text NOT NULL DEFAULT 'ACTIVO' CHECK (estado_datos IN ('ACTIVO','PARCIAL','PENDIENTE_CAPTURA','PENDIENTE_INTEGRACION')),
  nota_datos text,
  vigente_desde date,
  orden int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE public.kpi_eq_def ENABLE ROW LEVEL SECURITY;

INSERT INTO public.kpi_eq_def (codigo,equipo,nombre,descripcion,formula,fuente,unidad,factor,sentido,meta,tolerancia,cobertura_min,responsable,frecuencias,tipo,estado_datos,nota_datos,vigente_desde,orden) VALUES
 ('T1','TRANSPORTE','Rendimiento de combustible','Consumo real frente al rendimiento base de cada unidad: detecta consumo anormal o unidades que necesitan mantenimiento.',
  'km recorridos entre cargas ÷ (galones × km/gal base de la unidad) × 100','Cargas de combustible del conductor (dispatch_expenses COMBUSTIBLE) y vehicles.expected_km_per_gallon',
  '% de la base',100,'MAYOR',95,5,80,'Supervisor de Transporte','{QUINCENAL,MENSUAL}','PERIODO','PENDIENTE_CAPTURA',
  'No hay cargas de combustible registradas en la app. Se activa cuando los conductores registren cada carga con galones, odómetro y foto.',NULL,10),
 ('T2','TRANSPORTE','Costo por km','Costo real de mover cada unidad (combustible, mantenimiento, neumáticos, gastos de viaje y alquiler) por km recorrido.',
  '(costo total del mes por unidad) ÷ km del mes','vw_asset_tco y km de viajes',
  'S/ por km',1,'MENOR',NULL,5,80,'Supervisor de Transporte','{MENSUAL}','PERIODO','PENDIENTE_CAPTURA',
  'Falta el combustible (T1) y solo 37 % de los viajes tienen km reales. La meta se fijará con 3 meses de datos completos.',NULL,20),
 ('T3','TRANSPORTE','Fallas resueltas dentro del plazo','Rapidez del taller frente a las fallas que reportan los conductores, según el plazo por severidad.',
  'Fallas cerradas dentro del plazo de solución ÷ fallas cerradas × 100 (las descartadas no cuentan)','soporte_fallas_v (maintenance_requests + soporte_sla)',
  '%',100,'MAYOR',90,5,80,'Supervisor de Transporte / Mantenimiento','{QUINCENAL}','PERIODO','ACTIVO',NULL,NULL,30),
 ('T4','TRANSPORTE','Unidad apta en el checklist','Proporción de checklists preuso en los que la unidad quedó apta para operar.',
  'Checklists con «puede operar» ÷ checklists del periodo × 100','driver_preuse_inspections.can_operate',
  '%',100,'MAYOR',95,5,0,'Supervisor de Transporte','{MENSUAL}','PERIODO','ACTIVO',NULL,NULL,40),
 ('T5','TRANSPORTE','Checklist antes de salir','Seguridad: ningún viaje con unidad propia sale sin el checklist preuso de esa unidad ese día.',
  'Viajes propios con checklist de la misma placa el día de salida ÷ viajes propios que salieron × 100','kpi_despachos_v (salida) y driver_preuse_inspections',
  '%',100,'MAYOR',100,5,0,'Supervisor de Transporte','{SEMANAL}','PERIODO','ACTIVO',NULL,NULL,50),
 ('T6','TRANSPORTE','Salida puntual','Retrasos en patio que luego se vuelven entregas tarde. Misma regla que Desempeño: ≤ 30 min de la hora programada (si solo hay fecha, el mismo día).',
  'Salidas puntuales ÷ salidas registradas × 100 (por fecha programada)','kpi_despachos_v (salida_at, programado) y kpi_salida_puntual',
  '%',100,'MAYOR',90,5,80,'Supervisor de Transporte','{SEMANAL}','PERIODO','ACTIVO',NULL,NULL,60),
 ('D1','DESPACHO','Entrega en la fecha requerida (OTD)','Indicador principal de servicio al cliente.',
  'Solicitudes con llegada a destino ≤ fecha requerida ÷ solicitudes entregadas × 100','delivery_conformities.arrived_at y transport_requests.required_date',
  '%',100,'MAYOR',95,3,0,'Supervisor de Despacho','{SEMANAL}','PERIODO','PARCIAL',
  'La causa de la tardanza todavía no se registra; las entregas tarde se pueden excluir con motivo «Cambio pedido por el cliente».',NULL,110),
 ('D2','DESPACHO','Asignación ≤ 4 h desde la aprobación','Velocidad de planificación: despacho armado dentro de 4 h desde la aprobación.',
  'Solicitudes con despacho creado ≤ 4 h tras la aprobación ÷ solicitudes aprobadas (con 4 h ya cumplidas) × 100','transport_requests.approved_at, dispatch_requests y dispatches.created_at',
  '%',100,'MAYOR',90,5,0,'Supervisor de Despacho','{SEMANAL}','PERIODO','ACTIVO',NULL,NULL,120),
 ('D3','DESPACHO','Solicitudes reprogramadas','Cambios de fecha y quién los origina (causa obligatoria al reprogramar).',
  'Solicitudes aprobadas con al menos una reprogramación ÷ solicitudes aprobadas × 100','kpi_reprogramaciones',
  '%',100,'MENOR',5,3,0,'Supervisor de Despacho','{QUINCENAL}','PERIODO','ACTIVO',NULL,NULL,130),
 ('D4','DESPACHO','Entrega perfecta','Entregas sin rechazo y con la conformidad validada a la primera (guía, foto y receptor correctos).',
  'Entregas validadas sin observación ni rechazo ÷ entregas revisadas × 100','delivery_conformities, delivery_submissions, delivery_reviews, delivery_rejections',
  '%',100,'MAYOR',98,2,80,'Supervisor de Despacho','{QUINCENAL}','PERIODO','ACTIVO',NULL,NULL,140),
 ('D5','DESPACHO','Cargo de guía ≤ 48 h','Guías firmadas registradas a tiempo para facturar.',
  'Despachos con cargo registrado ≤ 48 h de la llegada ÷ despachos entregados (con 48 h ya cumplidas) × 100','dispatch_cargos.recibido_at y delivery_conformities.arrived_at',
  '%',100,'MAYOR',90,5,0,'Asistente Documentario','{SEMANAL}','PERIODO','ACTIVO',NULL,NULL,150),
 ('D6','DESPACHO','Ocupación de unidades','Aprovechar la capacidad antes de pedir más unidades o terceros.',
  'kg cargados ÷ capacidad de la unidad × 100','transport_requests.estimated_weight y vehicles.capacity_weight',
  '%',100,'MAYOR',75,5,80,'Supervisor de Despacho','{MENSUAL}','PERIODO','PENDIENTE_CAPTURA',
  'El peso está solo en 33 % de las solicitudes y el peso del despacho está vacío. Se activa cuando el peso sea obligatorio o llegue del packing list.',NULL,160),
 ('I1','INVENTARIO','Exactitud de inventario (conteo cíclico)','Confiabilidad del stock que se ofrece a Despacho.',
  'Ítems contados sin diferencia ÷ ítems contados × 100','WMS wh_count_lines / wh_count_results',
  '%',100,'MAYOR',98,1,0,'Equipo de Inventario','{MENSUAL}','PERIODO','PENDIENTE_INTEGRACION',
  'El dato vive en la base del WMS (2 campañas, 0 conteos) y aún no se reporta al TMS.',NULL,210),
 ('I2','INVENTARIO','Exactitud de recepción','Diferencias entre el ERP y lo recibido físicamente.',
  'Recepciones sin diferencia ÷ recepciones validadas × 100','WMS wh_receipt_validations',
  '%',100,'MAYOR',99,1,0,'Equipo de Inventario','{SEMANAL}','PERIODO','PENDIENTE_INTEGRACION',
  'El dato existe en el WMS (99,7 % en 321 validaciones) pero aún no se reporta al TMS.',NULL,220),
 ('I3','INVENTARIO','Stock APT con más de 30 días','Producto terminado inmovilizado. Foto del stock al momento del cálculo o del cierre.',
  'kg «En APT» con más de 30 días ÷ kg «En APT» × 100','apt_layers (estado, dias_saldo, kg_saldo)',
  '%',100,'MENOR',10,5,0,'Equipo de Inventario','{MENSUAL}','FOTO','ACTIVO',NULL,NULL,230),
 ('I4','INVENTARIO','Stock sin salida identificada','Trazabilidad: kg en libros cuya salida no se pudo enlazar con su ingreso. Foto al momento del cálculo o del cierre.',
  'kg «Sin salida identificada» ÷ kg en libros × 100','apt_layers (estado, kg_saldo)',
  '%',100,'MENOR',2,1,0,'Equipo de Inventario','{QUINCENAL,MENSUAL}','FOTO','ACTIVO',NULL,NULL,240),
 ('I5','INVENTARIO','Ajustes y mermas','Pérdidas y correcciones de inventario frente a lo despachado.',
  'kg de ajustes y mermas ÷ kg despachados × 100','inv_movements_v (AJUSTE…, MERMA…, clase DESPACHO)',
  '%',100,'MENOR',0.5,0.5,80,'Equipo de Inventario','{MENSUAL}','PERIODO','PARCIAL',
  'La causa del ajuste solo existe como comentario libre en el ERP y cerca de la mitad de los documentos de ajuste llegan sin peso.',NULL,250),
 ('I6','INVENTARIO','Devoluciones (logística inversa)','Cuánto material regresa frente a lo despachado. No incluye la devolución de herramientas prestadas.',
  'kg devueltos ÷ kg despachados × 100','inv_movements_v clase DEVOLUCION (sin DEV. HERRAMIENTAS) y clase DESPACHO',
  '%',100,'MENOR',0.5,0.5,80,'Equipo de Inventario / Despacho','{QUINCENAL}','PERIODO','PARCIAL',
  'Varios documentos de devolución llegan sin peso; el motivo y el estado del material no se registran.',NULL,260),
 ('A1','AUDITORIA','Despachos que pasan por el flujo WMS','Que toda carga se prepare, empaque y documente (packing list liberado) antes de salir.',
  'Solicitudes de despacho con packing list liberado antes de la salida ÷ solicitudes de despacho que salieron × 100','wms_packing_releases y kpi_despachos_v',
  '%',100,'MAYOR',95,5,0,'Auditor de Despacho / Supervisor de almacén','{SEMANAL}','PERIODO','ACTIVO',
  'Se mide desde el inicio del WMS (8-nov-2026).','2026-11-08',310),
 ('A2','AUDITORIA','Cobertura de auditoría antes de cargar','Que nada salga sin verificar.',
  'Despachos con todos sus LPN auditados ÷ despachos que pasaron por el WMS × 100','WMS wh_lpns.audit_status / wh_lpn_audits',
  '%',100,'MAYOR',100,5,0,'Auditor de Despacho','{SEMANAL}','PERIODO','PENDIENTE_INTEGRACION',
  'La auditoría de LPN vive en el WMS y aún no se reporta al TMS; además ningún despacho pasa todavía por el WMS (ver A1).',NULL,320),
 ('A3','AUDITORIA','Exactitud de preparación','LPN aprobados en su primera auditoría.',
  'LPN aprobados a la primera ÷ LPN auditados × 100','WMS wh_lpn_audits.result',
  '%',100,'MAYOR',99,1,0,'Auditor de Despacho','{SEMANAL}','PERIODO','PENDIENTE_INTEGRACION',
  'Vive en el WMS y aún no se reporta al TMS; 0 auditorías de despacho.',NULL,330),
 ('A4','AUDITORIA','Hallazgos por cada 100 despachos','Nivel de no conformidad por categoría y severidad.',
  'Hallazgos registrados ÷ despachos que salieron × 100','audit_findings y kpi_despachos_v',
  'por 100 despachos',100,'MENOR',5,2,0,'Auditor de Despacho','{QUINCENAL}','PERIODO','PENDIENTE_CAPTURA',
  'No se registran hallazgos (0): un valor 0 hoy significaría «no se audita», no «sin errores». Activar cuando la auditoría esté en marcha.',NULL,340),
 ('A5','AUDITORIA','Hallazgos cerrados en plazo','Que las correcciones se hagan y se validen a tiempo.',
  'Hallazgos cerrados hasta su fecha límite ÷ hallazgos que vencían en el periodo × 100','audit_findings (due_date, closed_at)',
  '%',100,'MAYOR',90,5,0,'Auditor de Despacho','{QUINCENAL}','PERIODO','ACTIVO',NULL,NULL,350),
 ('A6','AUDITORIA','Salidas liberadas con excepción','Veces que se dejó salir una carga con hallazgo Mayor o Crítico abierto.',
  'Excepciones de salida ÷ despachos con hallazgo Mayor/Crítico × 100','audit_finding_release_exceptions y audit_findings',
  '%',100,'MENOR',2,1,0,'Jefe de Distribución','{MENSUAL}','PERIODO','ACTIVO',NULL,NULL,360)
ON CONFLICT (codigo) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Correcciones manuales, cierres de periodo y enlace compartido
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_eq_correcciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo text NOT NULL REFERENCES public.kpi_eq_def(codigo),
  ref text NOT NULL,
  fecha date NOT NULL,
  accion text NOT NULL CHECK (accion IN ('CORREGIR','EXCLUIR')),
  num_orig numeric, den_orig numeric, con_dato_orig boolean,
  num_nuevo numeric, den_nuevo numeric,
  motivo text NOT NULL CHECK (motivo IN ('FALLA_GPS','ERROR_REGISTRO','OLVIDO_REGISTRO','DOC_MAL_CLASIFICADO','CAMBIO_CLIENTE','EXCLUIR_PRUEBA','OTRO')),
  detalle text,
  estado text NOT NULL DEFAULT 'PROPUESTA' CHECK (estado IN ('PROPUESTA','APROBADA','RECHAZADA','ANULADA')),
  propuesto_por uuid NOT NULL, propuesto_at timestamptz NOT NULL DEFAULT now(),
  resuelto_por uuid, resuelto_at timestamptz, comentario text,
  CHECK (accion = 'EXCLUIR' OR (num_nuevo IS NOT NULL AND den_nuevo IS NOT NULL AND num_nuevo >= 0 AND den_nuevo >= 0))
);
-- Una sola corrección viva (propuesta o aprobada) por registro y KPI; el historial rechazado/anulado se conserva.
CREATE UNIQUE INDEX IF NOT EXISTS kpi_eq_correcciones_viva ON public.kpi_eq_correcciones(codigo, ref) WHERE estado IN ('PROPUESTA','APROBADA');
CREATE INDEX IF NOT EXISTS kpi_eq_correcciones_estado ON public.kpi_eq_correcciones(estado, propuesto_at DESC);
ALTER TABLE public.kpi_eq_correcciones ENABLE ROW LEVEL SECURITY;

-- Cada cierre es una foto inmutable; reabrir marca la versión y el siguiente cierre crea otra.
CREATE TABLE IF NOT EXISTS public.kpi_eq_cierres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frecuencia text NOT NULL CHECK (frecuencia IN ('SEMANAL','QUINCENAL','MENSUAL')),
  desde date NOT NULL, hasta date NOT NULL,
  version int NOT NULL,
  estado text NOT NULL DEFAULT 'CERRADO' CHECK (estado IN ('CERRADO','REABIERTO')),
  valores jsonb NOT NULL,
  cerrado_at timestamptz NOT NULL DEFAULT now(), cerrado_por uuid, origen text NOT NULL DEFAULT 'MANUAL',
  reabierto_at timestamptz, reabierto_por uuid, motivo_reapertura text,
  UNIQUE (frecuencia, desde, version)
);
ALTER TABLE public.kpi_eq_cierres ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.kpi_eq_enlaces (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  etiqueta text,
  equipos text[] NOT NULL CHECK (cardinality(equipos) > 0 AND equipos <@ ARRAY['TRANSPORTE','DESPACHO','INVENTARIO','AUDITORIA']),
  pin_hash text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, revoked_by uuid,
  attempt_window timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0
);
ALTER TABLE public.kpi_eq_enlaces ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.kpi_eq_enlace_visitas (
  token uuid NOT NULL REFERENCES public.kpi_eq_enlaces(token),
  nombre text NOT NULL,
  dia date NOT NULL,
  consultas int NOT NULL DEFAULT 1,
  ultima_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, nombre, dia)
);
ALTER TABLE public.kpi_eq_enlace_visitas ENABLE ROW LEVEL SECURITY;
-- Sin políticas de lectura: todo acceso pasa por las funciones SECURITY DEFINER de abajo (C55).
REVOKE ALL ON public.kpi_eq_def FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.kpi_eq_correcciones FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.kpi_eq_cierres FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.kpi_eq_enlaces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.kpi_eq_enlace_visitas FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.kpi_eq_def;
CREATE POLICY security_active_account ON public.kpi_eq_def
 AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.kpi_eq_correcciones;
CREATE POLICY security_active_account ON public.kpi_eq_correcciones
 AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.kpi_eq_cierres;
CREATE POLICY security_active_account ON public.kpi_eq_cierres
 AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.kpi_eq_enlaces;
CREATE POLICY security_active_account ON public.kpi_eq_enlaces
 AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.kpi_eq_enlace_visitas;
CREATE POLICY security_active_account ON public.kpi_eq_enlace_visitas
 AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- ------------------------------------------------------------
-- 3. Periodos y permisos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_eq_rango(p_frec text, p_fecha date, OUT desde date, OUT hasta date)
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_frec WHEN 'SEMANAL' THEN date_trunc('week', p_fecha::timestamp)::date
                     WHEN 'QUINCENAL' THEN CASE WHEN extract(day FROM p_fecha) <= 15 THEN date_trunc('month', p_fecha::timestamp)::date ELSE date_trunc('month', p_fecha::timestamp)::date + 15 END
                     ELSE date_trunc('month', p_fecha::timestamp)::date END,
         CASE p_frec WHEN 'SEMANAL' THEN date_trunc('week', p_fecha::timestamp)::date + 6
                     WHEN 'QUINCENAL' THEN CASE WHEN extract(day FROM p_fecha) <= 15 THEN date_trunc('month', p_fecha::timestamp)::date + 14 ELSE (date_trunc('month', p_fecha::timestamp) + interval '1 month - 1 day')::date END
                     ELSE (date_trunc('month', p_fecha::timestamp) + interval '1 month - 1 day')::date END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_eq_etiqueta(p_frec text, p_desde date, p_hasta date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_frec
    WHEN 'SEMANAL' THEN 'Semana ' || to_char(p_desde, 'IW') || ' · ' || to_char(p_desde, 'DD/MM') || '–' || to_char(p_hasta, 'DD/MM/YYYY')
    WHEN 'QUINCENAL' THEN CASE WHEN extract(day FROM p_desde) = 1 THEN '1.ª' ELSE '2.ª' END || ' quincena ' || to_char(p_desde, 'MM/YYYY')
    ELSE (ARRAY['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Setiembre','Octubre','Noviembre','Diciembre'])[extract(month FROM p_desde)::int] || ' ' || extract(year FROM p_desde) END;
$$;

-- Momento de cierre automático (hora de Lima): semana y quincena al día siguiente 12:00; mes el día 3 a las 12:00.
CREATE OR REPLACE FUNCTION public.kpi_eq_vence(p_frec text, p_hasta date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((p_hasta + CASE p_frec WHEN 'MENSUAL' THEN 3 ELSE 1 END)::timestamp + interval '12 hours') AT TIME ZONE 'America/Lima';
$$;

CREATE OR REPLACE FUNCTION public.kpi_eq_hoy() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'America/Lima')::date $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_es_revisor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT public.desempeno_es_revisor() $$;

-- Equipos que el usuario puede ver: el revisor (permiso «desempeno» o Administrador) ve todos; los demás, el de su permiso.
CREATE OR REPLACE FUNCTION public.kpi_eq_equipos_visibles() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN public.desempeno_es_revisor() THEN ARRAY['TRANSPORTE','DESPACHO','INVENTARIO','AUDITORIA']
  ELSE ARRAY(SELECT e FROM (VALUES ('TRANSPORTE','flota',1),('DESPACHO','despacho',2),('INVENTARIO','apt',3),('AUDITORIA','hallazgos',4)) v(e,p,o)
             WHERE public.has_tms_permission(p) OR public.has_tms_permission(p || ':read') ORDER BY o) END;
$$;

-- Proponer correcciones exige permiso de escritura del equipo (o ser revisor); la lectura solo deja ver.
CREATE OR REPLACE FUNCTION public.kpi_eq_puede_corregir(p_equipo text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.desempeno_es_revisor() OR COALESCE(public.has_tms_permission(
    CASE p_equipo WHEN 'TRANSPORTE' THEN 'flota' WHEN 'DESPACHO' THEN 'despacho' WHEN 'INVENTARIO' THEN 'apt' WHEN 'AUDITORIA' THEN 'hallazgos' END), false);
$$;

-- Fecha a la que se imputa la corrección de un registro: la del registro; en los KPI «foto», hoy (la foto vigente).
CREATE OR REPLACE FUNCTION public.kpi_eq_fecha_efectiva(p_codigo text, p_fecha date) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN (SELECT tipo FROM public.kpi_eq_def WHERE codigo = p_codigo) = 'FOTO' THEN public.kpi_eq_hoy() ELSE p_fecha END;
$$;

-- Versión vigente de un periodo (la de mayor número); NULL si nunca se cerró.
CREATE OR REPLACE FUNCTION public.kpi_eq_cierre_vigente(p_frec text, p_desde date) RETURNS public.kpi_eq_cierres
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c FROM public.kpi_eq_cierres c WHERE c.frecuencia = p_frec AND c.desde = p_desde ORDER BY c.version DESC LIMIT 1;
$$;

-- ¿El registro de esa fecha cae en un periodo cerrado de alguna frecuencia del KPI? Entonces no se corrige sin reabrir.
CREATE OR REPLACE FUNCTION public.kpi_eq_fecha_cerrada(p_codigo text, p_fecha date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.kpi_eq_def d, unnest(d.frecuencias) f
    WHERE d.codigo = p_codigo AND (public.kpi_eq_cierre_vigente(f, (public.kpi_eq_rango(f, p_fecha)).desde)).estado = 'CERRADO');
$$;

CREATE OR REPLACE FUNCTION public.kpi_eq_nombre(p uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NULLIF(btrim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') FROM public.profiles WHERE id = p;
$$;

-- ------------------------------------------------------------
-- 4. Filas de cada KPI: una fila por registro operativo (num/den), sin correcciones.
--    con_dato = el registro tiene la medición; las filas sin dato no entran al valor, sí a la cobertura.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_eq_filas(p_codigo text, p_desde date, p_hasta date)
RETURNS TABLE(ref text, fecha date, etiqueta text, num numeric, den numeric, con_dato boolean, responsable uuid, dims jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t0 timestamptz := (p_desde::timestamp) AT TIME ZONE 'America/Lima';
  t1 timestamptz := ((p_hasta + 1)::timestamp) AT TIME ZONE 'America/Lima';
  v_desde date := GREATEST(p_desde, COALESCE((SELECT vigente_desde FROM public.kpi_eq_def WHERE codigo = p_codigo), p_desde));
BEGIN
  IF p_codigo = 'T1' THEN
    RETURN QUERY
    WITH c AS (
      SELECT e.id, upper(btrim(COALESCE(to_jsonb(e) ->> 'vehicle_plate', ''))) AS placa,
             COALESCE(NULLIF(to_jsonb(e) ->> 'expense_date', '')::date, (e.created_at AT TIME ZONE 'America/Lima')::date) AS f,
             NULLIF(to_jsonb(e) ->> 'fuel_gallons', '')::numeric AS g, NULLIF(to_jsonb(e) ->> 'fuel_odometer', '')::numeric AS o,
             public.kpi_uuid(to_jsonb(e) ->> 'created_by') AS por, e.created_at
      FROM public.dispatch_expenses e
      WHERE upper(COALESCE(to_jsonb(e) ->> 'expense_type', '')) = 'COMBUSTIBLE'
        AND upper(COALESCE(to_jsonb(e) ->> 'status', '')) NOT IN ('RECHAZADO','RECHAZADA','ANULADO','ANULADA')),
    l AS (SELECT c.*, lag(c.o) OVER (PARTITION BY c.placa ORDER BY c.o, c.created_at) AS prev FROM c WHERE c.g > 0 AND c.o IS NOT NULL AND c.placa <> ''),
    b AS (SELECT l.*, (SELECT NULLIF(to_jsonb(v) ->> 'expected_km_per_gallon', '')::numeric FROM public.vehicles v
                         WHERE upper(btrim(COALESCE(to_jsonb(v) ->> 'plate', ''))) = l.placa LIMIT 1) AS base FROM l)
    SELECT b.id::text, b.f, b.placa || ' · ' || round(b.g, 1) || ' gal', b.o - b.prev, b.g * b.base,
           (b.prev IS NOT NULL AND b.o > b.prev AND COALESCE(b.base, 0) > 0), b.por,
           jsonb_build_object('placa', b.placa, 'km', b.o - b.prev, 'galones', b.g, 'km_gal', CASE WHEN b.prev IS NOT NULL THEN round((b.o - b.prev) / b.g, 1) END, 'base_km_gal', b.base)
    FROM b WHERE b.f BETWEEN p_desde AND p_hasta;

  ELSIF p_codigo = 'T3' THEN
    RETURN QUERY
    SELECT f.id::text, (f.cerr AT TIME ZONE 'America/Lima')::date, f.plate || ' · ' || f.sev,
           CASE WHEN f.sol_h <= f.sla_sol_h THEN 1 ELSE 0 END::numeric, 1::numeric, f.sla_sol_h IS NOT NULL AND f.sol_h IS NOT NULL,
           f.tecnico, jsonb_build_object('placa', f.plate, 'severidad', f.sev, 'horas_solucion', round(f.sol_h, 1), 'plazo_horas', f.sla_sol_h)
    FROM public.soporte_fallas_v f WHERE f.status = 'CERRADA' AND f.cerr >= t0 AND f.cerr < t1;

  ELSIF p_codigo = 'T4' THEN
    RETURN QUERY
    SELECT i.operation_id::text || ':' || i.record_sequence, i.operation_date,
           COALESCE(i.vehicle_plate, '') || ' · ' || COALESCE(i.driver_name, ''),
           CASE WHEN i.can_operate THEN 1 ELSE 0 END::numeric, 1::numeric, i.can_operate IS NOT NULL, i.submitted_by,
           jsonb_build_object('placa', i.vehicle_plate, 'unidad_operativa', i.vehicle_operational, 'observacion', left(i.observation, 200))
    FROM public.driver_preuse_inspections i WHERE i.operation_date BETWEEN p_desde AND p_hasta;

  ELSIF p_codigo IN ('T5','T6') THEN
    RETURN QUERY
    WITH v AS (
      SELECT k.id, k.numero, k.placa, k.driver_id, k.programado, k.salida_at, k.estado,
             upper(COALESCE(to_jsonb(d) ->> 'modalidad', 'PROPIA')) AS modalidad
      FROM public.kpi_despachos_v k JOIN public.dispatches d ON d.id = k.id
      WHERE k.estado <> 'CANCELADO'
        AND ((p_codigo = 'T6' AND k.programado >= t0 AND k.programado < t1)
          OR (p_codigo = 'T5' AND k.salida_at >= t0 AND k.salida_at < t1)))
    SELECT v.id::text,
           (CASE WHEN p_codigo = 'T6' THEN v.programado ELSE v.salida_at END AT TIME ZONE 'America/Lima')::date,
           COALESCE(v.numero, '') || ' · ' || COALESCE(v.placa, ''),
           CASE WHEN p_codigo = 'T6' THEN CASE WHEN public.kpi_salida_puntual(v.salida_at, v.programado) THEN 1 ELSE 0 END
                ELSE CASE WHEN EXISTS (SELECT 1 FROM public.driver_preuse_inspections i
                                       WHERE upper(btrim(i.vehicle_plate)) = upper(btrim(v.placa))
                                         AND i.operation_date = (v.salida_at AT TIME ZONE 'America/Lima')::date) THEN 1 ELSE 0 END END::numeric,
           1::numeric,
           CASE WHEN p_codigo = 'T6' THEN v.salida_at IS NOT NULL ELSE true END,
           (SELECT dr.profile_id FROM public.drivers dr WHERE dr.id = v.driver_id),
           jsonb_build_object('placa', v.placa, 'programado', v.programado, 'salida', v.salida_at, 'modalidad', v.modalidad)
    FROM v WHERE p_codigo = 'T6' OR v.modalidad = 'PROPIA';

  ELSIF p_codigo = 'D1' THEN
    RETURN QUERY
    WITH e AS (SELECT c.request_id, min(c.arrived_at) AS llegada FROM public.delivery_conformities c WHERE c.arrived_at IS NOT NULL GROUP BY c.request_id)
    SELECT t.id::text, (e.llegada AT TIME ZONE 'America/Lima')::date, COALESCE(t.request_number, '')::text,
           CASE WHEN (e.llegada AT TIME ZONE 'America/Lima')::date <= (t.required_date AT TIME ZONE 'America/Lima')::date THEN 1 ELSE 0 END::numeric,
           1::numeric, true, NULL::uuid,
           jsonb_build_object('requerida', (t.required_date AT TIME ZONE 'America/Lima')::date, 'llegada', e.llegada,
             'cliente', (SELECT cl.business_name FROM public.clients cl WHERE cl.id = public.kpi_uuid(to_jsonb(t) ->> 'client_id')),
             'zona', to_jsonb(t) ->> 'delivery_zone', 'tipo', t.request_type)
    FROM e JOIN public.transport_requests t ON t.id = e.request_id
    WHERE e.llegada >= t0 AND e.llegada < t1 AND t.required_date IS NOT NULL AND upper(COALESCE(t.status, '')) <> 'CANCELADA'
    UNION ALL
    -- Vencidas sin llegada: cuentan como tarde en el periodo de su fecha requerida (si no, el OTD se infla).
    SELECT t.id::text, (t.required_date AT TIME ZONE 'America/Lima')::date, (COALESCE(t.request_number, '') || ' · sin entregar')::text,
           0::numeric, 1::numeric, true, NULL::uuid,
           jsonb_build_object('requerida', (t.required_date AT TIME ZONE 'America/Lima')::date, 'estado', t.status,
             'cliente', (SELECT cl.business_name FROM public.clients cl WHERE cl.id = public.kpi_uuid(to_jsonb(t) ->> 'client_id')),
             'zona', to_jsonb(t) ->> 'delivery_zone', 'tipo', t.request_type)
    FROM public.transport_requests t
    WHERE (t.required_date AT TIME ZONE 'America/Lima')::date BETWEEN p_desde AND LEAST(p_hasta, public.kpi_eq_hoy() - 1)
      AND upper(COALESCE(t.status, '')) NOT IN ('CANCELADA','ENTREGADA')
      AND NOT EXISTS (SELECT 1 FROM public.delivery_conformities c WHERE c.request_id = t.id AND c.arrived_at IS NOT NULL);

  ELSIF p_codigo IN ('D2','D3') THEN
    RETURN QUERY
    WITH t AS (
      SELECT r.id, r.request_number, NULLIF(to_jsonb(r) ->> 'approved_at', '')::timestamptz AS apr, r.request_type
      FROM public.transport_requests r WHERE upper(COALESCE(r.status, '')) <> 'CANCELADA'),
    a AS (
      SELECT t.*,
        (SELECT min(d.created_at) FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
          WHERE dr.transport_request_id = t.id AND upper(COALESCE(d.status, '')) <> 'CANCELADO') AS asig,
        (SELECT l."by" FROM public.dispatch_requests dr JOIN public.kpi_dispatch_log l ON l.dispatch_id = dr.dispatch_id
          WHERE dr.transport_request_id = t.id AND l.estado_nuevo = 'PROGRAMADO' ORDER BY l.at LIMIT 1) AS armo,
        (SELECT k.causa FROM public.kpi_reprogramaciones k WHERE k.request_id = t.id ORDER BY k.at DESC LIMIT 1) AS causa,
        (SELECT k."by" FROM public.kpi_reprogramaciones k WHERE k.request_id = t.id ORDER BY k.at DESC LIMIT 1) AS reprog_por
      FROM t WHERE t.apr >= t0 AND t.apr < t1)
    SELECT a.id::text, (a.apr AT TIME ZONE 'America/Lima')::date, COALESCE(a.request_number, '')::text,
           CASE WHEN p_codigo = 'D2' THEN CASE WHEN a.asig <= a.apr + interval '4 hours' THEN 1 ELSE 0 END
                ELSE CASE WHEN a.causa IS NOT NULL THEN 1 ELSE 0 END END::numeric,
           1::numeric, true,
           CASE WHEN p_codigo = 'D2' THEN a.armo ELSE a.reprog_por END,
           jsonb_build_object('aprobada', a.apr, 'asignada', a.asig,
             'horas', CASE WHEN a.asig IS NOT NULL THEN round(extract(epoch FROM a.asig - a.apr)::numeric / 3600, 1) END,
             'causa', a.causa, 'tipo', a.request_type)
    FROM a
    -- D2: las aprobadas sin despacho aún dentro de sus 4 h no se juzgan todavía.
    WHERE p_codigo = 'D3' OR a.asig IS NOT NULL OR a.apr + interval '4 hours' < now();

  ELSIF p_codigo = 'D4' THEN
    RETURN QUERY
    SELECT c.dispatch_id::text || ':' || c.request_id::text, (c.arrived_at AT TIME ZONE 'America/Lima')::date,
           COALESCE((SELECT t.request_number FROM public.transport_requests t WHERE t.id = c.request_id), '')::text,
           CASE WHEN upper(c.state) = 'VALIDADA' AND NOT obs.observada AND NOT rej.rechazo THEN 1 ELSE 0 END::numeric,
           1::numeric, upper(c.state) = 'VALIDADA' OR rej.rechazo,
           (SELECT s.submitted_by FROM public.delivery_submissions s WHERE s.id = c.current_submission_id),
           jsonb_build_object('estado', c.state, 'observada', obs.observada, 'rechazo', rej.rechazo)
    FROM public.delivery_conformities c
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.delivery_reviews rv JOIN public.delivery_submissions s ON s.id = rv.submission_id
                          WHERE s.dispatch_id = c.dispatch_id AND s.request_id = c.request_id AND upper(rv.decision) = 'OBSERVADA') AS observada) obs
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.delivery_rejections dj
                          WHERE dj.dispatch_id = c.dispatch_id AND dj.request_id = c.request_id) AS rechazo) rej
    WHERE c.arrived_at >= t0 AND c.arrived_at < t1;

  ELSIF p_codigo = 'D5' THEN
    RETURN QUERY
    WITH e AS (SELECT c.dispatch_id, min(c.arrived_at) AS llegada FROM public.delivery_conformities c WHERE c.arrived_at IS NOT NULL GROUP BY c.dispatch_id)
    SELECT e.dispatch_id::text, (e.llegada AT TIME ZONE 'America/Lima')::date, COALESCE(d.dispatch_number, '')::text,
           CASE WHEN cg.recibido_at <= e.llegada + interval '48 hours' THEN 1 ELSE 0 END::numeric, 1::numeric, true, cg.recibido_by,
           jsonb_build_object('llegada', e.llegada, 'cargo', cg.recibido_at,
             'horas', CASE WHEN cg.recibido_at IS NOT NULL THEN round(extract(epoch FROM cg.recibido_at - e.llegada)::numeric / 3600, 1) END)
    FROM e JOIN public.dispatches d ON d.id = e.dispatch_id
    LEFT JOIN LATERAL (SELECT x.recibido_at, x.recibido_by FROM public.dispatch_cargos x WHERE x.dispatch_id = e.dispatch_id ORDER BY x.recibido_at LIMIT 1) cg ON true
    WHERE e.llegada >= t0 AND e.llegada < t1 AND upper(COALESCE(d.status, '')) <> 'CANCELADO'
      -- sin cargo y aún dentro de las 48 h: todavía no se juzga
      AND (cg.recibido_at IS NOT NULL OR e.llegada + interval '48 hours' < now());

  ELSIF p_codigo IN ('I3','I4') THEN
    -- Foto del stock actual: el periodo no filtra (se congela al cerrar).
    RETURN QUERY
    SELECT l.movement_id::text || ':' || COALESCE(l.lote, ''), l.fecha_ingreso,
           COALESCE(l.lote, '') || ' · ' || COALESCE(l.producto, ''),
           CASE WHEN p_codigo = 'I3' THEN CASE WHEN l.dias_saldo > 30 THEN l.kg_saldo ELSE 0 END
                ELSE CASE WHEN l.estado = 'Sin salida identificada' THEN l.kg_saldo ELSE 0 END END,
           l.kg_saldo, true, NULL::uuid,
           jsonb_build_object('lote', l.lote, 'producto', l.producto, 'cliente', l.cliente, 'estado', l.estado, 'dias', l.dias_saldo, 'kg', round(l.kg_saldo, 1))
    FROM public.apt_layers l
    WHERE l.kg_saldo > 0 AND (p_codigo = 'I4' OR l.estado = 'En APT');

  ELSIF p_codigo IN ('I5','I6') THEN
    RETURN QUERY
    WITH m AS (
      SELECT x.id, x.fecha, x.tipodocto, x.clase, x.numero, x.bodega, x.razon_social, x.peso_kg
      FROM public.inv_movements_v x WHERE x.active AND x.fecha BETWEEN p_desde AND p_hasta)
    SELECT m.id::text, m.fecha, m.tipodocto || ' ' || COALESCE(m.numero, '') || ' · ' || COALESCE(m.bodega, ''),
           abs(COALESCE(m.peso_kg, 0)), 0::numeric, m.peso_kg IS NOT NULL, NULL::uuid,
           jsonb_build_object('tipo', m.tipodocto, 'bodega', m.bodega, 'razon_social', m.razon_social, 'kg', m.peso_kg)
    FROM m
    WHERE (p_codigo = 'I5' AND (m.tipodocto ILIKE 'AJUSTE%' OR m.tipodocto ILIKE 'MERMA%'))
       OR (p_codigo = 'I6' AND m.clase = 'DEVOLUCION' AND m.tipodocto <> 'DEV. HERRAMIENTAS')
    UNION ALL
    -- Denominador: cada documento despachado (los ajustes y mermas de la clase DESPACHO no son despacho).
    -- Los que no traen peso quedan sin dato y bajan la cobertura en vez de desaparecer.
    SELECT m.id::text, m.fecha, m.tipodocto || ' ' || COALESCE(m.numero, '') || ' · ' || COALESCE(m.bodega, ''),
           0::numeric, abs(COALESCE(m.peso_kg, 0)), m.peso_kg IS NOT NULL, NULL::uuid,
           jsonb_build_object('tipo', m.tipodocto, 'bodega', m.bodega, 'razon_social', m.razon_social, 'kg', m.peso_kg)
    FROM m WHERE m.clase = 'DESPACHO' AND m.tipodocto NOT ILIKE 'AJUSTE%' AND m.tipodocto NOT ILIKE 'MERMA%';

  ELSIF p_codigo = 'A1' THEN
    RETURN QUERY
    SELECT t.id::text, (k.salida_at AT TIME ZONE 'America/Lima')::date, COALESCE(t.request_number, '') || ' · ' || COALESCE(k.numero, ''),
           CASE WHEN EXISTS (SELECT 1 FROM public.wms_packing_releases w WHERE w.transport_request_id = t.id
                               AND upper(COALESCE(w.status, 'LIBERADO')) <> 'REEMPLAZADO' AND w.released_at <= k.salida_at) THEN 1 ELSE 0 END::numeric,
           1::numeric, true, NULL::uuid,
           jsonb_build_object('despacho', k.numero, 'salida', k.salida_at,
             'packing', (SELECT min(w.released_at) FROM public.wms_packing_releases w WHERE w.transport_request_id = t.id))
    FROM public.transport_requests t
    JOIN LATERAL (SELECT v.numero, min(v.salida_at) AS salida_at FROM public.dispatch_requests dr JOIN public.kpi_despachos_v v ON v.id = dr.dispatch_id
                   WHERE dr.transport_request_id = t.id AND v.estado <> 'CANCELADO' AND v.salida_at IS NOT NULL GROUP BY v.numero ORDER BY 2 LIMIT 1) k ON true
    WHERE upper(COALESCE(t.request_type, '')) = 'DESPACHO' AND k.salida_at >= GREATEST(t0, (v_desde::timestamp) AT TIME ZONE 'America/Lima') AND k.salida_at < t1;

  ELSIF p_codigo = 'A4' THEN
    RETURN QUERY
    SELECT f.id::text, (f.registered_at AT TIME ZONE 'America/Lima')::date, f.number || ' · ' || f.severity, 1::numeric, 0::numeric, true, f.auditor_id,
           jsonb_build_object('severidad', f.severity, 'estado', f.status, 'area', f.process_area)
    FROM public.audit_findings f WHERE f.registered_at >= t0 AND f.registered_at < t1
    UNION ALL
    SELECT k.id::text, (k.salida_at AT TIME ZONE 'America/Lima')::date, COALESCE(k.numero, '') || ' · salida', 0::numeric, 1::numeric, true, NULL::uuid,
           jsonb_build_object('placa', k.placa)
    FROM public.kpi_despachos_v k WHERE k.estado <> 'CANCELADO' AND k.salida_at >= t0 AND k.salida_at < t1;

  ELSIF p_codigo = 'A5' THEN
    RETURN QUERY
    SELECT f.id::text, f.due_date, f.number || ' · ' || f.severity,
           CASE WHEN f.closed_at IS NOT NULL AND (f.closed_at AT TIME ZONE 'America/Lima')::date <= f.due_date THEN 1 ELSE 0 END::numeric,
           1::numeric, true, f.responsible_id,
           jsonb_build_object('severidad', f.severity, 'estado', f.status, 'vence', f.due_date, 'cerrado', f.closed_at)
    FROM public.audit_findings f
    WHERE f.due_date BETWEEN p_desde AND p_hasta
      -- abierto y aún no vencido: todavía no se juzga
      AND (f.closed_at IS NOT NULL OR f.due_date < public.kpi_eq_hoy());

  ELSIF p_codigo = 'A6' THEN
    RETURN QUERY
    SELECT x.id::text, (x.approved_at AT TIME ZONE 'America/Lima')::date, 'Excepción · ' || COALESCE(f.number, ''), 1::numeric, 0::numeric, true, x.approved_by,
           jsonb_build_object('motivo', left(x.reason, 200), 'severidad', f.severity)
    -- Mismo universo que el denominador: excepciones sobre hallazgos Mayor/Crítico registrados en el periodo.
    FROM public.audit_finding_release_exceptions x JOIN public.audit_findings f ON f.id = x.finding_id
    WHERE x.revoked_at IS NULL AND f.dispatch_id IS NOT NULL AND f.severity IN ('MAYOR','CRITICO') AND f.registered_at >= t0 AND f.registered_at < t1
    UNION ALL
    SELECT f.dispatch_id::text, min((f.registered_at AT TIME ZONE 'America/Lima')::date), 'Despacho con hallazgo Mayor/Crítico', 0::numeric, 1::numeric, true, NULL::uuid, '{}'::jsonb
    FROM public.audit_findings f
    WHERE f.dispatch_id IS NOT NULL AND f.severity IN ('MAYOR','CRITICO') AND f.registered_at >= t0 AND f.registered_at < t1
    GROUP BY f.dispatch_id;
  END IF;
  -- T2, D6, I1, I2, A2, A3: sin fuente en el TMS todavía (ver nota_datos); no devuelven filas.
END $$;

-- Filas con las correcciones aprobadas aplicadas y el estado de cualquier corrección viva.
CREATE OR REPLACE FUNCTION public.kpi_eq_filas_corr(p_codigo text, p_desde date, p_hasta date)
RETURNS TABLE(ref text, fecha date, etiqueta text, num numeric, den numeric, con_dato boolean, responsable uuid, dims jsonb,
              origen text, num_orig numeric, den_orig numeric, con_dato_orig boolean, corr_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.ref, f.fecha, f.etiqueta,
         CASE WHEN c.estado = 'APROBADA' AND c.accion = 'CORREGIR' THEN c.num_nuevo ELSE f.num END,
         CASE WHEN c.estado = 'APROBADA' AND c.accion = 'CORREGIR' THEN c.den_nuevo ELSE f.den END,
         CASE WHEN c.estado = 'APROBADA' AND c.accion = 'CORREGIR' THEN true ELSE f.con_dato END,
         f.responsable, f.dims,
         CASE WHEN c.estado = 'APROBADA' THEN CASE c.accion WHEN 'EXCLUIR' THEN 'EXCLUIDO' ELSE 'CORREGIDO' END ELSE 'AUTO' END,
         f.num, f.den, f.con_dato, c.id
  FROM public.kpi_eq_filas(p_codigo, p_desde, p_hasta) f
  LEFT JOIN public.kpi_eq_correcciones c ON c.codigo = p_codigo AND c.ref = f.ref AND c.estado IN ('PROPUESTA','APROBADA');
$$;

-- ------------------------------------------------------------
-- 5. Valor y estado de un KPI en un periodo
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_eq_valor(p_codigo text, p_desde date, p_hasta date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.kpi_eq_def; s record; v numeric; cob numeric; est text;
BEGIN
  SELECT * INTO d FROM public.kpi_eq_def WHERE codigo = p_codigo;
  SELECT count(*) FILTER (WHERE origen <> 'EXCLUIDO') AS n,
         count(*) FILTER (WHERE origen <> 'EXCLUIDO' AND con_dato) AS n_con,
         COALESCE(sum(num) FILTER (WHERE origen <> 'EXCLUIDO' AND con_dato), 0) AS sn,
         COALESCE(sum(den) FILTER (WHERE origen <> 'EXCLUIDO' AND con_dato), 0) AS sd,
         count(*) FILTER (WHERE corr_id IS NOT NULL AND origen = 'AUTO') AS pend,
         count(*) FILTER (WHERE origen IN ('CORREGIDO','EXCLUIDO')) AS corr,
         -- filas que solo aportan al numerador (devoluciones, ajustes, hallazgos): su cobertura se mide aparte
         count(*) FILTER (WHERE origen <> 'EXCLUIDO' AND den_orig = 0) AS n_num,
         count(*) FILTER (WHERE origen <> 'EXCLUIDO' AND den_orig = 0 AND con_dato) AS n_num_con
    INTO s FROM public.kpi_eq_filas_corr(p_codigo, p_desde, p_hasta);
  v := CASE WHEN s.sd > 0 THEN round(d.factor * s.sn / s.sd, 2) END;
  -- La cobertura es la peor entre todas las filas y las del numerador: sin un kg medido en el numerador nunca «cumple».
  cob := CASE WHEN s.n > 0 THEN round(100.0 * s.n_con / s.n, 1) END;
  IF s.n_num > 0 THEN cob := LEAST(cob, round(100.0 * s.n_num_con / s.n_num, 1)); END IF;
  est := CASE
    WHEN d.estado_datos IN ('PENDIENTE_CAPTURA','PENDIENTE_INTEGRACION') THEN 'PENDIENTE_DATOS'
    WHEN s.n_con = 0 OR s.sd = 0 THEN 'SIN_REGISTROS'
    WHEN cob < d.cobertura_min THEN 'DATOS_INSUFICIENTES'
    WHEN d.meta IS NULL THEN 'SIN_REGISTROS'
    WHEN d.sentido = 'MAYOR' THEN CASE WHEN v >= d.meta THEN 'CUMPLE' WHEN v >= d.meta - d.tolerancia THEN 'ALERTA' ELSE 'NO_CUMPLE' END
    ELSE CASE WHEN v <= d.meta THEN 'CUMPLE' WHEN v <= d.meta + d.tolerancia THEN 'ALERTA' ELSE 'NO_CUMPLE' END END;
  RETURN jsonb_build_object('codigo', p_codigo,
    'valor', CASE WHEN est = 'PENDIENTE_DATOS' THEN NULL ELSE v END,
    'num', s.sn, 'den', s.sd, 'n', s.n, 'n_con_dato', s.n_con, 'cobertura', cob, 'estado', est,
    'correcciones_pendientes', s.pend, 'corregidos', s.corr, 'calculado_at', now());
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_def_json(d public.kpi_eq_def) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('codigo', d.codigo, 'equipo', d.equipo, 'nombre', d.nombre, 'descripcion', d.descripcion, 'formula', d.formula,
    'fuente', d.fuente, 'unidad', d.unidad, 'sentido', d.sentido, 'meta', d.meta, 'tolerancia', d.tolerancia, 'cobertura_min', d.cobertura_min,
    'responsable', d.responsable, 'estado_datos', d.estado_datos, 'nota_datos', d.nota_datos, 'tipo', d.tipo, 'frecuencias', to_jsonb(d.frecuencias), 'orden', d.orden);
$$;

-- Valores de todos los KPI de una frecuencia en un periodo (con la definición vigente al momento).
CREATE OR REPLACE FUNCTION public.kpi_eq_calcular(p_frec text, p_desde date, p_hasta date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(public.kpi_eq_def_json(d) || public.kpi_eq_valor(d.codigo, p_desde, p_hasta) ORDER BY d.orden), '[]')
  FROM public.kpi_eq_def d WHERE p_frec = ANY (d.frecuencias);
$$;

-- ------------------------------------------------------------
-- 6. Cierre, reapertura y cierre automático
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_eq_cerrar_interno(p_frec text, p_desde date, p_por uuid, p_origen text) RETURNS public.kpi_eq_cierres
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; c public.kpi_eq_cierres; vals jsonb; nueva public.kpi_eq_cierres;
BEGIN
  SELECT * INTO r FROM public.kpi_eq_rango(p_frec, p_desde);
  c := public.kpi_eq_cierre_vigente(p_frec, r.desde);
  IF c.estado = 'CERRADO' THEN RETURN c; END IF;
  vals := public.kpi_eq_calcular(p_frec, r.desde, r.hasta);
  -- Un KPI «foto» solo vale cerca de su fecha: si el periodo terminó hace más de 7 días se conserva la foto de la
  -- versión anterior (reapertura) o, si nunca hubo, queda pendiente; no se inventa con el stock de hoy.
  IF r.hasta < public.kpi_eq_hoy() - 7 THEN
    SELECT jsonb_agg(CASE WHEN x->>'tipo' = 'FOTO'
      THEN COALESCE((SELECT y FROM jsonb_array_elements(c.valores) y WHERE y->>'codigo' = x->>'codigo'),
                    x || jsonb_build_object('valor', NULL, 'estado', 'PENDIENTE_DATOS', 'nota_datos', 'Foto del stock no disponible para periodos anteriores al inicio del módulo.'))
      ELSE x END ORDER BY ord) INTO vals FROM jsonb_array_elements(vals) WITH ORDINALITY AS z(x, ord);
  END IF;
  INSERT INTO public.kpi_eq_cierres(frecuencia, desde, hasta, version, valores, cerrado_por, origen)
  VALUES (p_frec, r.desde, r.hasta, COALESCE(c.version, 0) + 1, COALESCE(vals, '[]'), p_por, p_origen)
  RETURNING * INTO nueva;
  RETURN nueva;
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_cerrar(p_frecuencia text, p_desde date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; c public.kpi_eq_cierres;
BEGIN
  IF NOT public.kpi_eq_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el revisor de indicadores puede cerrar un periodo'); END IF;
  IF p_frecuencia IS NULL OR p_frecuencia NOT IN ('SEMANAL','QUINCENAL','MENSUAL') OR p_desde IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Frecuencia o periodo no válido'); END IF;
  SELECT * INTO r FROM public.kpi_eq_rango(p_frecuencia, p_desde);
  IF r.hasta >= public.kpi_eq_hoy() THEN RETURN jsonb_build_object('success', false, 'error', 'El periodo todavía no termina'); END IF;
  BEGIN
    c := public.kpi_eq_cerrar_interno(p_frecuencia, r.desde, auth.uid(), 'MANUAL');
  EXCEPTION WHEN unique_violation THEN
    -- el cierre automático ganó la carrera: la foto ya existe
    c := public.kpi_eq_cierre_vigente(p_frecuencia, r.desde);
  END;
  RETURN jsonb_build_object('success', true, 'version', c.version);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_reabrir(p_frecuencia text, p_desde date, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; c public.kpi_eq_cierres;
BEGIN
  IF NOT public.kpi_eq_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el revisor de indicadores puede reabrir un periodo'); END IF;
  IF length(btrim(COALESCE(p_motivo, ''))) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la reapertura'); END IF;
  SELECT * INTO r FROM public.kpi_eq_rango(p_frecuencia, p_desde);
  c := public.kpi_eq_cierre_vigente(p_frecuencia, r.desde);
  IF c.id IS NULL OR c.estado <> 'CERRADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El periodo no está cerrado'); END IF;
  UPDATE public.kpi_eq_cierres SET estado = 'REABIERTO', reabierto_at = now(), reabierto_por = auth.uid(), motivo_reapertura = left(btrim(p_motivo), 500)
  WHERE id = c.id;
  RETURN jsonb_build_object('success', true);
END $$;

INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('KPI_EQUIPOS_CIERRE', 'CUMPLIMIENTO', 'Indicadores por equipo: periodo cerrado', 'info', ARRAY['desempeno'], false)
ON CONFLICT (evento) DO NOTHING;

-- Cierra los periodos vencidos sin foto: el último de cada frecuencia avisa; los anteriores (arranque) se cierran en silencio.
CREATE OR REPLACE FUNCTION public.kpi_eq_job() RETURNS int
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f text; r record; c public.kpi_eq_cierres; n int := 0; malos int; hoy date := public.kpi_eq_hoy();
BEGIN
  FOREACH f IN ARRAY ARRAY['SEMANAL','QUINCENAL','MENSUAL'] LOOP
    -- Ventana de arranque: 8 semanas, 6 quincenas o 3 meses hacia atrás; después solo cierra el periodo recién vencido.
    FOR r IN SELECT DISTINCT x.desde, x.hasta
             FROM generate_series(hoy - CASE f WHEN 'SEMANAL' THEN 56 WHEN 'QUINCENAL' THEN 90 ELSE 92 END, hoy, interval '1 day') g
             CROSS JOIN LATERAL public.kpi_eq_rango(f, g::date) x ORDER BY x.desde LOOP
      IF now() < public.kpi_eq_vence(f, r.hasta) OR (public.kpi_eq_cierre_vigente(f, r.desde)).id IS NOT NULL THEN CONTINUE; END IF;
      BEGIN
        c := public.kpi_eq_cerrar_interno(f, r.desde, NULL, 'AUTOMATICO');
        n := n + 1;
        IF r.hasta >= hoy - (CASE f WHEN 'MENSUAL' THEN 5 ELSE 3 END) THEN
          SELECT count(*) INTO malos FROM jsonb_array_elements(c.valores) x WHERE x->>'estado' = 'NO_CUMPLE';
          PERFORM public.notif_emit('KPI_EQUIPOS_CIERRE', 'kpieq-' || f || '-' || r.desde,
            'Indicadores cerrados: ' || public.kpi_eq_etiqueta(f, r.desde, r.hasta),
            CASE WHEN malos > 0 THEN malos || ' indicador(es) fuera de meta. ' ELSE '' END || 'Revise el tablero por equipo.',
            '/indicadores?frecuencia=' || f || '&desde=' || r.desde, NULL);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'kpi_eq_job %/%: %', f, r.desde, SQLERRM;
      END;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;

-- ------------------------------------------------------------
-- 7. API para la pantalla
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_eq_tablero(p_frecuencia text, p_desde date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE eq text[] := public.kpi_eq_equipos_visibles(); r record; c public.kpi_eq_cierres; vals jsonb; per jsonb; tend jsonb;
BEGIN
  IF cardinality(eq) = 0 THEN RETURN jsonb_build_object('error', 'Sin permiso para ver los indicadores por equipo'); END IF;
  IF p_frecuencia IS NULL OR p_frecuencia NOT IN ('SEMANAL','QUINCENAL','MENSUAL') THEN RETURN jsonb_build_object('error', 'Frecuencia no válida'); END IF;
  SELECT * INTO r FROM public.kpi_eq_rango(p_frecuencia, COALESCE(p_desde, public.kpi_eq_hoy()));
  c := public.kpi_eq_cierre_vigente(p_frecuencia, r.desde);
  vals := CASE WHEN c.estado = 'CERRADO' THEN c.valores ELSE public.kpi_eq_calcular(p_frecuencia, r.desde, r.hasta) END;
  -- Pendientes de corrección siempre en vivo (cambian después del cierre).
  IF c.estado = 'CERRADO' THEN
    SELECT jsonb_agg(x || jsonb_build_object('correcciones_pendientes',
      (SELECT count(*) FROM public.kpi_eq_correcciones k WHERE k.codigo = x->>'codigo' AND k.estado = 'PROPUESTA' AND k.fecha BETWEEN r.desde AND r.hasta)))
      INTO vals FROM jsonb_array_elements(vals) x;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', p.desde, 'hasta', p.hasta, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, p.desde, p.hasta),
           'estado', COALESCE((public.kpi_eq_cierre_vigente(p_frecuencia, p.desde)).estado, 'ABIERTO')) ORDER BY p.desde DESC), '[]')
    INTO per
    FROM (SELECT DISTINCT (public.kpi_eq_rango(p_frecuencia, g::date)).* FROM generate_series(public.kpi_eq_hoy() - CASE p_frecuencia WHEN 'SEMANAL' THEN 77 WHEN 'QUINCENAL' THEN 170 ELSE 340 END, public.kpi_eq_hoy(), interval '1 day') g) p;
  RETURN jsonb_build_object('frecuencia', p_frecuencia, 'desde', r.desde, 'hasta', r.hasta, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, r.desde, r.hasta),
    'estado_periodo', COALESCE(c.estado, 'ABIERTO'), 'version', c.version, 'cerrado_at', c.cerrado_at, 'motivo_reapertura', c.motivo_reapertura,
    'provisional', c.estado IS DISTINCT FROM 'CERRADO', 'es_revisor', public.kpi_eq_es_revisor(), 'equipos', to_jsonb(eq), 'periodos', per,
    'kpis', COALESCE((SELECT jsonb_agg(x || jsonb_build_object('tendencia', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('desde', h.desde, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, h.desde, h.hasta), 'valor', h.v->>'valor', 'estado', h.v->>'estado') ORDER BY h.desde)
        FROM (SELECT DISTINCT ON (k.desde) k.desde, k.hasta, (SELECT y FROM jsonb_array_elements(k.valores) y WHERE y->>'codigo' = x->>'codigo') AS v
              FROM public.kpi_eq_cierres k WHERE k.frecuencia = p_frecuencia AND k.desde < r.desde ORDER BY k.desde DESC, k.version DESC LIMIT 8) h
        WHERE h.v IS NOT NULL), '[]'::jsonb) || jsonb_build_array(jsonb_build_object('desde', r.desde, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, r.desde, r.hasta), 'valor', x->>'valor', 'estado', x->>'estado'))))
      FROM jsonb_array_elements(vals) x WHERE x->>'equipo' = ANY (eq)), '[]'));
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_detalle(p_codigo text, p_desde date, p_hasta date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.kpi_eq_def; corrige boolean;
BEGIN
  SELECT * INTO d FROM public.kpi_eq_def WHERE codigo = p_codigo;
  IF d.codigo IS NULL OR NOT d.equipo = ANY (public.kpi_eq_equipos_visibles()) THEN RETURN jsonb_build_object('error', 'Sin permiso para este indicador'); END IF;
  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde OR p_hasta - p_desde > 92 THEN RETURN jsonb_build_object('error', 'Rango de fechas no válido (máximo 3 meses)'); END IF;
  corrige := public.kpi_eq_puede_corregir(d.equipo);
  RETURN jsonb_build_object('kpi', public.kpi_eq_def_json(d), 'puede_corregir', corrige,
    'filas', COALESCE((SELECT jsonb_agg(jsonb_build_object('ref', f.ref, 'fecha', f.fecha, 'etiqueta', f.etiqueta, 'num', f.num, 'den', f.den, 'con_dato', f.con_dato,
        'num_orig', f.num_orig, 'den_orig', f.den_orig, 'origen', f.origen, 'responsable_nombre', public.kpi_eq_nombre(f.responsable), 'dims', f.dims,
        'cerrado', public.kpi_eq_fecha_cerrada(p_codigo, public.kpi_eq_fecha_efectiva(p_codigo, f.fecha)),
        'puede_proponer', corrige AND f.corr_id IS NULL AND NOT public.kpi_eq_fecha_cerrada(p_codigo, public.kpi_eq_fecha_efectiva(p_codigo, f.fecha)),
        'correccion', (SELECT jsonb_build_object('id', k.id, 'estado', k.estado, 'accion', k.accion, 'motivo', k.motivo, 'detalle', k.detalle,
                         'num_nuevo', k.num_nuevo, 'den_nuevo', k.den_nuevo, 'propuesto_por_nombre', public.kpi_eq_nombre(k.propuesto_por))
                       FROM public.kpi_eq_correcciones k WHERE k.id = f.corr_id))
      ORDER BY f.fecha DESC, f.ref) FROM public.kpi_eq_filas_corr(p_codigo, p_desde, p_hasta) f), '[]'),
    'cerrado', EXISTS (SELECT 1 FROM unnest(d.frecuencias) fr WHERE (public.kpi_eq_cierre_vigente(fr, (public.kpi_eq_rango(fr, p_desde)).desde)).estado = 'CERRADO'));
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_proponer(p_codigo text, p_ref text, p_fecha date, p_accion text, p_num numeric, p_den numeric, p_motivo text, p_detalle text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.kpi_eq_def; f record; nid uuid; det text := NULLIF(left(btrim(COALESCE(p_detalle, '')), 1000), ''); v_fecha date;
BEGIN
  SELECT * INTO d FROM public.kpi_eq_def WHERE codigo = p_codigo;
  IF d.codigo IS NULL OR NOT d.equipo = ANY (public.kpi_eq_equipos_visibles()) OR NOT public.kpi_eq_puede_corregir(d.equipo) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para corregir este indicador'); END IF;
  IF p_accion IS NULL OR p_accion NOT IN ('CORREGIR','EXCLUIR') OR p_ref IS NULL OR p_fecha IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Acción no válida'); END IF;
  IF p_motivo IS NULL OR p_motivo NOT IN ('FALLA_GPS','ERROR_REGISTRO','OLVIDO_REGISTRO','DOC_MAL_CLASIFICADO','CAMBIO_CLIENTE','EXCLUIR_PRUEBA','OTRO') THEN RETURN jsonb_build_object('success', false, 'error', 'Elija el motivo de la lista'); END IF;
  IF p_motivo = 'OTRO' AND length(COALESCE(det, '')) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Con «Otro» el detalle es obligatorio'); END IF;
  IF p_accion = 'CORREGIR' AND (p_num IS NULL OR p_den IS NULL OR p_num < 0 OR p_den < 0) THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el valor corregido'); END IF;
  -- En los KPI «foto» la corrección se imputa a la foto vigente (hoy), no a la fecha que mande el cliente.
  v_fecha := public.kpi_eq_fecha_efectiva(p_codigo, p_fecha);
  -- El registro debe existir en el KPI para esa fecha: se toma el valor original desde la fuente, no desde el cliente.
  SELECT * INTO f FROM public.kpi_eq_filas(p_codigo, p_fecha, p_fecha) x WHERE x.ref = p_ref LIMIT 1;
  IF f.ref IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El registro no pertenece a este indicador en esa fecha'); END IF;
  IF p_accion = 'CORREGIR' AND f.con_dato AND f.num IS NOT DISTINCT FROM p_num AND f.den IS NOT DISTINCT FROM p_den THEN
    RETURN jsonb_build_object('success', false, 'error', 'El valor corregido es igual al original'); END IF;
  -- En un registro que cuenta como «cumple/no cumple» (den > 0) el numerador no puede superar al denominador.
  IF p_accion = 'CORREGIR' AND f.den > 0 AND p_num > p_den THEN RETURN jsonb_build_object('success', false, 'error', 'El valor corregido no puede superar al total del registro'); END IF;
  IF public.kpi_eq_fecha_cerrada(p_codigo, v_fecha) THEN RETURN jsonb_build_object('success', false, 'error', 'El periodo de este registro está cerrado; pida su reapertura'); END IF;
  BEGIN
    INSERT INTO public.kpi_eq_correcciones(codigo, ref, fecha, accion, num_orig, den_orig, con_dato_orig, num_nuevo, den_nuevo, motivo, detalle, propuesto_por)
    VALUES (p_codigo, p_ref, v_fecha, p_accion, f.num, f.den, f.con_dato,
            CASE WHEN p_accion = 'CORREGIR' THEN p_num END, CASE WHEN p_accion = 'CORREGIR' THEN p_den END, p_motivo, det, auth.uid())
    RETURNING id INTO nid;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este registro ya tiene una corrección en curso o aprobada');
  END;
  RETURN jsonb_build_object('success', true, 'id', nid);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_resolver(p_id uuid, p_aprobar boolean, p_comentario text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k public.kpi_eq_correcciones; com text := NULLIF(left(btrim(COALESCE(p_comentario, '')), 1000), '');
BEGIN
  SELECT * INTO k FROM public.kpi_eq_correcciones WHERE id = p_id FOR UPDATE;
  IF k.id IS NULL OR k.estado <> 'PROPUESTA' THEN RETURN jsonb_build_object('success', false, 'error', 'La corrección no está pendiente'); END IF;
  IF NOT public.kpi_eq_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el revisor de indicadores aprueba correcciones'); END IF;
  IF k.propuesto_por = auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'Nadie aprueba su propia corrección'); END IF;
  IF NOT p_aprobar AND com IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique por qué se rechaza'); END IF;
  IF p_aprobar AND public.kpi_eq_fecha_cerrada(k.codigo, k.fecha) THEN RETURN jsonb_build_object('success', false, 'error', 'El periodo de este registro está cerrado; reábralo antes de aprobar'); END IF;
  UPDATE public.kpi_eq_correcciones SET estado = CASE WHEN p_aprobar THEN 'APROBADA' ELSE 'RECHAZADA' END,
    resuelto_por = auth.uid(), resuelto_at = now(), comentario = com WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_anular(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k public.kpi_eq_correcciones;
BEGIN
  SELECT * INTO k FROM public.kpi_eq_correcciones WHERE id = p_id FOR UPDATE;
  IF k.id IS NULL OR k.estado <> 'PROPUESTA' THEN RETURN jsonb_build_object('success', false, 'error', 'Solo se anula una corrección pendiente'); END IF;
  IF k.propuesto_por <> auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo quien la propuso puede anularla'); END IF;
  UPDATE public.kpi_eq_correcciones SET estado = 'ANULADA', resuelto_por = auth.uid(), resuelto_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END $$;

-- Revertir una corrección aprobada por error: queda ANULADA con su motivo (no se borra) y el registro vuelve a su valor original.
CREATE OR REPLACE FUNCTION public.kpi_eq_revertir(p_id uuid, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k public.kpi_eq_correcciones; mot text := NULLIF(left(btrim(COALESCE(p_motivo, '')), 1000), '');
BEGIN
  SELECT * INTO k FROM public.kpi_eq_correcciones WHERE id = p_id FOR UPDATE;
  IF k.id IS NULL OR k.estado <> 'APROBADA' THEN RETURN jsonb_build_object('success', false, 'error', 'Solo se revierte una corrección aprobada'); END IF;
  IF NOT public.kpi_eq_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el revisor de indicadores revierte correcciones'); END IF;
  IF length(COALESCE(mot, '')) < 5 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la reversión'); END IF;
  IF public.kpi_eq_fecha_cerrada(k.codigo, k.fecha) THEN RETURN jsonb_build_object('success', false, 'error', 'El periodo de este registro está cerrado; reábralo antes de revertir'); END IF;
  UPDATE public.kpi_eq_correcciones SET estado = 'ANULADA', resuelto_por = auth.uid(), resuelto_at = now(),
    comentario = 'Revertida: ' || mot || COALESCE(' · Aprobación anterior: ' || comentario, '') WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_correcciones(p_estado text DEFAULT 'PROPUESTA') RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', k.id, 'codigo', k.codigo, 'kpi_nombre', d.nombre, 'equipo', d.equipo, 'ref', k.ref, 'fecha', k.fecha,
    'accion', k.accion, 'num_orig', k.num_orig, 'den_orig', k.den_orig, 'num_nuevo', k.num_nuevo, 'den_nuevo', k.den_nuevo, 'motivo', k.motivo, 'detalle', k.detalle,
    'estado', k.estado, 'propuesto_por_nombre', public.kpi_eq_nombre(k.propuesto_por), 'propuesto_at', k.propuesto_at,
    'resuelto_por_nombre', public.kpi_eq_nombre(k.resuelto_por), 'resuelto_at', k.resuelto_at, 'comentario', k.comentario,
    'puede_resolver', k.estado = 'PROPUESTA' AND public.kpi_eq_es_revisor() AND k.propuesto_por <> auth.uid(),
    'puede_anular', k.estado = 'PROPUESTA' AND k.propuesto_por = auth.uid(),
    'puede_revertir', k.estado = 'APROBADA' AND public.kpi_eq_es_revisor()) ORDER BY k.propuesto_at DESC), '[]')
  FROM (SELECT * FROM public.kpi_eq_correcciones x WHERE p_estado = 'TODAS' OR x.estado = p_estado ORDER BY x.propuesto_at DESC LIMIT 500) k
  JOIN public.kpi_eq_def d ON d.codigo = k.codigo
  WHERE d.equipo = ANY (public.kpi_eq_equipos_visibles()) AND (public.kpi_eq_es_revisor() OR k.propuesto_por = auth.uid());
$$;

-- Las 24 definiciones (Configuración), sin importar la frecuencia en pantalla.
CREATE OR REPLACE FUNCTION public.kpi_eq_defs() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN public.kpi_eq_es_revisor()
    THEN COALESCE((SELECT jsonb_agg(public.kpi_eq_def_json(d) || jsonb_build_object('updated_at', d.updated_at, 'updated_by_nombre', public.kpi_eq_nombre(d.updated_by)) ORDER BY d.orden) FROM public.kpi_eq_def d), '[]')
    ELSE jsonb_build_object('error', 'Solo el revisor de indicadores ve la configuración') END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_eq_guardar_def(p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it jsonb; n int := 0;
BEGIN
  IF NOT public.kpi_eq_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el revisor de indicadores edita las metas'); END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]')) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.kpi_eq_def WHERE codigo = it->>'codigo') THEN RETURN jsonb_build_object('success', false, 'error', 'KPI desconocido: ' || COALESCE(it->>'codigo', '∅')); END IF;
    IF COALESCE(it->>'estado_datos', 'ACTIVO') NOT IN ('ACTIVO','PARCIAL','PENDIENTE_CAPTURA','PENDIENTE_INTEGRACION') THEN RETURN jsonb_build_object('success', false, 'error', 'Estado de datos no válido'); END IF;
    IF (it ? 'tolerancia') AND COALESCE((it->>'tolerancia')::numeric, -1) < 0 THEN RETURN jsonb_build_object('success', false, 'error', 'La tolerancia no puede ser negativa'); END IF;
    UPDATE public.kpi_eq_def SET
      meta = CASE WHEN it ? 'meta' THEN NULLIF(it->>'meta', '')::numeric ELSE meta END,
      tolerancia = COALESCE(NULLIF(it->>'tolerancia', '')::numeric, tolerancia),
      responsable = COALESCE(NULLIF(left(btrim(it->>'responsable'), 120), ''), responsable),
      estado_datos = COALESCE(it->>'estado_datos', estado_datos),
      nota_datos = CASE WHEN it ? 'nota_datos' THEN NULLIF(left(btrim(it->>'nota_datos'), 500), '') ELSE nota_datos END,
      updated_at = now(), updated_by = auth.uid()
    WHERE codigo = it->>'codigo';
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'actualizados', n);
END $$;

-- ------------------------------------------------------------
-- 8. Enlace general compartido (solo lectura, PIN, solo periodos cerrados, sin nombres de personas)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_eq_enlace_crear(p_etiqueta text, p_equipos text[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pin text; tok uuid;
BEGIN
  IF NOT public.kpi_eq_es_revisor() THEN RAISE EXCEPTION 'Solo el revisor de indicadores comparte el enlace'; END IF;
  IF COALESCE(cardinality(p_equipos), 0) = 0 OR NOT p_equipos <@ ARRAY['TRANSPORTE','DESPACHO','INVENTARIO','AUDITORIA'] THEN RAISE EXCEPTION 'Elija los equipos a compartir'; END IF;
  pin := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 100000000)::text, 8, '0');
  INSERT INTO public.kpi_eq_enlaces(etiqueta, equipos, pin_hash, created_by)
  VALUES (NULLIF(left(btrim(COALESCE(p_etiqueta, '')), 120), ''), p_equipos, extensions.crypt(pin, extensions.gen_salt('bf', 8)), auth.uid())
  RETURNING token INTO tok;
  RETURN jsonb_build_object('token', tok, 'pin', pin);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_enlaces() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('token', e.token, 'etiqueta', e.etiqueta, 'equipos', to_jsonb(e.equipos), 'created_at', e.created_at,
    'revoked_at', e.revoked_at, 'visitas', (SELECT COALESCE(sum(v.consultas), 0) FROM public.kpi_eq_enlace_visitas v WHERE v.token = e.token),
    'ultima_visita', (SELECT max(v.ultima_at) FROM public.kpi_eq_enlace_visitas v WHERE v.token = e.token),
    'visitantes', (SELECT COALESCE(jsonb_agg(DISTINCT v.nombre), '[]') FROM public.kpi_eq_enlace_visitas v WHERE v.token = e.token)) ORDER BY e.created_at DESC), '[]')
  FROM public.kpi_eq_enlaces e WHERE public.kpi_eq_es_revisor();
$$;

CREATE OR REPLACE FUNCTION public.kpi_eq_enlace_revocar(p_token uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.kpi_eq_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  UPDATE public.kpi_eq_enlaces SET revoked_at = now(), revoked_by = auth.uid() WHERE token = p_token AND revoked_at IS NULL;
  RETURN jsonb_build_object('success', FOUND);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_eq_publico(p_token uuid, p_pin text, p_nombre text, p_frecuencia text, p_desde date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.kpi_eq_enlaces; nom text := regexp_replace(btrim(COALESCE(p_nombre, '')), '\s+', ' ', 'g'); c public.kpi_eq_cierres; per jsonb;
BEGIN
  SELECT * INTO e FROM public.kpi_eq_enlaces WHERE token = p_token FOR UPDATE;
  IF e.token IS NULL OR e.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'El enlace no existe o fue revocado'); END IF;
  IF e.attempt_window < now() - interval '15 minutes' THEN
    UPDATE public.kpi_eq_enlaces SET attempt_window = now(), attempts = 0 WHERE token = p_token; e.attempts := 0;
  END IF;
  IF e.attempts >= 10 THEN RETURN jsonb_build_object('error', 'Demasiados intentos. Espere 15 minutos.'); END IF;
  IF COALESCE(p_pin, '') = '' OR extensions.crypt(btrim(p_pin), e.pin_hash) <> e.pin_hash THEN
    UPDATE public.kpi_eq_enlaces SET attempts = attempts + 1 WHERE token = p_token;
    RETURN jsonb_build_object('error', 'Código incorrecto');
  END IF;
  IF length(nom) < 3 OR nom !~ '[[:alpha:]].*[[:alpha:]].*[[:alpha:]]' OR length(nom) > 80 THEN RETURN jsonb_build_object('error', 'Ingrese su nombre (mínimo 3 letras)'); END IF;
  IF p_frecuencia IS NULL OR p_frecuencia NOT IN ('SEMANAL','QUINCENAL','MENSUAL') THEN RETURN jsonb_build_object('error', 'Frecuencia no válida'); END IF;
  INSERT INTO public.kpi_eq_enlace_visitas(token, nombre, dia) VALUES (p_token, nom, public.kpi_eq_hoy())
  ON CONFLICT (token, nombre, dia) DO UPDATE SET consultas = public.kpi_eq_enlace_visitas.consultas + 1, ultima_at = now();
  UPDATE public.kpi_eq_enlaces SET attempts = 0 WHERE token = p_token AND attempts > 0;

  -- Solo periodos cerrados: lo que ve gerencia no cambia salvo reapertura (y entonces deja de mostrarse hasta el nuevo cierre).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', x.desde, 'hasta', x.hasta, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, x.desde, x.hasta)) ORDER BY x.desde DESC), '[]')
    INTO per FROM (SELECT DISTINCT ON (k.desde) k.desde, k.hasta, k.estado FROM public.kpi_eq_cierres k WHERE k.frecuencia = p_frecuencia
                   ORDER BY k.desde DESC, k.version DESC LIMIT 60) x WHERE x.estado = 'CERRADO';
  SELECT k.* INTO c FROM public.kpi_eq_cierres k
   WHERE k.frecuencia = p_frecuencia AND k.estado = 'CERRADO'
     AND (p_desde IS NULL OR k.desde = (public.kpi_eq_rango(p_frecuencia, p_desde)).desde)
     AND k.version = (SELECT max(z.version) FROM public.kpi_eq_cierres z WHERE z.frecuencia = k.frecuencia AND z.desde = k.desde)
   ORDER BY k.desde DESC LIMIT 1;
  RETURN jsonb_build_object('etiqueta', e.etiqueta, 'frecuencia', p_frecuencia, 'periodos', per,
    'periodo', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('desde', c.desde, 'hasta', c.hasta, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, c.desde, c.hasta), 'version', c.version, 'cerrado_at', c.cerrado_at) END,
    'kpis', COALESCE((SELECT jsonb_agg(
        (x - 'num' - 'den' - 'correcciones_pendientes' - 'corregidos' - 'responsable' - 'fuente' - 'n' - 'n_con_dato' - 'cobertura_min') || jsonb_build_object('tendencia', COALESCE((
          SELECT jsonb_agg(jsonb_build_object('desde', h.desde, 'etiqueta', public.kpi_eq_etiqueta(p_frecuencia, h.desde, h.hasta), 'valor', h.v->>'valor', 'estado', h.v->>'estado') ORDER BY h.desde)
          FROM (SELECT DISTINCT ON (k.desde) k.desde, k.hasta, k.estado, (SELECT y FROM jsonb_array_elements(k.valores) y WHERE y->>'codigo' = x->>'codigo') AS v
                FROM public.kpi_eq_cierres k WHERE k.frecuencia = p_frecuencia AND k.desde <= c.desde ORDER BY k.desde DESC, k.version DESC LIMIT 9) h
          WHERE h.estado = 'CERRADO' AND h.v IS NOT NULL), '[]'::jsonb)) ORDER BY (x->>'orden')::int)
      FROM jsonb_array_elements(c.valores) x WHERE x->>'equipo' = ANY (e.equipos)), '[]'));
END $$;

-- ------------------------------------------------------------
-- 9. Permisos de ejecución y tarea programada
-- ------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['kpi_eq_rango(text,date)','kpi_eq_etiqueta(text,date,date)','kpi_eq_vence(text,date)','kpi_eq_hoy()','kpi_eq_es_revisor()',
    'kpi_eq_equipos_visibles()','kpi_eq_cierre_vigente(text,date)','kpi_eq_fecha_cerrada(text,date)','kpi_eq_nombre(uuid)','kpi_eq_puede_corregir(text)','kpi_eq_fecha_efectiva(text,date)','kpi_eq_filas(text,date,date)',
    'kpi_eq_filas_corr(text,date,date)','kpi_eq_valor(text,date,date)','kpi_eq_def_json(public.kpi_eq_def)','kpi_eq_calcular(text,date,date)',
    'kpi_eq_cerrar_interno(text,date,uuid,text)','kpi_eq_job()','kpi_eq_tablero(text,date)','kpi_eq_detalle(text,date,date)',
    'kpi_eq_proponer(text,text,date,text,numeric,numeric,text,text)','kpi_eq_resolver(uuid,boolean,text)','kpi_eq_anular(uuid)','kpi_eq_revertir(uuid,text)','kpi_eq_correcciones(text)',
    'kpi_eq_cerrar(text,date)','kpi_eq_reabrir(text,date,text)','kpi_eq_guardar_def(jsonb)','kpi_eq_defs()','kpi_eq_enlace_crear(text,text[])','kpi_eq_enlaces()',
    'kpi_eq_enlace_revocar(uuid)','kpi_eq_publico(uuid,text,text,text,date)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['kpi_eq_tablero(text,date)','kpi_eq_detalle(text,date,date)','kpi_eq_proponer(text,text,date,text,numeric,numeric,text,text)',
    'kpi_eq_resolver(uuid,boolean,text)','kpi_eq_anular(uuid)','kpi_eq_revertir(uuid,text)','kpi_eq_correcciones(text)','kpi_eq_cerrar(text,date)','kpi_eq_reabrir(text,date,text)',
    'kpi_eq_guardar_def(jsonb)','kpi_eq_defs()','kpi_eq_enlace_crear(text,text[])','kpi_eq_enlaces()','kpi_eq_enlace_revocar(uuid)'] LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.kpi_eq_publico(uuid,text,text,text,date) TO anon, authenticated;
END $grants$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('kpi-equipos-cierre'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('kpi-equipos-cierre', '7 * * * *', $cron$SELECT public.kpi_eq_job()$cron$);  -- cada hora; no hace nada si no hay periodos vencidos
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
