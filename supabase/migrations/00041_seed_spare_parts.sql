-- Script para poblar el catálogo maestro de repuestos estándar (Sin manejo de stock)
-- Ejecutar en el SQL Editor de Supabase

INSERT INTO public.spare_parts (internal_code, name, brand, category, compatibility) VALUES 
-- MOTORES Y FILTROS
('FIL-001', 'Filtro de Aceite Motor', 'Genérico', 'Filtros', 'Camiones, Autos'),
('FIL-002', 'Filtro de Aire Primario', 'Genérico', 'Filtros', 'Camiones'),
('FIL-003', 'Filtro de Combustible', 'Genérico', 'Filtros', 'Camiones, Montacargas'),
('LUB-001', 'Aceite de Motor 15W40 (Galón)', 'Mobil/Chevron', 'Lubricantes', 'Diésel General'),
('LUB-002', 'Líquido Refrigerante (Galón)', 'Genérico', 'Lubricantes', 'General'),
('LUB-003', 'Aceite Hidráulico ISO 68 (Balde)', 'Genérico', 'Lubricantes', 'Montacargas'),

-- FRENOS Y SUSPENSIÓN
('FRE-001', 'Pastillas de Freno (Juego)', 'Genérico', 'Frenos', 'Autos, Camiones Ligeros'),
('FRE-002', 'Fajas de Freno / Zapatas', 'Genérico', 'Frenos', 'Camiones Pesados'),
('FRE-003', 'Pulmón de Freno', 'Genérico', 'Frenos', 'Camiones Pesados, Carretas'),
('SUS-001', 'Amortiguador Delantero', 'Genérico', 'Suspensión', 'General'),
('SUS-002', 'Bolsa de Aire Suspensión', 'Genérico', 'Suspensión', 'Tractos, Carretas'),
('SUS-003', 'Muelle / Hoja de Muelle', 'Genérico', 'Suspensión', 'Camiones, Carretas'),

-- SISTEMA ELÉCTRICO
('ELE-001', 'Batería 12V 150Ah', 'Bosch/Etna', 'Eléctrico', 'Camiones'),
('ELE-002', 'Batería 12V 70Ah', 'Bosch/Etna', 'Eléctrico', 'Autos, Montacargas'),
('ELE-003', 'Alternador 24V', 'Genérico', 'Eléctrico', 'Camiones'),
('ELE-004', 'Foco Halógeno H4 24V', 'Genérico', 'Eléctrico', 'Camiones'),
('ELE-005', 'Faro Posterior LED 24V', 'Genérico', 'Eléctrico', 'Carretas'),

-- TRANSMISIÓN Y DIRECCIÓN
('TRA-001', 'Kit de Embrague Completo', 'Genérico', 'Transmisión', 'Camiones'),
('TRA-002', 'Cruceta de Cardán', 'Genérico', 'Transmisión', 'Camiones'),
('DIR-001', 'Terminal de Dirección', 'Genérico', 'Dirección', 'Camiones, Autos'),

-- OTROS CONSUMIBLES / SERVICIOS FRECUENTES
('CON-001', 'Grasa de Chasis (Kilo)', 'Genérico', 'Consumibles', 'General'),
('CON-002', 'Urea / AdBlue (Galón)', 'Genérico', 'Consumibles', 'Camiones Euro V'),
('SER-001', 'Mano de Obra - Mantenimiento Preventivo', 'Servicio', 'Servicios', 'General'),
('SER-002', 'Mano de Obra - Mantenimiento Correctivo', 'Servicio', 'Servicios', 'General'),
('SER-003', 'Servicio de Lavado', 'Servicio', 'Servicios', 'General')
ON CONFLICT (internal_code) DO NOTHING;
