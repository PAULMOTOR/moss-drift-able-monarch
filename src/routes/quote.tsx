import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
  emailFirstInvoice,
} from "@/lib/crm/server";
import type { InventoryItem, Lead } from "@/lib/crm/types";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMyProfile } from "@/lib/crm/server";
import { decodeVin, normalizeVin } from "@/lib/crm/vin-decode";
import { Check, Calculator, FolderOpen, Mail, Printer, Save, Search, Trash2 } from "lucide-react";


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

function pickPreferredQuote(
  rows: Array<{ id: string; status: string }>,
  requested?: string,
): string | null {
  if (requested && rows.some((r) => r.id === requested)) return requested;
  const accepted = rows.find((r) => r.status === "accepted");
  if (accepted) return accepted.id;
  return rows[0]?.id ?? null;
}

function QuotePage() {
  const search = useSearch({ from: "/quote" });
  const navigate = useNavigate();
  const save = useServerFn(saveLeaseQuote);
  const acceptFn = useServerFn(acceptLeaseQuoteOption);
  const getQuoteFn = useServerFn(getLeaseQuote);
  const deleteQuoteFn = useServerFn(deleteLeaseQuote);
  const decodeVinFn = useServerFn(decodeVin);
  const { user } = useCurrentUserState();
  const [busy, setBusy] = useState(false);
  const [vinBusy, setVinBusy] = useState(false);

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
  const openedQuoteRef = useRef<string | null>(search.quoteId || null);

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
    trackerFee: 795,
    lienPpsa: 0,
    license: 0,
    tireTax: 0,
    daysLeftOverride: null,
    contractStyle: "qc_individual_en",
    partyType: "individual",
    tradeVin: "",
    tradeYear: null,
    tradeMake: "",
    tradeModel: "",
    tradeTrim: "",
    tradeKm: null,
    tradeKind: "financed",
  });

  const [options, setOptions] = useState<LeaseOptionInput[]>([
    emptyOption({ termMonths: 36, ratePct: 6.99 }),
    emptyOption({ termMonths: 0, ratePct: 0 }), // clear by default — use Copy from left
    emptyOption({ termMonths: 0, ratePct: 0 }),
  ]);

  async function refreshSaved(forLead = leadId) {
    if (!forLead) {
      setSaved([]);
      return [];
    }
    const rows = await listLeaseQuotes({ data: { leadId: forLead } });
    setSaved(rows);
    return rows;
  }

  useEffect(() => {
    void Promise.all([
      listLeads({ data: { limit: 100, offset: 0 } }),
      listInventory({ data: {} }),
      getMyProfile().catch(() => null),
    ]).then(([L, inv, profile]) => {
      setLeads(L.leads);
      setInventory(inv);
      if (profile?.name) {
        setSalesman(profile.name);
        setClient((c) => ({ ...c, salesman: profile.name }));
      }
    });
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!leadId) {
        setSaved([]);
        return;
      }
      const rows = await refreshSaved(leadId);
      if (cancelled) return;
      const preferred = pickPreferredQuote(rows, search.quoteId);
      if (preferred && openedQuoteRef.current !== preferred) {
        openedQuoteRef.current = preferred;
        await loadQuote(preferred, { silent: true, syncUrl: true });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, search.quoteId]);

  useEffect(() => {
    if (!leadId) return;
    void getLead({ data: leadId })
      .then((res) => {
        const lead = res?.lead;
        if (!lead) return;
        // A saved quote owns the form — don't overwrite with a generic lead template
        if (openedQuoteRef.current) return;
        setClient((c) => ({
          ...c,
          clientName:
            lead.party_type === "business" && lead.legal_entity_name
              ? lead.legal_entity_name
              : lead.name || c.clientName,
          phone: lead.phone || c.phone,
          email: lead.email || c.email,
          notes: lead.notes || c.notes,
          guarantor: lead.guarantor || c.guarantor,
        }));
        if (lead.inventory_id) {
          const inv = inventory.find((i) => i.id === lead.inventory_id);
          if (inv) applyInventory(inv);
        } else if (lead.vehicle_interest) {
          // Parse "2024 Porsche Cayenne" style interest into year/make/model when possible
          const raw = lead.vehicle_interest.trim();
          const m = raw.match(/^((?:19|20)\d{2})\s+([A-Za-z0-9À-ÿ-]+)\s+(.+)$/);
          setClient((c) => ({
            ...c,
            year: m ? Number(m[1]) : c.year,
            make: m ? m[2] : c.make,
            model: m ? m[3] : raw || c.model,
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

  async function loadQuote(
    id: string,
    opts?: { silent?: boolean; syncUrl?: boolean },
  ) {
    try {
      const q = await getQuoteFn({ data: { id } });
      openedQuoteRef.current = q.id;
      setQuoteId(q.id);
      if (q.lead_id) setLeadId(q.lead_id);
      if (opts?.syncUrl) {
        void navigate({
          to: "/quote",
          search: { leadId: q.lead_id || leadId || undefined, quoteId: q.id },
          replace: true,
        });
      }
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
          tradeVin: payload.client.tradeVin || "",
          tradeYear: payload.client.tradeYear ?? null,
          tradeMake: payload.client.tradeMake || "",
          tradeModel: payload.client.tradeModel || "",
          tradeTrim: payload.client.tradeTrim || "",
          tradeKm: payload.client.tradeKm ?? null,
          tradeKind: payload.client.tradeKind === "leased" ? "leased" : "financed",
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
            securityDeposit: o.securityDeposit ?? 0,
            termMonths: o.termMonths,
            ratePct: o.ratePct,
            residual: o.residual,
            handling: o.handling,
          })),
        );
      }
      if (!opts?.silent) toast.success("Quote reopened");
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

  async function explodeVin() {
    const vin = normalizeVin(client.vin);
    if (vin.length !== 17) {
      toast.error("Enter a full 17-character VIN first");
      return;
    }
    setVinBusy(true);
    try {
      const result = await decodeVinFn({ data: { vin } });
      if (!result.ok) {
        toast.error(result.message);
        setClient((c) => ({ ...c, vin: result.vin || c.vin }));
        return;
      }
      const invMatch = inventory.find((i) => i.vin && normalizeVin(i.vin) === result.vin);
      setClient((c) => ({
        ...c,
        vin: result.vin,
        year: result.year ?? c.year,
        make: result.make || c.make,
        model: result.model || c.model,
        trim: result.trim || c.trim,
        color: invMatch?.exterior_color || c.color,
        km: invMatch?.mileage ?? c.km,
        stock: invMatch?.stock_number || c.stock,
      }));
      if (invMatch?.price) {
        const price = invMatch.price;
        setOptions((opts) =>
          opts.map((o, idx) =>
            idx === 0 && !o.cost
              ? {
                  ...o,
                  cost: price,
                  residual: o.residual || Math.round(price * 0.55),
                  deposit: o.deposit || Math.round(price * 0.2),
                }
              : o,
          ),
        );
      }
      toast.success(
        invMatch
          ? `${result.message} · matched stock #${invMatch.stock_number || "—"}`
          : `${result.message} · enter colour manually (not in VIN)`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "VIN decode failed");
    } finally {
      setVinBusy(false);
    }
  }

  async function explodeTradeVin() {
    const vin = normalizeVin(client.tradeVin || "");
    if (vin.length !== 17) {
      toast.error("Enter the trade-in 17-character VIN first");
      return;
    }
    setVinBusy(true);
    try {
      const result = await decodeVinFn({ data: { vin } });
      if (!result.ok) {
        toast.error(result.message);
        setClient((c) => ({ ...c, tradeVin: result.vin || c.tradeVin }));
        return;
      }
      setClient((c) => ({
        ...c,
        tradeVin: result.vin,
        tradeYear: result.year ?? c.tradeYear,
        tradeMake: result.make || c.tradeMake,
        tradeModel: result.model || c.tradeModel,
        tradeTrim: result.trim || c.tradeTrim,
      }));
      toast.success(`${result.message} · enter trade kilometres`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "VIN decode failed");
    } finally {
      setVinBusy(false);
    }
  }

  const taxRate = taxRateForProvince(client.province);
  const fees = {
    admin: client.adminFee,
    tracker: client.trackerFee,
    lienPpsa: client.lienPpsa,
    license: client.license,
    tireTax: client.tireTax,
  };
  // Pro-rata always uses today's calendar date → days left in current month
  const proRataCtx = {
    startDate: todayIso(),
    daysLeftOverride: client.daysLeftOverride,
  };
  const daysInfo = computeDaysLeftInMonth(proRataCtx.startDate);

  const calculated: LeaseOptionResult[] = useMemo(
    () =>
      options.map((o) =>
        calcLeaseOption(o, client.province || "QC", fees, proRataCtx, undefined, {
          partyType: client.partyType,
          tradeKind: client.tradeKind === "leased" ? "leased" : "financed",
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      options,
      client.province,
      client.adminFee,
      client.trackerFee,
      client.lienPpsa,
      client.license,
      client.tireTax,
      client.startDate,
      client.daysLeftOverride,
      // recompute pro-rata when the calendar day changes while page is open
      todayIso(),
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
      if (quoteId === id) {
        openedQuoteRef.current = null;
        setQuoteId(null);
      }
      toast.success("Quote deleted");
      const rows = await refreshSaved();
      const next = pickPreferredQuote(rows);
      if (next) await loadQuote(next, { silent: true, syncUrl: true });
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

  async function onEmailInvoice() {
    if (!quoteId) {
      toast.error("Save and accept an option first so the first invoice exists");
      return;
    }
    const to = (client.email || "").trim();
    if (!to || !to.includes("@")) {
      toast.error("Add the client email on the quote, then try again");
      return;
    }
    setBusy(true);
    try {
      // Ensure latest numbers are saved before emailing
      await silentSave(false);
      const res = await emailFirstInvoice({
        data: { quoteId, toEmail: to },
      });
      toast.success(`First invoice emailed to ${res.to}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Email failed");
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
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !quoteId}
              onClick={() => void onEmailInvoice()}
              title={!quoteId ? "Save & accept an option first" : "Email pro forma first invoice to client"}
            >
              <Mail className="size-4" />
              Email 1st invoice
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
                  className={
                    "flex flex-wrap items-center justify-between gap-2 rounded-sm border px-3 py-2 text-sm " +
                    (q.id === quoteId
                      ? "border-primary bg-primary/5"
                      : "border-border")
                  }
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
                      onClick={() => void loadQuote(q.id, { syncUrl: true })}
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
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>VIN</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={client.vin}
                  onChange={(e) =>
                    setClient((c) => ({
                      ...c,
                      vin: e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, "").slice(0, 17),
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void explodeVin();
                    }
                  }}
                  placeholder="17-character VIN"
                  className="font-mono tracking-wide uppercase"
                  maxLength={17}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={vinBusy || normalizeVin(client.vin).length !== 17}
                  onClick={() => void explodeVin()}
                  className="shrink-0"
                >
                  <Search className="size-4" />
                  {vinBusy ? "Decoding…" : "Explode VIN"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Free NHTSA (DOT) decode fills year, make, model, trim. Colour is not in the VIN
                {client.vin ? ` · ${normalizeVin(client.vin).length}/17` : ""}.
              </p>
            </div>
            <Field label="Stock #" value={client.stock} onChange={(v) => setClient((c) => ({ ...c, stock: v }))} />

            <div className="sm:col-span-2 rounded-sm border border-border bg-muted/30 p-3 space-y-3">
              <div>
                <p className="text-sm font-semibold">Trade-in vehicle</p>
                <p className="text-[11px] text-muted-foreground">
                  VIN explode fills year / make / model / trim for Chris on the contract. KM is manual.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label>Trade VIN</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={client.tradeVin || ""}
                    onChange={(e) =>
                      setClient((c) => ({
                        ...c,
                        tradeVin: e.target.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/gi, "").slice(0, 17),
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void explodeTradeVin();
                      }
                    }}
                    placeholder="Trade-in 17-character VIN"
                    className="font-mono tracking-wide uppercase"
                    maxLength={17}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={vinBusy || normalizeVin(client.tradeVin || "").length !== 17}
                    onClick={() => void explodeTradeVin()}
                    className="shrink-0"
                  >
                    <Search className="size-4" />
                    {vinBusy ? "Decoding…" : "Explode VIN"}
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Trade year" value={client.tradeYear?.toString() || ""} onChange={(v) => setClient((c) => ({ ...c, tradeYear: v ? Number(v) : null }))} />
                <Field label="Trade make" value={client.tradeMake || ""} onChange={(v) => setClient((c) => ({ ...c, tradeMake: v }))} />
                <Field label="Trade model" value={client.tradeModel || ""} onChange={(v) => setClient((c) => ({ ...c, tradeModel: v }))} />
                <Field label="Trade trim" value={client.tradeTrim || ""} onChange={(v) => setClient((c) => ({ ...c, tradeTrim: v }))} />
                <Field
                  label="Trade kilometres"
                  value={client.tradeKm != null ? String(client.tradeKm) : ""}
                  onChange={(v) => setClient((c) => ({ ...c, tradeKm: v.trim() ? Number(v) || 0 : null }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Trade payout</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={client.tradeKind !== "leased" ? "default" : "outline"}
                    onClick={() => setClient((c) => ({ ...c, tradeKind: "financed" }))}
                  >
                    Financed (payout includes tax)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={client.tradeKind === "leased" ? "default" : "outline"}
                    onClick={() => setClient((c) => ({ ...c, tradeKind: "leased" }))}
                  >
                    Leased (buyout is pre-tax)
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {client.partyType === "business"
                    ? "Business: no consumer tax credit on the trade or the payout. Lien is added as entered."
                    : client.tradeKind === "leased"
                      ? "Lease buyout is pre-tax — we fund buyout + GST/QST (or HST) on the payout. Tax credit still uses price − trade (not the lien)."
                      : "Bank loan payout already includes tax — we fund the lien as entered. Individual tax credit: tax the (price − trade) payment, finance the (price − trade + payout) payment."}
                </p>
              </div>
            </div>

            <Field
              label="KM allowance (per year)"
              value={String(client.kmPerYear || "")}
              onChange={(v) => setClient((c) => ({ ...c, kmPerYear: v ? Number(v) || 0 : 0 }))}
            />
            <DecimalField
              label="Excess KM fee ($/km)"
              value={client.excessKmFee}
              onChange={(v) => setClient((c) => ({ ...c, excessKmFee: v }))}
            />
            <Field label="Lease start date" value={client.startDate} onChange={(v) => setClient((c) => ({ ...c, startDate: v }))} />
            <Field
              label={`Pro-rata days (auto today → end of month: ${daysInfo.daysLeft}/${daysInfo.daysInMonth})`}
              value={client.daysLeftOverride != null ? String(client.daysLeftOverride) : ""}
              onChange={(v) =>
                setClient((c) => ({
                  ...c,
                  daysLeftOverride: v.trim() ? num(v) : null,
                }))
              }
            />
            <p className="text-[11px] text-muted-foreground -mt-1">
              Pro-rata uses today's date automatically. Override only if delivery is a different day.
            </p>
            <Field label="Salesman" value={client.salesman} onChange={(v) => setClient((c) => ({ ...c, salesman: v }))} />
            <div className="grid gap-1.5">
              <Label>Contract style</Label>
              <Select
                value={client.contractStyle}
                onValueChange={(v) =>
                  setClient((c) => ({
                    ...c,
                    contractStyle: v,
                    partyType: /business/i.test(v) ? "business" : "individual",
                  }))
                }
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
              <strong>
                {client.province?.toUpperCase() === "BC"
                  ? (() => {
                      const sample = calculated.find((o) => o.cost > 0 || o.payment > 0) || calculated[0];
                      if (!sample) return "GST 5% + PST (TRV)";
                      return `GST 5% + PST ${(sample.pstRate * 100).toFixed(0)}% (TRV ${formatMoney(sample.trv)})`;
                    })()
                  : `${(taxRate * 100).toFixed(3)}%`}
              </strong>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        {calculated.map((o, i) => {
          const isEmpty = !(o.cost > 0 || o.payment > 0);
          return (
          <Card key={i} className={isEmpty ? "border-dashed opacity-90" : undefined}>
            <CardHeader className="space-y-2 pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-semibold text-primary">
                  Option {i + 1}
                  {isEmpty ? " — (N/A)" : ""}
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
                  label="Cash down $"
                  value={options[i].deposit}
                  onChange={(v) => setDepositDollar(i, v)}
                />
                <MoneyField
                  label="Cash down %"
                  value={
                    vehicleTotalForOption(i) > 0
                      ? Math.round((options[i].deposit / vehicleTotalForOption(i)) * 1000) / 10
                      : 0
                  }
                  onChange={(v) => setDepositPct(i, v)}
                />
              </div>
              <MoneyField
                label="Security deposit $ (not taxed · does not reduce balance)"
                value={options[i].securityDeposit || 0}
                onChange={(v) => patchOption(i, { securityDeposit: v })}
              />
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
                  label="Price"
                  value={formatMoney(o.cost + o.extra + o.profit)}
                  bold
                />
                <Row
                  label="Trade equity (allowance − payout we fund)"
                  value={formatMoney((options[i].tradeIn || 0) - (o.payoutFunded || 0))}
                />
                <Row label="Payout we fund" value={formatMoney(o.payoutFunded || 0)} />
                <Row label="Payment cap (financed)" value={formatMoney(o.financed)} bold />
                {o.taxCreditApplied ? (
                  <Row label="Tax cap (price − trade − cash down)" value={formatMoney(o.taxCapCost)} />
                ) : null}
                <Row label="Cash down" value={formatMoney(o.deposit)} bold />
                <Row label="Cash down %" value={`${o.depositPct.toFixed(1)}%`} />
                <Row label="Security deposit" value={formatMoney(o.securityDeposit || 0)} bold />
                <Row label="Term" value={`${o.termMonths} mo`} bold />
                <Row label="Residual %" value={`${o.residualPct.toFixed(1)}%`} />
                <Row label="Int. rate" value={`${o.ratePct.toFixed(2)}%`} />
                <Row label="Yield %" value={`${o.yieldPct.toFixed(2)}%`} bold />
                <Row label="Depreciation" value={formatMoney(o.depreciation)} />
                <Row label="Interest" value={formatMoney(o.interest)} />
                <Row label="Lease payment" value={formatMoney(o.payment)} bold />
                {o.taxProvince === "BC" ? (
                  <>
                    <Row label={`GST ${(o.gstRate * 100).toFixed(0)}%`} value={formatMoney(o.gstOnPayment)} />
                    <Row label={`PST ${(o.pstRate * 100).toFixed(0)}% (locked)`} value={formatMoney(o.pstOnPayment)} />
                    <Row label="Taxes total" value={formatMoney(o.taxOnPayment)} bold />
                    <Row label="TRV (gross cap)" value={formatMoney(o.trv)} />
                    <Row label="Buyout tax (end)" value={formatMoney(o.residualTax)} />
                  </>
                ) : o.taxProvince === "QC" ? (
                  <>
                    <Row
                      label={`GST ${(o.gstRate * 100).toFixed(2)}%${o.taxCreditApplied ? " on tax-cap pmt" : ""}`}
                      value={formatMoney(o.gstOnPayment)}
                    />
                    <Row
                      label={`QST ${(o.pstRate * 100).toFixed(3)}%${o.taxCreditApplied ? " on tax-cap pmt" : ""}`}
                      value={formatMoney(o.pstOnPayment)}
                    />
                    <Row label="Taxes total" value={formatMoney(o.taxOnPayment)} bold />
                    {o.taxCreditApplied ? (
                      <Row
                        label="NAV tax codes"
                        value={`GST ${(o.effectiveGstRate * 100).toFixed(4)}% · QST ${(o.effectivePstRate * 100).toFixed(4)}%`}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <Row
                      label={o.taxCreditApplied ? "Tax (on tax-cap payment)" : "Taxes"}
                      value={formatMoney(o.taxOnPayment)}
                      bold
                    />
                    {o.taxCreditApplied ? (
                      <Row
                        label="NAV tax code"
                        value={`${(o.effectiveGstRate * 100).toFixed(4)}%`}
                      />
                    ) : null}
                  </>
                )}
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
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Share quote opens a customer PDF and sets the lead to Quote Sent.
        Update draft / Back to lead save without changing stage.
        Accept builds contract + invoice. Email 1st invoice sends the pro forma to the client email. Push to Drive is on the lead page.
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

/** Allows typing 0.30, 7.99, etc. without eating leading zeros or the decimal point. */
function DecimalField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft !== null ? draft : value === 0 ? "" : String(value);

  function commit(raw: string) {
    const cleaned = raw.replace(/[,$\s]/g, "");
    // Allow intermediate states while typing: "", ".", "0.", "7.", "0.3"
    if (cleaned === "" || cleaned === "." || cleaned === "-" || cleaned === "-.") {
      setDraft(raw);
      onChange(0);
      return;
    }
    if (!/^-?\d*\.?\d*$/.test(cleaned)) return;
    setDraft(raw);
    if (cleaned.endsWith(".") || cleaned === "-0") {
      // Keep draft; push best-effort number for live calc
      const n = Number(cleaned);
      if (Number.isFinite(n)) onChange(n);
      return;
    }
    const n = Number(cleaned);
    if (Number.isFinite(n)) onChange(n);
  }

  return (
    <div className={className || "grid gap-1.5"}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        inputMode="decimal"
        value={display}
        placeholder="0"
        onChange={(e) => commit(e.target.value)}
        onBlur={() => {
          setDraft(null);
        }}
        onFocus={() => {
          setDraft(value === 0 ? "" : String(value));
        }}
        className="h-9 rounded-sm tabular"
      />
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
    <DecimalField
      label={label}
      value={value}
      onChange={onChange}
      className="grid gap-1"
    />
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
