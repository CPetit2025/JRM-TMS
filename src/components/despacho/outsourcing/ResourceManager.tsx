"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/caja";
import { usePermissions } from "@/hooks/usePermissions";
import {
  OUTSOURCING_SERVICES,
  OUTSOURCING_STEPS,
  outsourcingStepsDone,
  type OutsourcingService,
} from "@/lib/outsourcing";
const NEXT_ACTION = [
  "Complete la ficha y envíela a Compras con «Abrir / corregir ficha».",
  "Compras registra proveedor, recurso y costo con «Asignar proveedor / recurso».",
  "Apruebe el costo y confirme al proveedor de cada recurso.",
  "Arme la ruta con el recurso confirmado y, tras el cierre económico, finalice el servicio.",
  "Servicio ejecutado y cerrado.",
];
import {
  RESOURCE_FIELDS,
  RESOURCE_STATES,
  type AssignedResource,
} from "@/lib/outsourcing-resources";
import { localDate, isoLima } from "@/lib/outsourcing-form";
import { cellDateTime } from "@/lib/table-format";
import { Modal } from "@/components/ui/modal";
const input = "w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
const button =
  "rounded-lg bg-jrm-navy px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";
type Supplier = {
  id: string;
  business_name: string;
  tax_id?: string;
  contact_name?: string;
  contact_phone?: string;
  contact_email?: string;
  category: string;
};
type Catalog = {
  id: string;
  supplier_id: string;
  [key: string]: string | number | boolean | null;
};
type Context = {
  outsourcing: { specification: Record<string, unknown>; revision: number;stage:number;review_status:string };
  requirements: { service: OutsourcingService; quantity: number }[];
  assignments: AssignedResource[];
  suppliers: Supplier[];
  vehicles: Catalog[];
  personnel: Catalog[];
};
// Categorías de proveedor que se ofrecen por servicio (subconjunto de las que acepta outsourcing_assignment_save).
const ALL_LOGISTIC = ["TRANSPORTE", "GRUA", "MONTACARGA", "ESTIBA", "SERVICIOS"];
const SERVICE_SUPPLIERS: Record<OutsourcingService, string[]> = {
  FLETE: ["TRANSPORTE"],
  MONTACARGAS: ["MONTACARGA"],
  GRUA: ["GRUA"],
  ESTIBA: ["ESTIBA"],
  STOCKA: ALL_LOGISTIC,
  OTROS: ALL_LOGISTIC,
};
type QuickField = [string, string, string?];
const QUICK_SUPPLIER: QuickField[] = [
  ["tax_id", "RUC (11 dígitos)"],
  ["business_name", "Razón social"],
  ["contact_name", "Contacto"],
  ["contact_phone", "Teléfono", "tel"],
  ["contact_email", "Correo", "email"],
];
const QUICK_OPERATOR: QuickField[] = [
  ["full_name", "Nombre completo"],
  ["document_number", "Documento de identidad"],
  ["phone", "Teléfono", "tel"],
];
const QUICK_DRIVER: QuickField[] = [
  ...QUICK_OPERATOR,
  ["license_number", "Licencia"],
  ["license_expiration", "Vencimiento de licencia", "date"],
];
const empty = () => ({
  supplier_id: "",
  quantity: "1",
  starts_at: "",
  ends_at: "",
  quoted_amount: "",
  confirmed_amount: "",
  currency: "PEN",
  exchange_rate: "1",
  terms: "",
  resource: {} as Record<string, string>,
});
export function ResourceManager({
  parent,
  service,
  onChanged,
  onManaged,
}: {
  parent: string;
  service: OutsourcingService;
  onChanged: () => void;
  onManaged?: (value: boolean) => void;
}) {
  const db = useMemo(() => createClient(), []),
    { canWrite } = usePermissions();
  const [context, setContext] = useState<Context | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AssignedResource | null | undefined>(
      undefined,
    ),
    [form, setForm] = useState(empty),
    [reason, setReason] = useState(""),
    [ack, setAck] = useState(false),
    [quick, setQuick] = useState<{ kind: "supplier" | "person"; data: Record<string, string> } | null>(null),
    [personId, setPersonId] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await db.rpc("outsourcing_assignment_context", {
      p_id: parent,
    });
    if (error) setError(errorMessage(error));
    else {
      setContext(data);
      onManaged?.(
        data.assignments.some((a: AssignedResource) => a.state !== "CANCELLED"),
      );
      setError("");
    }
    return error ? null : (data as Context);
  }, [db, parent, onManaged]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const assignments =
      context?.assignments.filter((a) => a.service === service) || [],
    supplier = context?.suppliers.find((s) => s.id === form.supplier_id);
  const suppliers = (context?.suppliers || []).filter(
      (s) => SERVICE_SUPPLIERS[service].includes(s.category) || s.id === form.supplier_id,
    ),
    people = (context?.personnel || []).filter((p) => p.supplier_id === form.supplier_id),
    personRole = service === "FLETE" ? "Conductor" : service === "ESTIBA" ? "Responsable" : "Operador";
  function selectSupplier(id: string) {
    setPersonId("");
    setQuick(null);
    setForm((f) => ({
      ...f,
      supplier_id: id,
      resource: { origin: f.resource.origin || "", destination: f.resource.destination || "" },
    }));
  }
  // Copia los datos del conductor u operador registrado a los campos del recurso según el servicio.
  function applyPerson(p: Catalog) {
    const text = (v: unknown) => (v == null ? "" : String(v));
    setPersonId(p.id);
    setForm((f) => ({
      ...f,
      resource: {
        ...f.resource,
        ...(service === "FLETE"
          ? { driver: text(p.full_name), document: text(p.document_number), phone: text(p.phone), license: text(p.license_number), license_expiration: text(p.license_expiration) }
          : service === "ESTIBA"
            ? { responsible: text(p.full_name) }
            : { operator: text(p.full_name), operator_document: text(p.document_number) }),
      },
    }));
  }
  async function register() {
    if (!quick) return;
    setBusy(true);
    try {
      const { data, error } = await db.rpc("outsourcing_quick_register", {
        p_service: service,
        p: quick.kind === "person" ? { ...quick.data, supplier_id: form.supplier_id } : quick.data,
      });
      if (error) throw error;
      const fresh = await load();
      if (quick.kind === "supplier") selectSupplier(data);
      else {
        const person = fresh?.personnel.find((p) => p.id === data);
        if (person) applyPerson(person);
      }
      setQuick(null);
      toast.success(quick.kind === "supplier" ? "Proveedor registrado y seleccionado" : `${personRole} registrado y asignado`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const required =
    context?.requirements.find((r) => r.service === service)?.quantity || 0;
  const requested = service==='FLETE' ? context?.outsourcing.specification : (context?.outsourcing.specification.services as {kind:string;details?:Record<string,string>}[]|undefined)?.find(s=>s.kind===service)?.details;
  const assignable=context?.outsourcing.review_status==='ACTIVE'&&context.outsourcing.stage>0&&context.outsourcing.stage<6;
  const assigned = assignments
    .filter((a) => a.state !== "CANCELLED")
    .reduce((s, a) => s + Number(a.quantity), 0);
  function open(a: AssignedResource | null) {
    setEditing(a);
    setReason("");
    setAck(false);
    setQuick(null);
    setPersonId("");
    setForm(
      a
        ? {
            ...a,
            quantity: String(a.quantity),
            quoted_amount: String(a.quoted_amount),
            confirmed_amount:
              a.confirmed_amount == null ? "" : String(a.confirmed_amount),
            exchange_rate: String(a.exchange_rate),
            starts_at: localDate(a.starts_at),
            ends_at: localDate(a.ends_at),
          }
        : {
            ...empty(),
            starts_at: localDate(
              String(context?.outsourcing.specification.required_at || ""),
            ),
            resource: {
              origin: String(context?.outsourcing.specification.pickup || ""),
              destination: String(
                context?.outsourcing.specification.delivery || "",
              ),
            },
          },
    );
  }
  async function save() {
    setBusy(true);
    try {
      const { error } = editing?.dispatch_id
        ? await db.rpc("outsourcing_assignment_rectify", {
            p_id: editing.id,
            p_version: editing.version,
            p_resource: form.resource,
            p_note: reason,
            p_acknowledge: ack,
          })
        : await db.rpc("outsourcing_assignment_save", {
            p_parent: parent,
            p_service: service,
            p: {
              ...form,
              starts_at: isoLima(form.starts_at),
              ends_at: isoLima(form.ends_at),
            },
            p_id: editing?.id || null,
            p_version: editing?.version || null,
            p_reason: reason,
          });
      if (error) throw error;
      setEditing(undefined);
      await load();
      onChanged();
      toast.success("Asignación guardada; requiere aprobación y confirmación");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function act(a: AssignedResource, action: string) {
    const note = window.prompt("Sustento de la acción (mínimo 5 caracteres)");
    if (note === null) return;
    setBusy(true);
    try {
      const { error } = await db.rpc("outsourcing_assignment_action", {
        p_id: a.id,
        p_version: a.version,
        p_action: action,
        p_note: note,
      });
      if (error) throw error;
      await load();
      onChanged();
      toast.success("Estado actualizado");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return (
      <p role="alert" className="text-red-700">
        {error}
        <button onClick={() => void load()} className={button}>
          Reintentar
        </button>
      </p>
    );
  if (!context) return <p role="status">Cargando recursos…</p>;
  const done = outsourcingStepsDone(context.outsourcing.stage, required, assignments);
  return (
    <>
    <ol className="grid grid-cols-4 gap-2" aria-label="Avance del servicio">
      {OUTSOURCING_STEPS.map((step, i) => (
        <li
          key={step}
          aria-current={i === done ? "step" : undefined}
          className={`rounded-lg border-t-4 px-2 py-1 text-xs ${i < done ? "border-emerald-500 bg-emerald-50 text-emerald-900" : i === done ? "border-blue-600 bg-blue-50 font-semibold text-blue-900" : "border-slate-200 text-slate-500"}`}
        >
          {i + 1}. {step}
        </li>
      ))}
    </ol>
    {context.outsourcing.review_status !== "CANCELLED" && (
      <p className="text-sm"><strong>Siguiente acción:</strong> {NEXT_ACTION[done]}</p>
    )}
    <section
      className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/30 p-4"
      aria-label="Asignaciones por proveedor"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {OUTSOURCING_SERVICES[service]} · Recursos y proveedores
          </h3>
          <p className="text-sm">
            Solicitado: {required} · Asignado: {assigned} · Pendiente:{" "}
            {Math.max(0, required - assigned)}
          </p>
        </div>
        {canWrite("compras-tercerizaciones") && (
          <button
            className={button}
            disabled={busy || assigned >= required || !assignable}
            onClick={() => open(null)}
          >
            Asignar proveedor / recurso
          </button>
        )}
      </div>
      <p className="text-xs text-slate-600">
        La aprobación económica no reserva presupuesto. El compromiso se
        registra al programar la ruta. Cada unidad o equipo tiene su propia
        ficha.
      </p>
      {!assignments.length && (
        <p className="text-sm text-slate-500">Pendiente de proveedor.</p>
      )}
      {assignments.map((a) => (
        <article
          key={a.id}
          className="space-y-2 rounded-lg border bg-white p-3"
        >
          <div className="flex flex-wrap justify-between gap-2">
            <strong>
              {a.supplier_name} ·{" "}
              {a.resource.plate ||
                a.resource.equipment ||
                a.resource.responsible ||
                OUTSOURCING_SERVICES[a.service]}
            </strong>
            <span className="rounded-full bg-slate-100 px-2 text-sm">
              {RESOURCE_STATES[a.state]}
            </span>
          </div>
          <p className="text-sm">
            Cantidad {a.quantity} · {cellDateTime(a.starts_at)} —{" "}
            {cellDateTime(a.ends_at)} · {a.currency}{" "}
            {Number(a.confirmed_amount ?? a.quoted_amount).toFixed(2)}{" "}
            {a.confirmed_amount ? "confirmado" : "cotizado"}
          </p>
          <details>
            <summary className="cursor-pointer text-sm">
              Datos técnicos y condiciones
            </summary>
            <dl className="grid gap-2 py-2 text-sm md:grid-cols-2">
              {RESOURCE_FIELDS[a.service].map(([key, label]) => (
                <div key={key}>
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="whitespace-pre-wrap">
                    {a.resource[key] || "—"}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="whitespace-pre-wrap text-sm">{a.terms}</p>
          </details>
          {a.dispatch_id && (
            <Link
              className="text-sm text-blue-700 underline"
              href={`/torre-control?despacho=${a.dispatch_id}`}
            >
              Ver despacho vinculado
            </Link>
          )}
          <div className="flex flex-wrap gap-2">
            {(!a.dispatch_id || canWrite("despacho-aprobacion")) &&
              !["CANCELLED", "COMPLETED"].includes(a.state) &&
              canWrite("compras-tercerizaciones") && (
                <button
                  disabled={busy}
                  className={button}
                  onClick={() => open(a)}
                >
                  {a.dispatch_id ? "Rectificar recurso programado" : "Editar"}
                </button>
              )}
            {a.state === "DRAFT" && canWrite("compras-aprobar") && (
              <button
                disabled={busy}
                className={button}
                onClick={() => void act(a, "APPROVE")}
              >
                Aprobar costo y recurso
              </button>
            )}
            {a.state === "APPROVED" && canWrite("compras-tercerizaciones") && (
              <button
                disabled={busy}
                className={button}
                onClick={() => void act(a, "CONFIRM")}
              >
                Confirmar proveedor
              </button>
            )}
            {a.state === "CONFIRMED" &&
              !a.dispatch_id &&
              canWrite("despacho") && (
                <Link className={button} href={`/despacho?asignacion=${a.id}`}>
                  Armar ruta con este recurso
                </Link>
              )}
            {a.state === "CONFIRMED" &&
              a.dispatch_id &&
              canWrite("cierre-economico") && (
                <button
                  disabled={busy}
                  className={button}
                  onClick={() => void act(a, "COMPLETE")}
                >
                  Finalizar tras cierre
                </button>
              )}
            {!["CANCELLED", "COMPLETED"].includes(a.state) &&
              canWrite("compras-tercerizaciones") && (
                <button
                  disabled={busy}
                  className="rounded-lg border px-3 py-2 text-sm text-red-700"
                  onClick={() => void act(a, "CANCEL")}
                >
                  Cancelar asignación
                </button>
              )}
          </div>
        </article>
      ))}
      {editing !== undefined && (
        <Modal
          isOpen
          onClose={() => {
            if (!busy) setEditing(undefined);
          }}
          title={`${editing ? "Editar" : "Asignar"} ${OUTSOURCING_SERVICES[service]}`}
          maxWidth="max-w-5xl"
        >
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <details open className="rounded-lg border border-blue-200 bg-blue-50 p-3"><summary className="cursor-pointer text-sm font-semibold">Requerimiento original · Cantidad {required}</summary><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{RESOURCE_FIELDS[service].filter(([key])=>requested?.[key]!=null&&requested[key]!=='').map(([key,label])=><div key={key}><dt className="text-slate-500">{label}</dt><dd>{String(requested?.[key])}</dd></div>)}</dl><p className="mt-2 text-xs">Registre abajo las características ofrecidas por el proveedor. La aprobación verifica los mínimos técnicos.</p></details>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                Proveedor de {OUTSOURCING_SERVICES[service].toLowerCase()}
                <select
                  aria-label="Proveedor"
                  disabled={!!editing?.dispatch_id}
                  required
                  className={input}
                  value={form.supplier_id}
                  onChange={(e) => selectSupplier(e.target.value)}
                >
                  <option value="">
                    {suppliers.length ? "Seleccione proveedor activo" : "Sin proveedores registrados: registre uno nuevo"}
                  </option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.business_name} · {s.tax_id || "Sin RUC"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="self-center text-sm text-slate-600">
                {supplier &&
                  [
                    supplier.contact_name,
                    supplier.contact_phone,
                    supplier.contact_email,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                {!editing?.dispatch_id && (
                  <button type="button" className="block text-blue-700 underline" onClick={() => setQuick({ kind: "supplier", data: {} })}>
                    + Registrar proveedor nuevo
                  </button>
                )}
              </div>
              {quick && (
                <fieldset className="grid gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 sm:col-span-2 sm:grid-cols-2" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void register(); } }}>
                  <legend className="px-1 text-sm font-semibold">
                    {quick.kind === "supplier"
                      ? `Nuevo proveedor de ${OUTSOURCING_SERVICES[service].toLowerCase()}`
                      : `Nuevo ${personRole.toLowerCase()} de ${supplier?.business_name}`}
                  </legend>
                  {(quick.kind === "supplier" ? QUICK_SUPPLIER : service === "FLETE" ? QUICK_DRIVER : QUICK_OPERATOR).map(([key, label, type]) => (
                    <label key={key} className="text-sm">
                      {label}
                      <input
                        className={input}
                        type={type || "text"}
                        value={quick.data[key] || ""}
                        onChange={(e) => setQuick({ ...quick, data: { ...quick.data, [key]: e.target.value } })}
                      />
                    </label>
                  ))}
                  <div className="flex gap-2 sm:col-span-2">
                    <button type="button" disabled={busy} className={button} onClick={() => void register()}>
                      {busy ? "Registrando…" : "Registrar y usar"}
                    </button>
                    <button type="button" disabled={busy} className="rounded-lg border px-3 py-2 text-sm" onClick={() => setQuick(null)}>
                      Cancelar
                    </button>
                  </div>
                </fieldset>
              )}
              <label>
                Cantidad
                <input
                  disabled={!!editing?.dispatch_id}
                  required
                  type="number"
                  min={service === "OTROS" ? "0.01" : "1"}
                  step={service === "OTROS" ? "any" : "1"}
                  max={
                    ["FLETE", "MONTACARGAS", "GRUA", "STOCKA"].includes(service)
                      ? 1
                      : undefined
                  }
                  className={input}
                  value={form.quantity}
                  onChange={(e) =>
                    setForm({ ...form, quantity: e.target.value })
                  }
                />
              </label>
              <label>
                Inicio de disponibilidad (Lima)
                <input
                  disabled={!!editing?.dispatch_id}
                  required
                  type="datetime-local"
                  className={input}
                  value={form.starts_at}
                  onChange={(e) =>
                    setForm({ ...form, starts_at: e.target.value })
                  }
                />
              </label>
              <label>
                Fin de disponibilidad (Lima)
                <input
                  disabled={!!editing?.dispatch_id}
                  required
                  type="datetime-local"
                  className={input}
                  value={form.ends_at}
                  onChange={(e) =>
                    setForm({ ...form, ends_at: e.target.value })
                  }
                />
              </label>
              {service === "FLETE" && (
                <>
                  <label>
                    Unidad del catálogo (opcional)
                    <select
                      className={input}
                      defaultValue=""
                      onChange={(e) => {
                        const v = context.vehicles.find(
                          (v) => v.id === e.target.value,
                        );
                        if (v) {
                          setForm((f) => ({
                            ...f,
                            resource: {
                              ...f.resource,
                              plate: String(v.plate || ""),
                              unit_type: String(v.unit_type || ""),
                              capacity_t: String(v.capacity_tons || ""),
                            },
                          }));
                          // La unidad hereda su conductor habitual registrado en el catálogo.
                          const driver = context.personnel.find((p) => p.id === v.personnel_id);
                          if (driver) applyPerson(driver);
                        }
                      }}
                    >
                      <option value="">
                        Datos manuales / seleccione unidad
                      </option>
                      {context.vehicles
                        .filter((v) => v.supplier_id === form.supplier_id)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {String(v.plate)}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {service !== "OTROS" && (
                <label>
                  {personRole} del catálogo del proveedor
                  <select
                    className={input}
                    disabled={!form.supplier_id}
                    value={personId}
                    onChange={(e) => {
                      const v = context.personnel.find((p) => p.id === e.target.value);
                      if (v) applyPerson(v);
                      else setPersonId("");
                    }}
                  >
                    <option value="">
                      {!form.supplier_id
                        ? "Seleccione primero el proveedor"
                        : people.length
                          ? `Datos manuales / seleccione ${personRole.toLowerCase()}`
                          : `Sin ${personRole.toLowerCase()}es registrados: registre uno nuevo`}
                    </option>
                    {people.map((v) => (
                      <option key={v.id} value={v.id}>
                        {String(v.full_name)} · {String(v.document_number || "Sin documento")}
                      </option>
                    ))}
                  </select>
                  {form.supplier_id && !editing?.dispatch_id && (
                    <button type="button" className="text-sm text-blue-700 underline" onClick={() => setQuick({ kind: "person", data: {} })}>
                      + Registrar {personRole.toLowerCase()} nuevo
                    </button>
                  )}
                </label>
              )}
              {RESOURCE_FIELDS[service].map(([key, label, type]) => (
                <label
                  key={key}
                  className={key === "maneuver_review" ? "sm:col-span-2" : ""}
                >
                  {label}
                  <input
                    className={input}
                    type={type || "text"}
                    min={type === "number" ? "0" : undefined}
                    step={type === "number" ? "any" : undefined}
                    value={form.resource[key] || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        resource: { ...form.resource, [key]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.resource.documents_verified === "true"}
                onChange={(e) =>
                  setForm({
                    ...form,
                    resource: {
                      ...form.resource,
                      documents_verified: String(e.target.checked),
                    },
                  })
                }
              />
              Documentación revisada internamente y vigente para la atención. No
              implica consulta a una entidad externa.
            </label>
            <fieldset
              disabled={!!editing?.dispatch_id}
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
            >
              <legend className="px-1 font-semibold">Acuerdo económico</legend>
              <label>
                Moneda
                <select
                  className={input}
                  value={form.currency}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      currency: e.target.value,
                      exchange_rate: "1",
                    })
                  }
                >
                  <option>PEN</option>
                  <option>USD</option>
                </select>
              </label>
              <label>
                Tipo de cambio a PEN
                <input
                  required
                  disabled={form.currency === "PEN"}
                  type="number"
                  min="0.001"
                  step="any"
                  className={input}
                  value={form.exchange_rate}
                  onChange={(e) =>
                    setForm({ ...form, exchange_rate: e.target.value })
                  }
                />
              </label>
              <label>
                Monto total cotizado
                <input
                  required
                  className={input}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.quoted_amount}
                  onChange={(e) =>
                    setForm({ ...form, quoted_amount: e.target.value })
                  }
                />
              </label>
              <label>
                Monto total confirmado
                <input
                  className={input}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.confirmed_amount}
                  onChange={(e) =>
                    setForm({ ...form, confirmed_amount: e.target.value })
                  }
                />
              </label>
              <label className="sm:col-span-2">
                Unidad de cobro, alcance, impuestos, inclusiones y exclusiones
                <textarea
                  required
                  minLength={5}
                  className={input}
                  value={form.terms}
                  onChange={(e) => setForm({ ...form, terms: e.target.value })}
                />
              </label>
            </fieldset>
            {editing?.dispatch_id && (
              <label className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                <input
                  type="checkbox"
                  required
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                Autorizo actualizar los datos operativos del despacho{" "}
                {editing.dispatch_id}. El cambio y su motivo quedarán en ambos
                historiales; no altera el costo aprobado.
              </label>
            )}
            <label className="block">
              Motivo de registro / cambio
              <textarea
                required
                minLength={5}
                className={input}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <p className="text-sm text-amber-800">
              Editar un recurso aprobado reinicia su aprobación. Los recursos ya
              programados deben rectificarse desde su despacho.
            </p>
            <button disabled={busy} className={button}>
              {busy ? "Guardando…" : "Guardar asignación"}
            </button>
          </form>
        </Modal>
      )}
    </section>
    </>
  );
}
