-- Production audit: zero operational orphan rows. Derived APT caches and historical
-- profiles without auth accounts are intentionally excluded; neither data nor audit history is removed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
DO $$ DECLARE r record; v_child regclass; v_parent regclass; v_col smallint; v_orphans bigint; v_name text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('driver_documents','driver_id','drivers','id'),
 ('maintenance_plans','mant_template_id','mant_plan_templates','id'),
 ('lease_usage_records','vehicle_id','vehicles','id'),
 ('lease_gps_days','vehicle_id','vehicles','id'),
 ('fe_assets','vehicle_id','vehicles','id'),
 ('trip_advances','maintenance_request_id','maintenance_requests','id'),
 ('kpi_dispatch_log','dispatch_id','dispatches','id'),
 ('kpi_reprogramaciones','request_id','transport_requests','id'),
 ('maintenance_invoices','proveedor_id','maintenance_providers','id'),
 ('driver_preuse_inspections','site_id','sites','id'),
 ('dispatch_cargos','dispatch_id','dispatches','id'),
 ('contract_budget_adjustments','budget_id','contract_budgets','id'),
 ('contract_budget_adjustments','contract_id','contracts','id'),
 ('mant_asset_familia','vehicle_id','vehicles','id'),
 ('desempeno_informes','user_id','profiles','id'),
 ('freight_rates','client_id','clients','id'),
 ('freight_rates','contract_id','contracts','id'),
 ('transport_unloading_costs','contract_id','contracts','id'),
 ('transport_unloading_costs','contract_service_id','contract_services','id'),
 ('transport_unloading_costs','expense_id','dispatch_expenses','id'),
 ('mant_turnos','vehicle_id','vehicles','id'),
 ('mant_turnos','profile_id','profiles','id'),
 ('kpi_historial','user_id','profiles','id'),
 ('maintenance_request_events','request_id','maintenance_requests','id'),
 ('soporte_informes','user_id','profiles','id'),
 ('notification_reads','user_id','profiles','id'),
 ('notif_prefs','user_id','profiles','id'),
 ('dispatch_tercero_entregas','transport_request_id','transport_requests','id')
 ) links(child,col,parent,parent_col) LOOP
  v_child:=to_regclass('public.'||r.child); v_parent:=to_regclass('public.'||r.parent);
  IF v_child IS NULL OR v_parent IS NULL THEN RAISE EXCEPTION 'La relación %.% no coincide con el esquema inspeccionado',r.child,r.col; END IF;
  SELECT attnum INTO v_col FROM pg_attribute WHERE attrelid=v_child AND attname=r.col AND NOT attisdropped;
  IF v_col IS NULL THEN RAISE EXCEPTION 'Columna ausente %.%',r.child,r.col; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=v_child AND contype='f' AND conkey=ARRAY[v_col]) THEN CONTINUE; END IF;
  EXECUTE format('SELECT count(*) FROM %s c WHERE c.%I IS NOT NULL AND NOT EXISTS(SELECT 1 FROM %s p WHERE p.%I=c.%I)',v_child,r.col,v_parent,r.parent_col,r.col) INTO v_orphans;
  IF v_orphans>0 THEN RAISE EXCEPTION 'Relación %.% con % referencias huérfanas; se requiere reconciliación sin borrar datos',r.child,r.col,v_orphans; END IF;
  v_name:='security_ref_'||left(r.child,25)||'_'||substr(md5(r.child||'.'||r.col),1,10);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY(%I) REFERENCES %s(%I) NOT VALID',v_child,v_name,r.col,v_parent,r.parent_col);
  EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I',v_child,v_name);
 END LOOP;
END $$;

-- An FK does not automatically create a child index in PostgreSQL. Add only missing
-- nonpartial leading-key coverage; existing equivalent/composite indexes are reused.
DO $$ DECLARE r record; v_cols text; v_name text;
BEGIN
 FOR r IN SELECT c.conrelid,c.conkey,c.conrelid::regclass AS tbl FROM pg_constraint c
 JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'
 ORDER BY c.conrelid,cardinality(c.conkey) DESC LOOP
  IF EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=r.conrelid AND i.indisvalid AND i.indpred IS NULL
    AND (i.indkey::smallint[])[0:cardinality(r.conkey)-1] @> r.conkey) THEN CONTINUE; END IF;
  SELECT string_agg(quote_ident(a.attname),',' ORDER BY k.ord) INTO v_cols
  FROM unnest(r.conkey) WITH ORDINALITY k(att,ord) JOIN pg_attribute a ON a.attrelid=r.conrelid AND a.attnum=k.att;
  v_name:='security_fk_'||left(r.tbl::text,25)||'_'||substr(md5(r.tbl::text||':'||v_cols),1,10);
  EXECUTE format('CREATE INDEX %I ON %s(%s)',v_name,r.tbl,v_cols);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
