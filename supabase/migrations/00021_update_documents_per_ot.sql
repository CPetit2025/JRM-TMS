-- Mover los campos de documento del despacho general a cada solicitud (OT)

-- 1. Eliminar los campos de la tabla dispatches si existen (de la migración 00019)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dispatches' AND column_name='document_type') THEN
        ALTER TABLE dispatches DROP COLUMN document_type;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dispatches' AND column_name='document_number') THEN
        ALTER TABLE dispatches DROP COLUMN document_number;
    END IF;
END $$;

-- 2. Añadir los campos a la tabla intermedia dispatch_requests
ALTER TABLE dispatch_requests
ADD COLUMN document_type VARCHAR(20) DEFAULT 'GR', -- 'GR' o 'NOTA_SALIDA'
ADD COLUMN document_number VARCHAR(50);
