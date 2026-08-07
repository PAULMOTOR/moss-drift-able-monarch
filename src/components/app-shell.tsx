import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Calculator,
  CalendarDays,
  Columns3,
  HelpCircle,
  ListTodo,
  KeyRound,
  LayoutDashboard,
  Menu,
  Package,
  Shield,
  ShieldCheck,
  Users,
  Wrench,
  X,
  Zap,
  FlaskConical,
} from "lucide-react";


import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { changeOwnPassword, getMyProfile, updateOwnAvatar } from "@/lib/crm/server";
import { getMyPermissions } from "@/lib/crm/permissions";
import { ROLE_LABELS, type PermissionKey, type Profile } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { LabBanner } from "@/components/lab-banner";
import { isDmsLab } from "@/lib/app-track";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  primary?: boolean;
  perm?: PermissionKey | PermissionKey[];
  roles?: Profile["role"][];
};

const baseNav: NavItem[] = [
  { to: "/capture", label: "New Lead", icon: Zap, primary: true, perm: "leads.create" },
  { to: "/", label: "Home", icon: LayoutDashboard },
  { to: "/leads", label: "Leads", icon: Users, perm: ["leads.early", "leads.late"] },
  { to: "/pipeline", label: "Pipeline", icon: Columns3, perm: "pipeline.access" },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/tasks", label: "Tasks", icon: ListTodo, perm: "tasks.access" },
  { to: "/quote", label: "Lease quote", icon: Calculator, perm: "quote.access" },
  { to: "/inventory", label: "Inventory", icon: Package, perm: "inventory.view" },
  { to: "/service", label: "Service", icon: Wrench, perm: "service.access" },
  {
    to: "/compliance-ops",
    label: "Compliance ops",
    icon: ShieldCheck,
    perm: ["compliance.ops", "liens.manage"],
  },
  { to: "/help", label: "Help", icon: HelpCircle },
];


function canSeeNav(item: NavItem, role: Profile["role"], perms: Set<string>) {
  if (role === "admin") return true;
  if (item.roles && !item.roles.includes(role)) return false;
  if (!item.perm) return true;
  const keys = Array.isArray(item.perm) ? item.perm : [item.perm];
  return keys.some((k) => perms.has(k));
}

export function AppShell({
  children,
  profile,
}: {
  children: React.ReactNode;
  profile: Profile;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url);
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const changePw = useServerFn(changeOwnPassword);
  const updateAvatar = useServerFn(updateOwnAvatar);

  useEffect(() => {
    setAvatarUrl(profile.avatar_url);
    void getMyPermissions()
      .then((r) => setPerms(new Set(r.permissions)))
      .catch(() => setPerms(new Set()));
  }, [profile.id, profile.avatar_url]);

  const nav: NavItem[] = [
    ...baseNav.filter((item) => canSeeNav(item, profile.role, perms)),
    ...((isDmsLab()
      ? [{ to: "/dms", label: "DMS lab", icon: FlaskConical }]
      : []) as NavItem[]),
    ...((profile.role === "admin" || profile.role === "gsm" || perms.has("data.analysis")
      ? [{ to: "/data-analysis", label: "Data analysis", icon: BarChart3 }]
      : []) as NavItem[]),
    ...((profile.role === "admin"
      ? [{ to: "/admin", label: "Admin", icon: Shield }]
      : []) as NavItem[]),
  ];

  async function submitPassword() {
    if (newPw.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPw !== confirmPw) {
      toast.error("New passwords do not match");
      return;
    }
    setPwBusy(true);
    try {
      await changePw({ data: { currentPassword: currentPw, newPassword: newPw } });
      toast.success("Password updated");
      setPwOpen(false);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change password");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[220px_1fr]">
      <div className="col-span-full">
        <LabBanner />
      </div>
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
          <div className="mb-2 flex items-center gap-2 rounded-sm border border-border bg-muted/50 px-2 py-2">
            <label className="relative shrink-0 cursor-pointer" title="Change profile photo">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="size-10 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {profile.name
                    .split(" ")
                    .map((p) => p[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 1_200_000) {
                    toast.error("Use a photo under ~1MB");
                    return;
                  }
                  try {
                    const dataUrl = await new Promise<string>((res, rej) => {
                      const r = new FileReader();
                      r.onload = () => res(String(r.result));
                      r.onerror = () => rej(new Error("read failed"));
                      r.readAsDataURL(f);
                    });
                    const updated = await updateAvatar({ data: { avatar_url: dataUrl } });
                    setAvatarUrl(updated.avatar_url);
                    toast.success("Profile photo updated");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Upload failed");
                  }
                }}
              />
            </label>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{profile.name}</p>
              <p className="truncate text-[11px] text-muted-foreground">
                {ROLE_LABELS[profile.role] || profile.role}
                {profile.title ? ` · ${profile.title}` : ""}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mb-2 w-full justify-start gap-2"
            onClick={() => setPwOpen(true)}
          >
            <KeyRound className="size-4" />
            Change password
          </Button>
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

      <Dialog open={pwOpen} onOpenChange={setPwOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change your password</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="cur-pw">Current password</Label>
              <Input
                id="cur-pw"
                type="password"
                autoComplete="current-password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-pw">New password (8+)</Label>
              <Input
                id="new-pw"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="confirm-pw">Confirm new password</Label>
              <Input
                id="confirm-pw"
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPwOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={pwBusy} onClick={() => void submitPassword()}>
              {pwBusy ? "Saving…" : "Update password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            Paul Motor Co. CRM — lead capture, inventory, pipeline, and lease quotes.
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
