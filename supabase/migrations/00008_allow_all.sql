-- 00008_allow_all.sql
-- Allow anonymous access for the prototype since there's no auth flow yet

CREATE POLICY "Allow all anon" ON work_order_items
    FOR ALL
    TO anon
    USING (true);

-- Also ensure work_orders has a policy if it doesn't
CREATE POLICY "Allow all anon on work orders" ON work_orders
    FOR ALL
    TO anon
    USING (true);
    
CREATE POLICY "Allow all authenticated on work orders" ON work_orders
    FOR ALL
    TO authenticated
    USING (true);
