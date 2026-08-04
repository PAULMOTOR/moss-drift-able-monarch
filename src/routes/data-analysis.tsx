import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BarChart3, Car, Users } from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDataAnalysis } from "@/lib/crm/server";
import type { DataAnalysis } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/data-analysis")({
  component: () => (
    <AuthGate>
      <DataAnalysisPage />
    </AuthGate>
  ),
});

function DataAnalysisPage() {
  const [data, setData] = useState<DataAnalysis | null>(null);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getDataAnalysis()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Access denied"));
  }, []);

  if (error) {
    return (
      <div className="rounded-sm border border-border bg-card p-8 text-center">
        <p className="font-semibold">Admin only</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Data analysis is restricted to administrators.
        </p>
      </div>
    );
  }

  if (!data) {
    return <div className="h-48 animate-pulse rounded-2xl bg-muted" />;
  }

  const cg = data.portal_inventory.find((p) => p.portal === "cargurus");
  const at = data.portal_inventory.find((p) => p.portal === "autotrader");

  return (
    <>
      <PageHeader
        title="Data analysis"
        description="Closing rates — inventory portals (CarGurus vs AutoTrader) and sales team performance."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="CarGurus close rate"
          value={`${cg?.close_rate ?? 0}%`}
          hint={`${cg?.won ?? 0} won / ${cg?.total ?? 0} inventory leads`}
        />
        <Stat
          label="AutoTrader close rate"
          value={`${at?.close_rate ?? 0}%`}
          hint={`${at?.won ?? 0} won / ${at?.total ?? 0} inventory leads`}
        />
        <Stat
          label="CG open pipeline"
          value={String(cg?.open ?? 0)}
          hint="Still active"
        />
        <Stat
          label="AT open pipeline"
          value={String(at?.open ?? 0)}
          hint="Still active"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2 text-xl">
              <Car className="size-5 text-primary" />
              Inventory closes by portal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Inventory-type leads only. Close rate = won ÷ total inventory leads from that portal
              (includes open — use open count for context).
            </p>
            {data.portal_inventory.map((p) => (
              <PortalRow key={p.portal} {...p} max={Math.max(1, ...data.portal_inventory.map((x) => x.total))} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2 text-xl">
              <Users className="size-5 text-primary" />
              Closes by sales rep
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.by_rep.map((r) => (
              <div
                key={r.profile_id}
                className="rounded-xl border border-border/70 px-3 py-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs capitalize text-muted-foreground">{r.role}</p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-semibold text-primary">
                      {r.inventory_close_rate}% inv
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.all_close_rate}% all types
                    </p>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>
                    Inventory: {r.inventory_won}/{r.inventory_total} won
                  </span>
                  <span>
                    All leads: {r.all_won}/{r.all_total} won
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/80"
                    style={{ width: `${Math.min(100, r.inventory_close_rate)}%` }}
                  />
                </div>
              </div>
            ))}
            {data.by_rep.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rep data yet.</p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <BarChart3 className="size-3.5" />
        Generated {new Date(data.generated_at).toLocaleString("en-CA")} · refresh page to update
      </p>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 font-display text-2xl font-semibold text-primary sm:text-3xl">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function PortalRow(p: {
  label: string;
  total: number;
  won: number;
  lost: number;
  open: number;
  close_rate: number;
  max: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="font-medium">{p.label}</span>
        <span className="tabular text-primary">{p.close_rate}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full bg-primary/80")}
          style={{ width: `${Math.round((p.total / p.max) * 100)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {p.total} leads · {p.won} won · {p.lost} lost · {p.open} open
      </p>
    </div>
  );
}
