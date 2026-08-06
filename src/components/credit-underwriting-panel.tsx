import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  approveDealGsm,
  getCreditPackage,
  requestCreditApp,
  requestCreditReview,
  requestGsmApproval,
  requestLesseeDocument,
  updateChecklistItem,
} from "@/lib/crm/credit";
import type { Profile } from "@/lib/crm/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

export function CreditUnderwritingPanel({
  leadId,
  me,
}: {
  leadId: string;
  me: Profile;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getCreditPackage>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [appEmail, setAppEmail] = useState("");
  const [showRequestApp, setShowRequestApp] = useState(false);
  const [showCreditReq, setShowCreditReq] = useState(false);
  const [creditNotes, setCreditNotes] = useState("");
  const [doNotPull, setDoNotPull] = useState(false);
  const [equifaxName, setEquifaxName] = useState<string | null>(null);
  const [equifaxData, setEquifaxData] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<{ name: string; data: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const pkg = await getCreditPackage({ data: { leadId } });
      setData(pkg);
      setAppEmail(pkg.lead.email || pkg.application.app_email || "");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load credit package");
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return <div className="h-24 animate-pulse rounded-sm bg-muted" />;
  }

  const { application: app, documents, checklist, lead } = data;
  const canStaff = ["admin", "rep", "gsm", "credit_manager"].includes(me.role);
  const canCustomerChecklist = ["admin", "credit_manager", "gsm"].includes(me.role);
  const canApprove = ["admin", "gsm"].includes(me.role);
  const vehicleItems = checklist.filter((c) => c.section === "vehicle");
  const customerItems = checklist.filter((c) => c.section === "customer");
  const appReady =
    app.status === "app_submitted" ||
    app.status === "ids_uploaded" ||
    app.status === "credit_requested" ||
    app.status === "in_review" ||
    app.status === "pending_gsm" ||
    app.status === "approved";

  return (
    <div className="space-y-4 rounded-sm border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-semibold text-primary">
            Credit underwriting
          </h3>
          <p className="text-xs text-muted-foreground">
            Status: <Badge variant="secondary">{app.status.replace(/_/g, " ")}</Badge>
            {" · "}
            Client: {lead.party_type === "business" ? "Business" : "Individual"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canStaff ? (
            <Button size="sm" onClick={() => setShowRequestApp(true)}>
              Request App & IDs
            </Button>
          ) : null}
          {canStaff && appReady ? (
            <Button size="sm" variant="secondary" onClick={() => setShowCreditReq(true)}>
              Get Credit Approval
            </Button>
          ) : null}
          {canStaff && app.vehicle_checklist_complete && app.customer_checklist_complete ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await requestGsmApproval({ data: { leadId } });
                  toast.success("GSM + Admins notified");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Request GSM Approval
            </Button>
          ) : null}
          {canApprove && app.status === "pending_gsm" ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await approveDealGsm({ data: { leadId, approve: true } });
                    toast.success("Deal approved");
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Approve deal
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await approveDealGsm({ data: { leadId, approve: false } });
                    toast.message("Deal declined");
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Decline
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {data.appLink ? (
        <p className="break-all text-xs text-muted-foreground">
          Lessee app link:{" "}
          <a className="text-primary underline" href={data.appLink} target="_blank" rel="noreferrer">
            {data.appLink}
          </a>
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChecklistSection
          title="Vehicle portion (Salesman)"
          items={vehicleItems}
          canEdit={canStaff && me.role !== "broker"}
          onSave={async (itemKey, notes, done) => {
            await updateChecklistItem({
              data: { applicationId: app.id, itemKey, notes, done },
            });
            await load();
          }}
        />
        <ChecklistSection
          title="Customer portion (Credit Manager)"
          items={customerItems}
          canEdit={canCustomerChecklist}
          onSave={async (itemKey, notes, done) => {
            await updateChecklistItem({
              data: { applicationId: app.id, itemKey, notes, done },
            });
            await load();
          }}
          extraActions={
            canCustomerChecklist ? (
              <div className="mb-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await requestLesseeDocument({
                        data: { leadId, kind: "noa_payslip" },
                      });
                      toast.success("NOA/payslip request emailed to lessee");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Request Doc from Lessee (NOA)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await requestLesseeDocument({
                        data: { leadId, kind: "bank_statement" },
                      });
                      toast.success("Bank statement request emailed to lessee");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Request Doc from Lessee (Bank)
                </Button>
              </div>
            ) : null
          }
        />
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">Documents</h4>
        {documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No documents yet.</p>
        ) : (
          <ul className="space-y-1">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <Badge variant="outline" className="mr-2 text-[10px]">
                    {d.kind}
                  </Badge>
                  {d.file_name}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewDoc({ name: d.file_name, data: d.file_data })}
                >
                  View
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {app.credit_request_notes ? (
        <p className="text-xs text-muted-foreground">
          Rep notes to credit: {app.credit_request_notes}
          {app.do_not_pull_credit ? " · Do not pull credit" : ""}
        </p>
      ) : null}

      {app.payload && Object.keys(app.payload).length > 0 ? (
        <details className="rounded-sm border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Submitted credit application answers
          </summary>
          <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-2">
            {Object.entries(app.payload)
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex gap-2 border-b border-border/60 py-1">
                  <dt className="w-36 shrink-0 font-medium text-muted-foreground">
                    {k.replace(/_/g, " ")}
                  </dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}

      <Dialog open={showRequestApp} onOpenChange={setShowRequestApp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request App & IDs</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will send a link to the following email asking the recipient to fill out our
            credit app and upload IDs.
          </p>
          <div>
            <Label>Email</Label>
            <Input
              className="mt-1"
              value={appEmail}
              onChange={(e) => setAppEmail(e.target.value)}
              placeholder="client@email.com"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRequestApp(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await requestCreditApp({
                    data: { leadId, email: appEmail },
                  });
                  toast.success(`Sent to ${res.email}`);
                  setShowRequestApp(false);
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

      <Dialog open={showCreditReq} onOpenChange={setShowCreditReq}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Get Credit Approval</DialogTitle>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={doNotPull} onCheckedChange={(c) => setDoNotPull(c === true)} />
            Do not pull credit
          </label>
          {doNotPull ? (
            <div>
              <Label>Upload Equifax file (optional)</Label>
              <Input
                type="file"
                className="mt-1"
                accept=".pdf,image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const r = new FileReader();
                  r.onload = () => {
                    setEquifaxName(f.name);
                    setEquifaxData(String(r.result));
                  };
                  r.readAsDataURL(f);
                }}
              />
              {equifaxName ? (
                <p className="mt-1 text-xs text-muted-foreground">{equifaxName}</p>
              ) : null}
            </div>
          ) : null}
          <div>
            <Label>Notes to Credit Manager</Label>
            <Textarea
              className="mt-1"
              value={creditNotes}
              onChange={(e) => setCreditNotes(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreditReq(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await requestCreditReview({
                    data: {
                      leadId,
                      notes: creditNotes,
                      doNotPullCredit: doNotPull,
                      equifaxFileName: equifaxName,
                      equifaxFileData: equifaxData,
                    },
                  });
                  toast.success("Credit Manager notified");
                  setShowCreditReq(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
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

      <Dialog open={!!viewDoc} onOpenChange={(o) => !o && setViewDoc(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{viewDoc?.name}</DialogTitle>
          </DialogHeader>
          {viewDoc?.data?.startsWith("data:image") ? (
            <img src={viewDoc.data} alt={viewDoc.name} className="max-h-[70vh] w-full object-contain" />
          ) : viewDoc?.data?.startsWith("data:application/pdf") ? (
            <iframe title={viewDoc.name} src={viewDoc.data} className="h-[70vh] w-full" />
          ) : (
            <p className="text-sm text-muted-foreground">Preview not available for this file type.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChecklistSection({
  title,
  items,
  canEdit,
  onSave,
  extraActions,
}: {
  title: string;
  items: {
    id: string;
    item_key: string;
    label: string;
    notes: string;
    done: boolean;
  }[];
  canEdit: boolean;
  onSave: (key: string, notes: string, done: boolean) => Promise<void>;
  extraActions?: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-border p-3">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      {extraActions}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="text-sm">
            <label className="flex items-start gap-2">
              <Checkbox
                checked={item.done}
                disabled={!canEdit}
                onCheckedChange={(c) => {
                  void onSave(item.item_key, item.notes, c === true);
                }}
              />
              <span className="font-medium leading-snug">{item.label}</span>
            </label>
            <Textarea
              className="mt-1 min-h-[52px] text-xs"
              placeholder="Notes…"
              defaultValue={item.notes}
              disabled={!canEdit}
              onBlur={(e) => {
                if (e.target.value !== item.notes) {
                  void onSave(item.item_key, e.target.value, item.done);
                }
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
