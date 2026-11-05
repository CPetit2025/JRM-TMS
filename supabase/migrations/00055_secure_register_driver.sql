-- The legacy register_driver RPC can attach a driver's identity based on DNI.
-- Keep it inaccessible to browser sessions after the old RPC migration runs.
REVOKE ALL ON FUNCTION public.register_driver(uuid,text,text,text,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_driver(uuid,text,text,text,text,text,text,uuid)
  TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.register_driver(character varying,character varying,character varying,character varying,character varying,character varying,character varying,date)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.register_driver(varchar,varchar,varchar,varchar,varchar,varchar,varchar,date) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;
