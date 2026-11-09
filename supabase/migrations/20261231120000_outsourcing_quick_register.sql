-- Alta rápida desde la asignación de tercerización: Compras registra el proveedor (con la categoría del servicio)
-- o su conductor/operador sin salir del modal. Las políticas de suppliers exigen permisos de maestros que Compras
-- no siempre tiene; esta función valida el permiso de Compras y los mismos formatos de la tabla.
-- p con supplier_id → registra personal de ese proveedor; sin supplier_id → registra el proveedor.
BEGIN;
CREATE OR REPLACE FUNCTION public.outsourcing_quick_register(p_service text, p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v uuid; cat text; s suppliers; doc text := btrim(coalesce(p->>'document_number',''));
BEGIN
 IF NOT has_tms_permission('compras-tercerizaciones') THEN RAISE EXCEPTION 'Sin permiso para registrar proveedores de tercerización'; END IF;
 cat := CASE p_service WHEN 'FLETE' THEN 'TRANSPORTE' WHEN 'MONTACARGAS' THEN 'MONTACARGA' WHEN 'GRUA' THEN 'GRUA' WHEN 'ESTIBA' THEN 'ESTIBA' WHEN 'STOCKA' THEN 'SERVICIOS' WHEN 'OTROS' THEN 'SERVICIOS' END;
 IF cat IS NULL THEN RAISE EXCEPTION 'Servicio inválido'; END IF;
 IF nullif(p->>'supplier_id','') IS NOT NULL THEN
  SELECT * INTO s FROM suppliers WHERE id=(p->>'supplier_id')::uuid AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Seleccione un proveedor activo antes de registrar su personal'; END IF;
  -- Mismas categorías que acepta outsourcing_assignment_save: no se registra personal de proveedores comerciales.
  IF NOT s.category=ANY(CASE p_service WHEN 'FLETE' THEN ARRAY['TRANSPORTE'] WHEN 'GRUA' THEN ARRAY['GRUA','SERVICIOS'] WHEN 'MONTACARGAS' THEN ARRAY['MONTACARGA','SERVICIOS'] WHEN 'ESTIBA' THEN ARRAY['ESTIBA','SERVICIOS'] ELSE ARRAY['TRANSPORTE','GRUA','MONTACARGA','ESTIBA','SERVICIOS'] END) THEN
   RAISE EXCEPTION 'El proveedor % (categoría %) no corresponde a este servicio',s.business_name,s.category;
  END IF;
  IF length(btrim(coalesce(p->>'full_name','')))<3 THEN RAISE EXCEPTION 'Registre el nombre completo del conductor u operador'; END IF;
  IF doc !~ '^[0-9A-Za-z-]{8,15}$' THEN RAISE EXCEPTION 'Registre un documento de identidad válido (8 a 15 caracteres)'; END IF;
  IF EXISTS(SELECT 1 FROM supplier_personnel WHERE supplier_id=s.id AND document_number=doc) THEN RAISE EXCEPTION 'El documento % ya está registrado para %',doc,s.business_name; END IF;
  INSERT INTO supplier_personnel(supplier_id,full_name,document_number,position,phone,license_number,license_expiration)
  VALUES(s.id,btrim(p->>'full_name'),doc,CASE WHEN p_service='FLETE' THEN 'Conductor' ELSE 'Operador' END,
   nullif(btrim(coalesce(p->>'phone','')),''),nullif(btrim(coalesce(p->>'license_number','')),''),nullif(p->>'license_expiration','')::date)
  RETURNING id INTO v;
 ELSE
  IF coalesce(p->>'tax_id','') !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'Registre un RUC de 11 dígitos'; END IF;
  IF length(btrim(coalesce(p->>'business_name','')))<3 THEN RAISE EXCEPTION 'Registre la razón social'; END IF;
  SELECT * INTO s FROM suppliers WHERE tax_id=p->>'tax_id';
  IF FOUND THEN RAISE EXCEPTION 'El RUC ya está registrado: % (categoría %). Actualícelo en Maestros > Proveedores.',s.business_name,s.category||CASE WHEN s.is_active THEN '' ELSE ', inactivo' END; END IF;
  INSERT INTO suppliers(tax_id,business_name,category,contact_name,contact_phone,contact_email)
  VALUES(p->>'tax_id',upper(btrim(p->>'business_name')),cat,nullif(btrim(coalesce(p->>'contact_name','')),''),
   nullif(btrim(coalesce(p->>'contact_phone','')),''),nullif(btrim(coalesce(p->>'contact_email','')),''))
  RETURNING id INTO v;
 END IF;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.outsourcing_quick_register(text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.outsourcing_quick_register(text,jsonb) TO authenticated;
COMMIT;
