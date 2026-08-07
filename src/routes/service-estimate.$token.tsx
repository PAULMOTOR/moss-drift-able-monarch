import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { getPublicEstimate, publicDecideEstimate } from "@/lib/crm/service";
import { formatCurrency } from "@/lib/utils";

export const Route = createFileRoute("/service-estimate/$token")({
  component: PublicEstimatePage,
});

function PublicEstimatePage() {
  const { token } = Route.useParams();
  const [row, setRow] = useState<{
    id: string;
    work_order_id: string;
    wo_number: string;
    vehicle_label: string | null;
    customer_name: string | null;
    line_items_json: string;
    subtotal: number;
    tax: number;
    total: number;
    status: string;
    notes: string | null;
  } | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPublicEstimate({ data: { token } })
      .then(setRow)
      .catch((e) => toast.error(e instanceof Error ? e.message : "Not found"));
  }, [token]);

  if (!row) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-4">
        <p className="text-sm text-muted-foreground">Loading estimate…</p>
      </div>
    );
  }

  const lines = JSON.parse(row.line_items_json) as Array<{
    desc: string;
    qty: number;
    unit: number;
  }>;
  const status = row.status;
  const locked =
    done || status === "customer_approved" || status === "customer_declined";

  return (
    <div className="min-h-dvh bg-background p-4">
      <div className="mx-auto max-w-lg space-y-4">
        <div className="rounded-sm bg-primary px-4 py-3 text-primary-foreground">
          <p className="text-xs uppercase tracking-wide opacity-80">Paul Motor Leasing</p>
          <h1 className="font-display text-xl font-semibold">Service estimate</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {row.wo_number || "Estimate"}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {row.vehicle_label || ""}
              {row.customer_name ? ` · ${row.customer_name}` : ""}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="divide-y divide-border text-sm">
              {lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-2 py-2">
                  <span>
                    {l.desc}{" "}
                    <span className="text-muted-foreground">
                      × {l.qty}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(l.qty * l.unit)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="space-y-1 border-t border-border pt-3 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCurrency(row.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax (est.)</span>
                <span>{formatCurrency(row.tax)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span>{formatCurrency(row.total)}</span>
              </div>
            </div>
            {locked ? (
              <p className="rounded-sm bg-muted p-3 text-sm">
                Status: <strong>{status.replace(/_/g, " ")}</strong>
              </p>
            ) : (
              <>
                <Textarea
                  placeholder="Optional note for the service team"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                />
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await publicDecideEstimate({
                          data: { token, decision: "approve", note },
                        });
                        setDone(true);
                        toast.success("Estimate approved — thank you");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    className="flex-1"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await publicDecideEstimate({
                          data: { token, decision: "decline", note },
                        });
                        setDone(true);
                        toast.message("Estimate declined");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Decline
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
