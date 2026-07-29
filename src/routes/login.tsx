import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { authClient, authEnabled } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { DEMO_PASSWORD } from "@/lib/crm/demo";
import { ensureDemoReady } from "@/lib/crm/server";
import { Brand } from "@/components/app-shell";
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

  if (!isPending && user) return <Navigate to="/capture" />;

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
      window.location.href = "/capture";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 grid size-16 place-items-center rounded-2xl border border-primary/35 bg-ink p-2 shadow-lg shadow-primary/10">
            <img
              src="/palmetto.png"
              alt="Paul Motor Co. palmetto"
              className="size-12 object-contain"
              width={48}
              height={48}
            />
          </div>
          <h1 className="font-brand text-3xl font-bold tracking-[0.06em] text-foreground">
            PAUL MOTOR CO.
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Team CRM · secure sign-in
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-xl sm:p-8">
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
                />
              </div>
              <Button type="submit" className="h-12 w-full text-base" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">
                Sessions are encrypted and stored server-side. Use your own password — ask an
                admin if you need an account.
              </p>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">Sign-in is disabled.</p>
          )}

          {showDemoLogins ? (
            <div className="mt-6">
              <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                Preview demo accounts
              </p>
              <div className="grid gap-1.5">
                {DEMOS.map((d) => (
                  <button
                    key={d.email}
                    type="button"
                    className="rounded-lg border border-border/80 bg-muted/40 px-3 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-muted"
                    onClick={() => setForm({ email: d.email, password: DEMO_PASSWORD })}
                  >
                    <span className="font-medium text-foreground">{d.label}</span>
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

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Floor-first lead capture · Inventory · Pipeline · Quotes
        </p>
        <div className="mt-4 flex justify-center opacity-40">
          <Brand compact />
        </div>
      </div>
    </main>
  );
}
