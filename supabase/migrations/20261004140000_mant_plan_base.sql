-- 20261004140000_mant_plan_base.sql
-- Plan de mantenimiento — Fase 1: relaciona el gasto histórico con Flota y Mantenimiento.
--
-- * Catálogo de sistemas (mant_sistemas) y clasificación del gasto del Excel por sistema (fe_maint.sistema).
-- * Montacargas y equipos de elevación registrados en Flota (vehicles) con su horómetro del historial, y vinculados
--   a su ficha de Eficiencia de Flota. No se crean ni modifican unidades de transporte: solo se informa su vínculo.
-- * Plantillas de plan preventivo por familia (mant_plan_templates), con frecuencias de fabricante y de campo
--   (docs/plan-mantenimiento.md), y la familia de cada unidad (mant_asset_familia). Los planes se cargan en la Fase 2.
-- * Historial único por unidad (mant_historial): Excel hasta su último registro y OT del sistema después, fallas,
--   lecturas y checklists de turno.
-- * Turno del operario (mant_turnos): horómetro al iniciar turno y checklist (pre-uso de montacargas, semanal de
--   elevadores). Un ítem crítico en falla crea la falla en maintenance_requests (fuente única de fallas).
-- * Aviso de fallas: el disparador de notificaciones apuntaba a vehicle_failures (eliminada en producción);
--   ahora escucha maintenance_requests.
-- Todo lo que lee tablas existentes es defensivo (to_regclass, to_jsonb) porque producción difiere del repo.

BEGIN;

-- ------------------------------------------------------------
-- 1. Sistemas y clasificación del gasto
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mant_sistemas (
  code text PRIMARY KEY,
  nombre text NOT NULL,
  orden integer NOT NULL
);
INSERT INTO public.mant_sistemas (code, nombre, orden) VALUES
  ('MOTOR', 'Motor y lubricación', 1), ('TRANSMISION', 'Caja, embrague y diferencial', 2), ('FRENOS', 'Frenos', 3),
  ('SUSPENSION', 'Suspensión y dirección', 4), ('LLANTAS', 'Llantas y alineamiento', 5), ('HIDRAULICO', 'Hidráulico y mástil', 6),
  ('BATERIAS', 'Baterías y carga', 7), ('ELECTRICO', 'Sistema eléctrico', 8), ('REFRIGERACION', 'Refrigeración', 9),
  ('COMBUSTIBLE', 'Combustible y GLP', 10), ('CARROCERIA', 'Carrocería y plataforma', 11),
  ('SERVICIOS', 'Lavado, seguridad y certificaciones', 12), ('OTROS', 'Otros', 13)
ON CONFLICT (code) DO UPDATE SET nombre = EXCLUDED.nombre, orden = EXCLUDED.orden;

-- El orden de las reglas importa: primero lo que identifica al sistema sin ambigüedad (baterías, servicio de motor),
-- luego los sistemas mecánicos y al final lo genérico. Sin coincidencia se usa la categoría del Excel.
CREATE OR REPLACE FUNCTION public.mant_sistema(p_detalle text, p_categoria text DEFAULT NULL)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN d ~ 'BATER|AGUA (DESTILADA|ACIDULADA)|CARGADOR' THEN 'BATERIAS'
    WHEN d ~ 'ACEITE (DE |DEL |PARA )?(MOTOR|MONTACARGA)|CAMBIO DE ACEITE|FILTROS? DE ACEITE|AFINAMIENTO|REPARACI[OÓ]N DE MOTOR|RECTIFICAD|C[AÁ]RTER|DISTRIBUCI[OÓ]N' THEN 'MOTOR'
    WHEN d ~ 'CAJA|CORONA|DIFERENCIAL|EMBRAG|EMNBRAG|COLLAR[IÍ]N|TRANSMISI|CARD[AÁ]N|PALIER|ARTICULACI[OÓ]N DE CAMBIOS|PALANCA DE MARCHA|\mSHIFT\M' THEN 'TRANSMISION'
    WHEN d ~ 'HIDR[AÁ]UL|MANGUERA|CILINDRO|M[AÁ]STIL|MARTIL|CADENA|HORQUILLA|V[AÁ]LVULA DE LEVANTE' THEN 'HIDRAULICO'
    WHEN d ~ 'LLANTA|NEUM[AÁ]TIC|ALINEAM|REENCAUCH|C[AÁ]MARA DE AIRE|[0-9]{3}/[0-9]{2} ?R ?[0-9]{2}' THEN 'LLANTAS'
    WHEN d ~ 'FRENO|ZAPATA|PASTILLA|TAMBOR|BOMB[IÍ]N|SECADOR DE AIRE' THEN 'FRENOS'
    WHEN d ~ 'MUELLE|MUIELLE|RESORTE|AMORTIGU|SUSPENSI|TERMINAL|R[OÓ]TULA|DIRECCI[OÓ]N|BOCAMASA|RODAJE|RODAMIENTO|ESTABILIZADORA|ABRAZADERA' THEN 'SUSPENSION'
    WHEN d ~ 'RADIADOR|REFRIGERANTE|TERMOSTATO|BOMBA DE AGUA' THEN 'REFRIGERACION'
    WHEN d ~ '\mGLP\M|\mGAS\M|COMBUSTIBLE|CONVERTIDOR|BAL[OÓ]N|CARBURADOR|INYECT' THEN 'COMBUSTIBLE'
    WHEN d ~ 'MOTOR|FILTRO|BUJ[IÍ]A|CULATA|TURBO|FAJA|CORREA|UREA|ESCANEO|ENGRAS|GRASA' THEN 'MOTOR'
    WHEN d ~ 'EL[EÉ]CTRIC|FOCO|ALTERNADOR|ARRANCADOR|CABLE|FUSIBLE|SENSOR|TABLERO|LUCES|FARO|ALARMA|CLAXON|RELAY|REL[EÉ]\M|JOYSTICK|CONECTOR|M[OÓ]DULO|ELECTRO ?V[AÁ]LVULA|S[EO]L[EO]NOIDE|SOLONOIDE|BOBINA|CHAPA DE CONTACTO|INDICADOR|REVOLUCIONES|BENDIX' THEN 'ELECTRICO'
    WHEN d ~ 'CARROCER|PLATAFORMA|BARANDA|PUERTA|PINTUR|PLANCH|SOLDA|ESTRUCTURA|CHASIS|VIDRIO|ESPEJO|ASIENTO|TOLD|CARRETA' THEN 'CARROCERIA'
    WHEN d ~ 'LAVADO|ENCERADO|BOTIQU|EXTINTOR|CERTIFIC|REVISI[OÓ]N T[EÉ]CNICA|SOAT|HOMOLOG|GPS|TAC[OÓ]GRAFO|CONO|CHALECO' THEN 'SERVICIOS'
    WHEN c ~ 'MOTOR' THEN 'MOTOR'
    WHEN c ~ 'BATER' THEN 'BATERIAS'
    WHEN c ~ 'EL[EÉ]CTRIC' THEN 'ELECTRICO'
    WHEN c ~ 'HIDR' THEN 'HIDRAULICO'
    WHEN c ~ 'LLANTA|NEUM' THEN 'LLANTAS'
    WHEN c ~ 'FRENO' THEN 'FRENOS'
    WHEN c ~ 'RUTINARIO' THEN 'MOTOR'
    WHEN c ~ 'CARROCER' THEN 'CARROCERIA'
    WHEN c ~ 'SEGURIDAD|SERVICIO' THEN 'SERVICIOS'
    ELSE 'OTROS' END
  FROM (SELECT upper(COALESCE(p_detalle, '')) AS d, upper(COALESCE(p_categoria, '')) AS c) z;
