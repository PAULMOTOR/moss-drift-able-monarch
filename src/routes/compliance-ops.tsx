import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FileUp, Mail, ShieldCheck } from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  emailTitleToBank,
  listLiens,
  listOwnershipQueue,
  uploadOwnershipDoc,
  upsertLien,
} from "@/lib/crm/compliance-ops";
import { getMyPermissions } from "@/lib/crm/permissions";
import { TITLE_BANKS, type OwnershipRecord, type VehicleLien } from "@/lib/crm/types";
import { cn, formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/compliance-ops")({
  validateSearch: (s: Record<string, unknown>) => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  component: () => (
    <AuthGate>
      <ComplianceOpsPage />
    </AuthGate>
  ),
});

function ComplianceOpsPage() {
  const search = Route.useSearch();
  const [tab, setTab] = useState<"ownership" | "liens">(
    search.tab === "liens" ? "liens" : "ownership",
  );
  const [ownership, setOwnership] = useState<OwnershipRecord[]>([]);
  const [liens, setLiens] = useState<VehicleLien[]>([]);
  const [canOps, setCanOps] = useState(false);
  const [canLiens, setCanLiens] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mailFor, setMailFor] = useState<OwnershipRecord | null>(null);
  const [bank, setBank] = useState("cibc");
  const [toEmail, setToEmail] = useState<string>(TITLE_BANKS[0]!.email);
  const [lienEdit, setLienEdit] = useState<VehicleLien | null>(null);

  const load = useCallback(async () => {
    try {
      const perms = await getMyPermissions();
      const ops =
        perms.me.role === "admin" || perms.permissions.includes("compliance.ops");
      const liensOk =
        perms.me.role === "admin" || perms.permissions.includes("liens.manage");
      setCanOps(ops);
      setCanLiens(liensOk);
      if (ops) setOwnership(await listOwnershipQueue());
      if (liensOk) setLiens(await listLiens({ data: { status: "all" } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const meta = TITLE_BANKS.find((b) => b.id === bank);
    if (meta?.email) setToEmail(meta.email);
    else if (bank !== "other") setToEmail("");
  }, [bank]);

  if (!canOps && !canLiens) {
    return (
      <>
        <PageHeader title="Compliance ops" description="Ownerships, titles & liens" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No compliance permissions on your account.
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Compliance ops"
        description="Ownership uploads, email title to bank, and lien registration — for Maxime, Kelly, and ops."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {canOps ? (
          <button
            type="button"
            onClick={() => setTab("ownership")}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-sm font-semibold",
              tab === "ownership"
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card",
            )}
          >
            Missing ownerships
          </button>
        ) : null}
        {canLiens ? (
          <button
            type="button"
            onClick={() => setTab("liens")}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-sm font-semibold",
              tab === "liens"
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card",
            )}
          >
            Liens
          </button>
        ) : null}
      </div>

      {tab === "ownership" && canOps ? (
        <div className="space-y-2">
          {ownership.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-12 text-sm text-muted-foreground">
                <ShieldCheck className="size-8 opacity-40" />
                All tracked deals have ownership uploaded.
              </CardContent>
            </Card>
          ) : (
            ownership.map((o) => (
              <Card key={o.id}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold">
                      <Link
                        to="/leads/$leadId"
                        params={{ leadId: o.lead_id }}
                        search={{ tab: "compliance" }}
                        className="text-primary underline"
                      >
                        {o.lead_name || o.lead_id}
                      </Link>
                    </p>
                    <p className="text-sm">{o.vehicle_label || o.vin || "—"}</p>
                    <p className="text-xs text-muted-foreground">
                      Signed {o.signed_at ? formatDateTime(o.signed_at) : "—"}
                      {o.title_emailed_at
                        ? ` · Title emailed to ${o.title_emailed_to}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="inline-flex">
                      <Button size="sm" variant="outline" asChild>
                        <span>
                          <FileUp className="size-4" />
                          Upload ownership
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*,.pdf"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (!f) return;
                              setBusy(true);
                              try {
                                const data = await new Promise<string>((res, rej) => {
                                  const r = new FileReader();
                                  r.onload = () => res(String(r.result));
                                  r.onerror = () => rej(new Error("read failed"));
                                  r.readAsDataURL(f);
                                });
                                await uploadOwnershipDoc({
                                  data: {
                                    leadId: o.lead_id,
                                    file_name: f.name,
                                    file_data: data,
                                  },
                                });
                                toast.success("Ownership uploaded");
                                await load();
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Upload failed",
                                );
                              } finally {
                                setBusy(false);
                              }
                            }}
                          />
                        </span>
                      </Button>
                    </label>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setMailFor(o);
                        setBank("cibc");
                        setToEmail("mailbox.waomail@cibc.com");
                      }}
                    >
                      <Mail className="size-4" />
                      Email Title to Bank
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {tab === "liens" && canLiens ? (
        <div className="space-y-2">
          <div className="mb-2 flex justify-end">
            <Button
              size="sm"
              onClick={() =>
                setLienEdit({
                  id: "",
                  lead_id: null,
                  inventory_id: null,
                  vin: "",
                  vehicle_label: "",
                  lienholder: "Paul Motor Leasing",
                  registration_province: "QC",
                  registered_at: null,
                  registration_ref: null,
                  notes: null,
                  status: "pending",
                  signed_lease_at: null,
                  created_at: "",
                  updated_at: "",
                })
              }
            >
              Add lien record
            </Button>
          </div>
          {liens.map((l) => (
            <Card key={l.id}>
              <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{l.vehicle_label || l.vin || "Unit"}</p>
                    <Badge
                      variant={l.status === "registered" ? "default" : "secondary"}
                    >
                      {l.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {l.registration_province || "—"} · {l.lienholder || "—"}
                    {l.registration_ref ? ` · ref ${l.registration_ref}` : ""}
                    {l.signed_lease_at
                      ? ` · lease ${String(l.signed_lease_at).slice(0, 10)}`
                      : ""}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setLienEdit(l)}>
                  Edit
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Email title dialog */}
      <Dialog open={!!mailFor} onOpenChange={(o) => !o && setMailFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email Title to Bank</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {mailFor?.vehicle_label || mailFor?.vin} · {mailFor?.lead_name}
            </p>
            <div>
              <Label>Bank</Label>
              <Select value={bank} onValueChange={setBank}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TITLE_BANKS.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Email address</Label>
              <Input
                className="mt-1"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="bank mailbox@…"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Default CIBC: mailbox.waomail@cibc.com — set RBC/BMO when you have their mailbox.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMailFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !toEmail}
              onClick={async () => {
                if (!mailFor) return;
                setBusy(true);
                try {
                  await emailTitleToBank({
                    data: {
                      leadId: mailFor.lead_id,
                      bank,
                      to_email: toEmail,
                    },
                  });
                  toast.success("Title emailed to bank");
                  setMailFor(null);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Send failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lien editor */}
      <Dialog open={!!lienEdit} onOpenChange={(o) => !o && setLienEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{lienEdit?.id ? "Edit lien" : "New lien"}</DialogTitle>
          </DialogHeader>
          {lienEdit ? (
            <div className="space-y-2">
              <div>
                <Label>Vehicle label</Label>
                <Input
                  className="mt-1"
                  value={lienEdit.vehicle_label || ""}
                  onChange={(e) =>
                    setLienEdit({ ...lienEdit, vehicle_label: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>VIN</Label>
                <Input
                  className="mt-1 font-mono"
                  value={lienEdit.vin || ""}
                  onChange={(e) => setLienEdit({ ...lienEdit, vin: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Province</Label>
                  <Input
                    className="mt-1"
                    value={lienEdit.registration_province || ""}
                    onChange={(e) =>
                      setLienEdit({
                        ...lienEdit,
                        registration_province: e.target.value,
                      })
                    }
                    placeholder="QC / ON"
                  />
                </div>
                <div>
                  <Label>Status</Label>
                  <Select
                    value={lienEdit.status}
                    onValueChange={(v) => setLienEdit({ ...lienEdit, status: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="registered">Registered</SelectItem>
                      <SelectItem value="released">Released</SelectItem>
                      <SelectItem value="n_a">N/A</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Registration ref / RDPRM #</Label>
                <Input
                  className="mt-1"
                  value={lienEdit.registration_ref || ""}
                  onChange={(e) =>
                    setLienEdit({ ...lienEdit, registration_ref: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>Registered date</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={lienEdit.registered_at || ""}
                  onChange={(e) =>
                    setLienEdit({ ...lienEdit, registered_at: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>Lead ID (optional)</Label>
                <Input
                  className="mt-1 font-mono text-xs"
                  value={lienEdit.lead_id || ""}
                  onChange={(e) =>
                    setLienEdit({ ...lienEdit, lead_id: e.target.value || null })
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLienEdit(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !lienEdit}
              onClick={async () => {
                if (!lienEdit) return;
                setBusy(true);
                try {
                  await upsertLien({
                    data: {
                      id: lienEdit.id || undefined,
                      lead_id: lienEdit.lead_id,
                      vin: lienEdit.vin,
                      vehicle_label: lienEdit.vehicle_label,
                      lienholder: lienEdit.lienholder,
                      registration_province: lienEdit.registration_province,
                      registered_at: lienEdit.registered_at,
                      registration_ref: lienEdit.registration_ref,
                      notes: lienEdit.notes,
                      status: lienEdit.status,
                    },
                  });
                  toast.success("Lien saved");
                  setLienEdit(null);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Save failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
