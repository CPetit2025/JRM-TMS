-- Añadir la columna budget_limit a transport_budgets si no existe
ALTER TABLE transport_budgets
ADD COLUMN IF NOT EXISTS budget_limit NUMERIC(10, 2) DEFAULT 0;
