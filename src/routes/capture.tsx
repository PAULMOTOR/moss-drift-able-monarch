import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  Check,
  ClipboardPaste,
  FileUp,
  Footprints,
  Mail,
  Phone,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  captureLead,
  getMyProfile,
  listInventory,
  listProfiles,
  parseEmailLead,
} from "@/lib/crm/server";
import { decodeVin, normalizeVin } from "@/lib/crm/vin-decode";
import {
  LEAD_TYPES,
  SOURCES,
  vehicleLabel,
  type InventoryItem,
  type LeadType,
  type Profile,
} from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";

export const Route = createFileRoute("/capture")({
  component: () => (
    <AuthGate>
      <CapturePage />
    </AuthGate>
  ),
});

const MAX_PDF_BYTES = 4 * 1024 * 1024; // 4MB base64-safe for prototype

function CapturePage() {
  const navigate = useNavigate();
  const capture = useServerFn(captureLead);
  const parseEmail = useServerFn(parseEmailLead);
  const decodeVinFn = useServerFn(decodeVin);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [me, setMe] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [vinBusy, setVinBusy] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const [invQ, setInvQ] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailRaw, setEmailRaw] = useState("");
  const [parseBusy, setParseBusy] = useState(false);
  const [parseHint, setParseHint] = useState<string | null>(null);
  const [pdfDrag, setPdfDrag] = useState(false);
  const [form, setForm] = useState({
    lead_type: "inventory" as LeadType,
    name: "",
    first_name: "",
    last_name: "",
    party_type: "individual" as "individual" | "business",
    phone: "",
    email: "",
    source: "phone",
    notes: "",
    vehicle_interest: "",
    vehicle_year: "" as string,
    vehicle_make: "",
    vehicle_model: "",
    vehicle_vin: "",
    inventory_id: "" as string,
    assigned_to: "",
    quote_sent: false,
    quote_sent_at: "",
    quote_link: "",
    quote_notes: "",
    quote_pdf_name: "" as string,
    quote_pdf_data: "" as string,
    source_email_raw: "" as string,
  });

  function composeVehicleInterest(f: typeof form): string {
    const parts = [
      f.vehicle_year?.trim(),
      f.vehicle_make?.trim(),
      f.vehicle_model?.trim(),
    ].filter(Boolean);
    const base = parts.join(" ");
    if (f.vehicle_vin?.trim()) {
      return base
        ? `${base} · VIN ${normalizeVin(f.vehicle_vin)}`
        : `VIN ${normalizeVin(f.vehicle_vin)}`;
    }
    return base || f.vehicle_interest.trim();
  }

  function applyVehicleParse(text: string) {
    const raw = text.trim();
    if (!raw) return {};
    // VIN-only
    const maybeVin = normalizeVin(raw);
    if (maybeVin.length === 17 && !/\s/.test(raw.replace(/[^A-Za-z0-9]/g, ""))) {
      return { vehicle_vin: maybeVin };
    }
    const m = raw.match(/^((?:19|20)\d{2})\s+([A-Za-z0-9À-ÿ-]+)\s+(.+)$/);
    if (m) {
      return {
        vehicle_year: m[1],
        vehicle_make: m[2],
        vehicle_model: m[3].replace(/\s*[·•].*$/, "").trim(),
      };
    }
    return { vehicle_model: raw, vehicle_interest: raw };
  }

  async function explodeVin() {
    const vin = normalizeVin(form.vehicle_vin);
    if (vin.length !== 17) {
      toast.error("Enter a 17-character VIN");
      return;
    }
    setVinBusy(true);
    try {
      const result = await decodeVinFn({ data: { vin } });
      if (!result.ok) {
        toast.error(result.message || "Could not decode VIN");
        return;
      }
      setForm((f) => ({
        ...f,
        vehicle_vin: result.vin,
        vehicle_year: result.year != null ? String(result.year) : f.vehicle_year,
        vehicle_make: result.make || f.vehicle_make,
        vehicle_model: [result.model, result.trim].filter(Boolean).join(" ") || f.vehicle_model,
      }));
      toast.success(result.message || "VIN decoded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "VIN decode failed");
    } finally {
      setVinBusy(false);
    }
  }

  useEffect(() => {
    void Promise.all([listProfiles({ data: {} }), listInventory({ data: {} }), getMyProfile()]).then(
      ([p, inv, profile]) => {
        setProfiles(p);
        setInventory(inv.filter((i) => i.status === "available" || i.status === "incoming"));
        setMe(profile);
        const lucas = p.find(
          (x) => x.email?.toLowerCase() === "lucasl@paulmotorcompany.com" || /^lucas/i.test(x.name),
        );
        setForm((f) => ({
          ...f,
          // Inventory defaults to Lucas; other types default to current user
          assigned_to: f.lead_type === "inventory" && lucas ? lucas.id : profile.id,
        }));
      },
    );
  }, []);

  const filteredInv = useMemo(() => {
    const q = invQ.trim().toLowerCase();
    if (!q) return inventory.slice(0, 14);
    return inventory
      .filter((i) =>
        [i.year, i.make, i.model, i.trim, i.stock_number, i.exterior_color]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 14);
  }, [inventory, invQ]);

  const selectedInv = inventory.find((i) => i.id === form.inventory_id);

  async function applyEmailParse() {
    if (!emailRaw.trim()) {
      toast.error("Paste an email first");
      return;
    }
    setParseBusy(true);
    try {
      const parsed = await parseEmail({ data: { raw: emailRaw } });
      const nameParts = (parsed.name || "").trim().split(/\s+/).filter(Boolean);
      const first_name = nameParts[0] || "";
      const last_name = nameParts.slice(1).join(" ");
      const businessHint =
        /business|inc\.?|ltd\.?|llc|corp|company|leasing form business/i.test(emailRaw) ||
        /business|inc\.?|ltd\.?|llc|corp/i.test(parsed.name || "");
      setForm((f) => ({
        ...f,
        lead_type: parsed.lead_type,
        name: parsed.name || f.name,
        first_name: first_name || f.first_name,
        last_name: last_name || f.last_name,
        party_type: businessHint ? "business" : f.party_type,
        phone: parsed.phone || f.phone,
        email: parsed.email || f.email,
        source: parsed.source || "email",
        notes: parsed.notes || f.notes,
        vehicle_interest: parsed.vehicle_interest || parsed.inventory_label || f.vehicle_interest,
        ...applyVehicleParse(parsed.vehicle_interest || parsed.inventory_label || ""),
        inventory_id:
          parsed.lead_type === "inventory" && parsed.inventory_id
            ? parsed.inventory_id
            : parsed.lead_type === "lease"
              ? ""
              : f.inventory_id,
        source_email_raw: emailRaw.trim(),
      }));
      const bits = [
        parsed.confidence,
        parsed.matched_fields.filter((m) => !m.startsWith("type:")).join(", ") || "few fields",
      ];
      if (parsed.inventory_label) bits.push(`matched ${parsed.inventory_label}`);
      setParseHint(`Parsed (${bits.join(" · ")})`);
      toast.success(
        parsed.lead_type === "lease"
          ? "Lease inquiry fields filled — confirm and save"
          : parsed.lead_type === "general"
            ? "General interest fields filled — confirm and save"
            : "Inventory lead fields filled — confirm and save",
      );
      setEmailOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not parse email");
    } finally {
      setParseBusy(false);
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
    setForm((f) => ({
      ...f,
      quote_sent: true,
      quote_sent_at: f.quote_sent_at || new Date().toISOString().slice(0, 16),
      quote_pdf_name: file.name,
      quote_pdf_data: dataUrl,
    }));
    toast.success(`Attached ${file.name}`);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const vehicleInterest = composeVehicleInterest(form);
      const lead = await capture({
        data: {
          name: [form.first_name, form.last_name].filter(Boolean).join(" ") || form.name,
          phone: form.phone || undefined,
          email: form.email || undefined,
          source: form.source,
          lead_type: form.lead_type,
          notes: form.notes || undefined,
          vehicle_interest: vehicleInterest || form.vehicle_interest || undefined,
          inventory_id: form.lead_type === "inventory" ? form.inventory_id || null : null,

          assigned_to: form.assigned_to || null,
          first_name: form.first_name || undefined,
          last_name: form.last_name || undefined,
          party_type: form.party_type || "individual",
          quote_sent: form.quote_sent,
          quote_sent_at:
            form.quote_sent && form.quote_sent_at
              ? new Date(form.quote_sent_at).toISOString()
              : null,
          quote_link: form.quote_link || undefined,
          quote_notes: form.quote_notes || undefined,
          quote_pdf_name: form.quote_pdf_name || null,
          quote_pdf_data: form.quote_pdf_data || null,
          source_email_raw: form.source_email_raw || null,
          estimated_value: selectedInv?.price ?? null,
        },
      });
      toast.success("Lead captured");
      void navigate({ to: "/leads/$leadId", params: { leadId: lead.id }, search: {} });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save lead");
    } finally {
      setBusy(false);
    }
  }

  function quickSource(source: string) {
    setForm((f) => ({ ...f, source }));
  }

  return (
    <>
      <PageHeader
        title="New Lead"
        description="Phone, walk-in, or paste an email — under 15 seconds on the floor."
        actions={
          <Button
            type="button"
            variant={emailOpen ? "default" : "outline"}
            className="h-11"
            onClick={() => setEmailOpen((o) => !o)}
          >
            <ClipboardPaste className="size-4" />
            Parse from email
          </Button>
        }
      />

      {emailOpen ? (
        <Card className="mb-4 border-primary/30 bg-primary/5">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-primary">Paste full email</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Works for website inventory inquiries and broker lease quote requests. We pull
                  name, phone, email, stock #, and vehicle.
                </p>
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={() => setEmailOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
            <Textarea
              rows={8}
              autoFocus
              placeholder={`Example inventory lead:

From: webform@paulmotorleasing.com
Subject: Inventory inquiry — Stock #18160

Name: Philippe Moreau
Email: p.moreau@example.com
Phone: 514-555-2201
Stock #: 18160
Vehicle: 2024 Ferrari Purosangue AWD
Message: Interested in a viewing this weekend.`}
              value={emailRaw}
              onChange={(e) => setEmailRaw(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void applyEmailParse()} disabled={parseBusy}>
                <Mail className="size-4" />
                {parseBusy ? "Parsing…" : "Fill form from email"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEmailRaw("")}>
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {parseHint ? (
        <p className="mb-3 text-xs text-primary">{parseHint}</p>
      ) : null}

      <form onSubmit={submit} className="mx-auto max-w-xl space-y-4">
        {/* Lead type — Inventory vs Lease */}
        <div className="grid grid-cols-2 gap-2">
          {LEAD_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  lead_type: t.id,
                  source: t.id === "lease" && f.source === "phone" ? "broker" : f.source,
                  inventory_id: t.id === "lease" ? "" : f.inventory_id,
                }))
              }
              className={cn(
                "rounded-xl border px-3 py-3 text-left transition-colors",
                form.lead_type === t.id
                  ? "border-primary bg-primary/15 shadow-sm shadow-primary/10"
                  : "border-border bg-card hover:border-primary/40",
              )}
            >
              <span className="block text-sm font-semibold">{t.label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                {t.description}
              </span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="lg"
            variant={form.source === "phone" ? "default" : "outline"}
            className="h-14"
            onClick={() => quickSource("phone")}
          >
            <Phone className="size-4" />
            Phone call
          </Button>
          <Button
            type="button"
            size="lg"
            variant={form.source === "walk_in" ? "default" : "outline"}
            className="h-14"
            onClick={() => quickSource("walk_in")}
          >
            <Footprints className="size-4" />
            Walk-in
          </Button>
        </div>

        <Card className="border-primary/20 shadow-lg shadow-primary/5">
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="first_name">First name *</Label>
                <Input
                  id="first_name"
                  required
                  autoFocus={!emailOpen}
                  autoComplete="given-name"
                  className="h-12 text-base"
                  placeholder="First"
                  value={form.first_name}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      first_name: e.target.value,
                      name: [e.target.value, f.last_name].filter(Boolean).join(" "),
                    }))
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="last_name">Last name *</Label>
                <Input
                  id="last_name"
                  required
                  autoComplete="family-name"
                  className="h-12 text-base"
                  placeholder="Last"
                  value={form.last_name}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      last_name: e.target.value,
                      name: [f.first_name, e.target.value].filter(Boolean).join(" "),
                    }))
                  }
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Client type</Label>
              <Select
                value={form.party_type}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    party_type: v as "individual" | "business",
                  }))
                }
              >
                <SelectTrigger className="h-12">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="individual">Individual</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="phone">Phone *</Label>
                <Input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  className="h-12 text-base"
                  placeholder="514-…"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  className="h-12 text-base"
                  placeholder="optional"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Source</Label>
              <Select value={form.source} onValueChange={(v) => setForm((f) => ({ ...f, source: v }))}>
                <SelectTrigger className="h-12">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.filter((s) => s.id !== "web").map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {form.lead_type === "inventory" ? (
              <div className="grid gap-1.5">
                <Label>Inventory unit (live stock)</Label>
                <div className="relative">
                  <button
                    type="button"
                    className={cn(
                      "flex h-12 w-full items-center justify-between rounded-lg border border-input bg-card px-3 text-left text-sm",
                      selectedInv ? "text-foreground" : "text-muted-foreground",
                    )}
                    onClick={() => setInvOpen((o) => !o)}
                  >
                    <span className="truncate">
                      {selectedInv
                        ? `${vehicleLabel(selectedInv)} · #${selectedInv.stock_number}`
                        : form.vehicle_interest || "Search live inventory…"}
                    </span>
                    <Search className="size-4 shrink-0 opacity-50" />
                  </button>
                  {invOpen ? (
                    <div className="absolute z-20 mt-1 w-full rounded-xl border border-border bg-popover p-2 shadow-xl">
                      <Input
                        autoFocus
                        placeholder="Ferrari, stock #18160…"
                        value={invQ}
                        onChange={(e) => setInvQ(e.target.value)}
                        className="mb-2 h-10"
                      />
                      <div className="max-h-56 space-y-1 overflow-y-auto">
                        {filteredInv.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="flex w-full items-start justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => {
                              setForm((f) => ({
                                ...f,
                                inventory_id: item.id,
                                vehicle_interest: vehicleLabel(item),
                                vehicle_year: item.year != null ? String(item.year) : f.vehicle_year,
                                vehicle_make: item.make || f.vehicle_make,
                                vehicle_model: [item.model, item.trim].filter(Boolean).join(" ") || f.vehicle_model,
                                vehicle_vin: item.vin ? normalizeVin(item.vin) : f.vehicle_vin,
                              }));
                              setInvOpen(false);
                            }}
                          >
                            <span>
                              <span className="font-medium">{vehicleLabel(item)}</span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                Stock #{item.stock_number}
                                {item.mileage != null
                                  ? ` · ${item.mileage.toLocaleString("en-CA")} km`
                                  : ""}
                              </span>
                            </span>
                            <span className="shrink-0 tabular text-xs text-primary">
                              {formatCurrency(item.price)}
                            </span>
                          </button>
                        ))}
                        {filteredInv.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-muted-foreground">
                            No live inventory match
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="mt-1 w-full rounded-lg px-2 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
                        onClick={() => {
                          setForm((f) => ({ ...f, inventory_id: "" }));
                          setInvOpen(false);
                        }}
                      >
                        Clear inventory selection
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="grid gap-3">
                <Label>Vehicle for lease quote *</Label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="grid gap-1">
                    <Label htmlFor="v-year" className="text-[11px] text-muted-foreground">
                      Year
                    </Label>
                    <Input
                      id="v-year"
                      className="h-11"
                      inputMode="numeric"
                      placeholder="2025"
                      maxLength={4}
                      value={form.vehicle_year}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, vehicle_year: e.target.value.replace(/\D/g, "").slice(0, 4) }))
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="v-make" className="text-[11px] text-muted-foreground">
                      Make
                    </Label>
                    <Input
                      id="v-make"
                      className="h-11"
                      placeholder="Porsche"
                      value={form.vehicle_make}
                      onChange={(e) => setForm((f) => ({ ...f, vehicle_make: e.target.value }))}
                    />
                  </div>
                  <div className="grid gap-1 col-span-2">
                    <Label htmlFor="v-model" className="text-[11px] text-muted-foreground">
                      Model
                    </Label>
                    <Input
                      id="v-model"
                      className="h-11"
                      placeholder="911 Carrera S"
                      value={form.vehicle_model}
                      onChange={(e) => setForm((f) => ({ ...f, vehicle_model: e.target.value }))}
                      required={form.lead_type === "lease"}
                    />
                  </div>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="v-vin" className="text-[11px] text-muted-foreground">
                    VIN
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="v-vin"
                      className="h-11 min-w-0 flex-1 font-mono tracking-wide uppercase"
                      placeholder="17-character VIN"
                      maxLength={17}
                      autoComplete="off"
                      value={form.vehicle_vin}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          vehicle_vin: normalizeVin(e.target.value),
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void explodeVin();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-11 shrink-0"
                      disabled={vinBusy || normalizeVin(form.vehicle_vin).length !== 17}
                      onClick={() => void explodeVin()}
                    >
                      <Search className="size-4" />
                      {vinBusy ? "Decoding…" : "Explode VIN"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Free NHTSA (DOT) decode fills year, make, model. Colour is not in the VIN
                    {form.vehicle_vin ? ` · ${normalizeVin(form.vehicle_vin).length}/17` : ""}.
                  </p>
                </div>
              </div>
            )}

            {form.lead_type === "inventory" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="interest">Vehicle interest notes</Label>
                <Input
                  id="interest"
                  className="h-11"
                  placeholder="Optional free-text (e.g. prefers Rosso, under 200k)"
                  value={form.vehicle_interest}
                  onChange={(e) => setForm((f) => ({ ...f, vehicle_interest: e.target.value }))}
                />
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label>Assign to</Label>
              <Select
                value={form.assigned_to || me?.id || ""}
                onValueChange={(v) => setForm((f) => ({ ...f, assigned_to: v }))}
              >
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Rep / broker" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      <span className="text-muted-foreground"> · {p.role}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                rows={3}
                placeholder="Budget, timeline, trade-in, broker details…"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>

            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <label className="flex items-start gap-3">
                <Checkbox
                  checked={form.quote_sent}
                  onCheckedChange={(c) =>
                    setForm((f) => ({
                      ...f,
                      quote_sent: c === true,
                      quote_sent_at:
                        c === true && !f.quote_sent_at
                          ? new Date().toISOString().slice(0, 16)
                          : f.quote_sent_at,
                    }))
                  }
                  className="mt-0.5"
                />
                <span>
                  <span className="text-sm font-medium">Quote already sent</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Attach the PDF quote, link, and notes
                  </span>
                </span>
              </label>
              {form.quote_sent ? (
                <div className="mt-3 grid gap-2">
                  <Input
                    type="datetime-local"
                    value={form.quote_sent_at}
                    onChange={(e) => setForm((f) => ({ ...f, quote_sent_at: e.target.value }))}
                  />
                  <div
                    className={cn(
                      "rounded-xl border border-dashed px-3 py-4 text-center transition-colors",
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
                    <FileUp className="mx-auto size-5 text-primary" />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Drag & drop PDF quote here, or{" "}
                      <button
                        type="button"
                        className="font-medium text-primary underline-offset-2 hover:underline"
                        onClick={() => pdfInputRef.current?.click()}
                      >
                        browse
                      </button>
                    </p>
                    {form.quote_pdf_name ? (
                      <div className="mt-2 flex items-center justify-center gap-2 text-xs text-foreground">
                        <span className="truncate font-medium">{form.quote_pdf_name}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              quote_pdf_name: "",
                              quote_pdf_data: "",
                            }))
                          }
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
                    placeholder="Quote link (optional)"
                    value={form.quote_link}
                    onChange={(e) => setForm((f) => ({ ...f, quote_link: e.target.value }))}
                  />
                  <Input
                    placeholder="Quote notes"
                    value={form.quote_notes}
                    onChange={(e) => setForm((f) => ({ ...f, quote_notes: e.target.value }))}
                  />
                </div>
              ) : null}
            </div>

            <Button type="submit" className="h-14 w-full text-base font-semibold" disabled={busy}>
              {busy ? (
                "Saving…"
              ) : (
                <>
                  <Check className="size-5" />
                  Save {
                    form.lead_type === "lease"
                      ? "lease"
                      : form.lead_type === "general"
                        ? "general"
                        : "inventory"
                  }{" "}
                  lead
                </>
              )}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
              <UserRound className="size-3" />
              Capturing as {me?.name || "…"}
            </p>
          </CardContent>
        </Card>
      </form>
    </>
  );
}
