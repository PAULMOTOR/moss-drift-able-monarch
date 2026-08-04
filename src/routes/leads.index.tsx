import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Search, Zap } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { StageBadge } from "@/components/stage-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listLeads, listProfiles } from "@/lib/crm/server";
import { LEAD_TYPES, STAGES, sourceLabel, type Lead, type Profile } from "@/lib/crm/types";
import { cn, formatCurrency, formatRelative } from "@/lib/utils";

export const Route = createFileRoute("/leads/")({
  component: LeadsPage,
});

function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("all");
  const [assigned, setAssigned] = useState("all");
  const [leadType, setLeadType] = useState("all");

  async function load(next?: {
    q?: string;
    stage?: string;
    assigned?: string;
    lead_type?: string;
  }) {
    const [rows, people] = await Promise.all([
      listLeads({
        data: {
          q: next?.q ?? q,
          stage: next?.stage ?? stage,
          assigned: next?.assigned ?? assigned,
          lead_type: next?.lead_type ?? leadType,
        },
      }),
      listProfiles({ data: {} }),
    ]);
    setLeads(rows);
    setProfiles(people);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader
        title="Leads"
        description="Full customer list — inventory sales and lease quote requests."
        actions={
          <Button asChild>
            <Link to="/capture">
              <Zap className="size-4" />
              New Lead
            </Link>
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-11 pl-9"
                placeholder="Search name, phone, email, vehicle…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void load({ q: e.currentTarget.value });
                }}
              />
            </div>
            <Select
              value={leadType}
              onValueChange={(v) => {
                setLeadType(v);
                void load({ lead_type: v });
              }}
            >
              <SelectTrigger className="h-11 w-full lg:w-36">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {LEAD_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={stage}
              onValueChange={(v) => {
                setStage(v);
                void load({ stage: v });
              }}
            >
              <SelectTrigger className="h-11 w-full lg:w-44">
                <SelectValue placeholder="Stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {STAGES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={assigned}
              onValueChange={(v) => {
                setAssigned(v);
                void load({ assigned: v });
              }}
            >
              <SelectTrigger className="h-11 w-full lg:w-48">
                <SelectValue placeholder="Owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">My leads + unassigned</SelectItem>
                <SelectItem value="unassigned">Unassigned only</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="secondary" className="h-11" onClick={() => void load()}>
              Apply
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">{leads.length} leads</p>

          <div className="space-y-2">
            {leads.map((lead) => (
              <Link
                key={lead.id}
                to="/leads/$leadId"
                params={{ leadId: lead.id }}
                className="block rounded-xl border border-border/80 bg-background/40 p-4 transition-colors hover:border-primary/30"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{lead.name}</p>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          lead.lead_type === "lease"
                            ? "border-accent-foreground/30 bg-accent text-accent-foreground"
                            : "border-primary/40 bg-primary/15 text-primary",
                        )}
                      >
                        {lead.lead_type === "lease" ? "Lease" : "Inventory"}
                      </span>
                      <StageBadge stage={lead.stage} />
                      {lead.quote_sent ? (
                        <span className="text-[10px] uppercase tracking-wide text-primary">
                          Quote
                          {lead.quote_pdf_name ? " · PDF" : ""}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {lead.phone || lead.email || "—"} · {sourceLabel(lead.source)}
                      {lead.assigned_name ? ` · ${lead.assigned_name}` : ""}
                    </p>
                    <p className="mt-0.5 line-clamp-1 text-sm text-foreground/80">
                      {lead.vehicle_interest || lead.inventory_label || "No vehicle noted"}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p className="tabular text-sm text-foreground">
                      {formatCurrency(lead.estimated_value)}
                    </p>
                    <p>{formatRelative(lead.updated_at)}</p>
                  </div>
                </div>
              </Link>
            ))}
            {leads.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No leads match.</p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
