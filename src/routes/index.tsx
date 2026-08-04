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
      inventory_leads?: number;
      lease_leads?: number;
      general_leads?: number;
    };
    mine: number;
    recent: Lead[];
  } | null>(null);

  useEffect(() => {
    void getDashboardStats().then(setData);
  }, []);

  if (!data) {
    return <div className="h-48 animate-pulse rounded-sm bg-muted" />;
  }

  return (
    <>
      <PageHeader
        title={`Hello, ${data.me.name.split(" ")[0]}`}
        description="Role Center — lead capture, pipeline, and inventory for Paul Motor Co."

        actions={
          <Button asChild className="h-9 rounded-sm px-4">
            <Link to="/capture">
              <Zap className="size-4" />
              New Lead
            </Link>
          </Button>
        }
      />

      <section className="mb-6">
        <h2 className="bc-section-title">Sales activities</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <BcTile label="New leads" value={data.totals.new_leads} to="/leads" />
          <BcTile label="Open pipeline" value={data.totals.open} to="/pipeline" />
          <BcTile label="My open" value={data.mine} to="/leads" />
          <BcTile label="Quotes pending" value={data.totals.quote_pending} to="/pipeline" />
          <BcTile label="Lease quotes" value={data.totals.drives ?? 0} to="/quote" />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="bc-section-title">Lead types</h2>
        <div className="grid grid-cols-3 gap-2">
          <BcTile label="Inventory" value={data.totals.inventory_leads ?? 0} to="/leads" />
          <BcTile label="Lease" value={data.totals.lease_leads ?? 0} to="/leads" />
          <BcTile label="General" value={data.totals.general_leads ?? 0} to="/leads" />
        </div>
      </section>

      <div className="mb-6 grid gap-2 sm:grid-cols-3">
        <QuickLink
          to="/capture"
          icon={<Phone className="size-4" />}
          title="Capture lead"
          sub="Phone / walk-in"
        />
        <QuickLink
          to="/pipeline"
          icon={<ArrowRight className="size-4" />}
          title="Pipeline"
          sub="Kanban board"
        />
        <QuickLink
          to="/quote"
          icon={<CalendarDays className="size-4" />}
          title="Lease quotes"
          sub="Schedule and status"
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base font-semibold">Recent leads</CardTitle>
          <Button variant="ghost" size="sm" asChild className="text-primary">
            <Link to="/leads">View all</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-0.5">
          {data.recent.map((lead) => (
            <Link
              key={lead.id}
              to="/leads/$leadId"
              params={{ leadId: lead.id }}
              className="flex items-center justify-between gap-3 rounded-sm px-2 py-2.5 transition-colors hover:bg-muted"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-semibold">{lead.name}</p>
                  <StageBadge stage={lead.stage} />
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {lead.vehicle_interest || lead.phone || lead.email}
                  {lead.assigned_name ? ` · ${lead.assigned_name}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <p>{formatRelative(lead.created_at)}</p>
                <p className="tabular text-foreground/80">
                  {formatCurrency(lead.estimated_value)}
                </p>
              </div>
            </Link>
          ))}
          {data.recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No leads yet.</p>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function BcTile({
  label,
  value,
  to,
}: {
  label: string;
  value: number;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="bc-tile group flex min-h-[88px] flex-col justify-between p-3 no-underline"
    >
      <span className="text-[12px] font-semibold leading-tight text-white/95">{label}</span>
      <div className="flex items-end justify-between gap-2">
        <span className="tabular text-3xl font-light tracking-tight text-white sm:text-4xl">
          {value}
        </span>
        <span className="text-white/70 group-hover:text-white">›</span>
      </div>
    </Link>
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
      className="flex items-center gap-3 rounded-sm border border-border bg-card px-3 py-3 shadow-sm transition-colors hover:border-primary/40 hover:bg-secondary no-underline"
    >
      <span className="grid size-9 place-items-center rounded-sm bg-secondary text-primary">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
    </Link>
  );
}
