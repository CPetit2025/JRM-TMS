-- C181: modal de Documentos — categoría de archivo y contexto del modal instalados y protegidos.
BEGIN;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_documents' AND column_name='category')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='dispatch_documents_category_check') THEN
  RAISE EXCEPTION 'CAJA C181 FAIL: falta la categoría de archivo';
 END IF;
 IF EXISTS(SELECT 1 FROM public.dispatch_documents WHERE category IS NOT NULL AND doc_type <> 'OTRO') THEN
  RAISE EXCEPTION 'CAJA C181 FAIL: categoría en un documento que no es «Otro»';
 END IF;
 IF to_regprocedure('public.dispatch_documents_modal_context(uuid)') IS NULL OR to_regprocedure('public.set_dispatch_document_category(uuid,text)') IS NULL
  OR has_function_privilege('anon','public.dispatch_documents_modal_context(uuid)','EXECUTE')
  OR has_function_privilege('anon','public.set_dispatch_document_category(uuid,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C181 FAIL: funciones del modal ausentes o con acceso anónimo';
 END IF;
 RAISE EXCEPTION 'CAJA C181 PASS: categoría de archivo y contexto del modal protegidos';
END $$;
ROLLBACK;
