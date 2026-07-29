import { Link, useRouterState } from "@tanstack/react-router";
import {
  CalendarDays,
  Columns3,
  LayoutDashboard,
  Menu,
  Package,
  Shield,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { getMyProfile } from "@/lib/crm/server";
import type { Profile } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const baseNav = [
  { to: "/capture", label: "New Lead", icon: Zap, primary: true },
  { to: "/", label: "Home", icon: LayoutDashboard },
  { to: "/leads", label: "Leads", icon: Users },
  { to: "/pipeline", label: "Pipeline", icon: Columns3 },
  { to: "/inventory", label: "Inventory", icon: Package },
  { to: "/test-drives", label: "Test drives", icon: CalendarDays },
] as const;

export function AppShell({
  children,
  profile,
}: {
  children: React.ReactNode;
  profile: Profile;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const nav = [
    ...baseNav,
    ...(profile.role === "admin"
      ? ([{ to: "/admin", label: "Admin", icon: Shield, primary: false }] as const)
      : []),
  ];

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[252px_1fr]">
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border/80 bg-background/90 px-4 py-3 backdrop-blur-md lg:hidden">
        <Brand compact />
        <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Menu">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
      </header>

      <aside
        className={cn(
          "z-30 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col",
          open ? "fixed inset-x-0 top-[57px] bottom-0 flex flex-col" : "hidden lg:flex",
        )}
      >
        <div className="hidden border-b border-sidebar-border px-4 py-5 lg:block">
          <Brand />
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {nav.map((item) => {
            const active =
              item.to === "/"
                ? pathname === "/"
                : pathname === item.to || pathname.startsWith(`${item.to}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                  "primary" in item && item.primary
                    ? active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-primary/15 text-primary hover:bg-primary/25"
                    : active
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="mb-2 rounded-xl bg-sidebar-accent/70 px-3 py-2">
            <p className="truncate text-sm font-medium">{profile.name}</p>
            <p className="truncate text-[11px] capitalize text-sidebar-muted">
              {profile.role}
              {profile.title ? ` · ${profile.title}` : ""}
            </p>
          </div>
          <div className="rounded-xl px-1 py-1 [&_span]:text-sidebar-foreground [&_button]:text-sidebar-muted">
            <UserButton />
          </div>
        </div>
      </aside>

      <main className="min-w-0">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
    </div>
  );
}

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-10 place-items-center overflow-hidden rounded-xl border border-primary/35 bg-ink shadow-inner shadow-primary/10">
        <img
          src="/palmetto.png"
          alt="Paul Motor Co. palmetto"
          className="size-8 object-contain"
          width={32}
          height={32}
        />
      </div>
      <div className={cn(compact && "leading-tight")}>
        <p className="font-brand text-[15px] font-bold tracking-[0.04em] text-foreground sm:text-base">
          PAUL MOTOR CO.
        </p>
        {!compact ? (
          <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            CRM · Montréal
          </p>
        ) : (
          <p className="text-[10px] text-muted-foreground">CRM</p>
        )}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    void getMyProfile()
      .then((p) => {
        if (!cancelled) {
          setProfile(p);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Profile error");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (isPending || (user && !profile && !error)) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <div className="h-10 w-48 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
          <Brand />
          <div className="gold-line my-5 h-px w-full" />
          <h1 className="font-display text-2xl font-semibold">Team sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            PAUL MOTOR CO. CRM — floor lead capture, inventory, pipeline, and test drives.
          </p>
          <Link
            to="/login"
            className="mt-6 flex h-12 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground"
          >
            Continue to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-4">
        <div className="max-w-md rounded-2xl border border-border bg-card p-6 text-sm">
          <p className="font-medium text-destructive">{error || "No CRM profile"}</p>
          <p className="mt-2 text-muted-foreground">
            Use a seeded team account, or ask an admin to create your user.
          </p>
          <Link to="/login" className="mt-4 inline-block text-primary underline-offset-4 hover:underline">
            Back to login
          </Link>
        </div>
      </div>
    );
  }

  return <AppShell profile={profile}>{children}</AppShell>;
}
