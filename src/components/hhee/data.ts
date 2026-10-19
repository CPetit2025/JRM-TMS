'use client';
import { useEffect, useState } from 'react';
import { rpc, useHhee } from './provider';
import type { Data, Filters } from '@/lib/hhee/types';
export function useData(filters: Filters) {
    const { revision, context } = useHhee(), [result, setResult] = useState<{
        key: string;
        data: Data;
    } | null>(null), [failure, setFailure] = useState<{
        key: string;
        error: string;
    } | null>(null);
    const key = JSON.stringify([filters, revision]);
    useEffect(() => {
        if (!context)
            return;
        let active = true;
        const timer = setTimeout(() => {
            rpc<Data>('hhee_read', { p: filters }).then(data => { if (active) {
                setResult({ key, data });
                setFailure(null);
            } }).catch(e => { if (active)
                setFailure({ key, error: e instanceof Error ? e.message : 'No se pudo cargar el período.' }); });
        }, 250);
        return () => { active = false; clearTimeout(timer); };
    }, [filters, key, context]);
    return { data: result?.key === key ? result.data : null, error: failure?.key === key ? failure.error : '', loading: result?.key !== key && failure?.key !== key };
}
