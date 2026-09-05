import { useState, useEffect, useCallback } from 'react';

export function usePermissions() {
  const [role, setRole] = useState<string>('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const storedRole = localStorage.getItem('userRole');
    if (storedRole) setRole(storedRole);
    
    const storedPermissions = localStorage.getItem('userPermissions');
    if (storedPermissions) {
      try {
        setPermissions(JSON.parse(storedPermissions));
      } catch (e) {
        console.error('Error parsing permissions');
      }
    }
    setIsLoaded(true);
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
