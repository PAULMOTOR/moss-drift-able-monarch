import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, CalendarDays, Phone, Zap } from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { StageBadge } from "@/components/stage-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardStats } from "@/lib/crm/server";
import type { Lead, Profile } from "@/lib/crm/types";
import { formatCurrency, formatRelative } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: () => (
    <AuthGate>
      <HomePage />
    </AuthGate>
  ),
});

function HomePage() {
  const [data, setData] = useState<{
    me: Profile;
    totals: {
      total: number;
      open: number;
      new_leads: number;
      quote_pending: number;
      drives: number;
    };
    mine: number;
    recent: Lead[];
  } | null>(null);

  useEffect(() => {
    void getDashboardStats().then(setData);
  }, []);

  if (!data) {
    return <div className="h-48 animate-pulse rounded-2xl bg-muted" />;
  }

  return (
    <>
      <PageHeader
        title={`Hello, ${data.me.name.split(" ")[0]}`}
        description="Paul Motor Company — floor CRM for luxury & exotic sales."
        actions={
          <Button asChild size="lg" className="h-12 px-5">
            <Link to="/capture">
              <Zap className="size-4" />
              New Lead
            </Link>
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New leads" value={String(data.totals.new_leads)} />
        <Stat label="Open pipeline" value={String(data.totals.open)} />
        <Stat label="My open" value={String(data.mine)} />
        <Stat label="Upcoming drives" value={String(data.totals.drives)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <QuickLink to="/capture" icon={<Phone className="size-4" />} title="Capture lead" sub="Phone / walk-in" />
        <QuickLink to="/pipeline" icon={<ArrowRight className="size-4" />} title="Pipeline" sub="Kanban board" />
        <QuickLink to="/test-drives" icon={<CalendarDays className="size-4" />} title="Test drives" sub="Schedule & status" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="font-display text-xl">Recent leads</CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/leads">View all</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.recent.map((lead) => (
            <Link
              key={lead.id}
              to="/leads/$leadId"
              params={{ leadId: lead.id }}
              className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/60"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{lead.name}</p>
                  <StageBadge stage={lead.stage} />
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {lead.vehicle_interest || lead.phone || lead.email}
                  {lead.assigned_name ? ` · ${lead.assigned_name}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <p>{formatRelative(lead.created_at)}</p>
                <p className="tabular text-foreground/80">{formatCurrency(lead.estimated_value)}</p>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 font-display text-3xl font-semibold tabular text-primary">{value}</p>
      </CardContent>
    </Card>
  );
}

function QuickLink({
  to,
  icon,
  title,
  sub,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
    >
      <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
    </Link>
  );
}
