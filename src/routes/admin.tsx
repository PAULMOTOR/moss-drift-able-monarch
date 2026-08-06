import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Eraser, Inbox, Mail, Pencil, RefreshCw, Trash2, UserPlus, X } from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adminClearAllLeads,
  adminCreateUser,
  adminDeleteUser,
  adminEmailImportStatus,
  adminRunEmailImport,
  adminUpdateUser,
  getAdminMetrics,
  getMyProfile,
  listProfiles,
  listContractTemplates,
  updateContractTemplate,
  driveHealth,
} from "@/lib/crm/server";
import { STAGES, type AdminMetrics, type Profile, type Role } from "@/lib/crm/types";
import { cn, formatCurrency } from "@/lib/utils";

export const Route = createFileRoute("/admin")({
  component: () => (
    <AuthGate>
      <AdminPage />
    </AuthGate>
  ),
});

type EditForm = {
  name: string;
  email: string;
  phone: string;
  title: string;
  role: Role;
  active: boolean;
  password: string;
};

type ImportStatus = Awaited<ReturnType<typeof adminEmailImportStatus>>;

// contract editor state helpers placed near top of module
function emptyCreate() {
  return {
    name: "",
    email: "",
    password: "",
    role: "rep" as Role,
    phone: "",
    title: "",
  };
}

