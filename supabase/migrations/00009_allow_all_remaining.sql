-- 00009_allow_all_remaining.sql
-- Allow anonymous access for the prototype for all other tables we insert into from the frontend

CREATE POLICY "Allow all anon on transport_budgets" ON transport_budgets
    FOR ALL
    TO anon
    USING (true);

CREATE POLICY "Allow all authenticated on transport_budgets" ON transport_budgets
    FOR ALL
    TO authenticated
    USING (true);

CREATE POLICY "Allow all anon on clients" ON clients
    FOR ALL
    TO anon
    USING (true);

CREATE POLICY "Allow all authenticated on clients" ON clients
    FOR ALL
    TO authenticated
    USING (true);

CREATE POLICY "Allow all anon on profiles" ON profiles
    FOR ALL
    TO anon
    USING (true);

CREATE POLICY "Allow all authenticated on profiles" ON profiles
    FOR ALL
    TO authenticated
    USING (true);

CREATE POLICY "Allow all anon on budget_extensions" ON budget_extensions
    FOR ALL
    TO anon
    USING (true);

CREATE POLICY "Allow all authenticated on budget_extensions" ON budget_extensions
    FOR ALL
    TO authenticated
    USING (true);
