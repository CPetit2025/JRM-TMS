-- 1. Tabla de Ubicaciones Autorizadas para Geocercas (Checklist)
CREATE TABLE IF NOT EXISTS public.authorized_locations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  address text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  radius_km double precision NOT NULL DEFAULT 0.5,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Insertar Planta Chilca por defecto
INSERT INTO public.authorized_locations (name, address, latitude, longitude, radius_km, is_active)
VALUES ('Planta Chilca', 'Panamericana Sur Km 62', -12.5204, -76.7371, 0.5, true)
ON CONFLICT DO NOTHING;

-- Trigger para updated_at en authorized_locations
CREATE TRIGGER update_authorized_locations_modtime
BEFORE UPDATE ON public.authorized_locations
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();

-- Políticas RLS para authorized_locations
ALTER TABLE public.authorized_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access to all users for authorized_locations"
  ON public.authorized_locations FOR SELECT
  USING (true);

CREATE POLICY "Allow all access to authenticated users for authorized_locations"
  ON public.authorized_locations FOR ALL
  USING (auth.role() = 'authenticated');


-- 2. Modificación a transport_requests para soportar Ubigeos estructurados
ALTER TABLE public.transport_requests
ADD COLUMN pickup_department text,
ADD COLUMN pickup_province text,
ADD COLUMN pickup_district text,
ADD COLUMN delivery_department text,
ADD COLUMN delivery_province text,
ADD COLUMN delivery_district text;

-- 3. Modificación a work_orders para soportar Ubigeos estructurados desde el alta del OT
ALTER TABLE public.work_orders
ADD COLUMN origin_department text,
ADD COLUMN origin_province text,
ADD COLUMN origin_district text,
ADD COLUMN destination_department text,
ADD COLUMN destination_province text,
ADD COLUMN destination_district text;
