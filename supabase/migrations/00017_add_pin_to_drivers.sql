-- Añadir PIN a los conductores
ALTER TABLE drivers 
ADD COLUMN pin VARCHAR(4);

-- Por defecto, establecer el PIN inicial como los 4 primeros dígitos del DNI para los ya existentes
UPDATE drivers 
SET pin = LEFT(document_number, 4)
WHERE pin IS NULL;
