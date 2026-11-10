-- Bultos etiquetados antes del correlativo por lote (código PKG-…): pasan al siguiente número de la serie de
-- su lote (lote-B-0001…), en orden de creación. Los bultos ya numerados no cambian.
-- Solo bultos sin tarea ni LPN (aún no despachados). El código anterior queda en wh_scan_events (RECODE);
-- como lo ejecuta el sistema, el operador registrado es quien creó el bulto.
-- Idempotente: una segunda ejecución no encuentra códigos PKG- pendientes.
DO $$
DECLARE p public.wh_packages%ROWTYPE; v_new text;
BEGIN
  FOR p IN SELECT * FROM public.wh_packages
            WHERE package_code LIKE 'PKG-%' AND status <> 'VOID' AND task_id IS NULL AND lpn_id IS NULL
            ORDER BY created_at, package_code
            FOR UPDATE
  LOOP
    v_new := public.wh_next_bulto_code(p.source_lot);
    UPDATE public.wh_packages SET package_code = v_new WHERE id = p.id;
    INSERT INTO public.wh_scan_events(site_id, package_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (p.site_id, p.id, 'RECODE', p.package_code,
            jsonb_build_object('action', 'RECODE', 'previous_code', p.package_code, 'new_code', v_new,
                               'reason', 'Correlativo de bulto por lote: reimprimir la etiqueta', 'executed_by', 'migración del sistema'),
            coalesce(auth.uid(), p.created_by), gen_random_uuid());
  END LOOP;
END $$;
