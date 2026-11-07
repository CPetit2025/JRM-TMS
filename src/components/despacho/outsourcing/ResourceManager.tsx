"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/caja";
import { usePermissions } from "@/hooks/usePermissions";
import {
  OUTSOURCING_SERVICES,
  type OutsourcingService,
} from "@/lib/outsourcing";
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
  onManaged: (value: boolean) => void;
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
    [ack, setAck] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await db.rpc("outsourcing_assignment_context", {
      p_id: parent,
    });
    if (error) setError(errorMessage(error));
    else {
      setContext(data);
      onManaged(
        data.assignments.some((a: AssignedResource) => a.state !== "CANCELLED"),
      );
      setError("");
    }
  }, [db, parent, onManaged]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const assignments =
      context?.assignments.filter((a) => a.service === service) || [],
    supplier = context?.suppliers.find((s) => s.id === form.supplier_id);
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
  return (
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
                Proveedor
                <select
                  aria-label="Proveedor"
                  disabled={!!editing?.dispatch_id}
                  required
                  className={input}
                  value={form.supplier_id}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      supplier_id: e.target.value,
                      resource: {
                        origin: form.resource.origin || "",
                        destination: form.resource.destination || "",
                      },
                    })
                  }
                >
                  <option value="">Seleccione proveedor activo</option>
                  {context.suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.business_name} · {s.tax_id || "Sin RUC"}
                    </option>
                  ))}
                </select>
              </label>
              <p className="self-center text-sm text-slate-600">
                {supplier &&
                  [
                    supplier.contact_name,
                    supplier.contact_phone,
                    supplier.contact_email,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
              </p>
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
                        if (v)
                          setForm({
                            ...form,
                            resource: {
                              ...form.resource,
                              plate: String(v.plate || ""),
                              unit_type: String(v.unit_type || ""),
                              capacity_t: String(v.capacity_tons || ""),
                            },
                          });
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
                  <label>
                    Conductor del catálogo (opcional)
                    <select
                      className={input}
                      defaultValue=""
                      onChange={(e) => {
                        const v = context.personnel.find(
                          (v) => v.id === e.target.value,
                        );
                        if (v)
                          setForm({
                            ...form,
                            resource: {
                              ...form.resource,
                              driver: String(v.full_name || ""),
                              document: String(v.document_number || ""),
                              phone: String(v.phone || ""),
                              license: String(v.license_number || ""),
                              license_expiration: String(
                                v.license_expiration || "",
                              ),
                            },
                          });
                      }}
                    >
                      <option value="">
                        Datos manuales / seleccione conductor
                      </option>
                      {context.personnel
                        .filter((v) => v.supplier_id === form.supplier_id)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {String(v.full_name)}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
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
  );
}
