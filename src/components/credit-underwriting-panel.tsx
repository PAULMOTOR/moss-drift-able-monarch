import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import {
  addGuarantor,
  approveDealGsm,
  deleteCreditDocument,
  getCreditPackage,
  requestCreditApp,
  requestCreditReview,
  requestGsmApproval,
  requestLesseeDocument,
  swapCreditParties,
  updateChecklistItem,
  uploadChecklistDocument,
  uploadDealDocument,
} from "@/lib/crm/credit";
import {
  listUnderwriteReports,
  runAiUnderwrite,
  type UnderwriteReport,
} from "@/lib/crm/underwrite";
import {
  generateApprovedLeaseContract,
  getLeadContractPacket,
  sendContractDocuSign,
} from "@/lib/crm/contracts";
import { emailFirstInvoice } from "@/lib/crm/server";
import {
  LESSEE_DOC_TYPES,
  STAFF_UPLOAD_DOC_TYPES,
  checklistDef,
  lesseeDocLabel,
  type ChecklistDef,
  type Profile,
} from "@/lib/crm/types";
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
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [declineNotify, setDeclineNotify] = useState<"sales" | "credit" | "both">("both");
  const [showApprove, setShowApprove] = useState(false);
  const [approveNext, setApproveNext] = useState("");
  const [notifyPartner, setNotifyPartner] = useState(true);
  const [notifyLessee, setNotifyLessee] = useState(false);
  const [showRequestDocs, setShowRequestDocs] = useState(false);
  const [docKinds, setDocKinds] = useState<string[]>([]);
  const [uploadKind, setUploadKind] = useState<string>("other");
  const [docEmail, setDocEmail] = useState("");
  const [uwReports, setUwReports] = useState<UnderwriteReport[]>([]);
  const [uwBusy, setUwBusy] = useState(false);
  const [uwError, setUwError] = useState("");
  const uwCardRef = useRef<HTMLDivElement>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [showAddGuar, setShowAddGuar] = useState(false);
  const [guarName, setGuarName] = useState("");
  const [guarEmail, setGuarEmail] = useState("");
  const [guarPhone, setGuarPhone] = useState("");
  const selectedAppIdRef = useRef<string | null>(null);
  selectedAppIdRef.current = selectedAppId;

  const load = useCallback(async () => {
    try {
      const pkg = await getCreditPackage({ data: { leadId } });
      setData(pkg);
      const ids = [pkg.application.id, ...(pkg.guarantors || []).map((g) => g.id)];
      const cur = selectedAppIdRef.current;
      const nextId = cur && ids.includes(cur) ? cur : pkg.application.id;
      setSelectedAppId(nextId);
      const focus =
        (pkg.guarantors || []).find((g) => g.id === nextId) || pkg.application;
      setAppEmail(focus.applicant_email || focus.app_email || pkg.lead.email || "");
      setDocEmail(focus.applicant_email || focus.app_email || pkg.lead.email || "");
      if (["admin", "gsm", "credit_manager"].includes(me.role)) {
        const reps = await listUnderwriteReports({ data: { leadId } }).catch(
          (): UnderwriteReport[] => [],
        );
        setUwReports(reps);
      }
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

  const { application: primaryApp, documents: allDocs, lead } = data;
  const guarantors = data.guarantors || [];
  const selected =
    guarantors.find((g) => g.id === selectedAppId) ||
    (primaryApp.id === selectedAppId ? primaryApp : primaryApp);
  const app = selected;
  const isGuarantorView = app.applicant_role === "guarantor";
  const checklistsByApp = data.checklistsByApp || {};
  const partyChecks = checklistsByApp[app.id] || data.checklist;
  const primaryChecks = checklistsByApp[primaryApp.id] || data.checklist;
  const documents = allDocs.filter((d) => d.application_id === app.id);
  const canStaff = ["admin", "rep", "gsm", "credit_manager"].includes(me.role);
  const canUpload = canStaff;
  const canCustomerChecklist = ["admin", "credit_manager", "gsm"].includes(me.role);
  const canApprove = ["admin", "gsm"].includes(me.role);
  const canDeleteDocs = ["admin", "gsm"].includes(me.role);
  const canSwap = ["admin", "gsm", "credit_manager"].includes(me.role);
  const vehicleItems = (isGuarantorView ? primaryChecks : partyChecks).filter((c) => c.section === "vehicle");
  const customerItems = partyChecks.filter((c) => c.section === "customer");
  const isDealApproved =
    String(primaryApp.status || "").toLowerCase() === "approved" ||
    String(lead.credit_status || "").toLowerCase() === "approved";
  const appReady =
    primaryApp.status === "app_submitted" ||
    primaryApp.status === "ids_uploaded" ||
    primaryApp.status === "credit_requested" ||
    primaryApp.status === "in_review" ||
    primaryApp.status === "pending_gsm" ||
    isDealApproved;

  async function readFile(file: File): Promise<string> {
    if (file.size > 6 * 1024 * 1024) throw new Error("File must be under 6 MB");
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Read failed"));
      r.readAsDataURL(file);
    });
  }

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
            {isGuarantorView ? " · viewing guarantor" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canStaff ? (
            <Button size="sm" onClick={() => setShowRequestApp(true)}>
              Request App & IDs
            </Button>
          ) : null}
          {canStaff ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDocKinds([]);
                setDocEmail(app.applicant_email || app.app_email || lead.email || "");
                setShowRequestDocs(true);
              }}
            >
              Request Docs
            </Button>
          ) : null}
          {canStaff && appReady ? (
            <Button size="sm" variant="secondary" onClick={() => setShowCreditReq(true)}>
              Get Credit Approval
            </Button>
          ) : null}
          {canStaff && primaryApp.vehicle_checklist_complete && primaryApp.customer_checklist_complete ? (
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
          {canApprove ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || uwBusy}
              onClick={async () => {
                setUwBusy(true);
                setUwError("");
                toast.message("Reading the file and documents — this can take a minute");
                try {
                  const report = await runAiUnderwrite({ data: { leadId } });
                  setUwReports((prev) => [report, ...prev.filter((r) => r.id !== report.id)]);
                  toast.success("Underwrite ready — it read the file and the documents");
                } catch (e) {
                  const msg = underwriteErr(e);
                  setUwError(msg);
                  toast.error(msg);
                  for (let i = 0; i < 8; i += 1) {
                    await new Promise((r) => setTimeout(r, 8000));
                    const reps = await listUnderwriteReports({ data: { leadId } }).catch(
                      (): UnderwriteReport[] => [],
                    );
                    if (!reps.length) continue;
                    setUwReports(reps);
                    if (reps[0] && !/Reading the file/.test(reps[0].summary || "")) {
                      setUwError("");
                      toast.success("Underwrite ready");
                      break;
                    }
                  }
                } finally {
                  setUwBusy(false);
                  requestAnimationFrame(() =>
                    uwCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
                  );
                }
              }}
            >
              {uwBusy ? "Reading file…" : "Run AI underwrite"}
            </Button>
          ) : null}
          {canApprove && app.status === "pending_gsm" ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setApproveNext("");
                  setNotifyPartner(true);
                  setNotifyLessee(false);
                  setShowApprove(true);
                }}
              >
                Approve deal
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setDeclineReason("");
                  setDeclineNotify("both");
                  setShowDecline(true);
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

      <div ref={uwCardRef} className="space-y-2">
        {uwBusy ? (
          <div className="rounded-sm border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Reading the file and documents — stay on this tab. The result appears here.
          </div>
        ) : null}
        {uwError && !uwBusy ? (
          <div className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-950">
            {uwError}
          </div>
        ) : null}
        {uwReports[0] ? <UnderwriteCard report={uwReports[0]} /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-muted/30 px-2 py-2">
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Parties
        </span>
        <button
          type="button"
          className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
            !isGuarantorView
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background hover:bg-muted"
          }`}
          onClick={() => {
            setSelectedAppId(primaryApp.id);
            setAppEmail(primaryApp.applicant_email || primaryApp.app_email || lead.email || "");
            setDocEmail(primaryApp.applicant_email || primaryApp.app_email || lead.email || "");
          }}
        >
          Primary · {primaryApp.applicant_name || lead.name}
        </button>
        {guarantors.map((g) => (
          <button
            key={g.id}
            type="button"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              selectedAppId === g.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:bg-muted"
            }`}
            onClick={() => {
              setSelectedAppId(g.id);
              setAppEmail(g.applicant_email || g.app_email || "");
              setDocEmail(g.applicant_email || g.app_email || "");
            }}
          >
            Guarantor {g.guarantor_slot || ""} · {g.applicant_name || "Unnamed"}
          </button>
        ))}
        {guarantors.length < 2 && canStaff ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => {
              setGuarName("");
              setGuarEmail("");
              setGuarPhone("");
              setShowAddGuar(true);
            }}
          >
            Add guarantor
          </Button>
        ) : null}
        {isGuarantorView && canSwap ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={busy}
            onClick={async () => {
              const label = app.applicant_name || "this guarantor";
              const current = primaryApp.applicant_name || lead.name;
              if (
                !window.confirm(
                  `Switch ${label} with the primary applicant (${current})?\n\nThe deal will be under ${label}. ${current} becomes Guarantor ${app.guarantor_slot || ""}.`,
                )
              ) {
                return;
              }
              setBusy(true);
              try {
                await swapCreditParties({
                  data: { leadId, guarantorApplicationId: app.id },
                });
                toast.success(`${label} is now the primary applicant`);
                setSelectedAppId(app.id);
                await load();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Switch failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Switch with primary
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {isGuarantorView ? "Guarantor" : "Primary"}: {app.applicant_name || lead.name}
        {app.applicant_email || app.app_email ? ` · ${app.applicant_email || app.app_email}` : ""}
        {app.applicant_phone ? ` · ${app.applicant_phone}` : ""}
      </p>

      {primaryApp.do_not_pull_credit ? (
        <div
          role="alert"
          className="rounded-sm border-2 border-red-700 bg-red-700 px-4 py-3 text-sm font-bold text-white shadow-sm"
        >
          DO NOT PULL CREDIT
          <p className="mt-1 text-xs font-normal text-red-50">
            The rep checked this box when requesting credit approval. Chris / Credit Manager — do{" "}
            <strong>not</strong> run a new bureau pull. Use the attached Equifax file (if any) or an
            existing file only.
          </p>
        </div>
      ) : null}

      {primaryApp.approval_notes &&
      (primaryApp.status === "declined" || (lead.credit_status || "").toLowerCase() === "declined") ? (
        <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-950">
          <p className="font-semibold">Decline reason</p>
          <p className="mt-1 whitespace-pre-wrap">{primaryApp.approval_notes}</p>
        </div>
      ) : null}

      {isDealApproved ? (
        <div className="space-y-3 rounded-sm border-2 border-primary/40 bg-primary/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-primary">Lease contract (post-approval)</h4>
              <p className="text-xs text-muted-foreground">
                Deal is approved. Generate the ENG lease contract from the accepted quote, then send
                for DocuSign + Live ID.
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
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setShowSendSign(true)}>
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

      {app.public_token ? (
        <p className="break-all text-xs text-muted-foreground">
          {isGuarantorView ? "Guarantor" : "Lessee"} app link:{" "}
          <a
            className="text-primary underline"
            href={`/credit-app/${app.public_token}`}
            target="_blank"
            rel="noreferrer"
          >
            /credit-app/{app.public_token}
          </a>
        </p>
      ) : data.appLink && !isGuarantorView ? (
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
          documents={documents}
          canEdit={canStaff && me.role !== "broker"}
          canUpload={canUpload}
          canDeleteDocs={canDeleteDocs}
          section="vehicle"
          leadId={leadId}
          applicationId={app.id}
          busy={busy}
          setBusy={setBusy}
          onView={(name, dataUrl) => setViewDoc({ name, data: dataUrl })}
          onReload={load}
          onSave={async (itemKey, notes, done) => {
            await updateChecklistItem({
              data: { applicationId: app.id, itemKey, notes, done },
            });
            await load();
          }}
          onUpload={async (itemKey, file) => {
            const fileData = await readFile(file);
            await uploadChecklistDocument({
              data: {
                leadId,
                applicationId: app.id,
                itemKey,
                fileName: file.name,
                mimeType: file.type || "application/octet-stream",
                fileData,
              },
            });
            toast.success(`${file.name} uploaded`);
            await load();
          }}
          onDeleteDoc={async (documentId) => {
            await deleteCreditDocument({ data: { documentId, leadId } });
            toast.success("Document removed");
            await load();
          }}
        />
        <ChecklistSection
          title={
            isGuarantorView
              ? `Customer portion — ${app.applicant_name || "Guarantor"}`
              : "Customer portion (Credit Manager)"
          }
          items={customerItems}
          documents={documents}
          canEdit={canCustomerChecklist}
          canUpload={canUpload}
          canDeleteDocs={canDeleteDocs}
          section="customer"
          leadId={leadId}
          applicationId={app.id}
          busy={busy}
          setBusy={setBusy}
          onView={(name, dataUrl) => setViewDoc({ name, data: dataUrl })}
          onReload={load}
          onSave={async (itemKey, notes, done) => {
            await updateChecklistItem({
              data: { applicationId: app.id, itemKey, notes, done },
            });
            await load();
          }}
          onUpload={async (itemKey, file) => {
            const fileData = await readFile(file);
            await uploadChecklistDocument({
              data: {
                leadId,
                applicationId: app.id,
                itemKey,
                fileName: file.name,
                mimeType: file.type || "application/octet-stream",
                fileData,
              },
            });
            toast.success(`${file.name} uploaded`);
            await load();
          }}
          onDeleteDoc={async (documentId) => {
            await deleteCreditDocument({ data: { documentId, leadId } });
            toast.success("Document removed");
            await load();
          }}
          extraActions={null}
        />
      </div>

      {canUpload ? (
        <div className="rounded-sm border border-border p-3">
          <h4 className="mb-1 text-sm font-semibold">Upload a document</h4>
          <p className="mb-2 text-xs text-muted-foreground">
            Attach any file to this deal — IDs, bank statements, insurance, or other.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[10rem] flex-1">
              <Label className="text-xs">Type</Label>
              <select
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={uploadKind}
                onChange={(e) => setUploadKind(e.target.value)}
              >
                {STAFF_UPLOAD_DOC_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[12rem] flex-[2]">
              <Label className="text-xs">File</Label>
              <Input
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.heic"
                className="mt-1 h-9 text-xs"
                disabled={busy}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBusy(true);
                  try {
                    const fileData = await readFile(file);
                    await uploadDealDocument({
                      data: {
                        leadId,
                        applicationId: app.id,
                        kind: uploadKind,
                        fileName: file.name,
                        mimeType: file.type || "application/octet-stream",
                        fileData,
                      },
                    });
                    toast.success(`${file.name} uploaded`);
                    await load();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Upload failed");
                  } finally {
                    setBusy(false);
                    e.target.value = "";
                  }
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <div>
        <h4 className="mb-2 text-sm font-semibold">All documents</h4>
        {allDocs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No documents yet.</p>
        ) : (
          <ul className="space-y-1">
            {allDocs.map((d) => {
              const party =
                d.application_id === primaryApp.id
                  ? "Primary"
                  : guarantors.find((g) => g.id === d.application_id)
                    ? `Guarantor ${
                        guarantors.find((g) => g.id === d.application_id)?.guarantor_slot || ""
                      }`.trim()
                    : "Deal";
              return (
              <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  <Badge variant="outline" className="mr-2 text-[10px]">
                    {party}
                  </Badge>
                  <Badge variant="outline" className="mr-2 text-[10px]">
                    {lesseeDocLabel(d.kind) !== d.kind.replace(/_/g, " ")
                      ? lesseeDocLabel(d.kind)
                      : d.kind.replace(/_/g, " ")}
                  </Badge>
                  {d.file_name}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setViewDoc({ name: d.file_name, data: d.file_data })}
                  >
                    View
                  </Button>
                  {canDeleteDocs ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      title="Delete document"
                      disabled={busy}
                      onClick={async () => {
                        if (!window.confirm(`Delete ${d.file_name}?`)) return;
                        setBusy(true);
                        try {
                          await deleteCreditDocument({ data: { documentId: d.id, leadId } });
                          toast.success("Document removed");
                          await load();
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Delete failed");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  ) : null}
                </span>
              </li>
              );
            })}
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
            <DialogTitle>
              Request {isGuarantorView ? "guarantor" : "lessee"} app & IDs
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will send a link to the following email asking the recipient to fill out our credit
            app and upload IDs
            {isGuarantorView ? ` for guarantor ${app.applicant_name || ""}`.trimEnd() : ""}.
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
                    data: { leadId, email: appEmail, applicationId: app.id },
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
            <div className="space-y-2 rounded-sm border border-red-200 bg-red-50 p-3">
              <p className="text-xs font-semibold text-red-900">
                Credit Manager will be told <strong>DO NOT PULL CREDIT</strong> in a red banner and
                email subject.
              </p>
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
                  toast.success(
                    doNotPull
                      ? "Credit Manager notified — DO NOT PULL CREDIT"
                      : "Credit Manager notified",
                  );
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

      <Dialog open={showApprove} onOpenChange={setShowApprove}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Approve this lease</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Sales and Credit are always notified. Referring dealer is on by default. Lessee is off
            unless you are ready for them to hear it.
          </p>
          <div>
            <Label>What's next (included in the emails)</Label>
            <Input
              className="mt-1"
              value={approveNext}
              onChange={(e) => setApproveNext(e.target.value)}
              placeholder="e.g. Kelly will book delivery once insurance is in"
            />
          </div>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2 text-muted-foreground">
              <Checkbox checked disabled />
              Sales rep{data?.lead.assigned_name ? ` — ${data.lead.assigned_name}` : ""} (always)
            </label>
            <label className="flex items-center gap-2 text-muted-foreground">
              <Checkbox checked disabled />
              Credit manager / Chris (always)
            </label>
            {data?.lead.partner_name ? (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={notifyPartner}
                  disabled={!data.lead.partner_email}
                  onCheckedChange={(c) => setNotifyPartner(c === true)}
                />
                {data.lead.partner_name}
                {data.lead.partner_email
                  ? ` (${data.lead.partner_email})`
                  : " — no email on file, add it on the partner"}
              </label>
            ) : (
              <p className="text-xs text-muted-foreground">No referring dealer on this file.</p>
            )}
            <label className="flex items-center gap-2">
              <Checkbox
                checked={notifyLessee}
                disabled={!data?.lead.email}
                onCheckedChange={(c) => setNotifyLessee(c === true)}
              />
              Lessee
              {data?.lead.email ? ` (${data.lead.email})` : " — no email, off"}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApprove(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await approveDealGsm({
                    data: {
                      leadId,
                      approve: true,
                      notifyPartner,
                      notifyLessee,
                      nextStep: approveNext.trim() || undefined,
                    },
                  });
                  toast.success("Deal approved — notices sent");
                  setShowApprove(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Approve & notify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDecline} onOpenChange={setShowDecline}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline deal</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Explain the reason. Choose who should receive this note by email.
          </p>
          <div>
            <Label>Reason *</Label>
            <Textarea
              className="mt-1"
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              rows={4}
              placeholder="Why is this deal declined?"
            />
          </div>
          <div className="space-y-2">
            <Label>Send reason to</Label>
            <div className="flex flex-col gap-2 text-sm">
              {(
                [
                  { id: "sales", label: "Salesman (vehicle portion)" },
                  { id: "credit", label: "Credit Manager (customer portion)" },
                  { id: "both", label: "Both" },
                ] as const
              ).map((opt) => (
                <label key={opt.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="decline-notify"
                    checked={declineNotify === opt.id}
                    onChange={() => setDeclineNotify(opt.id)}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDecline(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !declineReason.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await approveDealGsm({
                    data: {
                      leadId,
                      approve: false,
                      notes: declineReason.trim(),
                      notify: declineNotify,
                    },
                  });
                  toast.message("Deal declined — team notified");
                  setShowDecline(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Decline & notify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRequestDocs} onOpenChange={setShowRequestDocs}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Request docs from {isGuarantorView ? app.applicant_name || "guarantor" : "lessee"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Pick the documents you need. One secure upload link is emailed listing your selections.
          </p>
          <div>
            <Label>Email</Label>
            <Input
              className="mt-1"
              value={docEmail}
              onChange={(e) => setDocEmail(e.target.value)}
              placeholder="client@email.com"
            />
          </div>
          <ul className="max-h-64 space-y-2 overflow-y-auto rounded-sm border border-border p-3">
            {LESSEE_DOC_TYPES.map((t) => (
              <li key={t.key}>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={docKinds.includes(t.key)}
                    onCheckedChange={(c) => {
                      setDocKinds((prev) =>
                        c === true ? [...prev, t.key] : prev.filter((k) => k !== t.key),
                      );
                    }}
                  />
                  {t.label}
                </label>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRequestDocs(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || docKinds.length === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  await requestLesseeDocument({
                    data: { leadId, kinds: docKinds, email: docEmail, applicationId: app.id },
                  });
                  toast.success(
                    isGuarantorView
                      ? "Document request emailed to guarantor"
                      : "Document request emailed to lessee",
                  );
                  setShowRequestDocs(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send request
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

      <Dialog open={showAddGuar} onOpenChange={setShowAddGuar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add guarantor</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Up to two guarantors, each with their own credit application, IDs, and document requests.
            They do not replace the primary borrower.
          </p>
          <div>
            <Label>Full name *</Label>
            <Input
              className="mt-1"
              value={guarName}
              onChange={(e) => setGuarName(e.target.value)}
              placeholder="Sebastian Maneiro"
            />
          </div>
          <div>
            <Label>Email</Label>
            <Input
              className="mt-1"
              type="email"
              value={guarEmail}
              onChange={(e) => setGuarEmail(e.target.value)}
              placeholder="optional — needed to send the app"
            />
          </div>
          <div>
            <Label>Phone</Label>
            <Input
              className="mt-1"
              value={guarPhone}
              onChange={(e) => setGuarPhone(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddGuar(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !guarName.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await addGuarantor({
                    data: {
                      leadId,
                      name: guarName.trim(),
                      email: guarEmail.trim() || undefined,
                      phone: guarPhone.trim() || undefined,
                    },
                  });
                  toast.success(`${guarName.trim()} added as guarantor ${res.slot}`);
                  setShowAddGuar(false);
                  setSelectedAppId(res.applicationId);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not add guarantor");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add guarantor
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

function underwriteErr(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; data?: unknown };
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.data === "string" && o.data.trim()) return o.data;
    if (o.data && typeof o.data === "object") {
      const d = o.data as { message?: unknown };
      if (typeof d.message === "string" && d.message.trim()) return d.message;
    }
  }
  return "Underwrite timed out or failed. Stay on this tab — if a result was saved it will appear above. Otherwise click Run again.";
}

function recLabel(r: UnderwriteReport["recommendation"]) {
  if (r === "approve") return "Recommend approve";
  if (r === "approve_with_conditions") return "Approve with conditions";
  if (r === "decline") return "Recommend decline";
  return "Send back";
}

function UnderwriteCard({ report }: { report: UnderwriteReport }) {
  const pending = report.model === "pending" || /Reading the file/.test(report.summary || "");
  const tone = pending
    ? "border-amber-300 bg-amber-50 text-amber-950"
    : report.recommendation === "approve"
      ? "border-emerald-300 bg-emerald-50 text-emerald-950"
      : report.recommendation === "decline"
        ? "border-red-200 bg-red-50 text-red-950"
        : report.recommendation === "approve_with_conditions"
          ? "border-amber-300 bg-amber-50 text-amber-950"
          : "border-border bg-muted/40";
  return (
    <div className={`space-y-2 rounded-sm border p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{pending ? "Reading the file…" : recLabel(report.recommendation)}</p>
          <p className="text-[11px] opacity-80">
            {report.ran_by_name || "GSM"} · {new Date(report.created_at).toLocaleString("en-CA")}
            {report.model ? ` · ${report.model}` : ""}
          </p>
        </div>
        <Badge variant="secondary">{report.recommendation.replace(/_/g, " ")}</Badge>
      </div>
      {report.policy?.flags?.length ? (
        <ul className="space-y-1 text-xs">
          {report.policy.flags.map((f) => (
            <li key={f.id}>
              <span className="font-medium">
                {f.severity === "fail" ? "Fail" : f.severity === "warn" ? "Watch" : "OK"} — {f.label}.
              </span>{" "}
              {f.detail}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{report.summary}</p>
      {report.red_flags.length ? (
        <div>
          <p className="text-xs font-semibold">Red flags</p>
          <ul className="list-disc pl-4 text-xs">
            {report.red_flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.conditions.length ? (
        <div>
          <p className="text-xs font-semibold">If you approve, still need</p>
          <ul className="list-disc pl-4 text-xs">
            {report.conditions.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ChecklistSection({
  title,
  items,
  documents,
  canEdit,
  canUpload,
  canDeleteDocs,
  section,
  busy,
  setBusy,
  onSave,
  onUpload,
  onDeleteDoc,
  onView,
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
  documents: {
    id: string;
    kind: string;
    file_name: string;
    file_data: string;
  }[];
  canEdit: boolean;
  canUpload: boolean;
  canDeleteDocs: boolean;
  section: "vehicle" | "customer";
  leadId: string;
  applicationId: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onSave: (key: string, notes: string, done: boolean) => Promise<void>;
  onUpload: (key: string, file: File) => Promise<void>;
  onDeleteDoc: (documentId: string) => Promise<void>;
  onView: (name: string, data: string) => void;
  onReload: () => Promise<void>;
  extraActions?: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-border p-3">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      {extraActions}
      <ul className="space-y-3">
        {items.map((item) => {
          const def: ChecklistDef | undefined = checklistDef(section, item.item_key);
          const lineDocs = documents.filter((d) => d.kind === item.item_key);
          const needsUpload = Boolean(def?.needsUpload);
          return (
            <li key={item.id} className="text-sm">
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={item.done}
                  disabled={!canEdit || busy}
                  onCheckedChange={(c) => {
                    void (async () => {
                      try {
                        await onSave(item.item_key, item.notes, c === true);
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Update failed");
                      }
                    })();
                  }}
                />
                <span className="font-medium leading-snug">
                  {item.label}
                  {def?.optionalForComplete ? (
                    <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                      (optional)
                    </span>
                  ) : null}
                  {def?.uploadRequired ? (
                    <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                      · upload required
                    </span>
                  ) : null}
                </span>
              </label>
              {needsUpload && canUpload ? (
                <div className="mt-1.5 space-y-1 pl-6">
                  <Input
                    type="file"
                    accept="image/*,application/pdf"
                    className="h-8 max-w-xs text-xs"
                    disabled={busy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setBusy(true);
                      try {
                        await onUpload(item.item_key, file);
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Upload failed");
                      } finally {
                        setBusy(false);
                        e.target.value = "";
                      }
                    }}
                  />
                  {lineDocs.length > 0 ? (
                    <ul className="space-y-0.5">
                      {lineDocs.map((d) => (
                        <li
                          key={d.id}
                          className="flex items-center gap-1 text-xs text-muted-foreground"
                        >
                          <button
                            type="button"
                            className="truncate text-left text-primary underline"
                            onClick={() => onView(d.file_name, d.file_data)}
                          >
                            {d.file_name}
                          </button>
                          {canDeleteDocs ? (
                            <button
                              type="button"
                              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                              title="Delete"
                              disabled={busy}
                              onClick={async () => {
                                if (!window.confirm(`Delete ${d.file_name}?`)) return;
                                setBusy(true);
                                try {
                                  await onDeleteDoc(d.id);
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : "Delete failed");
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              <X className="size-3.5" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">No file yet</p>
                  )}
                </div>
              ) : needsUpload && lineDocs.length > 0 ? (
                <ul className="mt-1 space-y-0.5 pl-6">
                  {lineDocs.map((d) => (
                    <li key={d.id} className="text-xs">
                      <button
                        type="button"
                        className="text-primary underline"
                        onClick={() => onView(d.file_name, d.file_data)}
                      >
                        {d.file_name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Textarea
                className="mt-1 min-h-[52px] text-xs"
                placeholder="Notes…"
                defaultValue={item.notes}
                disabled={!canEdit}
                onBlur={(e) => {
                  if (e.target.value !== item.notes) {
                    void onSave(item.item_key, e.target.value, item.done).catch((err) =>
                      toast.error(err instanceof Error ? err.message : "Update failed"),
                    );
                  }
                }}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
