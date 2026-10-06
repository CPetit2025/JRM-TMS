import Dexie, { Table } from 'dexie';

export interface OfflineExpense {
  id?: number;
  dispatch_id: string;
  driver_id: string;
  expense_type: string;
  amount: number;
  gallons?: number;
  odometer?: number;
  receipt_blob?: Blob;
  description: string;
  client_operation_id: string;
  synced: number;
  created_at: string;
}

export interface OfflineChecklist {
  id?: number;
  dispatch_id: string;
  vehicle_plate: string;
  driver_id: string;
  odometer: number;
  checklist_data: Record<string, unknown>;
  photo_blob?: Blob;
  location: unknown;
  synced: number;
  created_at: string;
}

export interface OfflinePreuse {
  operation_id: string;
  profile_id: string;
  unit_revision: string;
  vehicle_plate?: string;
  operation_date?: string;
  captured_at: string;
  data: Record<string, unknown>;
  synced: number;
  created_at: string;
  last_error?: string;
}

export class AppDB extends Dexie {
  expenses!: Table<OfflineExpense>;
  checklists!: Table<OfflineChecklist>;
  preuse!: Table<OfflinePreuse, string>;

  constructor() {
    super('jrm-offline-db');
    this.version(2).stores({
      expenses: '++id, dispatch_id, driver_id, synced, created_at',
      checklists: '++id, dispatch_id, vehicle_plate, driver_id, synced, created_at'
    });
    this.version(3).stores({
      expenses: '++id, dispatch_id, driver_id, synced, created_at',
      checklists: '++id, dispatch_id, vehicle_plate, driver_id, synced, created_at',
      preuse: 'operation_id, profile_id, unit_revision, synced, created_at'
    });
  }
}

export const db = new AppDB();
