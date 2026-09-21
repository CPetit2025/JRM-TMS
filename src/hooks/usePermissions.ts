import { useState, useEffect, useCallback } from 'react';
import { normalizeRoleName } from '@/lib/roles';
import { createClient } from '@/lib/supabase/client';

export function usePermissions() {
  const [role, setRole] = useState<string>('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadPermissions = async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          localStorage.removeItem('userRole');
          localStorage.removeItem('userPermissions');
          return;
        }
        const { data: profile, error } = await supabase.from('profiles')
          .select('is_active, roles(name, permissions)').eq('id', user.id).maybeSingle();
        if (error) throw error;
        if (!profile?.is_active) {
          localStorage.removeItem('userRole');
          localStorage.removeItem('userPermissions');
          return;
        }
        const linkedRole = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles;
        const nextRole = normalizeRoleName(linkedRole?.name);
        const nextPermissions = Array.isArray(linkedRole?.permissions) ? linkedRole.permissions : [];
        if (cancelled) return;
        setRole(nextRole);
        setPermissions(nextPermissions);
        localStorage.setItem('userRole', nextRole);
        localStorage.setItem('userPermissions', JSON.stringify(nextPermissions));
      } catch {
        // Keep the last known menu while offline; database policies still enforce access.
        const storedRole = localStorage.getItem('userRole');
        if (storedRole && !cancelled) setRole(normalizeRoleName(storedRole));
        try {
          const storedPermissions = JSON.parse(localStorage.getItem('userPermissions') || '[]');
          if (Array.isArray(storedPermissions) && !cancelled) setPermissions(storedPermissions);
        } catch { /* Ignore a damaged local cache. */ }
      } finally {
        if (!cancelled) setIsLoaded(true);
      }
    };
    void loadPermissions();
    return () => { cancelled = true; };
  }, []);

  const hasAccess = useCallback((module: string) => {
    if (role === 'admin') return true;
    return permissions.some(p => p === module || p.startsWith(`${module}:`));
  }, [role, permissions]);

  const canRead = useCallback((module: string) => {
    if (role === 'admin') return true;
    return hasAccess(module);
  }, [hasAccess, role]);

  const canWrite = useCallback((module: string) => {
    if (role === 'admin') return true;
    // Retrocompatibilidad: si no tiene sufijo (es === module) asumimos permisos de escritura por legacy.
    return permissions.some(p => p === module || p === `${module}:write`);
  }, [role, permissions]);

  return { role, permissions, isLoaded, canRead, canWrite, hasAccess };
}
