import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
  CREDIT_PIPELINE_COLUMNS,
  PIPELINES,
  STAGES,
  creditColumnForLead,
  defaultLeadTab,
  daysInStage,
  stagesForPipeline,
  type CreditPipelineColumnId,
  type Lead,
  type PipelineId,
  type Profile,
  type StageId,
} from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Zap } from "lucide-react";

export const Route = createFileRoute("/pipeline")({
  validateSearch: (s: Record<string, unknown>): { board?: string } => {
    if (typeof s.board === "string" && s.board) return { board: s.board };
    return {};
  },
  component: () => (
    <AuthGate>
      <PipelinePage />
    </AuthGate>
  ),
});

function PipelinePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const initialBoard = (
    PIPELINES.some((p) => p.id === search.board) ? search.board : "lead"
  ) as PipelineId;
  const [board, setBoard] = useState<PipelineId>(initialBoard);
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
        setAssigned("all");
        await load("all");
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
  }, [leads, assigned, board]);

  function scrollBoard(dir: "left" | "right") {
    const el = boardRef.current;
    if (!el) return;
    const amount = Math.min(320, Math.max(240, el.clientWidth * 0.7));
    el.scrollBy({ left: dir === "left" ? -amount : amount, behavior: "smooth" });
  }

  const leadColumns = useMemo(() => {
    const stages = stagesForPipeline("lead");
    const map: Record<string, Lead[]> = {};
    for (const s of stages) map[s.id] = [];
    for (const lead of leads) {
      if (lead.stage === "lost") {
        map.lost?.push(lead);
        continue;
      }
      if (stages.some((s) => s.id === lead.stage)) {
        map[lead.stage]?.push(lead);
      } else if (
        !["credit_review", "ready_bc", "won"].includes(lead.stage) &&
        !creditColumnForLead(lead)
      ) {
        map.new?.push(lead);
      }
    }
    return { stages, map };
  }, [leads]);

  const creditColumns = useMemo(() => {
    const map: Record<string, Lead[]> = {};
    for (const c of CREDIT_PIPELINE_COLUMNS) map[c.id] = [];
    for (const lead of leads) {
      const col = creditColumnForLead(lead);
      if (col) map[col]?.push(lead);
      else if (lead.stage === "credit_review") map.app_requested?.push(lead);
    }
    return map;
  }, [leads]);

  const complianceColumns = useMemo(() => {
    const stages = stagesForPipeline("compliance");
    const map: Record<string, Lead[]> = {};
    for (const s of stages) map[s.id] = [];
    for (const lead of leads) {
      if (lead.stage === "ready_bc" || lead.stage === "won") {
        map[lead.stage]?.push(lead);
      } else if ((lead.credit_status || "").toLowerCase() === "approved") {
        map.ready_bc?.push(lead);
      }
    }
    return { stages, map };
  }, [leads]);

  async function moveLeadStage(leadId: string, stage: StageId) {
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
      await load();
    }
  }

  async function moveLeadCredit(leadId: string, col: CreditPipelineColumnId) {
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return;
    setLeads((prev) =>
      prev.map((l) =>
        l.id === leadId
          ? {
              ...l,
              credit_status: col,
              stage: col === "approved" ? "ready_bc" : "credit_review",
              stage_entered_at: new Date().toISOString(),
            }
          : l,
      ),
    );
    try {
      await update({
        data: {
          id: leadId,
          credit_status: col,
          stage: col === "approved" ? "ready_bc" : "credit_review",
        } as never,
      });
      toast.success(`Credit: ${CREDIT_PIPELINE_COLUMNS.find((c) => c.id === col)?.label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
      await load();
    }
  }

  const boardMeta = PIPELINES.find((p) => p.id === board)!;

  return (
    <>
      <PageHeader
        title="Pipeline"
        description={boardMeta.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <Select
                value={assigned}
                onValueChange={(v) => {
                  setAssigned(v);
                  void load(v);
                }}
              >
                <SelectTrigger className="h-9 w-[180px]">
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
            <Button asChild size="sm" variant="outline">
              <Link to="/capture">
                <Zap className="size-4" />
                New lead
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {PIPELINES.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setBoard(p.id);
              void navigate({ to: "/pipeline", search: { board: p.id }, replace: true });
            }}
            className={cn(
              "rounded-sm border px-3 py-2 text-left text-sm font-semibold transition-colors",
              board === p.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-foreground hover:bg-muted",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="relative mb-2 flex items-center gap-2">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="shrink-0"
          disabled={!canScrollLeft}
          onClick={() => scrollBoard("left")}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <p className="flex-1 text-center text-xs text-muted-foreground">
          Drag cards · click a card to open the matching deal tab
        </p>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="shrink-0"
          disabled={!canScrollRight}
          onClick={() => scrollBoard("right")}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div
        ref={boardRef}
        className="flex gap-3 overflow-x-auto pb-4 pt-1"
        style={{ scrollbarGutter: "stable" }}
      >
        {board === "lead"
          ? leadColumns.stages.map((stage) => (
              <Column
                key={stage.id}
                title={stage.short}
                count={leadColumns.map[stage.id]?.length || 0}
                onDrop={(id) => void moveLeadStage(id, stage.id)}
                dragging={dragging}
                setDragging={setDragging}
                leads={leadColumns.map[stage.id] || []}
                tabFor={() => defaultLeadTab({ stage: stage.id })}
              />
            ))
          : null}

        {board === "credit"
          ? CREDIT_PIPELINE_COLUMNS.map((col) => (
              <Column
                key={col.id}
                title={col.short}
                count={creditColumns[col.id]?.length || 0}
                onDrop={(id) => void moveLeadCredit(id, col.id)}
                dragging={dragging}
                setDragging={setDragging}
                leads={creditColumns[col.id] || []}
                tabFor={(lead) => defaultLeadTab(lead)}
              />
            ))
          : null}

        {board === "compliance"
          ? complianceColumns.stages.map((stage) => (
              <Column
                key={stage.id}
                title={stage.short}
                count={complianceColumns.map[stage.id]?.length || 0}
                onDrop={(id) => void moveLeadStage(id, stage.id)}
                dragging={dragging}
                setDragging={setDragging}
                leads={complianceColumns.map[stage.id] || []}
                tabFor={() => "compliance"}
              />
            ))
          : null}
      </div>
    </>
  );
}

function Column({
  title,
  count,
  leads,
  onDrop,
  dragging,
  setDragging,
  tabFor,
}: {
  title: string;
  count: number;
  leads: Lead[];
  onDrop: (id: string) => void;
  dragging: string | null;
  setDragging: (id: string | null) => void;
  tabFor: (lead: Lead) => string;
}) {
  return (
    <div
      className="flex w-[260px] shrink-0 flex-col rounded-sm border border-border bg-muted/30"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/lead-id") || dragging;
        if (id) onDrop(id);
        setDragging(null);
      }}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="tabular text-xs text-muted-foreground">{count}</span>
      </div>
      <div className="flex max-h-[calc(100dvh-260px)] flex-col gap-2 overflow-y-auto p-2">
        {leads.map((lead) => (
          <Card
            key={lead.id}
            draggable
            onDragStart={(e) => {
              setDragging(lead.id);
              e.dataTransfer.setData("text/lead-id", lead.id);
            }}
            onDragEnd={() => setDragging(null)}
            className={cn(
              "cursor-grab border-border shadow-sm active:cursor-grabbing",
              dragging === lead.id && "opacity-50",
            )}
          >
            <CardContent className="space-y-1 p-3">
              <Link
                to="/leads/$leadId"
                params={{ leadId: lead.id }}
                search={{ tab: tabFor(lead) }}
                className="block text-sm font-semibold text-foreground hover:text-primary"
              >
                {lead.name}
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                {lead.vehicle_interest || lead.inventory_label || "—"}
              </p>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="capitalize">{lead.lead_type}</span>
                <span>
                  {lead.estimated_value
                    ? formatCurrency(lead.estimated_value)
                    : `${daysInStage(lead.stage_entered_at)}d`}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
        {leads.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">Empty</p>
        ) : null}
      </div>
    </div>
  );
}
