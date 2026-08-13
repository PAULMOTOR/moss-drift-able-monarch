import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createPartner, listPartners } from "@/lib/crm/server";
import { PARTNER_KINDS, type Partner, type PartnerKind } from "@/lib/crm/partners";

export function PartnerField({
  value,
  onChange,
  disabled,
  size = "md",
}: {
  value: string;
  onChange: (partnerId: string, partner?: Partner | null) => void;
  disabled?: boolean;
  size?: "md" | "lg";
}) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<PartnerKind>("dealer");
  const [busy, setBusy] = useState(false);
  const h = size === "lg" ? "h-12" : "h-11";

  async function reload() {
    const rows = await listPartners({ data: { activeOnly: true } });
    setPartners(rows);
  }

  useEffect(() => {
    void reload().catch(() => setPartners([]));
  }, []);

  async function saveNew() {
    const name = newName.trim();
    if (name.length < 2) {
      toast.error("Enter the dealer or broker name");
      return;
    }
    setBusy(true);
    try {
      const p = await createPartner({ data: { name, kind: newKind } });
      await reload();
      onChange(p.id, p);
      setAdding(false);
      setNewName("");
      toast.success(`${p.name} added to the partner book`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add partner");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <Label>Origin — dealer / broker / referrer</Label>
      <Select
        value={value || "none"}
        onValueChange={(v) => {
          if (v === "__add__") {
            setAdding(true);
            return;
          }
          if (v === "none") onChange("", null);
          else onChange(v, partners.find((p) => p.id === v) || null);
        }}
        disabled={disabled}
      >
        <SelectTrigger className={h}>
          <SelectValue placeholder="Direct — our client" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Direct — our client (no partner)</SelectItem>
          {partners.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {PARTNER_KINDS.find((k) => k.id === p.kind)?.label || p.kind} · {p.name}
            </SelectItem>
          ))}
          <SelectItem value="__add__">+ Add dealer or broker…</SelectItem>
        </SelectContent>
      </Select>
      {adding ? (
        <div className="grid gap-2 rounded-sm border border-border bg-muted/40 p-3">
          <Input
            className={h}
            placeholder="e.g. Ferrari of Alberta"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy}
          />
          <Select value={newKind} onValueChange={(v) => setNewKind(v as PartnerKind)}>
            <SelectTrigger className={h}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PARTNER_KINDS.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void saveNew()}>
              <Plus className="size-3.5" />
              Save partner
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          External referral? Pick them now so search and client emails stay partner-safe.
        </p>
      )}
    </div>
  );
}
