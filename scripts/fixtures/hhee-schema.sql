-- Isolated compatibility fixture, not a production bootstrap. No real staff or business data.
-- Includes optional profiles.area and the real roles.name VARCHAR(50) constraint.
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
-- Supabase grants broad privileges to new public objects; each HHEE migration must revoke them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE TABLE public.roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name varchar(50) UNIQUE,permissions jsonb DEFAULT '[]');
CREATE TABLE public.profiles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),is_active boolean DEFAULT true,role_id uuid REFERENCES roles,first_name text,last_name text,area text);
CREATE TABLE public.sites(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text,name text,is_active boolean DEFAULT true);
CREATE TABLE public.contracts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text);
CREATE TABLE public.user_site_access(user_id uuid,site_id uuid);
CREATE FUNCTION public.is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND is_active)$$;
CREATE FUNCTION public.is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND r.name='Administrador')$$;
CREATE FUNCTION public.has_tms_permission(m text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT is_tms_admin() OR EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND (r.permissions ? m OR r.permissions ? (m||':write')))$$;
CREATE FUNCTION public.has_tms_read_permission(m text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT has_tms_permission(m) OR EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND r.permissions ? (m||':read'))$$;
CREATE FUNCTION public.primary_site_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT id FROM sites WHERE code='PRINCIPAL'$$;
CREATE FUNCTION public.can_access_site(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT is_active_tms_user() AND (is_tms_admin() OR EXISTS(SELECT 1 FROM user_site_access WHERE user_id=auth.uid() AND site_id=s))$$;
INSERT INTO sites(code,name) VALUES('PRINCIPAL','Principal');
INSERT INTO roles(name) VALUES('Administrador');
INSERT INTO profiles(id,role_id,first_name,last_name) SELECT '00000000-0000-4000-8000-000000000001',id,'Prueba','Admin' FROM roles;

INSERT INTO profiles(id,role_id,first_name,last_name) SELECT '00000000-0000-4000-8000-000000000002',id,'Prueba','Responsable' FROM roles LIMIT 1;
INSERT INTO auth.users SELECT id FROM profiles;
