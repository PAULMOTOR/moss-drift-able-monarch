import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Camera,
  ClipboardCheck,
  Plus,
  Search,
  Wrench,
} from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  completeInspection,
  createEstimate,
  listInspections,
  listWorkOrders,
  resolveVehicleByVin,
  startInspection,
  upsertWorkOrder,
} from "@/lib/crm/service";
import { getMyPermissions } from "@/lib/crm/permissions";
import { listProfiles } from "@/lib/crm/server";
import {
  SERVICE_BAYS,
  type Profile,
  type ServiceInspection,
  type ServiceWorkOrder,
} from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";

export const Route = createFileRoute("/service")({
  component: () => (
    <AuthGate>
      <ServicePage />
    </AuthGate>
  ),
});

const WO_STATUSES = [
  "all",
  "draft",
  "estimate",
  "pending_approval",
  "approved",
  "in_progress",
  "parts_ordered",
  "completed",
  "invoiced",
  "cancelled",
];

function ServicePage() {
  const [tab, setTab] = useState<"orders" | "inspect">("orders");
  const [orders, setOrders] = useState<ServiceWorkOrder[]>([]);
  const [inspections, setInspections] = useState<ServiceInspection[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [canAccess, setCanAccess] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showWo, setShowWo] = useState(false);
  const [showInsp, setShowInsp] = useState(false);
  const [showEst, setShowEst] = useState<ServiceWorkOrder | null>(null);

  // WO form
  const [vin, setVin] = useState("");
  const [vehicleLabel, setVehicleLabel] = useState("");
  const [inventoryId, setInventoryId] = useState<string | null>(null);
  const [customer, setCustomer] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [desc, setDesc] = useState("");
  const [bay, setBay] = useState("lift_1");
  const [assigned, setAssigned] = useState("");
  const [parts, setParts] = useState("");
  const [labor, setLabor] = useState("");

  // Inspection
  const [inspVin, setInspVin] = useState("");
  const [inspOdo, setInspOdo] = useState("");
  const [inspNotes, setInspNotes] = useState("");
  const [vinPhoto, setVinPhoto] = useState<{ name: string; data: string } | null>(null);
  const [vinMatches, setVinMatches] = useState<
    Array<{ id: string; vin: string | null; label: string; stock_number: string | null }>
  >([]);

  // Estimate lines
  const [estLines, setEstLines] = useState([{ desc: "Labour", qty: 1, unit: 120 }]);
  const [estEmail, setEstEmail] = useState("");

  const load = useCallback(async () => {
    try {
      const perms = await getMyPermissions();
      const access =
        perms.me.role === "admin" || perms.permissions.includes("service.access");
      setCanAccess(access);
      setCanManage(
        perms.me.role === "admin" || perms.permissions.includes("service.manage"),
      );
      if (!access) return;
      const [wos, people, ins] = await Promise.all([
        listWorkOrders({ data: { status, q: q || undefined } }),
        listProfiles({ data: {} }),
        listInspections({ data: {} }),
      ]);
      setOrders(wos);
      setProfiles(people.filter((p) => p.active));
      setInspections(ins);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load service");
    }
  }, [status, q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function lookupVin(raw: string, forInsp = false) {
    const v = raw.trim().toUpperCase();
    if (v.length < 6) {
      setVinMatches([]);
      return;
    }
    try {
      const matches = await resolveVehicleByVin({ data: { vin: v } });
      setVinMatches(matches);
      if (matches[0] && matches[0].vin?.toUpperCase() === v) {
        if (forInsp) {
          setInspVin(matches[0].vin || v);
        } else {
          setVin(matches[0].vin || v);
          setVehicleLabel(matches[0].label);
          setInventoryId(matches[0].id);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function onVinPhoto(file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      const data = String(reader.result || "");
      setVinPhoto({ name: file.name, data });
      // Try BarcodeDetector if available (rare for VIN stickers; still store photo)
      try {
        // @ts-expect-error experimental
        if (typeof window !== "undefined" && window.BarcodeDetector) {
          // @ts-expect-error experimental
          const detector = new window.BarcodeDetector({
            formats: ["code_39", "code_128", "qr_code", "data_matrix"],
          });
          const bmp = await createImageBitmap(file);
          const codes = await detector.detect(bmp);
          for (const c of codes) {
            const raw = String(c.rawValue || "").toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, "");
            if (raw.length >= 11) {
              setInspVin(raw.slice(0, 17));
              await lookupVin(raw.slice(0, 17), true);
              toast.success("VIN detected from barcode");
              return;
            }
          }
        }
      } catch {
        /* fall through */
      }
      toast.message("VIN photo saved — type or paste the VIN to match inventory");
    };
    reader.readAsDataURL(file);
  }

  if (!canAccess) {
    return (
      <>
        <PageHeader title="Service" description="Service department" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Your role does not have Service access. Ask an admin to enable it under Admin → Access.
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Service"
        description="Work orders, estimates, inspections, and shop bays — linked to inventory by VIN."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowInsp(true)}>
              <ClipboardCheck className="size-4" />
              New inspection
            </Button>
            {canManage ? (
              <Button
                size="sm"
                onClick={() => {
                  setVin("");
                  setVehicleLabel("");
                  setInventoryId(null);
                  setCustomer("");
                  setEmail("");
                  setPhone("");
                  setDesc("");
                  setShowWo(true);
                }}
              >
                <Plus className="size-4" />
                Work order
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            { id: "orders" as const, label: "Work orders" },
            { id: "inspect" as const, label: "Inspections" },
          ]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-sm font-semibold",
              tab === t.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "orders" ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search WO, VIN, customer…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WO_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "All statuses" : s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            {orders.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                  <Wrench className="size-8 opacity-40" />
                  No work orders yet.
                </CardContent>
              </Card>
            ) : (
              orders.map((wo) => (
                <Card key={wo.id}>
                  <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{wo.wo_number}</p>
                        <Badge variant="secondary">{wo.status.replace(/_/g, " ")}</Badge>
                        {wo.bay ? (
                          <span className="text-xs text-muted-foreground">
                            {SERVICE_BAYS.find((b) => b.id === wo.bay)?.label || wo.bay}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm">
                        {wo.vehicle_label || wo.vin || "No vehicle"}
                        {wo.customer_name ? ` · ${wo.customer_name}` : ""}
                      </p>
                      {wo.description ? (
                        <p className="mt-1 text-xs text-muted-foreground">{wo.description}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {wo.assigned_name ? `Tech: ${wo.assigned_name}` : "Unassigned"}
                        {wo.grand_total != null
                          ? ` · ${formatCurrency(wo.grand_total)}`
                          : ""}
                      </p>
                    </div>
                    {canManage ? (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setShowEst(wo)}>
                          Estimate
                        </Button>
                        <Select
                          value={wo.status}
                          onValueChange={async (v) => {
                            setBusy(true);
                            try {
                              await upsertWorkOrder({
                                data: {
                                  id: wo.id,
                                  status: v,
                                  inventory_id: wo.inventory_id,
                                  vin: wo.vin,
                                  vehicle_label: wo.vehicle_label,
                                  customer_name: wo.customer_name,
                                  customer_email: wo.customer_email,
                                  customer_phone: wo.customer_phone,
                                  description: wo.description,
                                  bay: wo.bay,
                                  assigned_to: wo.assigned_to,
                                  notes: wo.notes,
                                },
                              });
                              await load();
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : "Update failed");
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <SelectTrigger className="h-8 w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WO_STATUSES.filter((s) => s !== "all").map((s) => (
                              <SelectItem key={s} value={s}>
                                {s.replace(/_/g, " ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {inspections.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No inspections yet. Start one with a VIN (type, paste, or photo of the plate).
              </CardContent>
            </Card>
          ) : (
            inspections.map((i) => (
              <Card key={i.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-semibold">{i.vin}</p>
                    <Badge variant="secondary">{i.status}</Badge>
                  </div>
                  <p className="text-sm">{i.vehicle_label || "Not matched to inventory"}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.inspector_name || "—"}
                    {i.odometer != null ? ` · ${i.odometer} km` : ""}
                  </p>
                  {i.status === "in_progress" ? (
                    <Button
                      size="sm"
                      className="mt-2"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await completeInspection({
                            data: {
                              id: i.id,
                              findings: [
                                { area: "Overall", result: "pass", note: i.notes || "" },
                              ],
                            },
                          });
                          toast.success("Inspection completed");
                          await load();
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Mark complete
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* New WO */}
      <Dialog open={showWo} onOpenChange={setShowWo}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New work order</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>VIN (auto-matches inventory)</Label>
              <Input
                className="mt-1 font-mono uppercase"
                value={vin}
                onChange={(e) => {
                  setVin(e.target.value.toUpperCase());
                  void lookupVin(e.target.value);
                }}
                placeholder="Scan or type VIN"
              />
              {vehicleLabel ? (
                <p className="mt-1 text-xs text-primary">{vehicleLabel}</p>
              ) : null}
              {vinMatches.length > 1 ? (
                <ul className="mt-1 space-y-1 text-xs">
                  {vinMatches.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="text-left text-primary underline"
                        onClick={() => {
                          setVin(m.vin || vin);
                          setVehicleLabel(m.label);
                          setInventoryId(m.id);
                        }}
                      >
                        {m.label} {m.stock_number ? `(${m.stock_number})` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>Customer</Label>
                <Input className="mt-1" value={customer} onChange={(e) => setCustomer(e.target.value)} />
              </div>
              <div>
                <Label>Phone</Label>
                <Input className="mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Email (for estimate approval)</Label>
              <Input className="mt-1" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label>Job description</Label>
              <Textarea className="mt-1" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>Bay / lift</Label>
                <Select value={bay} onValueChange={setBay}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_BAYS.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Assign tech</Label>
                <Select value={assigned || "none"} onValueChange={(v) => setAssigned(v === "none" ? "" : v)}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {profiles
                      .filter((p) => p.role === "service" || p.role === "admin")
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>Parts $</Label>
                <Input className="mt-1" type="number" value={parts} onChange={(e) => setParts(e.target.value)} />
              </div>
              <div>
                <Label>Labour $</Label>
                <Input className="mt-1" type="number" value={labor} onChange={(e) => setLabor(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWo(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await upsertWorkOrder({
                    data: {
                      vin: vin || null,
                      inventory_id: inventoryId,
                      vehicle_label: vehicleLabel || null,
                      customer_name: customer || null,
                      customer_email: email || null,
                      customer_phone: phone || null,
                      description: desc || null,
                      bay,
                      assigned_to: assigned || null,
                      parts_total: parts ? Number(parts) : null,
                      labor_total: labor ? Number(labor) : null,
                      status: "draft",
                    },
                  });
                  toast.success("Work order created");
                  setShowWo(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inspection */}
      <Dialog open={showInsp} onOpenChange={setShowInsp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start inspection</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>VIN</Label>
              <Input
                className="mt-1 font-mono uppercase"
                value={inspVin}
                onChange={(e) => {
                  setInspVin(e.target.value.toUpperCase());
                  void lookupVin(e.target.value, true);
                }}
                placeholder="Type, paste, or detect from photo"
              />
              {vinMatches[0] ? (
                <p className="mt-1 text-xs text-primary">{vinMatches[0].label}</p>
              ) : null}
            </div>
            <div>
              <Label className="flex items-center gap-2">
                <Camera className="size-4" />
                Photo of VIN plate (optional)
              </Label>
              <Input
                type="file"
                accept="image/*"
                capture="environment"
                className="mt-1"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onVinPhoto(f);
                }}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Camera opens on phone. If a barcode is readable we try to fill the VIN; otherwise enter it
                once and we attach the photo to the inspection history.
              </p>
            </div>
            <div>
              <Label>Odometer (km)</Label>
              <Input
                className="mt-1"
                type="number"
                value={inspOdo}
                onChange={(e) => setInspOdo(e.target.value)}
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                className="mt-1"
                rows={2}
                value={inspNotes}
                onChange={(e) => setInspNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInsp(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || inspVin.trim().length < 11}
              onClick={async () => {
                setBusy(true);
                try {
                  await startInspection({
                    data: {
                      vin: inspVin,
                      inventory_id: vinMatches[0]?.id || null,
                      odometer: inspOdo ? Number(inspOdo) : null,
                      notes: inspNotes || null,
                      vin_photo_name: vinPhoto?.name || null,
                      vin_photo_data: vinPhoto?.data || null,
                    },
                  });
                  toast.success("Inspection started");
                  setShowInsp(false);
                  setTab("inspect");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Start
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Estimate */}
      <Dialog open={!!showEst} onOpenChange={(o) => !o && setShowEst(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Estimate — {showEst?.wo_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {estLines.map((line, i) => (
              <div key={i} className="grid grid-cols-[1fr_4rem_5rem] gap-2">
                <Input
                  value={line.desc}
                  onChange={(e) => {
                    const next = [...estLines];
                    next[i] = { ...line, desc: e.target.value };
                    setEstLines(next);
                  }}
                />
                <Input
                  type="number"
                  value={line.qty}
                  onChange={(e) => {
                    const next = [...estLines];
                    next[i] = { ...line, qty: Number(e.target.value) };
                    setEstLines(next);
                  }}
                />
                <Input
                  type="number"
                  value={line.unit}
                  onChange={(e) => {
                    const next = [...estLines];
                    next[i] = { ...line, unit: Number(e.target.value) };
                    setEstLines(next);
                  }}
                />
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEstLines((l) => [...l, { desc: "", qty: 1, unit: 0 }])}
            >
              Add line
            </Button>
            <div>
              <Label>Customer email</Label>
              <Input
                className="mt-1"
                value={estEmail || showEst?.customer_email || ""}
                onChange={(e) => setEstEmail(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (!showEst) return;
                setBusy(true);
                try {
                  await createEstimate({
                    data: {
                      work_order_id: showEst.id,
                      line_items: estLines,
                      send_internal: true,
                    },
                  });
                  toast.success("Sent for internal approval");
                  setShowEst(null);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send to team
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!showEst) return;
                const to = estEmail || showEst.customer_email;
                if (!to) {
                  toast.error("Customer email required");
                  return;
                }
                setBusy(true);
                try {
                  const res = await createEstimate({
                    data: {
                      work_order_id: showEst.id,
                      line_items: estLines,
                      send_customer: true,
                      send_to_email: to,
                    },
                  });
                  toast.success(`Customer link ready · $${res.total.toFixed(2)}`);
                  setShowEst(null);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Email customer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-6 text-xs text-muted-foreground">
        Schedule jobs on the{" "}
        <Link to="/calendar" className="text-primary underline">
          team calendar
        </Link>{" "}
        (type: Repair / Detailing) so lifts and techs stay visible.
      </p>
    </>
  );
}
