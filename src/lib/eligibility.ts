import { createClient } from '@/lib/supabase/client'

export type EligibilityStatus = 'APTO' | 'APTO_CON_OBSERVACION' | 'BLOQUEADO'

export interface EligibilityResult {
  eligible: boolean
  status: EligibilityStatus
  blocking_reasons: string[]
  observation_reasons: string[]
  checks: Record<string, boolean>
}

export interface DispatchEligibilityResult {
  eligible: boolean
  status: EligibilityStatus
  vehicle: EligibilityResult
  driver: EligibilityResult
  blocking_reasons: string[]
  observation_reasons: string[]
}

export async function checkVehicleEligibility(
  vehiclePlate: string,
  requiredCapacity?: number
): Promise<EligibilityResult> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc('check_vehicle_eligibility', {
    p_vehicle_plate: vehiclePlate,
    p_required_capacity: requiredCapacity ?? null,
  })
  if (error) throw new Error(error.message)
  return data as EligibilityResult
}

export async function checkDriverEligibility(
  driverId: string
): Promise<EligibilityResult> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc('check_driver_eligibility', {
    p_driver_id: driverId,
  })
  if (error) throw new Error(error.message)
  return data as EligibilityResult
}

export async function checkDispatchEligibility(
  vehiclePlate: string,
  driverId: string,
  requiredCapacity?: number
): Promise<DispatchEligibilityResult> {
  const supabase = createClient()
  const { data, error } = await supabase.rpc('check_dispatch_eligibility', {
    p_vehicle_plate: vehiclePlate,
    p_driver_id: driverId,
    p_required_capacity: requiredCapacity ?? null,
  })
  if (error) throw new Error(error.message)
  return data as DispatchEligibilityResult
}
