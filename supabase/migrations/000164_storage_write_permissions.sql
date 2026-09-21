BEGIN;

-- These legacy buckets serve existing public URLs, but anonymous clients may not alter files.
DROP POLICY IF EXISTS "Allow public deletes" ON storage.objects;
DROP POLICY IF EXISTS "Allow public updates" ON storage.objects;
DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects;
DROP POLICY IF EXISTS "Permitir subida a anon en evidence" ON storage.objects;

CREATE POLICY signatures_staff_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'signatures' AND public.has_tms_permission('usuarios'));
CREATE POLICY signatures_staff_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'signatures' AND public.has_tms_permission('usuarios'))
  WITH CHECK (bucket_id = 'signatures' AND public.has_tms_permission('usuarios'));
CREATE POLICY signatures_staff_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'signatures' AND public.has_tms_permission('usuarios'));

COMMIT;
