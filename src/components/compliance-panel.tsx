import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getComplianceFile,
  getCompliancePackage,
  updateComplianceItem,
} from "@/lib/crm/compliance";
import { COMPLIANCE_ITEMS, FUNDING_BANKS } from "@/lib/crm/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function CompliancePanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getCompliancePackage>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await getCompliancePackage({ data: { leadId } });
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load compliance");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  if (!data) {
    return <div className="h-32 animate-pulse rounded-sm bg-muted" />;
  }

  if (!data.unlocked) {
    return (
      <div className="rounded-sm border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        Compliance unlocks after <strong className="text-foreground">GSM or Admin approval</strong>.
        Complete Credit underwriting first, then request approval.
      </div>
    );
  }

  const def = (key: string) => COMPLIANCE_ITEMS.find((c) => c.key === key);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Compliance package</h3>
          <p className="text-xs text-muted-foreground">
            {data.progress.done} of {data.progress.total} complete
            {data.progress.done === data.progress.total
              ? " · deal can move to Closed Won"
              : ""}
          </p>
        </div>
        <div className="h-2 w-40 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{
              width: `${data.progress.total ? (100 * data.progress.done) / data.progress.total : 0}%`,
            }}
          />
        </div>
      </div>

      {data.quoteSummary ? (
        <div className="rounded-sm border border-border bg-card p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Accepted quote
          </p>
          <p className="font-medium">
            {data.quoteSummary.title || data.quoteSummary.client_name || "Quote"}
            {data.quoteSummary.accepted_option
              ? ` · Option ${data.quoteSummary.accepted_option}`
              : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.quoteSummary.retail_html ? (
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) return;
                  w.document.write(data.quoteSummary!.retail_html!);
                  w.document.close();
                }}
              >
                View quote
              </Button>
            ) : null}
            {data.quoteSummary.invoice_html ? (
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) return;
                  w.document.write(data.quoteSummary!.invoice_html!);
                  w.document.close();
                }}
              >
                First invoice
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ul className="space-y-3">
        {data.items.map((item) => {
          const meta = def(item.item_key);
          return (
            <li
              key={item.id}
              className="rounded-sm border border-border bg-card p-3 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={item.done}
                  disabled={busy}
                  onCheckedChange={async (v) => {
                    setBusy(true);
                    try {
                      await updateComplianceItem({
                        data: {
                          leadId,
                          itemKey: item.item_key,
                          done: Boolean(v),
                        },
                      });
                      await load();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Update failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium leading-snug">{item.label}</p>
                  {meta?.needsBank ? (
                    <div className="max-w-xs">
                      <Label className="text-[11px] text-muted-foreground">Funding bank</Label>
                      <Select
                        value={item.meta || undefined}
                        onValueChange={async (bank) => {
                          setBusy(true);
                          try {
                            await updateComplianceItem({
                              data: {
                                leadId,
                                itemKey: item.item_key,
                                meta: bank,
                                done: true,
                                notes: `Bank: ${bank}`,
                              },
                            });
                            await load();
                            toast.success(`Funding bank: ${bank}`);
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="RBC / BMO / CIBC" />
                        </SelectTrigger>
                        <SelectContent>
                          {FUNDING_BANKS.map((b) => (
                            <SelectItem key={b} value={b}>
                              {b}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {meta?.needsUpload ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="file"
                        className="h-9 max-w-xs text-xs"
                        disabled={busy}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 6 * 1024 * 1024) {
                            toast.error("File must be under 6 MB");
                            return;
                          }
                          setBusy(true);
                          try {
                            const dataUrl = await new Promise<string>((resolve, reject) => {
                              const r = new FileReader();
                              r.onload = () => resolve(String(r.result));
                              r.onerror = () => reject(new Error("Read failed"));
                              r.readAsDataURL(file);
                            });
                            await updateComplianceItem({
                              data: {
                                leadId,
                                itemKey: item.item_key,
                                fileName: file.name,
                                fileData: dataUrl,
                                mimeType: file.type || "application/octet-stream",
                                done: true,
                              },
                            });
                            toast.success(`${file.name} uploaded`);
                            await load();
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : "Upload failed");
                          } finally {
                            setBusy(false);
                            e.target.value = "";
                          }
                        }}
                      />
                      {item.has_file ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              const f = await getComplianceFile({
                                data: { leadId, itemKey: item.item_key },
                              });
                              const a = document.createElement("a");
                              a.href = f.file_data;
                              a.download = f.file_name;
                              a.click();
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : "Open failed");
                            }
                          }}
                        >
                          Download {item.file_name || "file"}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <Input
                    placeholder="Notes…"
                    className="h-8 text-xs"
                    defaultValue={item.notes}
                    onBlur={async (e) => {
                      const notes = e.target.value;
                      if (notes === item.notes) return;
                      try {
                        await updateComplianceItem({
                          data: { leadId, itemKey: item.item_key, notes },
                        });
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
