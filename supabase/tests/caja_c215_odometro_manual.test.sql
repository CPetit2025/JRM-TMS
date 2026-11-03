-- C215: el odómetro de la parada y del checklist se registra por ingreso manual, sin foto obligatoria, y conserva
-- las marcas de coherencia (retroceso / salto). Usa una placa real dentro de la transacción. Siempre se revierte.
BEGIN;
DO $$
DECLARE v_plate text; r public.unit_odometer_readings; base numeric; v_err text;
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'unit_odometer_readings'
     AND column_name = 'photo_path' AND is_nullable = 'NO') THEN v_err := 'photo_path sigue siendo obligatorio'; END IF;
 IF v_err IS NULL AND position('Adjunte la foto del tablero' IN pg_get_functiondef(
     'public.delivery_submit_driver_with_odometer(uuid,uuid,text[],text,text,text,uuid,timestamptz,numeric,text)'::regprocedure)) > 0 THEN
  v_err := 'la parada aún exige foto del odómetro'; END IF;
 -- Cerrar jornada envía p_photo NULL: la función solo delega en unit_odometer_record
 IF v_err IS NULL AND pg_get_functiondef('public.close_driver_workday(uuid,text,text,timestamptz)'::regprocedure) ~* '(p_photo IS NULL|foto)' THEN
  v_err := 'close_driver_workday aún exige foto'; END IF;
 IF v_err IS NULL AND position('inicial con foto' IN pg_get_functiondef('public.start_dispatch_route(uuid,numeric,numeric)'::regprocedure)) > 0 THEN
  v_err := 'el inicio sin GPS aún pide foto'; END IF;

 SELECT plate INTO v_plate FROM public.vehicles WHERE plate IS NOT NULL ORDER BY plate LIMIT 1;
 IF v_err IS NULL AND v_plate IS NULL THEN v_err := 'no hay unidades para probar'; END IF;
 IF v_err IS NULL THEN
  BEGIN
   base := COALESCE((SELECT odometer FROM public.unit_odometer_readings WHERE vehicle_plate = v_plate ORDER BY captured_at DESC LIMIT 1), 1000);
   r := public.unit_odometer_record(gen_random_uuid(), v_plate, NULL, (now() AT TIME ZONE 'America/Lima')::date, 'INICIO',
     (base + 10)::text, NULL, now() + interval '1 day', gen_random_uuid(), NULL);
   IF r.photo_path IS NOT NULL OR r.odometer <> round(base + 10, 1) OR r.flag IS NOT NULL THEN v_err := 'lectura manual mal registrada'; END IF;
   r := public.unit_odometer_record(gen_random_uuid(), v_plate, NULL, (now() AT TIME ZONE 'America/Lima')::date, 'INICIO',
     base::text, NULL, now() + interval '2 day', gen_random_uuid(), NULL);
   IF r.flag IS DISTINCT FROM 'RETROCESO' THEN v_err := 'retroceso sin marcar: ' || COALESCE(r.flag, 'NULL'); END IF;
  EXCEPTION WHEN OTHERS THEN v_err := 'unit_odometer_record: ' || SQLERRM;
  END;
 END IF;

 IF v_err IS NOT NULL THEN RAISE EXCEPTION 'CAJA C215 FAIL: %', v_err; END IF;
 RAISE EXCEPTION 'CAJA C215 PASS: odómetro manual sin foto en parada y checklist (placa %), retroceso marcado', v_plate;
END $$;
ROLLBACK;
