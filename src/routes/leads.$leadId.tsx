import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CalendarPlus, FileUp, Mail, Phone, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { StageBadge } from "@/components/stage-badge";
import { PartnerField } from "@/components/partner-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addActivity,
  clearLeadPause,
  deleteLead,
  getLead,
  listInventory,
  listProfiles,
  scheduleContactAppointment,
  updateLead,
  listLeaseQuotes,
  listLeadQuoteFiles,
  getLeadQuoteFile,
  readyForBusinessCentral,
  getLeaseQuote,
  deleteLeaseQuote,
  getMyProfile,
} from "@/lib/crm/server";
import { sendQuoteAcceptLink } from "@/lib/crm/quote-accept";
import { CreditUnderwritingPanel } from "@/components/credit-underwriting-panel";
import { listLeadCalendarEvents, upsertCalendarEvent } from "@/lib/crm/calendar";
import { listTasks, setTaskStatus, upsertTask } from "@/lib/crm/tasks";
import { CompliancePanel } from "@/components/compliance-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CALENDAR_EVENT_TYPES,
  LEAD_TABS,
  LEAD_TYPES,
  leadTypeLabel,
  leadDisplayName,
  REVIEW_STATUSES,
  SOURCES,
  STAGES,
  defaultLeadTab,
  vehicleLabel,
  type CalendarEvent,
  type CrmTask,
  type InventoryItem,
  type Lead,
  type LeadActivity,
  type LeadTabId,
  type Profile,
} from "@/lib/crm/types";
import {
  cn,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatRelative,
  toLocalInputValue,
} from "@/lib/utils";
import { compactEmailBody } from "@/lib/crm/email-text";

function displayActivityBody(kind: string, body: string): string {
  if (kind === "email" || /&nbsp;|email template/i.test(body || "")) {
    return compactEmailBody(body, 6000);
  }
  return body || "";
}

function realGuarantorLine(value: string | null | undefined): string | null {
  const s = (value || "").trim();
  if (!s || /^n\/?a$/i.test(s) || s === "-") return null;
  return `Guarantor: ${s}`;
}


/** Open HTML or PDF data URLs in a new tab (Blob URLs — browsers block huge data: PDFs as about:blank). */
function openFileDataUrl(dataUrl: string, fileName = "quote.pdf") {
  if (!dataUrl) {
    toast.error("No file data");
    return;
  }
  if (dataUrl.startsWith("data:text/html")) {
    const b64 = dataUrl.split(",")[1] || "";
    let html = "";
    try {
      html = decodeURIComponent(escape(atob(b64)));
    } catch {
      html = atob(b64);
    }
    const w = window.open("", "_blank");
    if (!w) {
      toast.error("Popup blocked — allow popups for this site");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    return;
  }

  const comma = dataUrl.indexOf(",");
  const header = comma >= 0 ? dataUrl.slice(0, comma) : "data:application/pdf;base64";
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch?.[1] || "application/pdf";
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) {
      const a = document.createElement("a");
      a.href = url;
      a.download =
        mime === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")
          ? fileName.replace(/\.html$/i, ".pdf")
          : fileName;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.message("Download started (popup was blocked)");
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Could not open file");
  }
}


export const Route = createFileRoute("/leads/$leadId")({
  validateSearch: (s: Record<string, unknown>): { tab?: string } => {
    if (typeof s.tab === "string" && s.tab) return { tab: s.tab };
    return {};
  },
  component: LeadDetail,
});

const MAX_PDF_BYTES = 4 * 1024 * 1024;