$$;

ALTER TABLE public.fe_maint ADD COLUMN IF NOT EXISTS sistema text;
UPDATE public.fe_maint SET sistema = public.mant_sistema(detalle, categoria) WHERE sistema IS NULL;

-- Las cargas futuras del Excel también quedan clasificadas
CREATE OR REPLACE FUNCTION public.mant_fe_maint_sistema()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sistema IS NULL THEN NEW.sistema := public.mant_sistema(NEW.detalle, NEW.categoria); END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mant_fe_maint_sistema ON public.fe_maint;
CREATE TRIGGER mant_fe_maint_sistema BEFORE INSERT ON public.fe_maint FOR EACH ROW EXECUTE FUNCTION public.mant_fe_maint_sistema();

-- ------------------------------------------------------------
-- 2. Familias y plantillas de plan preventivo
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mant_familias (
  code text PRIMARY KEY,
  nombre text NOT NULL,
  lectura text NOT NULL CHECK (lectura IN ('KM', 'HORAS', 'CALENDARIO')),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ítems del checklist del operario: [{id, texto, critico}]
  checklist_frecuencia text CHECK (checklist_frecuencia IN ('TURNO', 'SEMANAL')),
  orden integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.mant_plan_templates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  familia text NOT NULL REFERENCES public.mant_familias(code) ON DELETE CASCADE,
  servicio text NOT NULL,
  frecuencia_km integer, frecuencia_horas integer, frecuencia_dias integer,
  tareas jsonb NOT NULL DEFAULT '[]'::jsonb,
  sistema text REFERENCES public.mant_sistemas(code),
  fuente text,
  activo boolean NOT NULL DEFAULT true,
  UNIQUE (familia, servicio),
  CHECK (COALESCE(frecuencia_km, frecuencia_horas, frecuencia_dias) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.mant_asset_familia (
  vehicle_id uuid PRIMARY KEY,
  familia text NOT NULL REFERENCES public.mant_familias(code),
  nota text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.mant_familias (code, nombre, lectura, checklist_frecuencia, orden, checklist) VALUES
  ('PESADO_DIESEL', 'Camión diésel (Hino serie 500)', 'KM', NULL, 1, '[]'),
  ('TRACTO', 'Tracto con caja Eaton Fuller', 'KM', NULL, 2, '[]'),
  ('SEMIRREMOLQUE', 'Semirremolque / plataforma', 'KM', NULL, 3, '[]'),
  ('CAMION_ANTIGUO', 'Camión diésel de más de 15 años', 'KM', NULL, 4, '[]'),
  ('LIVIANO', 'Liviano a gasolina o GLP', 'KM', NULL, 5, '[]'),
  ('MONTACARGA_IC', 'Montacargas a combustión (GLP o gasolina)', 'HORAS', 'TURNO', 6, '[
    {"id":"aceite","texto":"Nivel de aceite de motor y refrigerante","critico":false},
    {"id":"fugas","texto":"Sin fugas de aceite, hidráulico ni combustible","critico":false},
    {"id":"glp","texto":"Balón de GLP y conexiones sin olor a gas","critico":true},
    {"id":"frenos","texto":"Freno de servicio y de parqueo funcionan","critico":true},
    {"id":"direccion","texto":"Dirección sin juego excesivo","critico":true},
    {"id":"horquillas","texto":"Horquillas, cadenas y mástil sin daño","critico":true},
    {"id":"luces","texto":"Luces, claxon y alarma de retroceso","critico":false},
    {"id":"llantas","texto":"Llantas sin cortes ni desgaste excesivo","critico":false},
    {"id":"cinturon","texto":"Cinturón de seguridad y asiento","critico":false}]'),
  ('ELEVACION_ELECTRICA', 'Plataforma de tijera / apilador eléctrico', 'CALENDARIO', 'SEMANAL', 7, '[
    {"id":"agua","texto":"Nivel de agua de baterías (después de cargar)","critico":false},
    {"id":"carga","texto":"Baterías cargan completo; cargador y bornes sin sulfato","critico":false},
    {"id":"fugas","texto":"Sin fugas hidráulicas en cilindros y mangueras","critico":false},
    {"id":"bajada","texto":"Bajada de emergencia funciona","critico":true},
    {"id":"paro","texto":"Paro de emergencia funciona","critico":true},
    {"id":"barandas","texto":"Barandas, puerta y pasadores completos","critico":true},
    {"id":"controles","texto":"Controles y joystick responden","critico":false},
    {"id":"alarmas","texto":"Alarmas de inclinación y movimiento","critico":false},
    {"id":"llantas","texto":"Llantas y estructura sin daño","critico":false}]')
ON CONFLICT (code) DO UPDATE SET nombre = EXCLUDED.nombre, lectura = EXCLUDED.lectura, checklist = EXCLUDED.checklist,
  checklist_frecuencia = EXCLUDED.checklist_frecuencia, orden = EXCLUDED.orden;

INSERT INTO public.mant_plan_templates (familia, servicio, frecuencia_km, frecuencia_horas, frecuencia_dias, sistema, tareas, fuente) VALUES
  ('PESADO_DIESEL', 'Servicio A', 7500, NULL, 90, 'MOTOR', '["Aceite de motor CK-4 15W-40 y filtro de aceite","Filtro de combustible y drenaje del separador","Engrase de chasis","Inspección de frenos, llantas, luces y nivel de urea","Muestra de aceite para análisis (primeros 4 servicios)"]',
     'Hino: 10.000 km en uso normal, primer control a 5.000 km en uso severo. Reparto urbano en Lima = severo; 7.500 km con análisis de aceite para validar.'),
  ('PESADO_DIESEL', 'Servicio B', 15000, NULL, 180, 'MOTOR', '["Servicio A","Filtro de aire primario y secundario","Ajuste de frenos","Rotación de llantas"]', 'Hino serie 500'),
  ('PESADO_DIESEL', 'Servicio C', 60000, NULL, 365, 'TRANSMISION', '["Servicio B","Aceite de caja y de corona/diferencial","Refrigerante","Embrague y escaneo de la unidad"]', 'Hino serie 500'),
  ('TRACTO', 'Servicio A', 10000, NULL, 90, 'MOTOR', '["Aceite de motor CK-4 y filtros de aceite y combustible","Engrase de quinta rueda y chasis","Nivel de aceite de caja (Eaton: revisar cada 4.000 km)","Inspección de frenos de aire, llantas y luces","Análisis de aceite"]',
     'Motor diésel pesado: 15.000–30.000 km en carretera; uso urbano exigente se acorta. Confirmar marca del motor.'),
  ('TRACTO', 'Servicio B', 30000, NULL, 180, 'MOTOR', '["Servicio A","Filtros de aire primario y secundario","Cartucho del secador de aire","Ajuste de frenos"]', 'Práctica de flota pesada'),
  ('TRACTO', 'Caja y diferencial', 150000, NULL, 730, 'TRANSMISION', '["Aceite de caja Eaton Fuller (sintético PS-386)","Aceite de diferencial","Limpieza de tapones magnéticos"]',
     'Eaton Fuller: sintético 290.000 km o 3 años en uso vocacional; se adopta 150.000 km o 2 años.'),
  ('SEMIRREMOLQUE', 'Servicio trimestral', 10000, NULL, 90, 'FRENOS', '["Zapatas y tambores","Engrase de rodajes y de la placa de la quinta rueda","Luces, conectores y cintas reflectivas","Llantas"]', 'Práctica de flota pesada'),
  ('SEMIRREMOLQUE', 'Servicio anual', NULL, NULL, 365, 'SUSPENSION', '["Rodamientos y retenes de ejes","Suspensión y muelles","Estructura y plataforma"]', 'Práctica de flota pesada'),
  ('CAMION_ANTIGUO', 'Servicio A', 5000, NULL, 60, 'MOTOR', '["Aceite de motor 15W-40 y filtro","Engrase","Inspección de frenos, llantas y luces"]', 'Motor de más de 15 años: se mantiene 5.000 km'),
  ('CAMION_ANTIGUO', 'Servicio B', 10000, NULL, 120, 'MOTOR', '["Servicio A","Filtros de aire y combustible","Ajuste de frenos"]', 'VW Delivery/Worker'),
  ('CAMION_ANTIGUO', 'Servicio C', 40000, NULL, 365, 'TRANSMISION', '["Aceite de caja y diferencial","Refrigerante","Embrague"]', 'VW Delivery/Worker'),
  ('LIVIANO', 'Servicio A', 5000, NULL, 180, 'MOTOR', '["Aceite y filtro de motor","Inspección de frenos, luces y llantas"]', 'JAC Perú y concesionarios: cada 5.000 km o 6 meses'),
  ('LIVIANO', 'Servicio B', 10000, NULL, 365, 'MOTOR', '["Servicio A","Filtros de aire y combustible","Kit de GLP (filtro y regulación) si aplica","Rotación de llantas"]', 'JAC Perú / Toyota'),
  ('LIVIANO', 'Servicio C', 20000, NULL, 730, 'FRENOS', '["Bujías","Líquido de frenos y pastillas","Alineamiento y balanceo"]', 'JAC Perú / Toyota'),
  ('MONTACARGA_IC', 'Servicio 250 h', NULL, 250, 45, 'MOTOR', '["Aceite y filtro de motor","Engrase de mástil, cadenas y rodaje","Agua de batería","Inspección de frenos, horquillas y mangueras"]',
     'Fabricantes de montacargas a GLP/gasolina: 250 h. No adelantar el cambio: hoy varios equipos cambian antes de 200 h.'),
  ('MONTACARGA_IC', 'Servicio 500 h', NULL, 500, 90, 'MOTOR', '["Servicio 250 h","Filtros de aire y combustible, bujías","Cadenas: tensión y desgaste","Rodillos del carro, cilindros de elevación e inclinación"]', 'Programa 250/500/1.000/2.000 h'),
  ('MONTACARGA_IC', 'Servicio 1.000 h', NULL, 1000, 180, 'HIDRAULICO', '["Servicio 500 h","Filtro hidráulico","Aceite de transmisión","Líquido de frenos","Mangueras hidráulicas (segundo sistema con más correctivo)"]', 'Transmisión: 1.000–1.200 h'),
  ('MONTACARGA_IC', 'Servicio 2.000 h', NULL, 2000, 365, 'HIDRAULICO', '["Servicio 1.000 h","Aceite hidráulico","Refrigerante","Inspección anual de seguridad"]', 'Aceite hidráulico: 2.000 h'),
  ('ELEVACION_ELECTRICA', 'Mensual', NULL, NULL, 30, 'BATERIAS', '["Carga de igualación","Limpieza de bornes y densidad de celdas","Bajada y paro de emergencia","Nivel y estado del aceite hidráulico"]', 'Baterías: agua semanal, prueba mensual'),
  ('ELEVACION_ELECTRICA', 'Trimestral', NULL, NULL, 90, 'HIDRAULICO', '["Inspección frecuente (ANSI A92: cada 3 meses)","Sellos y mangueras","Escaneo de códigos y sistema eléctrico","Pasadores y tijeras"]', 'ANSI A92.22/24'),
  ('ELEVACION_ELECTRICA', 'Anual', NULL, NULL, 365, 'SERVICIOS', '["Inspección anual y certificación","Cambio de aceite hidráulico y filtro","Prueba de carga"]', 'ANSI A92: inspección anual')
ON CONFLICT (familia, servicio) DO UPDATE SET frecuencia_km = EXCLUDED.frecuencia_km, frecuencia_horas = EXCLUDED.frecuencia_horas,
  frecuencia_dias = EXCLUDED.frecuencia_dias, sistema = EXCLUDED.sistema, tareas = EXCLUDED.tareas, fuente = EXCLUDED.fuente;

ALTER TABLE public.mant_sistemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mant_familias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mant_plan_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mant_asset_familia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mant_sistemas_read ON public.mant_sistemas;
CREATE POLICY mant_sistemas_read ON public.mant_sistemas FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mant_familias_read ON public.mant_familias;
CREATE POLICY mant_familias_read ON public.mant_familias FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mant_plan_templates_read ON public.mant_plan_templates;
CREATE POLICY mant_plan_templates_read ON public.mant_plan_templates FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mant_asset_familia_read ON public.mant_asset_familia;
CREATE POLICY mant_asset_familia_read ON public.mant_asset_familia FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mant_sistemas, public.mant_familias, public.mant_plan_templates, public.mant_asset_familia TO authenticated;

-- ------------------------------------------------------------
-- 3. Montacargas y elevadores en Flota
-- ------------------------------------------------------------
-- Bitácora de la puesta en marcha (la prueba C30 la informa después del despliegue)
CREATE TABLE IF NOT EXISTS public.mant_setup_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  paso text NOT NULL,
  detalle text
);
ALTER TABLE public.mant_setup_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r record; v_carrier uuid; v_vid uuid; v_hours numeric; v_has_hours boolean; v_has_cap boolean;
BEGIN
  IF to_regclass('public.vehicles') IS NULL THEN RETURN; END IF;
  v_has_hours := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'current_hours');
  v_has_cap := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicles' AND column_name = 'weight_capacity');
  BEGIN
    EXECUTE $q$SELECT id FROM public.carriers ORDER BY (upper(COALESCE(type::text, '')) = 'PROPIO') DESC, created_at NULLS LAST LIMIT 1$q$ INTO v_carrier;
  EXCEPTION WHEN OTHERS THEN v_carrier := NULL; END;

  FOR r IN SELECT * FROM (VALUES
      ('UN FORKLIFT 3TN NN01', 'NN01', 'MONTACARGAS', 'UN Forklift', 'Montacargas 3 t', 2018, 3000, 'MONTACARGA_IC'),
      ('UN FORKLIFT 3TN NN02', 'NN02', 'MONTACARGAS', 'UN Forklift', 'Montacargas 3 t', 2018, 3000, 'MONTACARGA_IC'),
      ('UN FORKLIFT 5TN NN03', 'NN03', 'MONTACARGAS', 'UN Forklift', 'Montacargas 5 t', 2019, 5000, 'MONTACARGA_IC'),
      ('UN FORKLIFT 5TN NN04', 'NN04', 'MONTACARGAS', 'UN Forklift', 'Montacargas 5 t', 2019, 5000, 'MONTACARGA_IC'),
      ('CLARK 4TN', 'CLARK 4TN', 'MONTACARGAS', 'Clark', 'Montacargas 4 t', 2009, 4000, 'MONTACARGA_IC'),
      ('CLARK 5TN', 'CLARK 5TN', 'MONTACARGAS', 'Clark', 'Montacargas 5 t', 2012, 5000, 'MONTACARGA_IC'),
      ('HANGZHOU 3.5TN', 'HANGZHOU 3.5TN', 'MONTACARGAS', 'Hangzhou', 'Montacargas 3,5 t', 2011, 3500, 'MONTACARGA_IC'),
      ('SCISSOR LIFT N1 MANTALL XE 140', 'TIJERA N1', 'OTRO', 'Mantall', 'Plataforma de tijera XE140W', 2013, NULL, 'ELEVACION_ELECTRICA'),
      ('SCISSOR LIFT N2 MANTALL XE 140', 'TIJERA N2', 'OTRO', 'Mantall', 'Plataforma de tijera XE140W', 2013, NULL, 'ELEVACION_ELECTRICA'),
      ('SCISSOR LIFT N5 MANTALL XE 140', 'TIJERA N5', 'OTRO', 'Mantall', 'Plataforma de tijera XE140W', 2016, NULL, 'ELEVACION_ELECTRICA'),
      ('SCISSOR LIFT N6 MANTALL XE 140', 'TIJERA N6', 'OTRO', 'Mantall', 'Plataforma de tijera XE140W', 2016, NULL, 'ELEVACION_ELECTRICA'),
      ('APILADOR BT REFLEX', 'APILADOR BT', 'APILADOR', 'BT (Toyota)', 'Apilador eléctrico Reflex', 2012, NULL, 'ELEVACION_ELECTRICA')
    ) AS x(code, plate, tipo, marca, modelo, anio, cap, familia)
  LOOP
    BEGIN
      v_vid := NULL;
      -- ¿Ya está en Flota? (vínculo de Eficiencia de Flota, misma placa/código o el código del Excel como placa o código interno)
      SELECT a.vehicle_id INTO v_vid FROM public.fe_assets a WHERE a.code = r.code AND a.vehicle_id IS NOT NULL;
      IF v_vid IS NULL THEN
        EXECUTE $q$SELECT id FROM public.vehicles WHERE upper(plate) IN (upper($1), upper($2))
                   OR upper(COALESCE(to_jsonb(vehicles) ->> 'internal_code', '')) IN (upper($1), upper($2)) LIMIT 1$q$
          INTO v_vid USING r.plate, r.code;
      END IF;
      IF v_vid IS NULL THEN
        IF v_carrier IS NULL THEN
          INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('equipo', r.code || ': sin transportista propio, no se registró');
          CONTINUE;
        END IF;
        -- Horómetro inicial: la última lectura del historial
        SELECT m.km_hrs INTO v_hours FROM public.fe_maint m WHERE m.asset_code = r.code AND m.km_hrs > 0 ORDER BY m.fecha DESC NULLS LAST, m.id DESC LIMIT 1;
        EXECUTE 'INSERT INTO public.vehicles (plate, carrier_id, type, brand, model, year) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id'
          INTO v_vid USING r.plate, v_carrier, r.tipo, r.marca, r.modelo, r.anio;
        IF v_has_hours AND v_hours IS NOT NULL THEN
          EXECUTE 'UPDATE public.vehicles SET current_hours = $1 WHERE id = $2' USING v_hours, v_vid;
        END IF;
        IF v_has_cap AND r.cap IS NOT NULL THEN
          EXECUTE 'UPDATE public.vehicles SET weight_capacity = $1 WHERE id = $2' USING r.cap, v_vid;
        END IF;
        INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('equipo', r.code || ': registrado como ' || r.plate || COALESCE(' (' || v_hours || ' h)', ''));
      ELSE
        INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('equipo', r.code || ': ya estaba en Flota');
      END IF;
      UPDATE public.fe_assets SET vehicle_id = v_vid, vehicle_plate = COALESCE(vehicle_plate, r.plate)
      WHERE code = r.code AND vehicle_id IS NULL;
      INSERT INTO public.mant_asset_familia (vehicle_id, familia) VALUES (v_vid, r.familia) ON CONFLICT (vehicle_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('equipo', r.code || ': error ' || SQLERRM);
    END;
  END LOOP;
END $$;

-- Familia de las unidades de transporte: por placa conocida y, si no, por tipo de Flota
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.vehicles') IS NULL THEN RETURN; END IF;
  FOR r IN EXECUTE $q$SELECT v.id, public.fe_code(v.plate) AS k, upper(COALESCE(v.type::text, '')) AS t, v.year
                      FROM public.vehicles v WHERE v.id NOT IN (SELECT vehicle_id FROM public.mant_asset_familia)$q$ LOOP
    BEGIN
      INSERT INTO public.mant_asset_familia (vehicle_id, familia, nota) VALUES (r.id,
        CASE WHEN r.k IN ('BDJ 943', 'BDK 791') THEN 'PESADO_DIESEL'
             WHEN r.k = 'BCW 838' OR r.t = 'TRACTO' THEN 'TRACTO'
             WHEN r.k = 'ARB 976' OR r.t IN ('SEMIRREMOLQUE', 'TRAILER') THEN 'SEMIRREMOLQUE'
             WHEN r.k = 'F3R 838' THEN 'CAMION_ANTIGUO'
             WHEN r.t IN ('MONTACARGAS') THEN 'MONTACARGA_IC'
             WHEN r.t IN ('APILADOR', 'TRANSPALETA') THEN 'ELEVACION_ELECTRICA'
             WHEN r.t = 'CAMION' AND r.year IS NOT NULL AND r.year <= extract(year FROM now()) - 15 THEN 'CAMION_ANTIGUO'
             WHEN r.t = 'CAMION' THEN 'PESADO_DIESEL'
             WHEN r.t IN ('CAMIONETA', 'FURGON') THEN 'LIVIANO'
             ELSE NULL END, 'automática')
      ON CONFLICT (vehicle_id) DO NOTHING;
    EXCEPTION WHEN not_null_violation THEN NULL;   -- tipo sin familia: se asigna a mano
    END;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Turno del operario: horómetro y checklist
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mant_turnos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  vehicle_id uuid NOT NULL,
  vehicle_plate text NOT NULL,
  profile_id uuid NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('TURNO', 'SEMANAL')),
  horas numeric CHECK (horas IS NULL OR horas >= 0),
  estado_lectura text NOT NULL DEFAULT 'SIN_LECTURA' CHECK (estado_lectura IN ('VALIDADA', 'POR_VALIDAR', 'SIN_LECTURA')),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, texto, critico, ok, obs}]
  observaciones text,
  fallas integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mant_turnos_vehicle_idx ON public.mant_turnos (vehicle_id, created_at DESC);
