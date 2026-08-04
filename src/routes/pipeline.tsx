import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { listLeads, listProfiles, updateLead, getMyProfile } from "@/lib/crm/server";
import {
  STAGES,
  daysInStage,
  type Lead,
  type Profile,
  type StageId,
} from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Zap } from "lucide-react";

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
  const [me, setMe] = useState<Profile | null>(null);
  const [assigned, setAssigned] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const update = useServerFn(updateLead);
  const isAdmin = me?.role === "admin";

  async function load(filter = assigned) {
    const [rows, people, profile] = await Promise.all([
      listLeads({ data: { assigned: filter } }),
      listProfiles({ data: {} }),
      getMyProfile().catch(() => null),
    ]);
    setLeads(rows);
    setProfiles(people);
    if (profile) setMe(profile);
  }

  useEffect(() => {
    void (async () => {
      const profile = await getMyProfile().catch(() => null);
      if (profile) {
        setMe(profile);
        // Non-admins: own + unassigned only (server enforces; use "all" meaning visible scope)
        const filter = profile.role === "admin" ? "all" : "all";
        setAssigned(filter);
        await load(filter);
      } else {
        await load();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateScrollButtons() {
    const el = boardRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < max - 4);
  }

  useEffect(() => {
    updateScrollButtons();
    const el = boardRef.current;
    if (!el) return;
    const onScroll = () => updateScrollButtons();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateScrollButtons());
    ro.observe(el);
    window.addEventListener("resize", updateScrollButtons);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      window.removeEventListener("resize", updateScrollButtons);
    };
  }, [leads, assigned]);

  function scrollBoard(dir: "left" | "right") {
    const el = boardRef.current;
    if (!el) return;
    const amount = Math.min(320, Math.max(240, el.clientWidth * 0.7));
    el.scrollBy({ left: dir === "left" ? -amount : amount, behavior: "smooth" });
  }

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
        description={
          isAdmin
            ? "Drag cards across stages. Filter by owner. Use the arrows or scrollbar to move sideways."
            : "Your pipeline — leads assigned to you and unassigned leads you can claim."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {isAdmin ? (
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
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button asChild>
              <Link to="/capture">
                <Zap className="size-4" />
                New Lead
              </Link>
            </Button>
          </div>
        }
      />

      {/* Always-visible horizontal navigation for mice without side-scroll */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-card px-3 py-2 shadow-sm">
        <p className="text-xs text-muted-foreground sm:text-sm">
          Scroll stages sideways
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1 px-3"
            disabled={!canScrollLeft}
            onClick={() => scrollBoard("left")}
            aria-label="Scroll pipeline left"
          >
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">Left</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1 px-3"
            disabled={!canScrollRight}
            onClick={() => scrollBoard("right")}
            aria-label="Scroll pipeline right"
          >
            <span className="hidden sm:inline">Right</span>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div
        ref={boardRef}
        className="pipeline-h-scroll flex gap-3 overflow-x-auto pb-3 snap-x"
        onScroll={updateScrollButtons}
      >
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
                <h2 className="text-base font-semibold leading-tight">{stage.short}</h2>
                <p className="text-xs text-muted-foreground">
                  {items.length} · {formatCurrency(value)}
                </p>
              </div>
              <div
                className={cn(
                  "min-h-[460px] space-y-2 rounded-sm border border-dashed border-border bg-muted/30 p-2",
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
                      "cursor-grab active:cursor-grabbing",
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
