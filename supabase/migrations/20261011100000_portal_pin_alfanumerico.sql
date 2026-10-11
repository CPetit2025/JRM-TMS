-- Portal público de seguimiento: el código de acceso pasa a 4 caracteres alfanuméricos (como el de los
-- conductores externos). Sin caracteres que se confunden (0/O, 1/I/L); mayúsculas y minúsculas valen igual.
-- Los PIN de 8 dígitos ya entregados siguen sirviendo hasta que se roten. Se mantiene el límite de intentos.
BEGIN;

CREATE FUNCTION public.portal_pin_generate() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path=public, pg_temp AS $$
DECLARE alphabet constant text:='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; pin text:=''; b integer;
BEGIN
 WHILE length(pin)<4 LOOP
  b:=get_byte(extensions.gen_random_bytes(1),0);
  IF b<248 THEN pin:=pin||substr(alphabet,b%31+1,1); END IF; -- 248 = 8×31: sin sesgo
 END LOOP;
 RETURN pin;
END $$;
REVOKE ALL ON FUNCTION public.portal_pin_generate() FROM PUBLIC,anon,authenticated;

DO $patch$
DECLARE f record; v_def text; generated integer:=0; checked integer:=0;
 old_gen constant text:='lpad(((''x''||substr(replace(gen_random_uuid()::text,''-'',''''),1,8))::bit(32)::bigint % 100000000)::text,8,''0'')';
 old_check constant text:='length(p_pin)<>8 OR extensions.crypt(p_pin,link.pin_hash)<>link.pin_hash';
 new_check constant text:='length(trim(p_pin)) NOT IN (4,8) OR extensions.crypt(upper(trim(p_pin)),link.pin_hash)<>link.pin_hash';
BEGIN
 FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (position(old_gen IN p.prosrc)>0 OR position(old_check IN p.prosrc)>0) LOOP
  v_def:=pg_get_functiondef(f.oid);
  IF position(old_gen IN v_def)>0 THEN generated:=generated+1; v_def:=replace(v_def,old_gen,'public.portal_pin_generate()'); END IF;
  IF position(old_check IN v_def)>0 THEN checked:=checked+1; v_def:=replace(v_def,old_check,new_check); END IF;
  EXECUTE v_def;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND position('portal_pin_generate()' IN prosrc)>0 AND proname<>'portal_pin_generate')
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND position(new_check IN prosrc)>0) THEN
  RAISE EXCEPTION 'Portal público: no se reconoció la generación o la validación del PIN (generación %, validación %)',generated,checked;
 END IF;
END $patch$;
COMMIT;
