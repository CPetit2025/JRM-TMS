-- 00020_allow_fleet.sql
CREATE POLICY "Allow all anon on carriers" ON carriers FOR ALL TO anon USING (true);
CREATE POLICY "Allow all authenticated on carriers" ON carriers FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all anon on vehicles" ON vehicles FOR ALL TO anon USING (true);
CREATE POLICY "Allow all authenticated on vehicles" ON vehicles FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow all anon on drivers" ON drivers FOR ALL TO anon USING (true);
CREATE POLICY "Allow all authenticated on drivers" ON drivers FOR ALL TO authenticated USING (true);

