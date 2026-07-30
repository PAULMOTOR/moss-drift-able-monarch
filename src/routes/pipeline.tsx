import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listLeads, listProfiles, updateLead } from "@/lib/crm/server";
import {
  STAGES,
  daysInStage,
  type Lead,
  type Profile,
  type StageId,
} from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";
import { Zap } from "lucide-react";

export const Route = createFileRoute("/pipeline")({
  component: () => (
    <AuthGate>
      <PipelinePage />
    </AuthGate>
  ),
});

function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [assigned, setAssigned] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const update = useServerFn(updateLead);

  async function load(filter = assigned) {
    const [rows, people] = await Promise.all([
      listLeads({ data: { assigned: filter } }),
      listProfiles({ data: {} }),
    ]);
    setLeads(rows);
    setProfiles(people);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = useMemo(() => {
    const map = Object.fromEntries(STAGES.map((s) => [s.id, [] as Lead[]])) as Record<
      StageId,
      Lead[]
    >;
    for (const lead of leads) {
      const stage = (lead.stage in map ? lead.stage : "new") as StageId;
      map[stage].push(lead);
    }
    return map;
  }, [leads]);

  async function moveLead(leadId: string, stage: StageId) {
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stage === stage) return;
    setLeads((prev) =>
      prev.map((l) =>
        l.id === leadId
          ? { ...l, stage, stage_entered_at: new Date().toISOString() }
          : l,
      ),
    );
    try {
      await update({ data: { id: leadId, stage } });
      toast.success(`Moved to ${STAGES.find((s) => s.id === stage)?.label}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
      await load();
    }
  }

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Drag cards across stages. Filter by rep or broker."
        actions={
          <div className="flex flex-wrap gap-2">
            <Select
              value={assigned}
              onValueChange={(v) => {
                setAssigned(v);
                void load(v);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild>
              <Link to="/capture">
                <Zap className="size-4" />
                New Lead
              </Link>
            </Button>
          </div>
        }
      />

      <div className="flex gap-3 overflow-x-auto pb-4 snap-x">
        {STAGES.map((stage) => {
          const items = columns[stage.id];
          const value = items.reduce((s, l) => s + (l.estimated_value ?? 0), 0);
          return (
            <div
              key={stage.id}
              className="w-[280px] shrink-0 snap-start sm:w-[300px]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/lead-id") || dragging;
                if (id) void moveLead(id, stage.id);
                setDragging(null);
              }}
            >
              <div className="mb-2 px-1">
                <h2 className="font-display text-lg font-semibold leading-tight">{stage.short}</h2>
                <p className="text-xs text-muted-foreground">
                  {items.length} · {formatCurrency(value)}
                </p>
              </div>
              <div
                className={cn(
                  "min-h-[460px] space-y-2 rounded-2xl border border-dashed border-border bg-muted/20 p-2",
                  dragging && "border-primary/40 bg-primary/5",
                )}
              >
                {items.map((lead) => (
                  <Card
                    key={lead.id}
                    draggable
                    onDragStart={(e) => {
                      setDragging(lead.id);
                      e.dataTransfer.setData("text/lead-id", lead.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={cn(
                      "cursor-grab rounded-xl active:cursor-grabbing",
                      dragging === lead.id && "opacity-50",
                    )}
                  >
                    <CardContent className="space-y-2 p-3">
                      <Link
                        to="/leads/$leadId"
                        params={{ leadId: lead.id }}
                        className="font-medium hover:text-primary"
                      >
                        {lead.name}
                      </Link>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {lead.vehicle_interest || lead.inventory_label || "—"}
                      </p>
                      <div className="flex flex-wrap gap-1 text-[10px] uppercase tracking-wide">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5",
                            lead.lead_type === "lease"
                              ? "bg-accent text-accent-foreground"
                              : lead.lead_type === "general"
                                ? "bg-muted text-foreground"
                                : "bg-primary/15 text-primary",
                          )}
                        >
                          {lead.lead_type === "lease"
                            ? "Lease"
                            : lead.lead_type === "general"
                              ? "General"
                              : "Inv"}
                        </span>
                        {lead.quote_sent ? (
                          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                            Quote{lead.quote_pdf_name ? "+PDF" : ""}
                          </span>
                        ) : null}
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                          Review {lead.google_review_status.replace("_", " ")}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                          {daysInStage(lead.stage_entered_at)}d
                        </span>
                      </div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span className="truncate">{lead.assigned_name || "Unassigned"}</span>
                        <span className="tabular text-foreground">
                          {formatCurrency(lead.estimated_value)}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
