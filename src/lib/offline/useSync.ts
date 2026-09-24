import { useEffect } from 'react';
import { db } from './db';
import { createClient } from '@/lib/supabase/client';

export function useSync() {
  useEffect(() => {
    const handleOnline = async () => {
      console.log('Online, syncing offline data...');
      const supabase = createClient();
      
      // Sync Expenses
      const offlineExpenses = await db.expenses.where('synced').equals(0).toArray();
      for (const exp of offlineExpenses) {
        try {
          let receipt_url = null;
          if (exp.receipt_blob) {
            const { data: userData } = await supabase.auth.getUser();
            const filePath = `${userData.user?.id}/${exp.dispatch_id}/gastos/${crypto.randomUUID()}-offline.jpg`;
            const { error: upErr } = await supabase.storage.from('driver_evidence').upload(filePath, exp.receipt_blob, { contentType: 'image/jpeg' });
            if (!upErr) receipt_url = filePath;
          }
          
          if (exp.expense_type === 'COMBUSTIBLE') {
            await supabase.rpc('register_fuel_expense', {
              p_dispatch_id: exp.dispatch_id,
              p_driver_id: exp.driver_id,
              p_amount: exp.amount,
              p_gallons: exp.gallons,
              p_odometer: exp.odometer,
              p_receipt_url: receipt_url,
              p_description: exp.description,
              p_client_operation_id: exp.client_operation_id
            });
          } else {
            await supabase.from('dispatch_expenses').insert([{ 
              dispatch_id: exp.dispatch_id, driver_id: exp.driver_id, expense_type: exp.expense_type,
              amount: exp.amount, description: exp.description, receipt_url,
              status: 'PENDIENTE', created_by: (await supabase.auth.getUser()).data.user?.id, 
              client_operation_id: exp.client_operation_id 
            }]);
          }
          await db.expenses.update(exp.id!, { synced: 1 });
        } catch (e) {
          console.error('Failed to sync expense', e);
        }
      }

      // Sync Checklists
      const offlineChecklists = await db.checklists.where('synced').equals(0).toArray();
      for (const chk of offlineChecklists) {
        try {
          let photo_url = null;
          if (chk.photo_blob) {
            const { data: userData } = await supabase.auth.getUser();
            const filePath = `${userData.user?.id}/${chk.dispatch_id}/checklist/${crypto.randomUUID()}-offline.jpg`;
            const { error: upErr } = await supabase.storage.from('driver_evidence').upload(filePath, chk.photo_blob, { contentType: 'image/jpeg' });
            if (!upErr) photo_url = filePath;
          }
          
          const checklistPayload = { ...chk.checklist_data, photo_url };
          await supabase.rpc('submit_pre_route_checklist', {
            p_dispatch_id: chk.dispatch_id,
            p_vehicle_plate: chk.vehicle_plate,
            p_driver_id: chk.driver_id,
            p_odometer: chk.odometer,
            p_checklist_data: checklistPayload,
            p_location: chk.location
          });
          await db.checklists.update(chk.id!, { synced: 1 });
        } catch (e) {
          console.error('Failed to sync checklist', e);
        }
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, []);
}
