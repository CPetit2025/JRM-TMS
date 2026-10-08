-- Número de despacho simple y correlativo (10001, 10002, …) en lugar de DESP-AAAAMMDD-XXXXXXXX.
--
-- 1. Secuencia public.dispatch_number_seq.
-- 2. Disparador BEFORE INSERT en dispatches: si el número llega vacío o con el formato automático
--    DESP-AAAAMMDD-XXXXXXXX (el que generan las funciones de programación), lo reemplaza por el siguiente
--    correlativo. Los números escritos a mano (otro formato) no se tocan.
-- 3. Disparador BEFORE INSERT en contract_services: las funciones de programación escriben el número
--    automático en la descripción del flete ("Flete del despacho DESP-…") después de insertar el despacho;
--    se cambia por el número definitivo del despacho vinculado.
-- 4. Renumeración de los despachos existentes con formato automático, en orden de creación. El código anterior
--    queda en dispatches.legacy_dispatch_number para búsquedas y documentos ya impresos, y se actualiza en los
--    textos de las tablas vinculadas al despacho (columna dispatch_id).
-- Los disparadores de usuario se suspenden solo durante la renumeración (no es un cambio operativo) y se
-- restauran con su estado original.

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS legacy_dispatch_number text;
COMMENT ON COLUMN public.dispatches.legacy_dispatch_number IS 'Código anterior DESP-AAAAMMDD-XXXXXXXX (antes del correlativo simple)';
CREATE INDEX IF NOT EXISTS dispatches_legacy_number_idx ON public.dispatches (legacy_dispatch_number) WHERE legacy_dispatch_number IS NOT NULL;

CREATE SEQUENCE IF NOT EXISTS public.dispatch_number_seq AS bigint START WITH 10001 MINVALUE 1;

CREATE OR REPLACE FUNCTION public.dispatch_is_auto_number(p_number text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_number IS NULL OR btrim(p_number) = '' OR p_number ~ '^DESP-[0-9]{8}-[0-9A-Fa-f]{8}$'
$$;

CREATE OR REPLACE FUNCTION public.dispatch_assign_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_number text;
BEGIN
  IF public.dispatch_is_auto_number(NEW.dispatch_number) THEN
    LOOP
      v_number := nextval('public.dispatch_number_seq')::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.dispatches WHERE dispatch_number = v_number);
    END LOOP;
    NEW.dispatch_number := v_number;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS dispatch_assign_number ON public.dispatches;
CREATE TRIGGER dispatch_assign_number BEFORE INSERT ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_assign_number();

