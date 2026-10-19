'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useRef, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Context } from '@/lib/hhee/types';
export async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await createClient().rpc(name, args);
    if (error)
        throw Error(error.message.includes('statement timeout') ? 'La consulta tardó más de lo esperado. Acote el período y vuelva a intentar.' : error.message);
    if (!data?.success)
        throw Error(data?.error || 'No se pudo completar la operación.');
    return data as T;
}
type State = {
    context: Context | null;
    error: string;
    refresh: () => Promise<void>;
    revision: number;
    mutate: (p: Record<string, unknown>) => Promise<void>;
};
const Store = createContext<State | null>(null);
export function HheeProvider({ children }: {
    children: ReactNode;
}) {
    const [context, setContext] = useState<Context | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
    const refresh = useCallback(async () => { try {
        const loaded = await rpc<Context>('hhee_context');
        setError('');
        setContext(loaded);
        setRevision(n => n + 1);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo cargar HHEE.');
    } }, []);
    useEffect(() => {
        let active = true;
        rpc<Context>('hhee_context').then(loaded => { if (active) {
            setContext(loaded);
            setRevision(n => n + 1);
        } }).catch(e => { if (active)
            setError(e instanceof Error ? e.message : 'No se pudo cargar HHEE.'); });
        return () => { active = false; };
    }, []);
    const pending = useRef(new Map<string, string>());
    const mutate = useCallback(async (p: Record<string, unknown>) => {
        const key = JSON.stringify(p), op = pending.current.get(key) || crypto.randomUUID();
        pending.current.set(key, op);
        await rpc('hhee_mutate', { p: { ...p, operation_id: op } });
        pending.current.delete(key);
        await refresh();
    }, [refresh]);
    const value = useMemo(() => ({ context, error, refresh, revision, mutate }), [context, error, refresh, revision, mutate]);
    return <Store.Provider value={value}>{children}</Store.Provider>;
}
export function useHhee() { const v = useContext(Store); if (!v)
    throw Error('HHEE requiere contexto'); return v; }
