import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  calcLeaseOption,
  computeDaysLeftInMonth,
  emptyOption,
  formatMoney,
  PROVINCE_TAX,
  suggestHandling,
  taxRateForProvince,
  type ClientQuoteInfo,
  type LeaseOptionInput,
  type LeaseOptionResult,
} from "@/lib/crm/lease-quote";
import {
  acceptLeaseQuoteOption,
  getLead,
  getLeaseQuote,
  listInventory,
  listLeaseQuotes,
  listLeads,
  saveLeaseQuote,
  deleteLeaseQuote,
} from "@/lib/crm/server";
import type { InventoryItem, Lead } from "@/lib/crm/types";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMyProfile } from "@/lib/crm/server";
import { Check, Calculator, FolderOpen, Printer, Save, Trash2 } from "lucide-react";

type QuoteSearch = { leadId?: string; quoteId?: string };

export const Route = createFileRoute("/quote")({
  validateSearch: (s: Record<string, unknown>): QuoteSearch => ({
    leadId: typeof s.leadId === "string" ? s.leadId : undefined,
    quoteId: typeof s.quoteId === "string" ? s.quoteId : undefined,
  }),
  component: () => (
    <AuthGate>
      <QuotePage />
    </AuthGate>
  ),
});

function num(v: string): number {
  const n = Number(String(v).replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function QuotePage() {
  const search = useSearch({ from: "/quote" });
  const save = useServerFn(saveLeaseQuote);
  const acceptFn = useServerFn(acceptLeaseQuoteOption);
  const getQuoteFn = useServerFn(getLeaseQuote);
  const deleteQuoteFn = useServerFn(deleteLeaseQuote);
  const { user } = useCurrentUserState();
  const [busy, setBusy] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [saved, setSaved] = useState<
    Array<{
      id: string;
      title: string | null;
      client_name: string;
      status: string;
      accepted_option: number | null;
      created_at: string;
      pdf_name: string | null;
    }>
  >([]);
  const [leadId, setLeadId] = useState(search.leadId || "");
  const [quoteId, setQuoteId] = useState<string | null>(search.quoteId || null);
  const [salesman, setSalesman] = useState("");

  const [client, setClient] = useState<ClientQuoteInfo>({
    clientName: "",
    phone: "",
    email: "",
    guarantor: "N/A",
    address: "",
    city: "",
    province: "QC",
    postalCode: "",
    salesman: "",
    year: null,
    make: "",
    model: "",
    trim: "",
    color: "",
    km: null,
    vin: "",
    stock: "",
    condition: "used",
    kmPerYear: 16000,
    excessKmFee: 0.9,
    quoteDate: new Date().toLocaleDateString("en-CA"),
    deliveryDate: todayIso(),
    startDate: todayIso(),
    notes: "This quote is valid for one week.",
    adminFee: 999,
    trackerFee: 495,
    lienPpsa: 0,
    license: 0,
    tireTax: 0,
    daysLeftOverride: null,
    contractStyle: "qc_individual_en",
    partyType: "individual",
  });

  const [options, setOptions] = useState<LeaseOptionInput[]>([
    emptyOption({ termMonths: 36, ratePct: 6.99 }),
    emptyOption({ termMonths: 0, ratePct: 0 }), // clear by default — use Copy from left
    emptyOption({ termMonths: 0, ratePct: 0 }),
  ]);

  async function refreshSaved(forLead = leadId) {
    if (!forLead) {
      setSaved([]);
      return;
    }
    const rows = await listLeaseQuotes({ data: { leadId: forLead } });
    setSaved(rows);
  }

  useEffect(() => {
    void Promise.all([
      listLeads({ data: {} }),
      listInventory({ data: {} }),
      getMyProfile().catch(() => null),
    ]).then(([L, inv, profile]) => {
      setLeads(L);
      setInventory(inv);
      if (profile?.name) {
        setSalesman(profile.name);
        setClient((c) => ({ ...c, salesman: profile.name }));
      }
    });
  }, [user?.id]);

  useEffect(() => {
    void refreshSaved(leadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  useEffect(() => {
    if (!search.quoteId) return;
    void loadQuote(search.quoteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.quoteId]);

  useEffect(() => {
    if (!leadId) return;
    void getLead({ data: leadId })
      .then((res) => {
        const lead = res?.lead;
        if (!lead) return;
        setClient((c) => ({
          ...c,
          clientName: lead.name || c.clientName,
          phone: lead.phone || c.phone,
          email: lead.email || c.email,
          notes: lead.notes || c.notes,
          guarantor: lead.guarantor || c.guarantor,
        }));
        if (lead.inventory_id) {
          const inv = inventory.find((i) => i.id === lead.inventory_id);
          if (inv) applyInventory(inv);
        } else if (lead.vehicle_interest) {
          setClient((c) => ({
            ...c,
            model: lead.vehicle_interest || c.model,
          }));
        }
        if (lead.estimated_value) {
          setOptions((opts) =>
            opts.map((o, i) =>
              i === 0
                ? {
                    ...o,
                    cost: lead.estimated_value || o.cost,
                    handling: 0,
                    residual: Math.round((lead.estimated_value || 0) * 0.55),
                    deposit: Math.round((lead.estimated_value || 0) * 0.2),
                  }
                : o,
            ),
          );
        }
      })
      .catch(() => toast.error("Could not load lead"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, inventory.length]);

  async function loadQuote(id: string) {
    try {
      const q = await getQuoteFn({ data: { id } });
      setQuoteId(q.id);
      if (q.lead_id) setLeadId(q.lead_id);
      const payload = JSON.parse(q.payload) as {
        client: ClientQuoteInfo;
        options: LeaseOptionResult[];
      };
      if (payload.client) {
        setClient({
          ...payload.client,
          startDate: payload.client.startDate || todayIso(),
          daysLeftOverride: payload.client.daysLeftOverride ?? null,
          contractStyle: payload.client.contractStyle || "qc_individual_en",
          partyType: payload.client.partyType || "individual",
        });
      }
      if (payload.options?.length) {
        setOptions(
          payload.options.map((o) => ({
            cost: o.cost,
            extra: 0,
            profit: o.profit,
            tradeIn: o.tradeIn,
            tradeInLien: o.tradeInLien ?? 0,
            deposit: o.deposit,
            termMonths: o.termMonths,
            ratePct: o.ratePct,
            residual: o.residual,
            handling: o.handling,
          })),
        );
      }
      toast.success("Quote reopened");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open quote");
    }
  }

  function applyInventory(inv: InventoryItem) {
    setClient((c) => ({
      ...c,
      year: inv.year,
      make: inv.make,
      model: inv.model,
      trim: inv.trim || "",
      color: inv.exterior_color || "",
      km: inv.mileage,
      vin: inv.vin || "",
      stock: inv.stock_number || "",
      condition: inv.status === "available" ? "used" : inv.status,
    }));
    const price = inv.price || 0;
    setOptions((opts) =>
      opts.map((o, idx) =>
        idx === 0
          ? {
              ...o,
              cost: price,
              handling: 0,
              residual: o.residual || Math.round(price * 0.55),
              deposit: o.deposit || Math.round(price * 0.2),
            }
          : o,
      ),
    );
  }

  const taxRate = taxRateForProvince(client.province);
  const fees = {
    admin: client.adminFee,
    tracker: client.trackerFee,
    lienPpsa: client.lienPpsa,
    license: client.license,
    tireTax: client.tireTax,
  };
  const proRataCtx = {
    startDate: client.startDate || todayIso(),
    daysLeftOverride: client.daysLeftOverride,
  };
  const daysInfo = computeDaysLeftInMonth(proRataCtx.startDate);

  const calculated: LeaseOptionResult[] = useMemo(
    () => options.map((o) => calcLeaseOption(o, taxRate, fees, proRataCtx)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      options,
      taxRate,
      client.adminFee,
      client.trackerFee,
      client.lienPpsa,
      client.license,
      client.tireTax,
      client.startDate,
      client.daysLeftOverride,
    ],
  );

  function patchOption(i: number, patch: Partial<LeaseOptionInput>) {
    setOptions((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  function vehicleTotalForOption(i: number) {
    const o = options[i];
    return Math.max(0, (o.cost || 0) + (o.profit || 0));
  }

  /** Dollar amount drives % (and vice versa) against cost+extra+profit. */
  function setDepositDollar(i: number, dollars: number) {
    const vt = vehicleTotalForOption(i);
    patchOption(i, { deposit: dollars });
  }
  function setDepositPct(i: number, pct: number) {
    const vt = vehicleTotalForOption(i);
    const dollars = vt > 0 ? Math.round((pct / 100) * vt * 100) / 100 : 0;
    patchOption(i, { deposit: dollars });
  }
  function setResidualDollar(i: number, dollars: number) {
    patchOption(i, { residual: dollars });
  }
  function setResidualPct(i: number, pct: number) {
    const vt = vehicleTotalForOption(i);
    const dollars = vt > 0 ? Math.round((pct / 100) * vt * 100) / 100 : 0;
    patchOption(i, { residual: dollars });
  }

  async function onDeleteQuote(id: string) {
    if (!confirm("Delete this saved quote permanently?")) return;
    setBusy(true);
    try {
      await deleteQuoteFn({ data: { id } });
      if (quoteId === id) setQuoteId(null);
      toast.success("Quote deleted");
      await refreshSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  /** Copy all inputs from the column immediately to the left (Opt2←Opt1, Opt3←Opt2). */
  function copyFromLeft(i: number) {
    if (i <= 0) return;
    setOptions((prev) => {
      const next = [...prev];
      next[i] = { ...prev[i - 1] };
      return next;
    });
    toast.success(`Option ${i + 1} copied from Option ${i}`);
  }

  /** Clear all variables on this option column. */
  function clearOption(i: number) {
    setOptions((prev) => {
      const next = [...prev];
      next[i] = emptyOption({ termMonths: 0, ratePct: 0 });
      return next;
    });
    toast.message(`Option ${i + 1} cleared`);
  }

  function openPdfData(dataUrl: string, fileName = "quote.pdf") {
    if (!dataUrl?.startsWith("data:")) {
      toast.error("No PDF generated");
      return;
    }
    try {
      const comma = dataUrl.indexOf(",");
      const header = comma >= 0 ? dataUrl.slice(0, comma) : "data:application/pdf;base64";
      const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const mime = header.match(/data:([^;]+)/)?.[1] || "application/pdf";
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) {
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        toast.message("Download started (popup blocked)");
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open PDF");
    }
  }

  /** Silent save (no Quote Sent). Used by Update draft + Back to lead. */
  async function silentSave(asNew = false): Promise<string | null> {
    if (!client.clientName.trim()) {
      toast.error("Client name is required");
      return null;
    }
    const res = await save({
      data: {
        leadId: leadId || null,
        client: { ...client, salesman: client.salesman || salesman },
        options: calculated,
        selectedOption: 1,
        status: "draft",
        existingId: asNew ? null : quoteId,
        title: `${client.clientName} · ${client.year || ""} ${client.make} ${client.model}`.trim(),
        markQuoteSent: false,
      },
    });
    setQuoteId(res.id);
    await refreshSaved();
    return res.id;
  }

  /** Share quote: save + open PDF + set stage Quote Sent. */
  async function onShare() {
    if (!client.clientName.trim()) {
      toast.error("Client name is required");
      return;
    }
    setBusy(true);
    try {
      const res = await save({
        data: {
          leadId: leadId || null,
          client: { ...client, salesman: client.salesman || salesman },
          options: calculated,
          selectedOption: 1,
          status: "shared",
          existingId: quoteId,
          title: `${client.clientName} · ${client.year || ""} ${client.make} ${client.model}`.trim(),
          markQuoteSent: true,
        },
      });
      setQuoteId(res.id);
      await refreshSaved();
      openPdfData(res.pdfData, res.pdfName || "quote.pdf");
      toast.success(leadId ? "Quote PDF opened · status set to Quote Sent" : "Quote PDF opened");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Share failed");
    } finally {
      setBusy(false);
    }
  }

  async function onBackToLead() {
    if (!leadId) return;
    setBusy(true);
    try {
      if (client.clientName.trim()) {
        await silentSave(false);
        toast.success("Quote saved");
      }
      window.location.href = `/leads/${leadId}`;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  async function onAccept(optionNumber: number) {
    if (!quoteId) {
      // auto-save first
      if (!client.clientName.trim()) {
        toast.error("Save the quote first (client name required)");
        return;
      }
      setBusy(true);
      try {
        const res = await save({
          data: {
            leadId: leadId || null,
            client: { ...client, salesman: client.salesman || salesman },
            options: calculated,
            selectedOption: optionNumber,
            status: "draft",
            title: `${client.clientName} · Opt ${optionNumber}`,
            markQuoteSent: false,
          },
        });
        setQuoteId(res.id);
        const acc = await acceptFn({
          data: {
            quoteId: res.id,
            optionNumber,
            contractStyle: client.contractStyle,
          },
        });
        toast.success(`Option ${optionNumber} accepted · contract + invoice ready`);
        await refreshSaved();
        openHtml(acc.retailHtml);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Accept failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      // refresh save then accept
      await save({
        data: {
          leadId: leadId || null,
          client: { ...client, salesman: client.salesman || salesman },
          options: calculated,
          selectedOption: optionNumber,
          status: "draft",
          existingId: quoteId,
        },
      });
      const acc = await acceptFn({
        data: {
          quoteId,
          optionNumber,
          contractStyle: client.contractStyle,
        },
      });
      toast.success(`Option ${optionNumber} accepted`);
      await refreshSaved();
      openHtml(acc.contractHtml);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Accept failed");
    } finally {
      setBusy(false);
    }
  }

  function openHtml(html: string) {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
  }

  function onPrint() {
    void import("@/lib/crm/lease-quote").then(({ buildRetailQuoteHtml }) => {
      openHtml(buildRetailQuoteHtml(client, calculated, taxRate));
      // user uses browser print → PDF
    });
  }

  return (
    <>
      <PageHeader
        title="Lease quote"
        description="Spreadsheet engine · save instances · accept one of 3 options · print PDF"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onPrint}>
              <Printer className="size-4" />
              Print / PDF
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const id = await silentSave(false);
                  if (id) toast.success("Draft saved");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Save failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Save className="size-4" />
              Update draft
            </Button>
            <Button type="button" disabled={busy} onClick={() => void onShare()}>
              <Printer className="size-4" />
              {busy ? "Working…" : "Share quote"}
            </Button>
          </div>
        }
      />

      {leadId ? (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Saved quotes on this lead</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {saved.length === 0 ? (
              <p className="text-sm text-muted-foreground">No saved quotes yet.</p>
            ) : (
              saved.map((q) => (
                <div
                  key={q.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">
                      {q.title || q.client_name || q.id.slice(0, 8)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(q.created_at).toLocaleString()} · {q.status}
                      {q.accepted_option ? ` · accepted Opt ${q.accepted_option}` : ""}
                      {q.pdf_name ? ` · ${q.pdf_name}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void loadQuote(q.id)}
                    >
                      <FolderOpen className="size-4" />
                      Reopen
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={busy}
                      onClick={() => void onDeleteQuote(q.id)}
                    >
                      <Trash2 className="size-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Client & vehicle</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2 grid gap-1.5">
              <Label>Link to lead (optional)</Label>
              <Select
                value={leadId || "__none__"}
                onValueChange={(v) => setLeadId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select lead" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No lead</SelectItem>
                  {leads.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                      {l.vehicle_interest ? ` · ${l.vehicle_interest}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field label="Client / lessee" value={client.clientName} onChange={(v) => setClient((c) => ({ ...c, clientName: v }))} />
            <Field label="Guarantor(s)" value={client.guarantor} onChange={(v) => setClient((c) => ({ ...c, guarantor: v }))} />
            <Field label="Phone" value={client.phone} onChange={(v) => setClient((c) => ({ ...c, phone: v }))} />
            <Field label="Email" value={client.email} onChange={(v) => setClient((c) => ({ ...c, email: v }))} />
            <Field label="Address" value={client.address} onChange={(v) => setClient((c) => ({ ...c, address: v }))} />
            <Field label="City" value={client.city} onChange={(v) => setClient((c) => ({ ...c, city: v }))} />
            <div className="grid gap-1.5">
              <Label>Province (tax)</Label>
              <Select value={client.province} onValueChange={(v) => setClient((c) => ({ ...c, province: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.keys(PROVINCE_TAX).map((p) => (
                    <SelectItem key={p} value={p}>{p} ({(PROVINCE_TAX[p] * 100).toFixed(3)}%)</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field label="Postal code" value={client.postalCode} onChange={(v) => setClient((c) => ({ ...c, postalCode: v }))} />
            <div className="sm:col-span-2 grid gap-1.5">
              <Label>Inventory vehicle</Label>
              <Select
                value="__pick__"
                onValueChange={(id) => {
                  const inv = inventory.find((i) => i.id === id);
                  if (inv) applyInventory(inv);
                }}
              >
                <SelectTrigger><SelectValue placeholder="Prefill from inventory" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__pick__">Prefill from inventory…</SelectItem>
                  {inventory.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.year} {i.make} {i.model}
                      {i.stock_number ? ` · #${i.stock_number}` : ""}{" "}
                      {i.price ? `· ${formatMoney(i.price)}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field label="Year" value={client.year?.toString() || ""} onChange={(v) => setClient((c) => ({ ...c, year: v ? Number(v) : null }))} />
            <Field label="Make" value={client.make} onChange={(v) => setClient((c) => ({ ...c, make: v }))} />
            <Field label="Model" value={client.model} onChange={(v) => setClient((c) => ({ ...c, model: v }))} />
            <Field label="Trim" value={client.trim} onChange={(v) => setClient((c) => ({ ...c, trim: v }))} />
            <Field label="Colour" value={client.color} onChange={(v) => setClient((c) => ({ ...c, color: v }))} />
            <Field label="KM" value={client.km?.toString() || ""} onChange={(v) => setClient((c) => ({ ...c, km: v ? Number(v) : null }))} />
            <Field label="VIN" value={client.vin} onChange={(v) => setClient((c) => ({ ...c, vin: v }))} />
            <Field label="Stock #" value={client.stock} onChange={(v) => setClient((c) => ({ ...c, stock: v }))} />
            <Field
              label="KM allowance (per year)"
              value={String(client.kmPerYear || "")}
              onChange={(v) => setClient((c) => ({ ...c, kmPerYear: v ? Number(v) || 0 : 0 }))}
            />
            <Field
              label="Excess KM fee ($/km)"
              value={String(client.excessKmFee || "")}
              onChange={(v) => setClient((c) => ({ ...c, excessKmFee: v ? Number(v) || 0 : 0 }))}
            />
            <Field label="Lease start date" value={client.startDate} onChange={(v) => setClient((c) => ({ ...c, startDate: v }))} />
            <Field
              label={`Days left in month (auto ${daysInfo.daysLeft}/${daysInfo.daysInMonth})`}
              value={client.daysLeftOverride != null ? String(client.daysLeftOverride) : ""}
              onChange={(v) =>
                setClient((c) => ({
                  ...c,
                  daysLeftOverride: v.trim() ? num(v) : null,
                }))
              }
            />
            <Field label="Salesman" value={client.salesman} onChange={(v) => setClient((c) => ({ ...c, salesman: v }))} />
            <div className="grid gap-1.5">
              <Label>Contract style</Label>
              <Select
                value={client.contractStyle}
                onValueChange={(v) => setClient((c) => ({ ...c, contractStyle: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="qc_individual_en">QC Individual EN</SelectItem>
                  <SelectItem value="qc_individual_fr">QC Individual FR</SelectItem>
                  <SelectItem value="qc_business_en">QC Business EN</SelectItem>
                  <SelectItem value="qc_business_fr">QC Business FR</SelectItem>
                  <SelectItem value="ca_business_en">Canada Business</SelectItem>
                  <SelectItem value="ca_individual_en">Canada Individual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Fees (due on delivery)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <MoneyField label="Admin / document" value={client.adminFee} onChange={(v) => setClient((c) => ({ ...c, adminFee: v }))} />
            <MoneyField label="Tracker / anti-theft" value={client.trackerFee} onChange={(v) => setClient((c) => ({ ...c, trackerFee: v }))} />
            <MoneyField label="Lien / PPSA" value={client.lienPpsa} onChange={(v) => setClient((c) => ({ ...c, lienPpsa: v }))} />
            <MoneyField label="License" value={client.license} onChange={(v) => setClient((c) => ({ ...c, license: v }))} />
            <MoneyField label="Tire tax" value={client.tireTax} onChange={(v) => setClient((c) => ({ ...c, tireTax: v }))} />
            <p className="text-xs text-muted-foreground">
              Pro-rata = payment × (days left ÷ days in month). Tax:{" "}
              <strong>{(taxRate * 100).toFixed(3)}%</strong>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        {calculated.map((o, i) => (
          <Card key={i}>
            <CardHeader className="space-y-2 pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-semibold text-primary">
                  Option {i + 1}
                </CardTitle>
                <Calculator className="size-4 shrink-0 text-muted-foreground" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {i > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => copyFromLeft(i)}
                  >
                    Copy from left
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => clearOption(i)}
                >
                  Clear
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <MoneyField label="Cost / price" value={options[i].cost} onChange={(v) => patchOption(i, { cost: v })} />
              <MoneyField label="Profit" value={options[i].profit} onChange={(v) => patchOption(i, { profit: v })} />
              <MoneyField label="Trade-in" value={options[i].tradeIn} onChange={(v) => patchOption(i, { tradeIn: v })} />
              <MoneyField
                label="Trade-in lien amount"
                value={options[i].tradeInLien || 0}
                onChange={(v) => patchOption(i, { tradeInLien: v })}
              />
              <div className="grid grid-cols-2 gap-2">
                <MoneyField
                  label="Deposit $ (cash down)"
                  value={options[i].deposit}
                  onChange={(v) => setDepositDollar(i, v)}
                />
                <MoneyField
                  label="Deposit %"
                  value={
                    vehicleTotalForOption(i) > 0
                      ? Math.round((options[i].deposit / vehicleTotalForOption(i)) * 1000) / 10
                      : 0
                  }
                  onChange={(v) => setDepositPct(i, v)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <MoneyField label="Term (mo)" value={options[i].termMonths} onChange={(v) => patchOption(i, { termMonths: Math.round(v) })} />
                <MoneyField label="Rate %" value={options[i].ratePct} onChange={(v) => patchOption(i, { ratePct: v })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <MoneyField
                  label="Residual $"
                  value={options[i].residual}
                  onChange={(v) => setResidualDollar(i, v)}
                />
                <MoneyField
                  label="Residual %"
                  value={
                    vehicleTotalForOption(i) > 0
                      ? Math.round((options[i].residual / vehicleTotalForOption(i)) * 1000) / 10
                      : 0
                  }
                  onChange={(v) => setResidualPct(i, v)}
                />
              </div>
              <MoneyField label="Handling $ (default 0)" value={options[i].handling} onChange={(v) => patchOption(i, { handling: v })} />

              <div className="mt-3 space-y-1 rounded-sm border border-border bg-muted/40 p-3 text-xs">
                <Row
                  label="Trade equity (trade − lien)"
                  value={formatMoney((options[i].tradeIn || 0) - (options[i].tradeInLien || 0))}
                />
                <Row label="Financed (cap. cost)" value={formatMoney(o.financed)} bold />
                <Row label="Deposit %" value={`${o.depositPct.toFixed(1)}%`} />
                <Row label="Residual %" value={`${o.residualPct.toFixed(1)}%`} />
                <Row label="Int. rate" value={`${o.ratePct.toFixed(2)}%`} />
                <Row label="Depreciation" value={formatMoney(o.depreciation)} />
                <Row label="Interest" value={formatMoney(o.interest)} />
                <Row label="Lease payment" value={formatMoney(o.payment)} bold />
                <Row label="Taxes" value={formatMoney(o.taxOnPayment)} />
                <Row label="Total payment" value={formatMoney(o.totalPayment)} bold />
                <Row label={`Pro-rata (${o.daysLeftMonth}/${o.daysInMonth}d)`} value={formatMoney(o.proRata)} />
                <Row label="Due on delivery" value={formatMoney(o.dueTotal)} bold />
              </div>

              <Button
                type="button"
                className="mt-2 w-full"
                disabled={busy || !(o.cost > 0 || o.payment > 0)}
                onClick={() => void onAccept(i + 1)}
              >
                <Check className="size-4" />
                Quote Accepted (Option {i + 1})
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Share quote opens a customer PDF and sets the lead to Quote Sent.
        Update draft / Back to lead save without changing stage.
        Accept builds contract + invoice. Push to Drive is on the lead page.
      </p>
      {leadId ? (
        <div className="mt-6 flex justify-center">
          <Button
            type="button"
            size="lg"
            variant="default"
            className="min-w-[220px] text-base font-semibold"
            disabled={busy}
            onClick={() => void onBackToLead()}
          >
            ← Back to lead
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-sm" />
    </div>
  );
}

function MoneyField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        inputMode="decimal"
        value={value === 0 ? "" : String(value)}
        placeholder="0"
        onChange={(e) => onChange(num(e.target.value))}
        className="h-9 rounded-sm tabular"
      />
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${bold ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
      <span>{label}</span>
      <span className="tabular text-foreground">{value}</span>
    </div>
  );
}
