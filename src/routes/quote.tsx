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
  getLead,
  listInventory,
  listLeads,
  saveLeaseQuote,
} from "@/lib/crm/server";
import type { InventoryItem, Lead } from "@/lib/crm/types";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMyProfile } from "@/lib/crm/server";
import { Calculator, Printer, Save } from "lucide-react";

type QuoteSearch = { leadId?: string };

export const Route = createFileRoute("/quote")({
  validateSearch: (s: Record<string, unknown>): QuoteSearch => ({
    leadId: typeof s.leadId === "string" ? s.leadId : undefined,
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

function QuotePage() {
  const search = useSearch({ from: "/quote" });
  const save = useServerFn(saveLeaseQuote);
  const { user } = useCurrentUserState();
  const [busy, setBusy] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [leadId, setLeadId] = useState(search.leadId || "");
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
    deliveryDate: "",
    notes: "This quote is valid for one week.",
    adminFee: 499,
    trackerFee: 495,
    lienPpsa: 0,
    license: 0,
    tireTax: 0,
  });

  const [options, setOptions] = useState<LeaseOptionInput[]>([
    emptyOption({ termMonths: 24, ratePct: 6.99 }),
    emptyOption({ termMonths: 36, ratePct: 6.99 }),
    emptyOption({ termMonths: 48, ratePct: 6.99 }),
  ]);

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
                    handling: suggestHandling(lead.estimated_value || 0, 0, 0),
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
      opts.map((o, idx) => ({
        ...o,
        cost: price,
        handling: suggestHandling(price, o.extra, o.profit),
        residual: o.residual || Math.round(price * (0.6 - idx * 0.05)),
        deposit: o.deposit || Math.round(price * 0.2),
      })),
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

  const calculated: LeaseOptionResult[] = useMemo(
    () => options.map((o) => calcLeaseOption(o, taxRate, fees)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, taxRate, client.adminFee, client.trackerFee, client.lienPpsa, client.license, client.tireTax],
  );

  function patchOption(i: number, patch: Partial<LeaseOptionInput>) {
    setOptions((prev) => {
      const next = [...prev];
      const merged = { ...next[i], ...patch };
      // Auto-suggest handling when vehicle price changes and handling still 0
      if (
        ("cost" in patch || "extra" in patch || "profit" in patch) &&
        (next[i].handling === 0 || patch.cost !== undefined)
      ) {
        if (next[i].handling === 0 || "cost" in patch) {
          merged.handling = suggestHandling(
            merged.cost,
            merged.extra,
            merged.profit,
          );
        }
      }
      next[i] = merged;
      return next;
    });
  }

  async function onSave() {
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
          status: "draft",
        },
      });
      toast.success("Lease quote saved");
      // Open printable retail quote
      const w = window.open("", "_blank");
      if (w && res.html) {
        w.document.write(res.html);
        w.document.close();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function onPrint() {
    const w = window.open("", "_blank");
    if (!w) return;
    // Build via same server path - client-side quick print from calculated
    void import("@/lib/crm/lease-quote").then(({ buildRetailQuoteHtml }) => {
      const html = buildRetailQuoteHtml(client, calculated, taxRate);
      w.document.write(html);
      w.document.close();
      setTimeout(() => w.print(), 300);
    });
  }

  return (
    <>
      <PageHeader
        title="Lease quote"
        description="Paul Motor spreadsheet engine — three options, provincial tax, due on delivery."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onPrint}>
              <Printer className="size-4" />
              Print / PDF
            </Button>
            <Button type="button" disabled={busy} onClick={() => void onSave()}>
              <Save className="size-4" />
              {busy ? "Saving…" : "Save quote"}
            </Button>
          </div>
        }
      />

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
            <Field
              label="Client name"
              value={client.clientName}
              onChange={(v) => setClient((c) => ({ ...c, clientName: v }))}
            />
            <Field
              label="Phone"
              value={client.phone}
              onChange={(v) => setClient((c) => ({ ...c, phone: v }))}
            />
            <Field
              label="Email"
              value={client.email}
              onChange={(v) => setClient((c) => ({ ...c, email: v }))}
            />
            <Field
              label="Guarantor"
              value={client.guarantor}
              onChange={(v) => setClient((c) => ({ ...c, guarantor: v }))}
            />
            <Field
              label="Address"
              value={client.address}
              onChange={(v) => setClient((c) => ({ ...c, address: v }))}
            />
            <Field
              label="City"
              value={client.city}
              onChange={(v) => setClient((c) => ({ ...c, city: v }))}
            />
            <div className="grid gap-1.5">
              <Label>Province (tax)</Label>
              <Select
                value={client.province}
                onValueChange={(v) => setClient((c) => ({ ...c, province: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(PROVINCE_TAX).map((p) => (
                    <SelectItem key={p} value={p}>
                      {p} ({(PROVINCE_TAX[p] * 100).toFixed(3)}%)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field
              label="Postal code"
              value={client.postalCode}
              onChange={(v) => setClient((c) => ({ ...c, postalCode: v }))}
            />
            <div className="sm:col-span-2 grid gap-1.5">
              <Label>Inventory vehicle</Label>
              <Select
                value="__pick__"
                onValueChange={(id) => {
                  const inv = inventory.find((i) => i.id === id);
                  if (inv) applyInventory(inv);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Prefill from inventory" />
                </SelectTrigger>
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
            <Field
              label="Year"
              value={client.year?.toString() || ""}
              onChange={(v) =>
                setClient((c) => ({ ...c, year: v ? Number(v) : null }))
              }
            />
            <Field
              label="Make"
              value={client.make}
              onChange={(v) => setClient((c) => ({ ...c, make: v }))}
            />
            <Field
              label="Model"
              value={client.model}
              onChange={(v) => setClient((c) => ({ ...c, model: v }))}
            />
            <Field
              label="Trim"
              value={client.trim}
              onChange={(v) => setClient((c) => ({ ...c, trim: v }))}
            />
            <Field
              label="Colour"
              value={client.color}
              onChange={(v) => setClient((c) => ({ ...c, color: v }))}
            />
            <Field
              label="KM"
              value={client.km?.toString() || ""}
              onChange={(v) =>
                setClient((c) => ({ ...c, km: v ? Number(v) : null }))
              }
            />
            <Field
              label="VIN"
              value={client.vin}
              onChange={(v) => setClient((c) => ({ ...c, vin: v }))}
            />
            <Field
              label="Stock #"
              value={client.stock}
              onChange={(v) => setClient((c) => ({ ...c, stock: v }))}
            />
            <Field
              label="KM / year"
              value={String(client.kmPerYear)}
              onChange={(v) =>
                setClient((c) => ({ ...c, kmPerYear: num(v) || 16000 }))
              }
            />
            <Field
              label="$ / KM over"
              value={String(client.excessKmFee)}
              onChange={(v) =>
                setClient((c) => ({ ...c, excessKmFee: num(v) }))
              }
            />
            <Field
              label="Salesman"
              value={client.salesman}
              onChange={(v) => setClient((c) => ({ ...c, salesman: v }))}
            />
            <Field
              label="Quote date"
              value={client.quoteDate}
              onChange={(v) => setClient((c) => ({ ...c, quoteDate: v }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              Fees (due on delivery)
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field
              label="Admin / document"
              value={String(client.adminFee)}
              onChange={(v) => setClient((c) => ({ ...c, adminFee: num(v) }))}
            />
            <Field
              label="Tracker / anti-theft"
              value={String(client.trackerFee)}
              onChange={(v) => setClient((c) => ({ ...c, trackerFee: num(v) }))}
            />
            <Field
              label="Lien / PPSA"
              value={String(client.lienPpsa)}
              onChange={(v) => setClient((c) => ({ ...c, lienPpsa: num(v) }))}
            />
            <Field
              label="License"
              value={String(client.license)}
              onChange={(v) => setClient((c) => ({ ...c, license: num(v) }))}
            />
            <Field
              label="Tire tax"
              value={String(client.tireTax)}
              onChange={(v) => setClient((c) => ({ ...c, tireTax: num(v) }))}
            />
            <p className="text-xs text-muted-foreground">
              Tax rate: <strong>{(taxRate * 100).toFixed(3)}%</strong> (
              {client.province})
            </p>
            <p className="text-xs text-muted-foreground">
              Formula: Excel <code>PMT(rate/12, term, −financed, residual)</code>{" "}
              + handling — matches your Google Sheet samples.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        {calculated.map((o, i) => (
          <Card key={i}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-semibold text-primary">
                Option {i + 1}
              </CardTitle>
              <Calculator className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="space-y-2">
              <MoneyField
                label="Cost / price"
                value={options[i].cost}
                onChange={(v) => patchOption(i, { cost: v })}
              />
              <MoneyField
                label="Extra"
                value={options[i].extra}
                onChange={(v) => patchOption(i, { extra: v })}
              />
              <MoneyField
                label="Profit"
                value={options[i].profit}
                onChange={(v) => patchOption(i, { profit: v })}
              />
              <MoneyField
                label="Trade-in"
                value={options[i].tradeIn}
                onChange={(v) => patchOption(i, { tradeIn: v })}
              />
              <MoneyField
                label="Deposit (cash down)"
                value={options[i].deposit}
                onChange={(v) => patchOption(i, { deposit: v })}
              />
              <div className="grid grid-cols-2 gap-2">
                <MoneyField
                  label="Term (mo)"
                  value={options[i].termMonths}
                  onChange={(v) => patchOption(i, { termMonths: Math.round(v) })}
                />
                <MoneyField
                  label="Rate %"
                  value={options[i].ratePct}
                  onChange={(v) => patchOption(i, { ratePct: v })}
                />
              </div>
              <MoneyField
                label="Residual"
                value={options[i].residual}
                onChange={(v) => patchOption(i, { residual: v })}
              />
              <MoneyField
                label="Handling $"
                value={options[i].handling}
                onChange={(v) => patchOption(i, { handling: v })}
              />

              <div className="mt-3 space-y-1 rounded-sm border border-border bg-muted/40 p-3 text-xs">
                <Row label="Financed" value={formatMoney(o.financed)} />
                <Row label={`Deposit %`} value={`${o.depositPct}%`} />
                <Row label={`Residual %`} value={`${o.residualPct}%`} />
                <Row label="Depreciation" value={formatMoney(o.depreciation)} />
                <Row label="Interest" value={formatMoney(o.interest)} />
                <Row label="Handling" value={formatMoney(o.handling)} />
                <Row label="Lease payment" value={formatMoney(o.payment)} bold />
                <Row label="Taxes" value={formatMoney(o.taxOnPayment)} />
                <Row
                  label="Total payment"
                  value={formatMoney(o.totalPayment)}
                  bold
                />
                <Row
                  label="Due on delivery"
                  value={formatMoney(o.dueTotal)}
                  bold
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Save attaches the quote to the lead (stage → Quote Sent) and opens a
        printable retail quote. Email/SMS send comes next once Resend domain is
        verified.
      </p>
      {leadId ? (
        <p className="mt-2 text-center text-xs">
          <Link
            to="/leads/$leadId"
            params={{ leadId }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Back to lead
          </Link>
        </p>
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
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-sm"
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

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-2 ${bold ? "font-semibold text-foreground" : "text-muted-foreground"}`}
    >
      <span>{label}</span>
      <span className="tabular text-foreground">{value}</span>
    </div>
  );
}
