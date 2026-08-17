import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient, authEnabled } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { DEMO_PASSWORD } from "@/lib/crm/demo";
import { ensureDemoReady } from "@/lib/crm/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const DEMOS = [
  { email: "jeremyp@paulmotorcompany.com", label: "Jeremy Paul · President" },
  { email: "guillaume.dec@paulmotorcompany.com", label: "Guillaume Decroocq · VP" },
  { email: "lucasl@paulmotorcompany.com", label: "Lucas Legatos · Sales" },
  { email: "alexh@paulmotorcompany.com", label: "Alex Hudon · Sales" },
];

/** Demo chips only in local/preview — never on a real Vercel production host. */
const showDemoLogins =
  import.meta.env.VITE_SHOW_DEMO_LOGINS === "true" ||
  (import.meta.env.DEV && import.meta.env.VITE_SHOW_DEMO_LOGINS !== "false");

function LoginPage() {
  const { user, isPending } = useCurrentUserState();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [form, setForm] = useState({
    email: showDemoLogins ? "lucasl@paulmotorcompany.com" : "",
    password: showDemoLogins ? DEMO_PASSWORD : "",
  });

  useEffect(() => {
    void ensureDemoReady()
      .then(() => setReady(true))
      .catch(() => setReady(true));
  }, []);

  if (!isPending && user) return <Navigate to="/" />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (!ready) await ensureDemoReady();
      const res = await authClient.signIn.email({
        email: form.email.trim(),
        password: form.password,
      });
      if (res.error) throw new Error(res.error.message || "Sign in failed");
      toast.success("Welcome back");
      window.location.href = "/";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 overflow-hidden rounded-sm border border-border bg-card shadow-sm">
          <div className="bg-primary px-5 py-4 text-primary-foreground">
            <div className="flex items-center gap-3">
              <img
                src="/palmetto-white.png"
                alt="Paul Motor Co."
                className="size-10 object-contain"
                width={40}
                height={40}
              />
              <div>
                <h1 className="text-base font-semibold tracking-wide">
                  Paul Motor Co.
                </h1>
                <p className="text-[12px] text-white/85">CRM · Secure sign-in</p>
              </div>
            </div>
          </div>

          <div className="p-6 sm:p-7">
          {authEnabled ? (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid gap-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="h-10 rounded-sm"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="current-password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  className="h-10 rounded-sm"
                />
              </div>
              <Button type="submit" className="h-10 w-full rounded-sm" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Sessions are encrypted and stored server-side. Ask an admin if you need an account.
              </p>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">Sign-in is disabled.</p>
          )}

          {showDemoLogins ? (
            <div className="mt-6">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Preview demo accounts
              </p>
              <div className="grid gap-1.5">
                {DEMOS.map((d) => (
                  <button
                    key={d.email}
                    type="button"
                    className="rounded-sm border border-border bg-muted/40 px-3 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-secondary"
                    onClick={() => setForm({ email: d.email, password: DEMO_PASSWORD })}
                  >
                    <span className="font-semibold text-foreground">{d.label}</span>
                    <span className="mt-0.5 block text-muted-foreground">{d.email}</span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Demo password: <span className="font-mono text-primary">{DEMO_PASSWORD}</span>
              </p>
            </div>
          ) : null}
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Floor lead capture · Inventory · Pipeline · Quotes
        </p>
      </div>
    </main>
  );
}
