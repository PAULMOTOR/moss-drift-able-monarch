import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { leadsQueryKey } from "@/lib/query-client";
import { Input } from "@/components/ui/input";
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
  leadTypeLabel,
  leadDisplayName,
} from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Loader2, Search, X, Zap } from "lucide-react";

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
  const queryClient = useQueryClient();
  const initialBoard = (
    PIPELINES.some((p) => p.id === search.board) ? search.board : "lead"
  ) as PipelineId;
  const [board, setBoard] = useState<PipelineId>(initialBoard);
  const [assigned, setAssigned] = useState("all");
  const [dealQ, setDealQ] = useState("");
  const [dealQDebounced, setDealQDebounced] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const update = useServerFn(updateLead);

  const leadsFilters = useMemo(
    () => ({ assigned, limit: 200, offset: 0 }),
    [assigned],
  );

  useEffect(() => {
    const tmr = window.setTimeout(() => setDealQDebounced(dealQ.trim()), 280);
    return () => window.clearTimeout(tmr);
  }, [dealQ]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!searchWrapRef.current?.contains(e.target as Node)) setSearchOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const dealSearchFilters = useMemo(
    () => ({
      q: dealQDebounced,
      assigned,
      limit: 25,
      offset: 0,
    }),
    [dealQDebounced, assigned],
  );

  const dealSearchQ = useQuery({
    queryKey: ["pipeline-deal-search", dealSearchFilters],
    queryFn: () => listLeads({ data: dealSearchFilters }),
    enabled: dealQDebounced.length >= 2,
    staleTime: 15_000,
  });
  const searchHits = dealSearchQ.data?.leads ?? [];
  const searchTotal = dealSearchQ.data?.total ?? 0;

  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => getMyProfile(),
    staleTime: 120_000,
  });
  const me = meQ.data ?? null;
  const isAdmin = me?.role === "admin" || me?.role === "gsm";

  const profilesQ = useQuery({
    queryKey: ["profiles"],
    queryFn: () => listProfiles({ data: {} }),
    staleTime: 120_000,
  });
  const profiles = profilesQ.data ?? [];

  const leadsQ = useQuery({
    queryKey: leadsQueryKey(leadsFilters),
    queryFn: () => listLeads({ data: leadsFilters }),
  });

  /** Local optimistic copy while dragging; re-syncs when server data changes. */
  const [leads, setLeads] = useState<Lead[]>([]);
  useEffect(() => {
    if (leadsQ.data?.leads) setLeads(leadsQ.data.leads);
  }, [leadsQ.data]);

  async function load(filter = assigned) {
    setAssigned(filter);
    await queryClient.invalidateQueries({ queryKey: ["leads"] });
  }

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

      <div ref={searchWrapRef} className="relative z-30 mb-4 max-w-xl">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={dealQ}
            onChange={(e) => {
              setDealQ(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search all pipelines — name, phone, email, vehicle, stock, VIN…"
            className="h-10 pl-9 pr-9"
            aria-label="Search deals across all pipelines"
            autoComplete="off"
          />
          {dealQ ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setDealQ("");
                setDealQDebounced("");
                setSearchOpen(false);
              }}
              aria-label="Clear search"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        {searchOpen && dealQDebounced.length >= 2 ? (
          <div className="absolute left-0 right-0 mt-1 max-h-[min(420px,55vh)] overflow-y-auto rounded-sm border border-border bg-card shadow-lg">
            {dealSearchQ.isFetching ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Searching…
              </div>
            ) : searchHits.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No deals match “{dealQDebounced}”.
              </p>
            ) : (
              <ul className="divide-y divide-border py-1">
                {searchHits.map((lead) => {
                  const stageLabel =
                    STAGES.find((s) => s.id === lead.stage)?.label || lead.stage;
                  const tab = defaultLeadTab(lead);
                  const pipelineHint =
                    tab === "compliance"
                      ? "Compliance"
                      : tab === "credit" || tab === "approval"
                        ? "Credit"
                        : "Lead";
                  return (
                    <li key={lead.id}>
                      <Link
                        to="/leads/$leadId"
                        params={{ leadId: lead.id }}
                        search={{ tab }}
                        onClick={() => setSearchOpen(false)}
                        className="block px-3 py-2.5 transition-colors hover:bg-muted/80"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {leadDisplayName(lead)}
                          </span>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {pipelineHint}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {lead.vehicle_interest || lead.inventory_label || "—"}
                          {lead.phone ? ` · ${lead.phone}` : ""}
                          {lead.email ? ` · ${lead.email}` : ""}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {stageLabel}
                          {lead.credit_status && lead.credit_status !== "none"
                            ? ` · credit: ${lead.credit_status.replace(/_/g, " ")}`
                            : ""}
                          {lead.assigned_name ? ` · ${lead.assigned_name}` : ""}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {searchTotal > searchHits.length ? (
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                Showing {searchHits.length} of {searchTotal} — refine your search for more.
              </p>
            ) : null}
          </div>
        ) : searchOpen && dealQ.trim().length > 0 && dealQ.trim().length < 2 ? (
          <div className="absolute left-0 right-0 mt-1 rounded-sm border border-border bg-card px-3 py-3 text-xs text-muted-foreground shadow-lg">
            Type at least 2 characters to search across Lead, Credit, and Compliance.
          </div>
        ) : null}
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
                {leadDisplayName(lead)}
              </Link>
              <p className="truncate text-xs text-muted-foreground">
                {lead.vehicle_interest || lead.inventory_label || "—"}
              </p>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="capitalize">{leadTypeLabel(lead.lead_type)}</span>
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
