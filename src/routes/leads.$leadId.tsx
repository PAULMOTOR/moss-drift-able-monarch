import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CalendarPlus, FileUp, Mail, Phone, X } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { StageBadge } from "@/components/stage-badge";
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
  bookTestDrive,
  clearLeadPause,
  getLead,
  listInventory,
  listProfiles,
  scheduleContactAppointment,
  updateLead,
} from "@/lib/crm/server";
import {
  LEAD_TYPES,
  REVIEW_STATUSES,
  SOURCES,
  STAGES,
  vehicleLabel,
  type InventoryItem,
  type Lead,
  type LeadActivity,
  type Profile,
  type TestDrive,
} from "@/lib/crm/types";
import {
  cn,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatRelative,
  toLocalInputValue,
} from "@/lib/utils";

export const Route = createFileRoute("/leads/$leadId")({
  component: LeadDetail,
});

const MAX_PDF_BYTES = 4 * 1024 * 1024;

function LeadDetail() {
  const { leadId } = Route.useParams();
  const getLeadFn = useServerFn(getLead);
  const updateFn = useServerFn(updateLead);
  const noteFn = useServerFn(addActivity);
  const bookFn = useServerFn(bookTestDrive);
  const scheduleFn = useServerFn(scheduleContactAppointment);
  const clearPauseFn = useServerFn(clearLeadPause);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const [lead, setLead] = useState<Lead | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [drives, setDrives] = useState<TestDrive[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [note, setNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [pdfDrag, setPdfDrag] = useState(false);
  const [driveAt, setDriveAt] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 2, 0, 0, 0);
    return toLocalInputValue(d);
  });
  const [contactAt, setContactAt] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return toLocalInputValue(d);
  });
  const [contactNote, setContactNote] = useState("");
  const [busy, setBusy] = useState(false);

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
    setActivities(detail.activities);
    setDrives(detail.drives);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function patch(partial: Record<string, unknown>) {
    if (!lead) return;
    setBusy(true);
    try {
      const updated = await updateFn({ data: { id: lead.id, ...partial } as never });
      setLead(updated);
      await load();
      toast.success("Updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
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
      quote_sent: true,
      quote_sent_at: lead?.quote_sent_at || new Date().toISOString(),
      quote_pdf_name: file.name,
      quote_pdf_data: dataUrl,
      stage:
        lead && (lead.stage === "new" || lead.stage === "contacted")
          ? "quote_sent"
          : lead?.stage,
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
        description={[lead.phone, lead.email].filter(Boolean).join(" · ") || "No contact yet"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                lead.lead_type === "lease"
                  ? "border-accent-foreground/30 bg-accent text-accent-foreground"
                  : lead.lead_type === "general"
                    ? "border-border bg-muted text-foreground"
                    : "border-primary/40 bg-primary/15 text-primary",
              )}
            >
              {lead.lead_type === "lease"
                ? "Lease"
                : lead.lead_type === "general"
                  ? "General"
                  : "Inventory"}
            </span>
            <StageBadge stage={lead.stage} />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
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
                    <p className="whitespace-pre-wrap text-sm">{a.body}</p>
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
                Schedule a callback. The lead moves to <strong className="text-foreground">Paused</strong>{" "}
                until that date — hourly and daily auto-reminders skip it.
              </p>
              {lead.stage === "paused" && lead.pause_until ? (
                <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
                  <p className="font-medium">
                    Paused until {formatDateTime(lead.pause_until)}
                  </p>
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
            <CardHeader>
              <CardTitle className="font-display text-xl">Test drives</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  type="datetime-local"
                  value={driveAt}
                  onChange={(e) => setDriveAt(e.target.value)}
                  className="h-11"
                />
                <Button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await bookFn({
                        data: {
                          lead_id: lead.id,
                          inventory_id: lead.inventory_id,
                          scheduled_at: new Date(driveAt).toISOString(),
                          duration_minutes: 45,
                        },
                      });
                      toast.success("Test drive booked");
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Booking failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <CalendarPlus className="size-4" />
                  Book
                </Button>
              </div>
              {drives.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">{formatDateTime(d.scheduled_at)}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.vehicle_label || "Vehicle TBD"} · {d.status}
                    </p>
                  </div>
                </div>
              ))}
              {drives.length === 0 ? (
                <p className="text-sm text-muted-foreground">No test drives yet.</p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="space-y-3 p-4">
              {lead.phone ? (
                <a href={`tel:${lead.phone}`} className="flex items-center gap-2 text-sm hover:text-primary">
                  <Phone className="size-3.5" />
                  {lead.phone}
                </a>
              ) : null}
              {lead.email ? (
                <a href={`mailto:${lead.email}`} className="flex items-center gap-2 text-sm hover:text-primary">
                  <Mail className="size-3.5" />
                  {lead.email}
                </a>
              ) : null}

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
                <Select value={lead.stage} onValueChange={(v) => void patch({ stage: v })} disabled={busy}>
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
                  onValueChange={(v) => void patch({ assigned_to: v === "unassigned" ? null : v })}
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
                <Select value={lead.source} onValueChange={(v) => void patch({ source: v })} disabled={busy}>
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

              {lead.lead_type === "inventory" ? (
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
                      <SelectValue placeholder="Select unit" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {inventory.map((i) => (
                        <SelectItem key={i.id} value={i.id}>
                          {vehicleLabel(i)} · #{i.stock_number}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}

              <Field label={lead.lead_type === "lease" ? "Vehicle for lease quote" : "Vehicle interest"}>
                <Input
                  defaultValue={lead.vehicle_interest ?? ""}
                  key={`vi-${lead.updated_at}`}
                  onBlur={(e) => {
                    if (e.target.value !== (lead.vehicle_interest ?? "")) {
                      void patch({ vehicle_interest: e.target.value });
                    }
                  }}
                />
              </Field>

              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={lead.quote_sent}
                    onCheckedChange={(c) =>
                      void patch({
                        quote_sent: c === true,
                        quote_sent_at: c === true ? new Date().toISOString() : null,
                        stage: c === true && lead.stage === "new" ? "quote_sent" : lead.stage,
                      })
                    }
                  />
                  Quote sent
                </label>
                {lead.quote_sent ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {lead.quote_sent_at ? formatDate(lead.quote_sent_at) : "Date set"}
                    </p>
                    <div
                      className={cn(
                        "rounded-xl border border-dashed px-3 py-3 text-center transition-colors",
                        pdfDrag
                          ? "border-primary bg-primary/10"
                          : "border-border bg-background/40 hover:border-primary/40",
                      )}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setPdfDrag(true);
                      }}
                      onDragLeave={() => setPdfDrag(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setPdfDrag(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) void readPdfFile(file);
                      }}
                    >
                      <FileUp className="mx-auto size-4 text-primary" />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Drop PDF quote or{" "}
                        <button
                          type="button"
                          className="font-medium text-primary underline-offset-2 hover:underline"
                          onClick={() => pdfInputRef.current?.click()}
                        >
                          upload
                        </button>
                      </p>
                      {lead.quote_pdf_name ? (
                        <div className="mt-2 flex items-center justify-center gap-2 text-xs">
                          {lead.quote_pdf_data ? (
                            <a
                              href={lead.quote_pdf_data}
                              download={lead.quote_pdf_name}
                              className="truncate font-medium text-primary hover:underline"
                            >
                              {lead.quote_pdf_name}
                            </a>
                          ) : (
                            <span className="truncate font-medium">{lead.quote_pdf_name}</span>
                          )}
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => void patch({ clear_quote_pdf: true })}
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ) : null}
                      <input
                        ref={pdfInputRef}
                        type="file"
                        accept="application/pdf,.pdf"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void readPdfFile(file);
                          e.target.value = "";
                        }}
                      />
                    </div>
                    <Input
                      placeholder="Quote link"
                      defaultValue={lead.quote_link ?? ""}
                      key={`ql-${lead.updated_at}`}
                      onBlur={(e) => {
                        if (e.target.value !== (lead.quote_link ?? "")) {
                          void patch({ quote_link: e.target.value });
                        }
                      }}
                    />
                    <Input
                      placeholder="Quote notes"
                      defaultValue={lead.quote_notes ?? ""}
                      key={`qn-${lead.updated_at}`}
                      onBlur={(e) => {
                        if (e.target.value !== (lead.quote_notes ?? "")) {
                          void patch({ quote_notes: e.target.value });
                        }
                      }}
                    />
                  </div>
                ) : null}
              </div>

              <Field label="Google review">
                <Select
                  value={lead.google_review_status}
                  onValueChange={(v) =>
                    void patch({
                      google_review_status: v,
                      google_review_at:
                        v === "not_requested" ? null : lead.google_review_at || new Date().toISOString(),
                    })
                  }
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
                {lead.google_review_status !== "not_requested" ? (
                  <Input
                    className="mt-2"
                    placeholder="Review link"
                    defaultValue={lead.google_review_link ?? ""}
                    key={`gr-${lead.updated_at}`}
                    onBlur={(e) => {
                      if (e.target.value !== (lead.google_review_link ?? "")) {
                        void patch({ google_review_link: e.target.value });
                      }
                    }}
                  />
                ) : null}
              </Field>

              <Field label="Est. value (CAD)">
                <Input
                  type="number"
                  defaultValue={lead.estimated_value ?? ""}
                  key={`ev-${lead.updated_at}`}
                  onBlur={(e) => {
                    const n = e.target.value === "" ? null : Number(e.target.value);
                    if (n !== lead.estimated_value) void patch({ estimated_value: n });
                  }}
                />
                <p className="text-xs text-muted-foreground">{formatCurrency(lead.estimated_value)}</p>
              </Field>

              <p className="text-xs text-muted-foreground">
                Created {formatDate(lead.created_at)} · Updated {formatRelative(lead.updated_at)}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