function LeadDetail() {
  const { leadId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [tab, setTab] = useState<LeadTabId>("lead");
  const getLeadFn = useServerFn(getLead);
  const updateFn = useServerFn(updateLead);
  const deleteFn = useServerFn(deleteLead);
  const noteFn = useServerFn(addActivity);
  const scheduleFn = useServerFn(scheduleContactAppointment);
  const clearPauseFn = useServerFn(clearLeadPause);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
    const [profiles, setProfiles] = useState<Profile[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [pdfDrag, setPdfDrag] = useState(false);
  const [editName, setEditName] = useState("");
  const [editFirst, setEditFirst] = useState("");
  const [editLast, setEditLast] = useState("");
  const [editParty, setEditParty] = useState<"individual" | "business">("individual");
  const [editEntity, setEditEntity] = useState("");
  const [editPartner, setEditPartner] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contactAt, setContactAt] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return toLocalInputValue(d);
  });
  const [contactNote, setContactNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [leadEvents, setLeadEvents] = useState<CalendarEvent[]>([]);
  const [leadTasks, setLeadTasks] = useState<CrmTask[]>([]);
  const [quickEventType, setQuickEventType] = useState("test_drive");
  const [quickEventWhen, setQuickEventWhen] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return toLocalInputValue(d);
  });
  const [quickTaskTitle, setQuickTaskTitle] = useState("");

  const [me, setMe] = useState<Profile | null>(null);
  const [savedQuotes, setSavedQuotes] = useState<Array<{
    id: string;
    title: string | null;
    status: string;
    accepted_option: number | null;
    selected_option?: number;
    created_at: string;
    pdf_name: string | null;
  }>>([]);
  const [quoteFiles, setQuoteFiles] = useState<Array<{
    id: string;
    file_name: string;
    source: string;
    option_number: number | null;
    created_at: string;
  }>>([]);
  const readyBc = useServerFn(readyForBusinessCentral);
  const deleteQuote = useServerFn(deleteLeaseQuote);
  const getQuoteFile = useServerFn(getLeadQuoteFile);
  const getQuote = useServerFn(getLeaseQuote);

  async function load() {
    const [detail, people, inv] = await Promise.all([
      getLeadFn({ data: leadId }),
      listProfiles({ data: {} }),
      listInventory({ data: {} }),
    ]);
    setProfiles(people);
    setInventory(inv);
    if (!detail) {
      setMissing(true);
      setLead(null);
      return;
    }
    setMissing(false);
    setLead(detail.lead);
    setEditName(detail.lead.name);
    setEditFirst(detail.lead.first_name || detail.lead.name.split(" ")[0] || "");
    setEditLast(
      detail.lead.last_name ||
        detail.lead.name.split(" ").slice(1).join(" ") ||
        "",
    );
    setEditParty(detail.lead.party_type === "business" ? "business" : "individual");
    setEditEntity(detail.lead.legal_entity_name || "");
    setEditPartner(detail.lead.partner_id || "");
    setEditPhone(detail.lead.phone || "");
    setEditEmail(detail.lead.email || "");
    setActivities(detail.activities);
    void listLeaseQuotes({ data: { leadId } })
      .then(setSavedQuotes)
      .catch(() => setSavedQuotes([]));
    void listLeadQuoteFiles({ data: { leadId } })
      .then((rows) =>
        setQuoteFiles(
          rows.map((r) => ({
            id: r.id,
            file_name: r.file_name,
            source: r.source,
            option_number: r.option_number,
            created_at: r.created_at,
          })),
        ),
      )
      .catch(() => setQuoteFiles([]));
    void listLeadCalendarEvents({ data: { leadId } })
      .then(setLeadEvents)
      .catch(() => setLeadEvents([]));
    void listTasks({ data: { leadId } })
      .then((r) => setLeadTasks(r.tasks.filter((t) => t.status === "open" || t.status === "done").slice(0, 20)))
      .catch(() => setLeadTasks([]));
  }

  useEffect(() => {
    void getMyProfile().then(setMe).catch(() => setMe(null));
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  useEffect(() => {
    if (!lead) return;
    const fromSearch = LEAD_TABS.some((t) => t.id === search.tab)
      ? (search.tab as LeadTabId)
      : null;
    setTab(fromSearch || defaultLeadTab(lead));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, lead?.stage, lead?.credit_status, search.tab]);

  async function patch(partial: Record<string, unknown>) {
    if (!lead) return;
    setBusy(true);
    try {
      const updated = await updateFn({ data: { id: lead.id, ...partial } as never });
      setLead(updated);
      setEditName(updated.name);
      setEditFirst(updated.first_name || updated.name.split(" ")[0] || "");
      setEditLast(updated.last_name || updated.name.split(" ").slice(1).join(" ") || "");
      setEditParty(updated.party_type === "business" ? "business" : "individual");
      setEditEntity(updated.legal_entity_name || "");
      setEditPartner(updated.partner_id || "");
      setEditPhone(updated.phone || "");
      setEditEmail(updated.email || "");
      await load();
      toast.success("Updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveContact() {
    if (!lead) return;
    const first = editFirst.trim();
    const last = editLast.trim();
    const name = [first, last].filter(Boolean).join(" ") || editName.trim();
    if (!name) {
      toast.error("Name is required");
      return;
    }
    const phone = editPhone.trim();
    const email = editEmail.trim();
    if (!phone && !email) {
      toast.error("Add a phone or email");
      return;
    }
    if (editParty === "business" && !editEntity.trim()) {
      toast.error("Add the business name");
      return;
    }
    await patch({
      name,
      first_name: first || null,
      last_name: last || null,
      party_type: editParty,
      legal_entity_name: editParty === "business" ? editEntity.trim() : null,
      partner_id: editPartner || null,
      phone: phone || null,
      email: email || null,
    });
  }

  async function handleDelete() {
    if (!lead) return;
    setBusy(true);
    try {
      const res = await deleteFn({ data: { id: lead.id } });
      toast.success(res.message);
      void navigate({ to: "/leads" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  async function readPdfFile(file: File) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Please drop a PDF quote");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      toast.error("PDF must be under 4 MB");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Read failed"));
      reader.readAsDataURL(file);
    });
    await patch({
      quote_pdf_name: file.name,
      quote_pdf_data: dataUrl,
      // Stage unchanged — Quote Sent only via Share quote, stage dropdown, or pipeline
    });
  }

  if (missing) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <p>Lead not found</p>
        <Button asChild className="mt-4" variant="outline">
          <Link to="/leads">Back</Link>
        </Button>
      </div>
    );
  }

  if (!lead) {
    return <div className="h-64 animate-pulse rounded-2xl bg-muted" />;
  }

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="mb-3">
        <Link to="/leads">
          <ArrowLeft className="size-4" />
          Leads
        </Link>
      </Button>

      <PageHeader
        title={lead.name}
        description={[lead.party_type === "business" ? lead.legal_entity_name : null, lead.partner_name ? `via ${lead.partner_name}` : null, lead.phone, lead.email, realGuarantorLine(lead.guarantor)].filter(Boolean).join(" · ") || "No contact yet"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link
                to="/quote"
                search={{
                  leadId: lead.id,
                  quoteId:
                    savedQuotes.find(
                      (q) =>
                        q.status === "accepted" || q.id === lead.accepted_quote_id,
                    )?.id || savedQuotes[0]?.id,
                }}
              >
                Lease quote
              </Link>
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (lead.drive_folder_url) {
                  const ok = window.confirm(
                    "This deal already has a Google Drive folder.\n\n" +
                      "Push again will UPDATE the package files (same names are replaced with the latest from the CRM).\n" +
                      "Google Drive keeps older versions in each file’s version history.\n\n" +
                      "Update the existing Drive package now?",
                  );
                  if (!ok) return;
                }
                setBusy(true);
                try {
                  const r = await readyBc({ data: { leadId: lead.id } });
                  const n = (r as { uploadedCount?: number }).uploadedCount;
                  const replaced = (r as { replacedCount?: number }).replacedCount;
                  const created = (r as { newCount?: number }).newCount;
                  toast.success(
                    n != null
                      ? `Drive package: ${n} file(s)` +
                          (replaced != null && created != null
                            ? ` · ${replaced} updated, ${created} new`
                            : "")
                      : "Pushed to Drive",
                  );
                  if (r.folderUrl) window.open(r.folderUrl, "_blank");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Drive folder failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {lead.drive_folder_url ? "Update Drive package" : "Push to Drive"}
            </Button>
            <span
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                lead.lead_type === "lease"
                  ? "border-accent-foreground/30 bg-accent text-accent-foreground"
                  : lead.lead_type === "wholesale"
                    ? "border-amber-700/40 bg-amber-500/15 text-amber-900 dark:text-amber-200"
                    : lead.lead_type === "cash"
                      ? "border-sky-700/40 bg-sky-500/15 text-sky-900 dark:text-sky-200"
                      : lead.lead_type === "consignment"
                        ? "border-teal-700/40 bg-teal-500/15 text-teal-900 dark:text-teal-200"
                        : lead.lead_type === "general"
                          ? "border-border bg-muted text-foreground"
                          : "border-primary/40 bg-primary/15 text-primary",
              )}
            >
              {leadTypeLabel(lead.lead_type)}
            </span>
            <StageBadge stage={lead.stage} />
          </div>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = v as LeadTabId;
          setTab(next);
          void navigate({
            to: "/leads/$leadId",
            params: { leadId: lead.id },
            search: { tab: next },
            replace: true,
          });
        }}
        className="mb-4"
      >
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1 bg-muted/50 p-1">
          {LEAD_TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="flex-1 min-w-[5.5rem] data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="credit" className="mt-0 space-y-4">
          {me ? <CreditUnderwritingPanel leadId={lead.id} me={me} /> : null}
        </TabsContent>

        <TabsContent value="approval" className="mt-0 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Management approval</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Full deal recap for GSM and Admins — credit package, accepted quote, and approve / decline.
              </p>
              <dl className="grid gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Client</dt>
                  <dd className="font-medium">{lead.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Guarantor(s)</dt>
                  <dd className="font-medium">{lead.guarantor || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Credit status</dt>
                  <dd className="font-medium capitalize">
                    {(lead.credit_status || "none").replace(/_/g, " ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Stage</dt>
                  <dd className="font-medium">
                    {STAGES.find((s) => s.id === lead.stage)?.label || lead.stage}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Vehicle</dt>
                  <dd className="font-medium">{lead.vehicle_interest || lead.inventory_label || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Est. value</dt>
                  <dd className="font-medium">
                    {lead.estimated_value != null ? formatCurrency(lead.estimated_value) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Accepted quote</dt>
                  <dd className="font-medium">
                    {savedQuotes.find((q) => q.status === "accepted" || q.id === lead.accepted_quote_id)
                      ? `Option ${
                          savedQuotes.find(
                            (q) => q.status === "accepted" || q.id === lead.accepted_quote_id,
                          )?.accepted_option || "—"
                        }`
                      : lead.accepted_quote_id
                        ? "On file"
                        : "None yet"}
                  </dd>
                </div>
              </dl>
              {savedQuotes.some((q) => q.status === "accepted" || q.id === lead.accepted_quote_id) ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={async () => {
                      const q = savedQuotes.find(
                        (x) => x.status === "accepted" || x.id === lead.accepted_quote_id,
                      );
                      if (!q) return;
                      try {
                        const full = await getQuote({ data: { id: q.id } });
                        if (full?.retail_html) {
                          openFileDataUrl(
                            `data:text/html;base64,${btoa(unescape(encodeURIComponent(full.retail_html)))}`,
                            "quote.html",
                          );
                        } else if (full?.pdf_data) {
                          openFileDataUrl(full.pdf_data, full.pdf_name || "quote.pdf");
                        } else {
                          toast.error("No quote preview available");
                        }
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Could not open quote");
                      }
                    }}
                  >
                    View accepted quote
                  </Button>
                </div>
              ) : null}
              {me ? <CreditUnderwritingPanel leadId={lead.id} me={me} /> : null}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="compliance" className="mt-0 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Compliance & funding</CardTitle>
            </CardHeader>
            <CardContent>
              <CompliancePanel leadId={lead.id} />
            </CardContent>
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                if (lead.drive_folder_url) {
                  const ok = window.confirm(
                    "Update the existing Drive package with the latest files?",
                  );
                  if (!ok) return;
                }
                setBusy(true);
                try {
                  const r = await readyBc({ data: { leadId: lead.id } });
                  toast.success("Drive package updated");
                  if (r.folderUrl) window.open(r.folderUrl, "_blank");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Drive failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {lead.drive_folder_url ? "Update Drive package" : "Push to Drive"}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="lead" className="mt-0">
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {lead.quote_notes ? (
            <Card>
              <CardHeader>
                <CardTitle className="font-display text-xl">Website quote</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm tabular-nums leading-relaxed">
                  {lead.quote_notes}
                </p>
                {lead.vehicle_interest ? (
                  <p className="mt-2 text-xs text-muted-foreground">{lead.vehicle_interest}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-xl">Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!note.trim()) return;
                  setBusy(true);
                  try {
                    await noteFn({ data: { leadId: lead.id, body: note } });
                    setNote("");
                    await load();
                  } finally {
                    setBusy(false);
                  }
                }}
                className="space-y-2"
              >
                <Textarea
                  placeholder="Log a call, note, or follow-up…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy || !note.trim()}>
                    Add note
                  </Button>
                </div>
              </form>
              <div className="space-y-2 border-t border-border pt-4">
                {activities.map((a) => (
                  <div key={a.id} className="rounded-xl border border-border/70 bg-muted/20 p-3">
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                      <span className="capitalize text-foreground/80">
                        {a.kind}
                        {a.created_by_name ? ` · ${a.created_by_name}` : ""}
                      </span>
                      <span>{formatRelative(a.created_at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{displayActivityBody(a.kind, a.body)}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="font-display text-xl">Contact appointment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Schedule a callback. The lead moves to{" "}
                <strong className="text-foreground">Paused</strong> until that date — weekday and
                daily auto-reminders skip it.
              </p>
              {lead.stage === "paused" && lead.pause_until ? (
                <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
                  <p className="font-medium">Paused until {formatDateTime(lead.pause_until)}</p>
                  {lead.pause_note ? (
                    <p className="mt-1 text-xs text-muted-foreground">{lead.pause_note}</p>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await clearPauseFn({ data: { leadId: lead.id } });
                        toast.success("Pause cleared");
                        await load();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Resume now
                  </Button>
                </div>
              ) : null}
              <div className="grid gap-2">
                <Input
                  type="datetime-local"
                  value={contactAt}
                  onChange={(e) => setContactAt(e.target.value)}
                  className="h-11"
                />
                <Input
                  placeholder="Note (e.g. call back after work)"
                  value={contactNote}
                  onChange={(e) => setContactNote(e.target.value)}
                />
                <Button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await scheduleFn({
                        data: {
                          leadId: lead.id,
                          scheduled_at: new Date(contactAt).toISOString(),
                          note: contactNote || undefined,
                        },
                      });
                      toast.success("Appointment set — lead paused");
                      setContactNote("");
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <CalendarPlus className="size-4" />
                  Pause until appointment
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="font-display text-lg">Calendar on this deal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2">
                <Select value={quickEventType} onValueChange={setQuickEventType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Event type" />
                  </SelectTrigger>
                  <SelectContent>
                    {CALENDAR_EVENT_TYPES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="datetime-local"
                  value={quickEventWhen}
                  onChange={(e) => setQuickEventWhen(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const typeMeta = CALENDAR_EVENT_TYPES.find((t) => t.id === quickEventType);
                      const start = new Date(quickEventWhen);
                      await upsertCalendarEvent({
                        data: {
                          title: `${typeMeta?.label || "Appointment"} — ${lead.name}`,
                          event_type: quickEventType,
                          starts_at: start.toISOString(),
                          ends_at: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
                          lead_id: lead.id,
                          participant_ids: me ? [me.id] : [],
                        },
                      });
                      toast.success("Added to team calendar");
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <CalendarPlus className="size-4" />
                  Add to calendar
                </Button>
              </div>
              {leadEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No calendar events linked yet.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {leadEvents.map((ev) => (
                    <li key={ev.id} className="rounded-sm border border-border px-2 py-1.5">
                      <p className="font-medium">{ev.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(ev.starts_at)}
                        {ev.location ? ` · ${ev.location}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <Button asChild size="sm" variant="outline">
                <Link to="/calendar">Open calendar</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="font-display text-lg">My tasks on this deal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Call / email / follow-up…"
                  value={quickTaskTitle}
                  onChange={(e) => setQuickTaskTitle(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy || !quickTaskTitle.trim()}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await upsertTask({
                        data: {
                          title: quickTaskTitle.trim(),
                          task_type: "follow_up",
                          lead_id: lead.id,
                        },
                      });
                      setQuickTaskTitle("");
                      toast.success("Task added");
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Add
                </Button>
              </div>
              {leadTasks.filter((t) => t.status === "open").length === 0 ? (
                <p className="text-xs text-muted-foreground">No open tasks.</p>
              ) : (
                <ul className="space-y-1.5">
                  {leadTasks
                    .filter((t) => t.status === "open")
                    .map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={false}
                          disabled={busy}
                          onCheckedChange={async () => {
                            setBusy(true);
                            try {
                              await setTaskStatus({ data: { id: t.id, status: "done" } });
                              toast.success("Done");
                              await load();
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : "Failed");
                            } finally {
                              setBusy(false);
                            }
                          }}
                        />
                        <span className="min-w-0 flex-1">{t.title}</span>
                        {t.due_date ? (
                          <span className="text-[11px] text-muted-foreground">{t.due_date}</span>
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
              <Button asChild size="sm" variant="outline">
                <Link to="/tasks">Open tasks</Link>
              </Button>
            </CardContent>
          </Card>

        </div>

        <div className="space-y-4 lg:col-span-2">
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="font-display text-lg">Saved lease quotes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 pt-0">
              {savedQuotes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No CRM quotes yet. Use Lease quote to create one.</p>
              ) : (
                savedQuotes.map((q) => (
                  <div key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{q.title || q.pdf_name || q.id.slice(0, 8)}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(q.created_at).toLocaleString()} · {q.status}
                        {q.accepted_option ? ` · Opt ${q.accepted_option} accepted` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link to="/quote" search={{ leadId: lead.id, quoteId: q.id }}>
                          Reopen
                        </Link>
                      </Button>
                      {q.status !== "accepted" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={async () => {
                            if (!lead.email) {
                              toast.error("Add the client email first");
                              return;
                            }
                            setBusy(true);
                            try {
                              const res = await sendQuoteAcceptLink({
                                data: {
                                  quoteId: q.id,
                                  optionNumber: q.selected_option || 1,
                                  email: lead.email,
                                },
                              });
                              toast.success(`Accept link sent to ${res.email}`);
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : "Send failed");
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Email accept link
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const full = await getQuote({ data: { id: q.id } });
                            if (full.pdf_data?.startsWith("data:application/pdf")) {
                              openFileDataUrl(full.pdf_data, full.pdf_name || "quote.pdf");
                            } else if (full.retail_html) {
                              const w = window.open("", "_blank");
                              if (w) {
                                w.document.open();
                                w.document.write(full.retail_html);
                                w.document.close();
                              } else {
                                toast.error("Popup blocked — allow popups for this site");
                              }
                            } else if (full.pdf_data?.startsWith("data:")) {
                              openFileDataUrl(full.pdf_data, full.pdf_name || "quote.pdf");
                            } else {
                              toast.error("No PDF available for this quote");
                            }
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Open failed");
                          }
                        }}
                      >
                        View PDF
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={busy}
                        onClick={async () => {
                          if (!confirm("Delete this quote permanently?")) return;
                          setBusy(true);
                          try {
                            await deleteQuote({ data: { id: q.id } });
                            toast.success("Quote deleted");
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Delete failed");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))
              )}
              {quoteFiles.length > 0 ? (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quote files</p>
                  {quoteFiles.map((f) => (
                    <div key={f.id} className="flex items-center justify-between gap-2 py-1 text-sm">
                      <span className="truncate">{f.file_name} <span className="text-xs text-muted-foreground">({f.source})</span></span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const file = await getQuoteFile({ data: { id: f.id } });
                            openFileDataUrl(file.file_data, file.file_name || "quote.pdf");
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Open failed");
                          }
                        }}
                      >
                        Open
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {lead.drive_folder_url ? (
                <p className="pt-2 text-xs">
                  Drive folder:{" "}
                  <a className="text-primary underline" href={lead.drive_folder_url} target="_blank" rel="noreferrer">
                    open in Google Drive
                  </a>
                </p>
              ) : null}
            </CardContent>
          </Card>
<Card>
            <CardHeader className="pb-2">
              <CardTitle className="font-display text-lg">Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="First name">
                  <Input
                    value={editFirst}
                    onChange={(e) => {
                      setEditFirst(e.target.value);
                      setEditName([e.target.value, editLast].filter(Boolean).join(" "));
                    }}
                    disabled={busy}
                    className="h-11"
                  />
                </Field>
                <Field label="Last name">
                  <Input
                    value={editLast}
                    onChange={(e) => {
                      setEditLast(e.target.value);
                      setEditName([editFirst, e.target.value].filter(Boolean).join(" "));
                    }}
                    disabled={busy}
                    className="h-11"
                  />
                </Field>
              </div>
              <Field label="Client type">
                <Select
                  value={editParty}
                  onValueChange={(v) => setEditParty(v as "individual" | "business")}
                  disabled={busy}
                >
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">Individual</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <PartnerField
                value={editPartner}
                onChange={(id) => setEditPartner(id)}
                disabled={busy}
              />
              {editParty === "business" ? (
                <Field label="Business name">
                  <Input
                    value={editEntity}
                    onChange={(e) => setEditEntity(e.target.value)}
                    placeholder="Legal company name"
                    disabled={busy}
                    className="h-11"
                  />
                </Field>
              ) : null}
              <Field label="Phone">
                <div className="flex gap-2">
                  <Input
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="Add phone"
                    disabled={busy}
                    className="h-11"
                  />
                  {editPhone.trim() ? (
                    <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" asChild>
                      <a href={`tel:${editPhone}`} aria-label="Call">
                        <Phone className="size-4" />
                      </a>
                    </Button>
                  ) : null}
                </div>
              </Field>
              <Field label="Email">
                <div className="flex gap-2">
                  <Input
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    placeholder="Add email"
                    disabled={busy}
                    className="h-11"
                  />
                  {editEmail.trim() ? (
                    <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" asChild>
                      <a href={`mailto:${editEmail}`} aria-label="Email">
                        <Mail className="size-4" />
                      </a>
                    </Button>
                  ) : null}
                </div>
              </Field>
              <Button
                type="button"
                className="w-full"
                disabled={busy}
                onClick={() => void saveContact()}
              >
                Save contact
              </Button>

              <div className="border-t border-border pt-3" />

              <Field label="Lead type">
                <Select
                  value={lead.lead_type}
                  onValueChange={(v) => void patch({ lead_type: v })}
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_TYPES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Stage">
                <Select
                  value={lead.stage}
                  onValueChange={(v) => void patch({ stage: v })}
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STAGES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Assignee">
                <Select
                  value={lead.assigned_to || "unassigned"}
                  onValueChange={(v) =>
                    void patch({ assigned_to: v === "unassigned" ? null : v })
                  }
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {profiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Source">
                <Select
                  value={lead.source}
                  onValueChange={(v) => void patch({ source: v })}
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {["inventory", "cash", "wholesale"].includes(lead.lead_type) ? (
                <Field label="Inventory unit">
                  <Select
                    value={lead.inventory_id || "none"}
                    onValueChange={(v) => {
                      if (v === "none") {
                        void patch({ inventory_id: null });
                        return;
                      }
                      const item = inventory.find((i) => i.id === v);
                      void patch({
                        inventory_id: v,
                        vehicle_interest: item ? vehicleLabel(item) : lead.vehicle_interest,
                        estimated_value: item?.price ?? lead.estimated_value,
                      });
                    }}
                    disabled={busy}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None / TBD</SelectItem>
                      {inventory.map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {vehicleLabel(i)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              <Field label="Vehicle interest">
                <Input
                  defaultValue={lead.vehicle_interest || ""}
                  key={lead.vehicle_interest || "vi"}
                  onBlur={(e) => {
                    if (e.target.value !== (lead.vehicle_interest || "")) {
                      void patch({ vehicle_interest: e.target.value || null });
                    }
                  }}
                  disabled={busy}
                />
              </Field>

              <Field label="Where the car went / sold to">
                <Input
                  defaultValue={lead.destination || ""}
                  key={lead.destination || "dest"}
                  placeholder="Buyer, dealer, city…"
                  onBlur={(e) => {
                    if (e.target.value !== (lead.destination || "")) {
                      void patch({ destination: e.target.value || null });
                    }
                  }}
                  disabled={busy}
                />
              </Field>

              <div className="space-y-2 rounded-xl border border-border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={lead.quote_sent}
                    onCheckedChange={(c) =>
                      void patch({
                        quote_sent: c === true,
                        quote_sent_at:
                          c === true
                            ? lead.quote_sent_at || new Date().toISOString()
                            : null,
                        stage:
                          c === true && lead.stage === "new" ? "quote_sent" : lead.stage,
                      })
                    }
                    disabled={busy}
                  />
                  <Label>Quote sent</Label>
                </div>
                {lead.quote_sent ? (
                  <>
                    <Input
                      type="date"
                      defaultValue={
                        lead.quote_sent_at
                          ? formatDate(lead.quote_sent_at).split("/").reverse().join("-")
                          : ""
                      }
                      onBlur={(e) => {
                        if (e.target.value) {
                          void patch({
                            quote_sent_at: new Date(e.target.value).toISOString(),
                          });
                        }
                      }}
                    />
                    <Input
                      placeholder="Quote link"
                      defaultValue={lead.quote_link || ""}
                      onBlur={(e) => {
                        if (e.target.value !== (lead.quote_link || "")) {
                          void patch({ quote_link: e.target.value || null });
                        }
                      }}
                    />
                  </>
                ) : null}
                <div
                  className={cn(
                    "rounded-lg border border-dashed p-3 text-center text-xs",
                    pdfDrag ? "border-primary bg-primary/10" : "border-border",
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setPdfDrag(true);
                  }}
                  onDragLeave={() => setPdfDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setPdfDrag(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void readPdfFile(f);
                  }}
                >
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void readPdfFile(f);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => pdfInputRef.current?.click()}
                  >
                    <FileUp className="size-3.5" />
                    {lead.quote_pdf_name || "Upload quote PDF"}
                  </Button>
                  {lead.quote_pdf_name ? (
                    <button
                      type="button"
                      className="mt-2 flex w-full items-center justify-center gap-1 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        void patch({ clear_quote_pdf: true, quote_pdf_name: null })
                      }
                    >
                      <X className="size-3" /> Remove PDF
                    </button>
                  ) : null}
                </div>
              </div>

              <Field label="Google review">
                <Select
                  value={lead.google_review_status}
                  onValueChange={(v) =>
                    void patch({
                      google_review_status: v,
                      google_review_at:
                        v === "received"
                          ? lead.google_review_at || new Date().toISOString()
                          : lead.google_review_at,
                    })
                  }
                  disabled={busy}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEW_STATUSES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {lead.estimated_value != null ? (
                <p className="text-sm text-muted-foreground">
                  Est. value {formatCurrency(lead.estimated_value)}
                </p>
              ) : null}

              <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-xs text-muted-foreground">
                  False lead? Delete permanently — removed from the CRM and{" "}
                  <strong className="text-foreground">not</strong> counted as Closed Lost (keeps
                  close rates clean).
                </p>
                {!confirmDelete ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 w-full border-destructive/50 text-destructive hover:bg-destructive/10"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="size-4" />
                    Delete lead permanently
                  </Button>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    <p className="text-xs font-medium text-destructive">
                      Delete “{lead.name}” forever? This cannot be undone.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        className="flex-1"
                        disabled={busy}
                        onClick={() => void handleDelete()}
                      >
                        Yes, delete
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="flex-1"
                        disabled={busy}
                        onClick={() => setConfirmDelete(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

        </TabsContent>
      </Tabs>

    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