-- Reemplaza el código automático por el número definitivo del despacho indicado.
CREATE OR REPLACE FUNCTION public.dispatch_number_in_text(p_text text, p_dispatch uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_number text;
BEGIN
  IF p_text IS NULL OR p_dispatch IS NULL OR p_text !~ 'DESP-[0-9]{8}-[0-9A-Fa-f]{8}' THEN RETURN p_text; END IF;
  SELECT dispatch_number INTO v_number FROM public.dispatches WHERE id = p_dispatch;
  IF v_number IS NULL OR public.dispatch_is_auto_number(v_number) THEN RETURN p_text; END IF;
  RETURN regexp_replace(p_text, 'DESP-[0-9]{8}-[0-9A-Fa-f]{8}', v_number, 'g');
END $$;
REVOKE ALL ON FUNCTION public.dispatch_number_in_text(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_number_in_text(text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.contract_service_dispatch_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.description := public.dispatch_number_in_text(NEW.description, NULLIF(to_jsonb(NEW) ->> 'dispatch_id', '')::uuid);
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contract_services' AND column_name = 'dispatch_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contract_services' AND column_name = 'description') THEN
    DROP TRIGGER IF EXISTS contract_service_dispatch_number ON public.contract_services;
    CREATE TRIGGER contract_service_dispatch_number BEFORE INSERT ON public.contract_services
      FOR EACH ROW EXECUTE FUNCTION public.contract_service_dispatch_number();
  END IF;
END $$;

-- Renumeración de los despachos existentes
DO $$
DECLARE
  v_base bigint; v_last bigint; r record; t record; v_tables text[]; v_tab text; v_cols text[]; v_col text;
  v_disabled text[];
BEGIN
  SELECT GREATEST(10000, COALESCE(max(dispatch_number::bigint) FILTER (WHERE dispatch_number ~ '^[0-9]{1,15}$'), 0))
    INTO v_base FROM public.dispatches;

  CREATE TEMP TABLE _dispatch_renumber ON COMMIT DROP AS
    SELECT id, dispatch_number AS old_number,
           (v_base + row_number() OVER (ORDER BY created_at NULLS LAST, id))::text AS new_number
      FROM public.dispatches
     WHERE dispatch_number ~ '^DESP-[0-9]{8}-[0-9A-Fa-f]{8}$';

  IF EXISTS (SELECT 1 FROM _dispatch_renumber) THEN
    -- 1) dispatches: sin disparadores de usuario (no es un cambio operativo); se restauran tal como estaban
    v_disabled := '{}';
    FOR t IN SELECT tg.tgname FROM pg_trigger tg WHERE tg.tgrelid = 'public.dispatches'::regclass AND NOT tg.tgisinternal AND tg.tgenabled <> 'D' LOOP
      EXECUTE format('ALTER TABLE public.dispatches DISABLE TRIGGER %I', t.tgname);
      v_disabled := v_disabled || t.tgname::text;
    END LOOP;
    UPDATE public.dispatches d
       SET legacy_dispatch_number = m.old_number, dispatch_number = m.new_number
      FROM _dispatch_renumber m WHERE d.id = m.id;
    FOREACH v_col IN ARRAY v_disabled LOOP
      EXECUTE format('ALTER TABLE public.dispatches ENABLE TRIGGER %I', v_col);
    END LOOP;

    -- 2) Textos que copiaron el código anterior en tablas vinculadas al despacho (columna dispatch_id uuid).
    --    Cada tabla va en su propio bloque: si una no se puede actualizar, se avisa y se sigue.
    SELECT array_agg(DISTINCT k.table_name::text) INTO v_tables
      FROM information_schema.columns k
      JOIN information_schema.tables tb ON tb.table_schema = k.table_schema AND tb.table_name = k.table_name AND tb.table_type = 'BASE TABLE'
     WHERE k.table_schema = 'public' AND k.table_name <> 'dispatches' AND k.column_name = 'dispatch_id' AND k.udt_name = 'uuid';

    FOREACH v_tab IN ARRAY COALESCE(v_tables, '{}') LOOP
      SELECT array_agg(c.column_name::text) INTO v_cols FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = v_tab AND c.data_type IN ('text', 'character varying');
      CONTINUE WHEN v_cols IS NULL;
      BEGIN
        v_disabled := '{}';
        FOR t IN SELECT tg.tgname FROM pg_trigger tg WHERE tg.tgrelid = format('public.%I', v_tab)::regclass AND NOT tg.tgisinternal AND tg.tgenabled <> 'D' LOOP
          EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', v_tab, t.tgname);
          v_disabled := v_disabled || t.tgname::text;
        END LOOP;
        FOREACH v_col IN ARRAY v_cols LOOP
          EXECUTE format('UPDATE public.%1$I x SET %2$I = replace(x.%2$I, m.old_number, m.new_number)
                            FROM _dispatch_renumber m
                           WHERE x.dispatch_id = m.id AND x.%2$I LIKE ''%%DESP-%%'' AND strpos(x.%2$I, m.old_number) > 0',
                         v_tab, v_col);
        END LOOP;
        FOREACH v_col IN ARRAY v_disabled LOOP
          EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', v_tab, v_col);
        END LOOP;
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Número de despacho: no se actualizaron los textos de % (%)', v_tab, SQLERRM;
      END;
    END LOOP;
  END IF;

  SELECT GREATEST(10000, COALESCE(max(dispatch_number::bigint) FILTER (WHERE dispatch_number ~ '^[0-9]{1,15}$'), 0))
    INTO v_last FROM public.dispatches;
  PERFORM setval('public.dispatch_number_seq', v_last, true);
END $$;