function AdminPage() {
  const [me, setMe] = useState<Profile | null>(null);
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);
  const [form, setForm] = useState(emptyCreate);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [confirmClearLeads, setConfirmClearLeads] = useState(false);
  const [clearingLeads, setClearingLeads] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const [contracts, setContracts] = useState<Array<{
    style_key: string;
    label: string;
    body_html: string;
    language: string;
    jurisdiction: string;
  }>>([]);
  const [contractKey, setContractKey] = useState("qc_individual_en");
  const [contractBody, setContractBody] = useState("");
  const [driveStatus, setDriveStatus] = useState<{ ok: boolean; error?: string } | null>(null);
  const listContracts = useServerFn(listContractTemplates);
  const saveContract = useServerFn(updateContractTemplate);
  const driveProbe = useServerFn(driveHealth);
  const createUser = useServerFn(adminCreateUser);
  const updateUser = useServerFn(adminUpdateUser);
  const deleteUser = useServerFn(adminDeleteUser);
  const clearAllLeads = useServerFn(adminClearAllLeads);
  const runImport = useServerFn(adminRunEmailImport);
  const loadImportStatus = useServerFn(adminEmailImportStatus);

  async function load() {
    const profile = await getMyProfile();
    setMe(profile);
    if (profile.role !== "admin") return;
    const [m, u, emailSt] = await Promise.all([
      getAdminMetrics(),
      listProfiles({ data: { activeOnly: false } }),
      loadImportStatus().catch(() => null),
    ]);
    setMetrics(m);
    setUsers(u);
    if (emailSt) setImportStatus(emailSt);
  }

  useEffect(() => {
    void load();
  }, []);

  function startEdit(u: Profile) {
    setConfirmRemoveId(null);
    setEditingId(u.id);
    setEditForm({
      name: u.name,
      email: u.email,
      phone: u.phone || "",
      title: u.title || "",
      role: u.role,
      active: u.active,
      password: "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
  }

  async function saveEdit(profileId: string) {
    if (!editForm) return;
    setBusyId(profileId);
    try {
      await updateUser({
        data: {
          id: profileId,
          name: editForm.name,
          email: editForm.email,
          phone: editForm.phone,
          title: editForm.title,
          role: editForm.role,
          active: editForm.active,
          password: editForm.password.trim() || undefined,
        },
      });
      toast.success("User updated");
      cancelEdit();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function removeUser(u: Profile) {
    setBusyId(u.id);
    try {
      const res = await deleteUser({ data: { id: u.id } });
      toast.success(`${res.removed || u.name} removed`);
      setConfirmRemoveId(null);
      if (editingId === u.id) cancelEdit();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleClearAllLeads() {
    setClearingLeads(true);
    try {
      const res = await clearAllLeads();
      toast.success(res.message);
      setConfirmClearLeads(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not clear leads");
    } finally {
      setClearingLeads(false);
    }
  }

  async function handleImportNow(days = 14) {
    setImporting(true);
    try {
      const res = await runImport({
        data: { days, max: days >= 25 ? 200 : 40 },
      });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  if (me && me.role !== "admin") {
    return <Navigate to="/" />;
  }

  if (!me || !metrics) {
    return <div className="h-48 animate-pulse rounded-2xl bg-muted" />;
  }

  const funnelMap = Object.fromEntries(metrics.funnel.map((f) => [f.stage, f.count]));
  const leadTotal = metrics.overall.total;
  const gmailOk = importStatus?.config?.configured;

  return (
    <>
      <PageHeader
        title="Admin"
        description="Jeremy & Guillaume — team performance, email import, and user management."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Success rate"
          value={`${metrics.overall.success_rate}%`}
          hint={`${metrics.overall.won} won / ${metrics.overall.total}`}
        />
        <Metric label="Contact rate" value={`${metrics.overall.contact_rate}%`} hint="Past New Lead" />
        <Metric
          label="Review rate"
          value={`${metrics.overall.review_rate}%`}
          hint="Google reviews received"
        />
        <Metric
          label="Pipeline value"
          value={formatCurrency(metrics.overall.pipeline_value)}
          hint="Open deals"
        />
      </div>

      <Card className="mb-6 border-primary/25">
        <CardHeader className="pb-2">
          <CardTitle className="font-display flex items-center gap-2 text-xl">
            <Mail className="size-5 text-primary" />
            Email import · client@paulmotorcompany.com
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Auto-reads the shared lead inbox. Rules: TAdvantage general →{" "}
            <strong className="text-foreground">General Interest</strong>; financing forms →{" "}
            <strong className="text-foreground">Lease</strong>; CarGurus / AutoTrader →{" "}
            <strong className="text-foreground">Inventory</strong>. Same person + same car merges
            into one open lead (90 days).
          </p>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={gmailOk ? "default" : "outline"}>
              {gmailOk ? "Gmail connected" : "Gmail not connected"}
            </Badge>
            {importStatus?.config?.user ? (
              <span className="text-xs text-muted-foreground">{importStatus.config.user}</span>
            ) : null}
            {importStatus?.last_run ? (
              <span className="text-xs text-muted-foreground">
                Last run: {new Date(importStatus.last_run).toLocaleString("en-CA")}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Never run yet</span>
            )}
          </div>

          {!gmailOk ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              Add <code className="text-foreground">GMAIL_CLIENT_ID</code>,{" "}
              <code className="text-foreground">GMAIL_CLIENT_SECRET</code>,{" "}
              <code className="text-foreground">GMAIL_REFRESH_TOKEN</code>,{" "}
              <code className="text-foreground">GMAIL_USER=client@paulmotorcompany.com</code> in
              Vercel env, then redeploy. Full steps:{" "}
              <code className="text-foreground">deploy/GMAIL_SETUP.md</code> in GitHub.
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button disabled={importing} onClick={() => void handleImportNow(14)}>
              <RefreshCw className={cn("size-4", importing && "animate-spin")} />
              {importing ? "Importing…" : "Import now"}
            </Button>
            <Button
              variant="outline"
              disabled={importing}
              onClick={() => void handleImportNow(25)}
            >
              {importing ? "Importing…" : "Import last 25 days"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Classifies each email as Inventory (CarGurus / AutoTrader), Lease (TAdvantage financing
            forms), or General Interest. Duplicates (same person + same car) are merged.
          </p>

          {importStatus?.recent && importStatus.recent.length > 0 ? (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
              <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Inbox className="size-3.5" /> Recent imports
              </p>
              {importStatus.recent.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/40 py-1.5 text-xs last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.subject || "(no subject)"}</p>
                    <p className="truncate text-muted-foreground">
                      {r.from_address} · {r.portal || "—"} · {r.lead_type || "—"}
                    </p>
                  </div>
                  <Badge
                    variant={
                      r.status === "created"
                        ? "default"
                        : r.status === "merged"
                          ? "outline"
                          : r.status === "error"
                            ? "lost"
                            : "outline"
                    }
                    className="shrink-0 capitalize"
                  >
                    {r.status}
                  </Badge>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mb-6 border-destructive/30">
        <CardHeader className="pb-2">
          <CardTitle className="font-display flex items-center gap-2 text-xl">
            <Eraser className="size-5 text-destructive" />
            Data cleanup
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Remove demo / sample leads so the pipeline only shows real customers. This deletes{" "}
            <strong className="text-foreground">all leads</strong>, notes, activities, and test
            drives. <strong className="text-foreground">Team accounts and inventory stay</strong>.
          </p>
          <p className="text-xs text-muted-foreground">
            Currently: <span className="tabular font-medium text-foreground">{leadTotal}</span>{" "}
            lead{leadTotal === 1 ? "" : "s"} in the database.
          </p>

          {!confirmClearLeads ? (
            <Button
              variant="destructive"
              disabled={leadTotal === 0 || clearingLeads}
              onClick={() => setConfirmClearLeads(true)}
            >
              <Trash2 className="size-4" />
              Clear all leads
            </Button>
          ) : (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
              <p className="text-sm font-medium">
                Permanently delete all {leadTotal} lead{leadTotal === 1 ? "" : "s"}?
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                This cannot be undone. Use New Lead after this to capture real floor leads only.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={clearingLeads}
                  onClick={() => void handleClearAllLeads()}
                >
                  {clearingLeads ? "Deleting…" : "Yes, delete everything"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={clearingLeads}
                  onClick={() => setConfirmClearLeads(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-display text-xl">Per rep / broker</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {metrics.by_rep.map((r) => (
              <div key={r.profile_id} className="rounded-xl border border-border/70 px-3 py-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs capitalize text-muted-foreground">{r.role}</p>
                  </div>
                  <p className="tabular text-primary">{r.success_rate}% win</p>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                  <span>{r.total} leads</span>
                  <span>{r.contact_rate}% contact</span>
                  <span>{r.reviews_received} reviews</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-xl">Conversion funnel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {STAGES.map((s) => {
              const count = funnelMap[s.id] ?? 0;
              const max = Math.max(1, ...Object.values(funnelMap).map(Number));
              return (
                <div key={s.id}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="tabular">{count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/80"
                      style={{ width: `${Math.round((count / max) * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="users-panel">
        <CardHeader>
          <CardTitle className="font-display text-xl">Users</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <form
            className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await createUser({
                  data: {
                    name: form.name,
                    email: form.email,
                    password: form.password,
                    role: form.role,
                    phone: form.phone,
                    title: form.title,
                  },
                });
                toast.success("User created");
                setForm(emptyCreate());
                await load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Create failed");
              }
            }}
          >
            <div className="flex items-center gap-2 sm:col-span-2">
              <UserPlus className="size-4 text-primary" />
              <Label className="text-base">Create user</Label>
            </div>
            <Input
              placeholder="Full name"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Input
              type="email"
              placeholder="Email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
            <Input
              type="password"
              placeholder="Password (8+)"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
            <Select
              value={form.role}
              onValueChange={(v) => setForm((f) => ({ ...f, role: v as Role }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="rep">Sales rep</SelectItem>
                <SelectItem value="credit_manager">Credit Manager</SelectItem>
                <SelectItem value="gsm">General Sales Manager</SelectItem>
                <SelectItem value="broker">Broker</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
            <Input
              placeholder="Title (e.g. Sales Representative)"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
            <Button type="submit" className="sm:col-span-2">
              Create account
            </Button>
          </form>

          <div className="space-y-3" data-testid="users-list">
            {users.map((u) => {
              const isEditing = editingId === u.id && editForm;
              const isConfirming = confirmRemoveId === u.id;
              const isSelf = me.id === u.id;
              return (
                <div
                  key={u.id}
                  data-testid={`user-row-${u.id}`}
                  data-user-name={u.name}
                  className={cn(
                    "rounded-xl border px-3 py-3",
                    isEditing ? "border-primary/40 bg-primary/5" : "border-border",
                  )}
                >
                  {!isEditing ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{u.name}</p>
                          <Badge variant="outline" className="capitalize">
                            {u.role}
                          </Badge>
                          {!u.active ? <Badge variant="lost">Inactive</Badge> : null}
                          {isSelf ? <Badge variant="default">You</Badge> : null}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {u.email}
                          {u.phone ? ` · ${u.phone}` : ""}
                          {u.title ? ` · ${u.title}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === u.id}
                          onClick={() => startEdit(u)}
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === u.id || isSelf}
                          onClick={async () => {
                            setBusyId(u.id);
                            try {
                              await updateUser({ data: { id: u.id, active: !u.active } });
                              toast.success(u.active ? "Deactivated" : "Reactivated");
                              await load();
                            } catch (e) {
                              toast.error(e instanceof Error ? e.message : "Update failed");
                            } finally {
                              setBusyId(null);
                            }
                          }}
                        >
                          {u.active ? "Deactivate" : "Activate"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busyId === u.id || isSelf}
                          onClick={() => {
                            setConfirmRemoveId(u.id);
                            cancelEdit();
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-primary">Edit {u.name}</p>
                        <Button size="icon" variant="ghost" onClick={cancelEdit} aria-label="Close edit">
                          <X className="size-4" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-1.5">
                          <Label htmlFor={`edit-name-${u.id}`}>Name</Label>
                          <Input
                            id={`edit-name-${u.id}`}
                            value={editForm.name}
                            onChange={(e) =>
                              setEditForm((f) => (f ? { ...f, name: e.target.value } : f))
                            }
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`edit-email-${u.id}`}>Email</Label>
                          <Input
                            id={`edit-email-${u.id}`}
                            type="email"
                            value={editForm.email}
                            onChange={(e) =>
                              setEditForm((f) => (f ? { ...f, email: e.target.value } : f))
                            }
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`edit-phone-${u.id}`}>Phone</Label>
                          <Input
                            id={`edit-phone-${u.id}`}
                            value={editForm.phone}
                            onChange={(e) =>
                              setEditForm((f) => (f ? { ...f, phone: e.target.value } : f))
                            }
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor={`edit-title-${u.id}`}>Title</Label>
                          <Input
                            id={`edit-title-${u.id}`}
                            value={editForm.title}
                            onChange={(e) =>
                              setEditForm((f) => (f ? { ...f, title: e.target.value } : f))
                            }
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label>Role</Label>
                          <Select
                            value={editForm.role}
                            onValueChange={(v) =>
                              setEditForm((f) => (f ? { ...f, role: v as Role } : f))
                            }
                            disabled={isSelf}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="rep">Sales rep</SelectItem>
                              <SelectItem value="broker">Broker</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1.5">
                          <Label>Status</Label>
                          <Select
                            value={editForm.active ? "active" : "inactive"}
                            onValueChange={(v) =>
                              setEditForm((f) => (f ? { ...f, active: v === "active" } : f))
                            }
                            disabled={isSelf}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="inactive">Inactive</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1.5 sm:col-span-2">
                          <Label htmlFor={`edit-password-${u.id}`}>
                            Override password (admin)
                          </Label>
                          <Input
                            id={`edit-password-${u.id}`}
                            type="password"
                            placeholder="Leave blank to keep their current password"
                            minLength={8}
                            value={editForm.password}
                            onChange={(e) =>
                              setEditForm((f) => (f ? { ...f, password: e.target.value } : f))
                            }
                          />
                          <p className="text-[11px] text-muted-foreground">
                            Sets a new password for this user without needing their current one.
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={busyId === u.id} onClick={() => void saveEdit(u.id)}>
                          {busyId === u.id ? "Saving…" : "Save changes"}
                        </Button>
                        <Button variant="outline" onClick={cancelEdit}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {isConfirming ? (
                    <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
                      <p className="text-sm font-medium">Remove {u.name} permanently?</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Their assigned leads become unassigned. They lose sign-in access.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busyId === u.id}
                          onClick={() => void removeUser(u)}
                        >
                          {busyId === u.id ? "Removing…" : "Yes, remove"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setConfirmRemoveId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">Lease contracts (admin)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Six contract styles. Edit the HTML body. Placeholders: client_name, payment, residual, term, start_date (double curly braces).
          </p>
          <div className="flex flex-wrap gap-2">
            {contracts.map((c) => (
              <Button
                key={c.style_key}
                type="button"
                size="sm"
                variant={contractKey === c.style_key ? "default" : "outline"}
                onClick={() => {
                  setContractKey(c.style_key);
                  setContractBody(c.body_html);
                }}
              >
                {c.label}
              </Button>
            ))}
          </div>
          <Textarea
            value={contractBody}
            onChange={(e) => setContractBody(e.target.value)}
            className="min-h-[220px] font-mono text-xs"
          />
          <Button
            type="button"
            onClick={async () => {
              try {
                await saveContract({ data: { styleKey: contractKey, bodyHtml: contractBody } });
                toast.success("Contract template saved");
                const c = await listContracts();
                setContracts(c);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Save failed");
              }
            }}
          >
            Save contract template
          </Button>
          <div className="rounded-sm border border-border bg-muted/30 p-3 text-xs">
            <p className="font-semibold">Google Drive (Push to Drive)</p>
            <p className="text-muted-foreground">
              {driveStatus == null
                ? "—"
                : driveStatus.ok
                  ? "Connected — can create year/month/deal folders"
                  : `Not ready: ${driveStatus.error || "check OAuth Drive scope"}`}
            </p>
            <p className="mt-1 text-muted-foreground">
              Parent folder must be shared with the Google account used for OAuth. Re-auth with Drive scope if needed
              (GOOGLE_DRIVE_REFRESH_TOKEN).
            </p>
          </div>
        </CardContent>
      </Card>
</>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
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