ALTER TABLE public.mant_turnos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mant_turnos_read ON public.mant_turnos;
CREATE POLICY mant_turnos_read ON public.mant_turnos FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('mantenimiento-fallas'));
GRANT SELECT ON public.mant_turnos TO authenticated;

-- Equipos que el operario puede registrar, con su checklist y si toca el semanal
CREATE OR REPLACE FUNCTION public.mant_equipos_turno()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_items jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  EXECUTE $q$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'vehicle_id', v.id, 'plate', v.plate, 'codigo', to_jsonb(v) ->> 'internal_code', 'modelo', concat_ws(' ', v.brand, v.model),
      'familia', f.code, 'familia_nombre', f.nombre, 'lectura', f.lectura,
      'checklist', f.checklist, 'checklist_frecuencia', f.checklist_frecuencia,
      'horas', NULLIF(to_jsonb(v) ->> 'current_hours', '')::numeric,
      'ultimo_turno', (SELECT max(t.created_at) FROM public.mant_turnos t WHERE t.vehicle_id = v.id),
      'ultimo_semanal', (SELECT max(t.created_at) FROM public.mant_turnos t WHERE t.vehicle_id = v.id AND t.tipo = 'SEMANAL'),
      'semanal_pendiente', f.checklist_frecuencia = 'SEMANAL' AND NOT EXISTS (
        SELECT 1 FROM public.mant_turnos t WHERE t.vehicle_id = v.id AND t.tipo = 'SEMANAL' AND t.created_at > now() - interval '7 days'))
      ORDER BY f.orden, v.plate), '[]')
    FROM public.vehicles v
    JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
    JOIN public.mant_familias f ON f.code = af.familia
    WHERE f.checklist_frecuencia IS NOT NULL
      AND upper(COALESCE(to_jsonb(v) ->> 'status', '')) <> 'FUERA_DE_SERVICIO'$q$ INTO v_items;
  RETURN jsonb_build_object('success', true, 'equipos', v_items);
