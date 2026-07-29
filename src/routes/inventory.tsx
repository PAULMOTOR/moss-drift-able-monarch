import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getMyProfile, listInventory, refreshInventoryFeeds, upsertInventory } from "@/lib/crm/server";
import { vehicleLabel, type InventoryItem, type Profile } from "@/lib/crm/types";
import { formatCurrency } from "@/lib/utils";

export const Route = createFileRoute("/inventory")({
  component: () => (
    <AuthGate>
      <InventoryPage />
    </AuthGate>
  ),
});

function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [q, setQ] = useState("");
  const [me, setMe] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useServerFn(refreshInventoryFeeds);
  const upsert = useServerFn(upsertInventory);

  async function load(query = q) {
    const [rows, profile] = await Promise.all([
      listInventory({ data: { q: query } }),
      getMyProfile(),
    ]);
    setItems(rows);
    setMe(profile);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Live PAUL MOTOR CO. stock from paulmotorleasing.com — used for inventory lead dropdowns."
        actions={
          me?.role === "admin" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await refresh();
                    toast.success(res.message);
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Refresh failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw className="size-4" />
                Sync live stock
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  const make = prompt("Make (e.g. Ferrari)");
                  const model = prompt("Model");
                  const year = Number(prompt("Year", "2024"));
                  if (!make || !model || !year) return;
                  setBusy(true);
                  try {
                    await upsert({
                      data: {
                        year,
                        make,
                        model,
                        stock_number: prompt("Stock #") || undefined,
                        price: Number(prompt("Price CAD", "200000") || 0) || null,
                        source: "manual",
                        status: "available",
                      },
                    });
                    toast.success("Vehicle added");
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Add failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Add vehicle
              </Button>
            </div>
          ) : null
        }
      />

      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-11 pl-9"
            placeholder="Search make, model, stock #…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(e.currentTarget.value);
            }}
          />
        </div>
        <Button variant="secondary" className="h-11" onClick={() => void load()}>
          Search
        </Button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {items.length} units · source: paulmotorleasing.com
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <Card key={item.id} className="overflow-hidden border-border/80">
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium leading-snug">{vehicleLabel(item)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Stock #{item.stock_number || "—"}
                    {item.mileage != null
                      ? ` · ${item.mileage.toLocaleString("en-CA")} km`
                      : ""}
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 capitalize">
                  {item.status}
                </Badge>
              </div>
              <p className="tabular text-lg font-semibold text-primary">
                {formatCurrency(item.price)}
              </p>
              {item.body_type ? (
                <p className="text-xs text-muted-foreground">{item.body_type}</p>
              ) : null}
              {item.external_url ? (
                <a
                  href={item.external_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  View on website <ExternalLink className="size-3" />
                </a>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No inventory found.</p>
      ) : null}
    </>
  );
}
