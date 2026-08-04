import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Calculator,
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
  { to: "/quote", label: "Lease quote", icon: Calculator },
  { to: "/inventory", label: "Inventory", icon: Package },
  { to: "/test-drives", label: "Test drives", icon: CalendarDays },
  { to: "/data-analysis", label: "Data analysis", icon: BarChart3 },
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
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[220px_1fr]">
      {/* Mobile top bar — BC style white chrome */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-border bg-card px-3 py-2 shadow-sm lg:hidden">
        <Brand compact />
        <Button variant="ghost" size="icon" onClick={() => setOpen((v) => !v)} aria-label="Menu">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
      </header>

      <aside
        className={cn(
          "z-30 border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col",
          open ? "fixed inset-x-0 top-[49px] bottom-0 flex flex-col shadow-lg" : "hidden lg:flex",
        )}
      >
        <div className="hidden border-b border-sidebar-border bg-primary px-4 py-3 lg:block">
          <Brand onTeal />
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
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
                  "flex h-10 items-center gap-2.5 rounded-sm px-3 text-[13px] font-semibold transition-colors",
                  "primary" in item && item.primary
                    ? active
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-primary hover:bg-primary/15"
                    : active
                      ? "bg-sidebar-accent text-primary"
                      : "text-sidebar-muted hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0 opacity-90" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="mb-2 rounded-sm border border-border bg-muted/50 px-3 py-2">
            <p className="truncate text-sm font-semibold">{profile.name}</p>
            <p className="truncate text-[11px] capitalize text-muted-foreground">
              {profile.role}
              {profile.title ? ` · ${profile.title}` : ""}
            </p>
          </div>
          <UserButton />
        </div>
      </aside>

      <main className="min-w-0">
        {/* Desktop page ribbon */}
        <div className="hidden border-b border-border bg-card px-6 py-2 lg:block">
          <p className="text-sm font-semibold text-foreground">
            Paul Motor Co.{" "}
            <span className="font-normal text-muted-foreground">| CRM</span>
          </p>
        </div>
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-6">{children}</div>
      </main>
    </div>
  );
}

export function Brand({ compact, onTeal }: { compact?: boolean; onTeal?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src={onTeal ? "/palmetto-white.png" : "/palmetto.png"}
        alt="Paul Motor Co."
        className={cn(
          "object-contain",
          compact ? "size-8" : "size-9",
          onTeal && "drop-shadow-sm",
        )}
        width={onTeal ? 36 : 36}
        height={onTeal ? 36 : 36}
      />
      <div className={cn(compact && "leading-tight")}>
        <p
          className={cn(
            "text-[15px] font-semibold tracking-wide sm:text-base",
            onTeal ? "text-white" : "text-foreground",
          )}
        >
          Paul Motor Co.
        </p>
        {!compact ? (
          <p className={cn("text-[11px]", onTeal ? "text-white/80" : "text-muted-foreground")}>
            CRM · Role Center
          </p>
        ) : (
          <p className={cn("text-[10px]", onTeal ? "text-white/75" : "text-muted-foreground")}>
            CRM
          </p>
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
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[1.65rem]">
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
        <div className="h-10 w-48 animate-pulse rounded-sm bg-muted" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-4">
        <div className="w-full max-w-md rounded-sm border border-border bg-card p-8 shadow-sm">
          <Brand />
          <div className="my-5 h-px w-full bg-border" />
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Paul Motor Co. CRM — lead capture, inventory, pipeline, and test drives.
          </p>
          <Link
            to="/login"
            className="mt-6 flex h-10 items-center justify-center rounded-sm bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
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
        <div className="max-w-md rounded-sm border border-border bg-card p-6 text-sm shadow-sm">
          <p className="font-medium text-destructive">{error || "No CRM profile"}</p>
          <p className="mt-2 text-muted-foreground">
            Use a team account, or ask an admin to create your user.
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
