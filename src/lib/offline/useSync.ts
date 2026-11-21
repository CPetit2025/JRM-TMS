import { useEffect } from 'react';
import { db } from './db';
import { createClient } from '@/lib/supabase/client';
import { syncOwnPreuse } from './preuse-runtime';
import { toast } from 'sonner';

export function useSync() {
  useEffect(() => {
    const handleOnline = async () => {
      console.log('Online, syncing offline data...');
      const supabase = createClient();
      
      // Sync Expenses
      const offlineExpenses = await db.expenses.where('synced').equals(0).toArray();
      for (const exp of offlineExpenses) {
        try {
          // Antes el error se ignoraba y el gasto quedaba como enviado: solo se marca si el servidor lo confirma.
          // La ruta de la foto usa el id de la operación, así un reintento no duplica la foto ni el gasto.
          let receipt_url = null;
          if (exp.receipt_blob) {
            const { data: userData } = await supabase.auth.getUser();
            const filePath = `${userData.user?.id}/${exp.dispatch_id}/gastos/${exp.client_operation_id}-offline.jpg`;
            const { error: upErr } = await supabase.storage.from('driver_evidence').upload(filePath, exp.receipt_blob, { contentType: 'image/jpeg' });
            if (upErr && String((upErr as { statusCode?: unknown }).statusCode) !== '409') throw upErr;
            receipt_url = filePath;
          }
          let saveError: { code?: string; message: string } | null = null;
          if (exp.expense_type === 'COMBUSTIBLE') {
            ({ error: saveError } = await supabase.rpc('register_fuel_expense', {
              p_dispatch_id: exp.dispatch_id,
              p_driver_id: exp.driver_id,
              p_amount: exp.amount,
              p_gallons: exp.gallons,
              p_odometer: exp.odometer,
              p_receipt_url: receipt_url,
              p_description: exp.description,
              p_client_operation_id: exp.client_operation_id
            }));
          } else {
            ({ error: saveError } = await supabase.from('dispatch_expenses').insert([{
              dispatch_id: exp.dispatch_id, driver_id: exp.driver_id, expense_type: exp.expense_type,
              amount: exp.amount, description: exp.description, receipt_url,
              status: 'PENDIENTE', created_by: (await supabase.auth.getUser()).data.user?.id,
              client_operation_id: exp.client_operation_id
            }]));
          }
          // 23505: la misma operación ya se registró en un intento anterior
          if (saveError && saveError.code !== '23505') throw saveError;
          await db.expenses.update(exp.id!, { synced: 1 });
        } catch (e) {
          console.error('Failed to sync expense', e);
          toast.warning(`Gasto ${exp.expense_type} pendiente de envío: ${e && typeof e === 'object' && 'message' in e ? String(e.message) : 'error de conexión'}`);
        }
      }

      // El formato anterior no contiene los 34 ítems: se conserva, sin simular una inspección completa.
      const offlineChecklists = await db.checklists.where('synced').equals(0).toArray();
      const { data: current } = await supabase.auth.getUser();
      const { data: ownDriver } = current.user ? await supabase.from('drivers').select('id').eq('profile_id',current.user.id).eq('is_active',true).maybeSingle() : { data: null };
      if (ownDriver && offlineChecklists.some(row => row.driver_id === ownDriver.id)) toast.warning('Tienes un checklist del formato anterior pendiente. Abre Checklist y completa los 34 ítems del FR-DT 007. El registro anterior se conserva en el dispositivo.');
      await syncOwnPreuse(supabase);
    };

    const online = () => { void handleOnline().catch(() => toast.warning('No se pudo completar la sincronización. Los registros pendientes se conservan.')); };
    window.addEventListener('online', online);
    const initial = window.setTimeout(() => { if (navigator.onLine) void syncOwnPreuse(createClient()).catch(() => {}); },0);
    return () => { window.removeEventListener('online', online); window.clearTimeout(initial); };
  }, []);
}
