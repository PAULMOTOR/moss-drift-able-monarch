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
import {
  generateApprovedLeaseContract,
  getLeadContractPacket,
  sendContractDocuSign,
} from "@/lib/crm/contracts";
import { emailFirstInvoice } from "@/lib/crm/server";
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
  const [contractPkt, setContractPkt] = useState<Awaited<
    ReturnType<typeof getLeadContractPacket>
  > | null>(null);
  const [showSendSign, setShowSendSign] = useState(false);
  const [signerEmail, setSignerEmail] = useState("");
  const [signerName, setSignerName] = useState("");
  const [contractStyle, setContractStyle] = useState("qc_individual_en");
  const [requireIdv, setRequireIdv] = useState(true);

  const load = useCallback(async () => {
    try {
      const pkg = await getCreditPackage({ data: { leadId } });
      setData(pkg);
      setAppEmail(pkg.lead.email || pkg.application.app_email || "");
      if (
        (pkg.lead.credit_status || "").toLowerCase() === "approved" ||
        (pkg.application.status || "").toLowerCase() === "approved"
      ) {
        const pkt = await getLeadContractPacket({ data: { leadId } }).catch(() => null);
        setContractPkt(pkt);
        if (pkt) {
          setSignerEmail(pkt.lesseeEmail || "");
          setSignerName(pkt.lesseeName || "");
          if (pkt.quote?.contract_style) setContractStyle(pkt.quote.contract_style);
        }
      } else {
        setContractPkt(null);
      }
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
  const isDealApproved =
    String(app.status || "").toLowerCase() === "approved" ||
    String(lead.credit_status || "").toLowerCase() === "approved";
  const appReady =
    app.status === "app_submitted" ||
    app.status === "ids_uploaded" ||
    app.status === "credit_requested" ||
    app.status === "in_review" ||
    app.status === "pending_gsm" ||
    isDealApproved;


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
          {isDealApproved && canStaff ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await generateApprovedLeaseContract({
                    data: { leadId, contractStyle },
                  });
                  toast.success("Lease contract generated");
                  if (res.pdfData) {
                    setViewDoc({ name: res.pdfName, data: res.pdfData });
                  }
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Generate failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Generate lease contract
            </Button>
          ) : null}
          {isDealApproved && canStaff ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowSendSign(true)}>
              Send for DocuSign
            </Button>
          ) : null}
        </div>
      </div>

      {isDealApproved ? (
        <div className="rounded-sm border-2 border-primary/40 bg-primary/5 p-3 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-primary">Lease contract (post-approval)</h4>
              <p className="text-xs text-muted-foreground">
                Deal is approved. Generate the ENG lease contract from the accepted quote, then send
                for DocuSign + Live ID. Requires a saved lease quote with an accepted option.
              </p>
            </div>
            <Badge variant="secondary">
              {contractPkt?.contractStatus === "sent_docusign"
                ? "Sent for signature"
                : contractPkt?.quote?.contract_pdf_name
                  ? "Contract ready"
                  : "Ready to generate"}
            </Badge>
          </div>
          <div className="grid gap-2 sm:max-w-sm">
            <div>
              <Label className="text-xs">Contract style</Label>
              <select
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={contractStyle}
                onChange={(e) => setContractStyle(e.target.value)}
              >
                {(
                  contractPkt?.styles || [
                    { key: "qc_individual_en", label: "Quebec Individual English" },
                    { key: "qc_business_en", label: "Quebec Business English" },
                    { key: "ca_individual_en", label: "Canada Individual lease" },
                    { key: "ca_business_en", label: "Canada Business lease" },
                    { key: "qc_individual_fr", label: "Quebec Individual French" },
                    { key: "qc_business_fr", label: "Quebec Business French" },
                  ]
                ).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await generateApprovedLeaseContract({
                    data: { leadId, contractStyle },
                  });
                  toast.success("Lease contract generated");
                  if (res.pdfData) {
                    setViewDoc({ name: res.pdfName, data: res.pdfData });
                  }
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Generate failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Generate lease contract
            </Button>
            {contractPkt?.quote?.contract_html ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) {
                    toast.error("Popup blocked");
                    return;
                  }
                  w.document.open();
                  w.document.write(contractPkt.quote!.contract_html!);
                  w.document.close();
                }}
              >
                View HTML contract
              </Button>
            ) : null}
            {contractPkt?.quote?.contract_pdf_data ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setViewDoc({
                    name: contractPkt.quote!.contract_pdf_name || "Lease-Contract.pdf",
                    data: contractPkt.quote!.contract_pdf_data!,
                  })
                }
              >
                View PDF
              </Button>
            ) : null}
            {contractPkt?.quote?.invoice_html ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const w = window.open("", "_blank");
                    if (!w) return;
                    w.document.open();
                    w.document.write(contractPkt.quote!.invoice_html!);
                    w.document.close();
                  }}
                >
                  First invoice
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !contractPkt.quote?.id}
                  onClick={async () => {
                    if (!contractPkt.quote?.id) return;
                    setBusy(true);
                    try {
                      const res = await emailFirstInvoice({
                        data: { quoteId: contractPkt.quote.id },
                      });
                      toast.success(`First invoice emailed to ${res.to}`);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Email failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Email 1st invoice
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setShowSendSign(true)}
            >
              Send for DocuSign
            </Button>
          </div>
          {contractPkt?.docusign && !contractPkt.docusign.configured ? (
            <p className="text-xs text-amber-800">
              DocuSign is not connected yet. Add the API keys on Vercel — generate still works without
              them.
            </p>
          ) : contractPkt?.docusign?.configured ? (
            <p className="text-xs text-muted-foreground">
              DocuSign connected
              {contractPkt.docusign.idvReady
                ? " · Live ID workflow ready"
                : " · Live ID workflow ID not set"}
            </p>
          ) : null}
          {contractPkt?.envelopes && contractPkt.envelopes.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {contractPkt.envelopes.map((e) => (
                <li key={e.id}>
                  {e.status} · {e.signer_email || "—"} · {e.envelope_id || "no id"}
                  {e.idv_enabled ? " · Live ID" : ""}
                  {e.error ? ` · ${e.error}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

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

      <Dialog open={showSendSign} onOpenChange={setShowSendSign}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send contract for DocuSign</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Sends the generated lease contract PDF for electronic signature. If Live ID is configured
            in DocuSign, the lessee must verify ID before signing.
          </p>
          <div>
            <Label>Lessee name</Label>
            <Input className="mt-1" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>
          <div>
            <Label>Lessee email</Label>
            <Input
              className="mt-1"
              type="email"
              value={signerEmail}
              onChange={(e) => setSignerEmail(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={requireIdv} onCheckedChange={(c) => setRequireIdv(c === true)} />
            Require Live ID (DocuSign Identity Verification)
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendSign(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await sendContractDocuSign({
                    data: {
                      leadId,
                      signerEmail,
                      signerName,
                      requireIdv,
                    },
                  });
                  toast.success(
                    `Sent via DocuSign${res.idvEnabled ? " with Live ID" : ""} · ${res.envelopeId}`,
                  );
                  setShowSendSign(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "DocuSign send failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send envelope
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
