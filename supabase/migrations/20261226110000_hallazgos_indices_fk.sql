-- Los índices parciales de hallazgos abiertos no cubren las FK de las filas
-- cerradas. Completar sus índices de apoyo conserva el control global C55.
-- No modifica hallazgos, permisos ni reglas de salida.
BEGIN;
CREATE INDEX IF NOT EXISTS audit_findings_dispatch_idx ON public.audit_findings(dispatch_id);
CREATE INDEX IF NOT EXISTS audit_finding_corrections_submitted_by_idx ON public.audit_finding_corrections(submitted_by);
CREATE INDEX IF NOT EXISTS audit_finding_corrections_validated_by_idx ON public.audit_finding_corrections(validated_by);
CREATE INDEX IF NOT EXISTS audit_finding_evidence_uploaded_by_idx ON public.audit_finding_evidence(uploaded_by);
CREATE INDEX IF NOT EXISTS audit_finding_evidence_voided_by_idx ON public.audit_finding_evidence(voided_by);
CREATE INDEX IF NOT EXISTS audit_finding_release_exceptions_finding_idx ON public.audit_finding_release_exceptions(finding_id);
CREATE INDEX IF NOT EXISTS audit_finding_release_exceptions_dispatch_idx ON public.audit_finding_release_exceptions(dispatch_id);
COMMIT;
