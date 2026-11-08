-- Regla no negociable: la bandeja de Recepción y etiquetado (/almacen/etiquetado) muestra solo ingresos pendientes de
-- etiquetar. Un ingreso con etiquetas completas (MATCH) o con diferencia (DIFFERENCE: ya etiquetado; se corrige
-- anulando en Control de recepción, y entonces vuelve) no sale ni buscándolo. Quedan NOT_LABELED y PENDING_PRINT
-- (etiquetas generadas sin imprimir: el etiquetado no terminó).
-- La consulta completa pasa a wh_receipt_candidates_all (sin acceso directo) y wh_receipt_candidates la filtra, para
-- no copiar aquí la consulta (staging y producción tienen versiones distintas).
-- Si una migración futura vuelve a definir la consulta, debe hacerlo sobre wh_receipt_candidates_all, no sobre esta.
BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.wh_receipt_candidates_all(text)') IS NULL THEN
  ALTER FUNCTION public.wh_receipt_candidates(text) RENAME TO wh_receipt_candidates_all;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.wh_receipt_candidates_all(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wh_receipt_candidates_all(text) TO service_role;

CREATE OR REPLACE FUNCTION public.wh_receipt_candidates(p_query text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(r ORDER BY n), '[]'::jsonb)
 FROM jsonb_array_elements(public.wh_receipt_candidates_all(p_query)) WITH ORDINALITY AS t(r, n)
 WHERE r->>'label_status' IN ('NOT_LABELED', 'PENDING_PRINT');
$$;
REVOKE ALL ON FUNCTION public.wh_receipt_candidates(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_candidates(text) TO authenticated, service_role;
COMMIT;
