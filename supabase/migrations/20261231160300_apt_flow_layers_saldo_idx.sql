-- menu_pending_counts (cada página) suma el saldo en ST VENTAS: recorría ~29 mil capas de ST para quedarse con ~760 con saldo.
-- Índice parcial solo de capas con saldo: 22-620 ms -> 0,4 ms (medido en producción).
CREATE INDEX IF NOT EXISTS apt_flow_layers_saldo_idx ON public.apt_flow_layers (almacen, fecha) INCLUDE (kg_saldo) WHERE kg_saldo > 0;
