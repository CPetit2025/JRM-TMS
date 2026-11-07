import type { OutsourcingService } from "./outsourcing";
export type AssignedResource = {
  id: string;
  outsourcing_id: string;
  service: OutsourcingService;
  supplier_id: string;
  supplier_name: string;
  quantity: number;
  resource: Record<string, string>;
  starts_at: string;
  ends_at: string;
  quoted_amount: number;
  confirmed_amount: number | null;
  currency: "PEN" | "USD";
  exchange_rate: number;
  amount_pen: number;
  terms: string;
  version: number;
  state: "DRAFT" | "APPROVED" | "CONFIRMED" | "CANCELLED" | "COMPLETED";
  dispatch_id: string | null;
  request_id?: string;
  request_number?: string;
  carrier_id?: string;
};
export const RESOURCE_STATES = {
  DRAFT: "En gestión",
  APPROVED: "Aprobada",
  CONFIRMED: "Confirmada",
  CANCELLED: "Cancelada",
  COMPLETED: "Finalizada",
};
export const RESOURCE_FIELDS: Record<
  OutsourcingService,
  [string, string, string?][]
> = {
  FLETE: [
    ["plate", "Placa"],
    ["trailer", "Placa de semirremolque (si aplica)"],
    ["unit_type", "Tipo / configuración"],
    ["capacity_t", "Capacidad (t)", "number"],
    ["length_m", "Largo útil (m)", "number"],
    ["width_m", "Ancho útil (m)", "number"],
    ["height_m", "Alto útil (m)", "number"],
    ["cargo_weight_kg", "Peso asignado a esta unidad (kg)", "number"],
    ["volume_m3", "Volumen asignado (m³)", "number"],
    ["driver", "Conductor"],
    ["document", "Documento del conductor"],
    ["phone", "Teléfono"],
    ["license", "Licencia"],
    ["license_category", "Categoría de licencia"],
    ["license_expiration", "Vencimiento de licencia", "date"],
    ["vehicle_documents", "Documentación de unidad / vigencias"],
    ["driver_documents", "Documentación del conductor"],
    ["origin", "Origen"],
    ["destination", "Destino"],
    ["stops", "Puntos intermedios"],
  ],
  MONTACARGAS: [
    ["equipment", "Identificador / modelo del equipo"],
    ["capacity", "Capacidad (t)", "number"],
    ["height", "Altura de elevación (m)", "number"],
    ["operator", "Operador"],
    ["operator_document", "Documento del operador"],
    ["certificates", "Certificaciones y vigencias"],
    ["location", "Lugar de operación"],
  ],
  GRUA: [
    ["equipment", "Identificador / tipo de grúa"],
    ["capacity", "Capacidad nominal (t)", "number"],
    ["reach", "Alcance aprobado (m)", "number"],
    ["operator", "Operador"],
    ["operator_document", "Documento del operador"],
    ["certificates", "Certificaciones y vigencias"],
    ["location", "Lugar de maniobra"],
    [
      "maneuver_review",
      "Evaluación de maniobra: responsable, carga, radio, tabla de carga, accesorios y condiciones",
    ],
  ],
  STOCKA: [
    ["equipment", "Identificador / tipo de stocka"],
    ["capacity", "Capacidad (t)", "number"],
    ["operator", "Operador / responsable"],
    ["operator_document", "Documento del responsable"],
    ["certificates", "Documentación / inspección"],
    ["location", "Lugar de operación"],
  ],
  ESTIBA: [
    ["responsible", "Responsable del grupo"],
    ["staff", "Relación de personal (según requisitos de ingreso)"],
    ["activity", "Actividad"],
    ["location", "Lugar de trabajo"],
    ["safety", "EPP, inducciones y condiciones de seguridad"],
  ],
  OTROS: [
    ["description", "Descripción y características del recurso"],
    ["attributes", "Especificaciones adicionales"],
    ["location", "Lugar de atención"],
    ["responsible", "Responsable"],
  ],
};
