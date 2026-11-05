-- C55: toda FK necesita un índice válido y no parcial que la cubra. F1 (20261226090000) y F3 (20261226100000)
-- dejaron siete FK sin cobertura (algunas solo con índice parcial). Solo índices; no toca datos.
CREATE INDEX IF NOT EXISTS audit_findings_dispatch_idx ON public.audit_findings(dispatch_id);
CREATE INDEX IF NOT EXISTS audit_finding_corrections_submitted_by_idx ON public.audit_finding_corrections(submitted_by);
CREATE INDEX IF NOT EXISTS audit_finding_corrections_validated_by_idx ON public.audit_finding_corrections(validated_by);
CREATE INDEX IF NOT EXISTS audit_finding_evidence_uploaded_by_idx ON public.audit_finding_evidence(uploaded_by);
CREATE INDEX IF NOT EXISTS audit_finding_evidence_voided_by_idx ON public.audit_finding_evidence(voided_by);
CREATE INDEX IF NOT EXISTS audit_finding_release_exceptions_finding_idx ON public.audit_finding_release_exceptions(finding_id);
CREATE INDEX IF NOT EXISTS audit_finding_release_exceptions_dispatch_idx ON public.audit_finding_release_exceptions(dispatch_id);