END $$;

-- Registra el turno. Horómetro: no retrocede; un salto mayor al posible (16 h por día desde la última lectura,
-- mínimo 24 h) queda POR_VALIDAR y no mueve el horómetro de la unidad (un dígito de más bloquearía las lecturas
-- siguientes). Ítem crítico en falla → falla CRÍTICA en maintenance_requests (la unidad se bloquea por el motor F2).
CREATE OR REPLACE FUNCTION public.mant_registrar_turno(p_vehicle_id uuid, p_horas numeric DEFAULT NULL,
  p_checklist jsonb DEFAULT '[]'::jsonb, p_observaciones text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v record; f record; v_actual numeric; v_last timestamptz; v_max numeric;
  v_estado text := 'SIN_LECTURA'; v_tipo text; v_items jsonb := '[]'::jsonb; it jsonb; x jsonb; v_fallas int := 0;
  v_desc text; v_sev text; v_id bigint; v_msg text := NULL; v_activo boolean; v_n int;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  BEGIN
    EXECUTE 'SELECT COALESCE((to_jsonb(p) ->> ''is_active'')::boolean, true) FROM public.profiles p WHERE p.id = $1' INTO v_activo USING v_uid;
  EXCEPTION WHEN OTHERS THEN v_activo := true; END;
  IF v_activo IS NOT TRUE THEN RETURN jsonb_build_object('success', false, 'error', 'Usuario inactivo'); END IF;

  EXECUTE 'SELECT id, plate, NULLIF(to_jsonb(vehicles) ->> ''current_hours'', '''')::numeric AS horas, COALESCE(NULLIF(to_jsonb(vehicles) ->> ''current_odometer'', '''')::numeric, 0) AS odo FROM public.vehicles WHERE id = $1 FOR UPDATE'
    INTO v USING p_vehicle_id;
  IF v.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Equipo no registrado'); END IF;
  SELECT fa.* INTO f FROM public.mant_asset_familia af JOIN public.mant_familias fa ON fa.code = af.familia
  WHERE af.vehicle_id = v.id AND fa.checklist_frecuencia IS NOT NULL;
  IF f.code IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El equipo no tiene checklist de operario'); END IF;
  v_tipo := CASE WHEN f.checklist_frecuencia = 'SEMANAL' THEN 'SEMANAL' ELSE 'TURNO' END;

  IF f.lectura = 'HORAS' AND p_horas IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registra el horómetro');
  END IF;
  IF p_horas IS NOT NULL THEN
    IF p_horas < 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El horómetro no puede ser negativo'); END IF;
    v_actual := COALESCE(v.horas, 0);
    IF p_horas < v_actual THEN
      RETURN jsonb_build_object('success', false, 'error', 'El horómetro no puede ser menor a ' || v_actual || ' h. Si se cambió el horómetro, avisa a Mantenimiento.');
    END IF;
    SELECT max(t.created_at) INTO v_last FROM public.mant_turnos t WHERE t.vehicle_id = v.id AND t.estado_lectura = 'VALIDADA';
    v_max := v_actual + GREATEST(24, 16 * CEIL(EXTRACT(epoch FROM now() - COALESCE(v_last, now() - interval '30 days')) / 86400.0));
    IF p_horas > v_max THEN
      v_estado := 'POR_VALIDAR';
      v_msg := 'Lectura guardada para validar: el salto desde ' || v_actual || ' h es mayor a lo posible. Mantenimiento la revisará.';
    ELSE
      v_estado := 'VALIDADA';
      EXECUTE 'UPDATE public.vehicles SET current_hours = $1 WHERE id = $2' USING p_horas, v.id;
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicle_odometer_logs' AND column_name = 'hours_value') THEN
          EXECUTE 'INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, hours_value, source_event, status, notes, created_by) VALUES ($1, $2, $3, ''TURNO_OPERARIO'', ''VALIDADO'', ''Horómetro al iniciar turno'', $4)'
            USING v.plate, v.odo, p_horas, v_uid;
        END IF;
      EXCEPTION WHEN OTHERS THEN NULL;   -- la bitácora de lecturas es informativa; el turno guarda la lectura
      END;
    END IF;
  END IF;

  -- Checklist: se arma desde la plantilla de la familia (el cliente solo marca ok/obs)
  FOR it IN SELECT * FROM jsonb_array_elements(f.checklist) LOOP
    SELECT e INTO x FROM jsonb_array_elements(COALESCE(p_checklist, '[]'::jsonb)) e WHERE e ->> 'id' = it ->> 'id' LIMIT 1;
    v_items := v_items || jsonb_build_object('id', it ->> 'id', 'texto', it ->> 'texto', 'critico', COALESCE((it ->> 'critico')::boolean, false),
      'ok', COALESCE((x ->> 'ok')::boolean, true), 'obs', NULLIF(btrim(COALESCE(x ->> 'obs', '')), ''));
  END LOOP;

  INSERT INTO public.mant_turnos (vehicle_id, vehicle_plate, profile_id, tipo, horas, estado_lectura, checklist, observaciones)
  VALUES (v.id, v.plate, v_uid, v_tipo, p_horas, v_estado, v_items, NULLIF(btrim(COALESCE(p_observaciones, '')), ''))
  RETURNING id INTO v_id;

  -- Ítems en falla → maintenance_requests (una por ítem y día: índice único de la tabla)
  FOR it IN SELECT * FROM jsonb_array_elements(v_items) WHERE (value ->> 'ok')::boolean = false LOOP
    v_sev := CASE WHEN (it ->> 'critico')::boolean THEN 'CRITICA' ELSE 'MEDIA' END;
    v_desc := 'Checklist de ' || lower(CASE WHEN v_tipo = 'SEMANAL' THEN 'semana' ELSE 'turno' END) || ': ' || (it ->> 'texto') || COALESCE(' — ' || (it ->> 'obs'), '');
    BEGIN
      IF to_regclass('public.maintenance_requests') IS NOT NULL THEN
        EXECUTE 'INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status, source, reported_by, notes) VALUES ($1, $2, $3, ''REPORTADA'', ''INSPECCION'', $4, $5) ON CONFLICT DO NOTHING'
          USING v.plate, v_desc, v_sev, v_uid, 'Turno ' || v_id || ' (horómetro ' || COALESCE(p_horas::text, '-') || ')';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_fallas := v_fallas + v_n;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('turno', 'Turno ' || v_id || ': no se registró la falla: ' || SQLERRM);
    END;
  END LOOP;
  UPDATE public.mant_turnos SET fallas = v_fallas WHERE id = v_id AND v_fallas > 0;

  RETURN jsonb_build_object('success', true, 'id', v_id, 'estado_lectura', v_estado, 'fallas', v_fallas, 'aviso', v_msg);
END $$;

-- ------------------------------------------------------------
-- 5. Historial único por unidad
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_historial(p_plate text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; v_key text := public.fe_code(p_plate); v_codes text[]; v_corte date; v_fam record; r jsonb := '{}'::jsonb;
  v_has_ot boolean := to_regclass('public.maintenance_work_orders') IS NOT NULL AND to_regclass('public.work_order_costs') IS NOT NULL;
BEGIN
  IF NOT (public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('mantenimiento-ot')
          OR public.menu_has_permission('mantenimiento-finanzas') OR public.fe_can_view()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso');
  END IF;
  EXECUTE 'SELECT id, plate FROM public.vehicles WHERE upper(plate) = upper($1) OR public.fe_code(plate) = $2 LIMIT 1' INTO v USING btrim(p_plate), v_key;
  SELECT array_agg(a.code) INTO v_codes FROM public.fe_assets a
  WHERE (v.id IS NOT NULL AND a.vehicle_id = v.id) OR a.code = v_key OR public.fe_code(a.vehicle_plate) = v_key;
  v_codes := COALESCE(v_codes, ARRAY[v_key]);
  SELECT max(m.fecha) INTO v_corte FROM public.fe_maint m WHERE m.asset_code = ANY (v_codes);

  CREATE TEMP TABLE IF NOT EXISTS mh (fecha date, fuente text, tipo text, sistema text, monto numeric, detalle text, proveedor text, lectura numeric, ref text) ON COMMIT DROP;
  TRUNCATE mh;
  INSERT INTO mh SELECT m.fecha, 'Historial (Excel)',
      CASE COALESCE(m.tipo_real, public.fe_tipo_real(m.tipo, m.categoria, m.detalle)) WHEN 'NEUMATICOS' THEN 'PREVENTIVO' ELSE COALESCE(m.tipo_real, public.fe_tipo_real(m.tipo, m.categoria, m.detalle)) END,
      COALESCE(m.sistema, public.mant_sistema(m.detalle, m.categoria)), m.monto, m.detalle, m.proveedor, m.km_hrs, m.factura
    FROM public.fe_maint m WHERE m.asset_code = ANY (v_codes) AND m.fecha IS NOT NULL AND m.fecha > DATE '1990-01-01';
  IF v.id IS NOT NULL AND v_has_ot THEN
    BEGIN
      EXECUTE $q$INSERT INTO mh
        SELECT COALESCE(NULLIF(to_jsonb(o) ->> 'completed_at', '')::timestamptz, NULLIF(to_jsonb(o) ->> 'start_date', '')::timestamptz, NULLIF(to_jsonb(o) ->> 'created_at', '')::timestamptz)::date,
               'OT del sistema',
               CASE WHEN upper(COALESCE(to_jsonb(o) ->> 'type', to_jsonb(o) ->> 'maintenance_type', '')) ~ 'PREVENT' THEN 'PREVENTIVO'
                    WHEN upper(COALESCE(to_jsonb(o) ->> 'type', to_jsonb(o) ->> 'maintenance_type', '')) ~ 'MEJORA' THEN 'MEJORA' ELSE 'CORRECTIVO' END,
               COALESCE(NULLIF(to_jsonb(o) ->> 'sistema', ''), public.mant_sistema(to_jsonb(o) ->> 'description', NULL)),
               (SELECT COALESCE(sum(c.amount), 0) FROM public.work_order_costs c WHERE c.work_order_id = o.id),
               to_jsonb(o) ->> 'description', NULL,
               NULLIF(to_jsonb(o) ->> 'odometer_at_start', '')::numeric,
               COALESCE(to_jsonb(o) ->> 'ot_code', to_jsonb(o) ->> 'ot_number')
        FROM public.maintenance_work_orders o
        WHERE (to_jsonb(o) ->> 'vehicle_id' = $1::text OR upper(COALESCE(to_jsonb(o) ->> 'vehicle_plate', '')) = upper($2))
          AND upper(COALESCE(to_jsonb(o) ->> 'status', '')) NOT IN ('CANCELADA', 'ANULADA')$q$ USING v.id, v.plate;
      -- Sin doble conteo: lo cubierto por el Excel no se repite con las OT
      DELETE FROM mh WHERE fuente = 'OT del sistema' AND v_corte IS NOT NULL AND fecha <= v_corte;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  SELECT f.code, f.nombre INTO v_fam FROM public.mant_asset_familia af JOIN public.mant_familias f ON f.code = af.familia WHERE af.vehicle_id = v.id;

  r := jsonb_build_object('success', true, 'plate', COALESCE(v.plate, p_plate), 'vehicle_id', v.id, 'corte_excel', v_corte,
    'familia', v_fam.code, 'familia_nombre', v_fam.nombre,
    'total', (SELECT COALESCE(sum(monto), 0) FROM mh),
    'ultimos_12m', (SELECT jsonb_build_object('monto', COALESCE(sum(monto), 0),
        'correctivo', COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0),
        'pct_correctivo', round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)))
      FROM mh WHERE fecha > (SELECT max(fecha) FROM mh) - 365),
    'por_anio', (SELECT COALESCE(jsonb_agg(jsonb_build_object('anio', a, 'preventivo', p, 'correctivo', c, 'mejora', m) ORDER BY a), '[]') FROM (
        SELECT extract(year FROM fecha)::int AS a, round(sum(monto) FILTER (WHERE tipo = 'PREVENTIVO')) AS p,
               round(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO')) AS c, round(sum(monto) FILTER (WHERE tipo = 'MEJORA')) AS m
        FROM mh GROUP BY 1) z),
    'por_sistema', (SELECT COALESCE(jsonb_agg(jsonb_build_object('sistema', z.sistema, 'nombre', s.nombre, 'monto', z.monto, 'correctivo', z.corr, 'n', z.n) ORDER BY z.monto DESC), '[]') FROM (
        SELECT sistema, round(sum(monto)) AS monto, round(COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0)) AS corr, count(*) AS n FROM mh GROUP BY 1) z
        LEFT JOIN public.mant_sistemas s ON s.code = z.sistema),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(z) ORDER BY z.fecha DESC), '[]') FROM (SELECT * FROM mh ORDER BY fecha DESC LIMIT 300) z),
    'plan', (SELECT COALESCE(jsonb_agg(jsonb_build_object('servicio', t.servicio, 'km', t.frecuencia_km, 'horas', t.frecuencia_horas, 'dias', t.frecuencia_dias,
               'tareas', t.tareas, 'fuente', t.fuente) ORDER BY COALESCE(t.frecuencia_km, t.frecuencia_horas * 40, t.frecuencia_dias * 100)), '[]')
             FROM public.mant_plan_templates t WHERE t.familia = v_fam.code AND t.activo),
    'turnos', (SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', t.created_at, 'tipo', t.tipo, 'horas', t.horas, 'estado', t.estado_lectura, 'fallas', t.fallas,
               'observaciones', t.observaciones, 'no_ok', (SELECT jsonb_agg(e ->> 'texto') FROM jsonb_array_elements(t.checklist) e WHERE (e ->> 'ok')::boolean = false)) ORDER BY t.created_at DESC), '[]')
             FROM (SELECT * FROM public.mant_turnos WHERE vehicle_id = v.id ORDER BY created_at DESC LIMIT 15) t));
  RETURN r;
END $$;

-- ------------------------------------------------------------
-- 6. Aviso de fallas desde la fuente única (maintenance_requests)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.maintenance_requests') IS NOT NULL AND to_regprocedure('public.notif_trg_falla()') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS notif_falla ON public.maintenance_requests;
    CREATE TRIGGER notif_falla AFTER INSERT ON public.maintenance_requests FOR EACH ROW EXECUTE FUNCTION public.notif_trg_falla();
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.mant_equipos_turno() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_registrar_turno(uuid, numeric, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_historial(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mant_equipos_turno() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_registrar_turno(uuid, numeric, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_historial(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
