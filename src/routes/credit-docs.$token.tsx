import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
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
import { getPublicDocRequest, uploadPublicCreditDoc, finishPublicDocUpload } from "@/lib/crm/credit";
import { LESSEE_DOC_TYPES, lesseeDocLabel } from "@/lib/crm/types";

export const Route = createFileRoute("/credit-docs/$token")({
  component: PublicDocUploadPage,
});

function parseKindsFromSearch(): string[] {
  if (typeof window === "undefined") return [];
  const search = new URLSearchParams(window.location.search);
  const multi = search.get("kinds");
  if (multi) {
    return multi
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }
  const single = search.get("kind");
  if (single === "bank_statement") return ["bank_statement"];
  if (single === "noa_payslip") return ["noa_payslip"];
  if (single) return [single];
  return [];
}

function kindLabel(key: string) {
  if (key === "noa_payslip") return "NOA / payslips";
  if (key === "bank_statement") return "Bank / financial statements";
  const known = LESSEE_DOC_TYPES.find((d) => d.key === key);
  return known?.label || lesseeDocLabel(key);
}

function kindAliases(key: string): string[] {
  if (key === "bank_statement" || key === "personal_bank_statements") {
    return ["bank_statement", "personal_bank_statements", "bank_statements"];
  }
  if (key === "noa_payslip" || key === "noas") {
    return ["noa_payslip", "noas", "noa"];
  }
  return [key];
}

function isKindUploaded(key: string, uploaded: string[]): boolean {
  const aliases = kindAliases(key);
  return uploaded.some((u) => aliases.includes(u) || u === key);
}

function PublicDocUploadPage() {
  const { token } = Route.useParams();
  const urlKinds = useMemo(() => parseKindsFromSearch(), []);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [pendingKinds, setPendingKinds] = useState<string[]>(urlKinds);
  const [uploadedKinds, setUploadedKinds] = useState<string[]>([]);
  const [selectedKind, setSelectedKind] = useState<string>(urlKinds[0] || "");
  const [notified, setNotified] = useState(false);

  useEffect(() => {
    void getPublicDocRequest({ data: { token } })
      .then((r) => {
        setName(r.leadName);
        const fromServer = r.pendingKinds?.length ? r.pendingKinds : urlKinds;
        if (fromServer.length) {
          setPendingKinds(fromServer);
        }
        const already = r.uploadedKinds || [];
        setUploadedKinds(already);
        const remaining = fromServer.filter((k) => !isKindUploaded(k, already));
        setSelectedKind((prev) => {
          if (prev && !isKindUploaded(prev, already)) return prev;
          return remaining[0] || fromServer[0] || prev || "";
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Invalid link"));
  }, [token, urlKinds]);

  const remainingKinds = pendingKinds.filter((k) => !isKindUploaded(k, uploadedKinds));
  const dropdownKinds = remainingKinds.length > 0 ? remainingKinds : pendingKinds.length > 0 ? pendingKinds : LESSEE_DOC_TYPES.map((d) => d.key);
  const allRequestedDone = pendingKinds.length > 0 && remainingKinds.length === 0;

  async function onUpload(file: File | null) {
    if (!file) return;
    if (!selectedKind) {
      toast.error("Choose which document you are uploading");
      return;
    }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("Read failed"));
        r.readAsDataURL(file);
      });
      const res = await uploadPublicCreditDoc({
        data: {
          token,
          kind: selectedKind,
          fileName: file.name,
          mimeType: file.type || "application/pdf",
          fileData: data,
          via: "doc",
        },
      });
      const nextUploaded = [...uploadedKinds, res.uploadedKind || selectedKind];
      setUploadedKinds(nextUploaded);
      setCount((c) => c + 1);
      const nextLeft = pendingKinds.filter((k) => !isKindUploaded(k, nextUploaded));
      setSelectedKind(nextLeft[0] || selectedKind);
      toast.success(
        res.notified
          ? "All requested documents received — credit has been notified"
          : nextLeft.length
            ? `${kindLabel(selectedKind)} received — ${nextLeft.length} still needed`
            : "All requested documents received",
      );
      if (res.notified) setNotified(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#f3f2f1]">
      <header className="border-b bg-[#008272] px-4 py-4 text-white">
        <div className="mx-auto max-w-lg">
          <p className="text-xs font-semibold opacity-90">PAUL MOTOR LEASING</p>
          <h1 className="text-xl font-bold">Secure document upload</h1>
          {name ? <p className="text-sm opacity-90">{name}</p> : null}
        </div>
      </header>
      <main className="mx-auto max-w-lg p-4">
        <div className="rounded-sm border bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-[#008272]">Requested documents</h2>
          {pendingKinds.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-sm">
              {pendingKinds.map((k) => {
                const done = isKindUploaded(k, uploadedKinds);
                return (
                  <li
                    key={k}
                    className={`flex items-center gap-2 ${
                      done ? "text-emerald-800" : "text-foreground"
                    }`}
                  >
                    {done ? (
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
                        <Check className="size-3.5" strokeWidth={3} />
                      </span>
                    ) : (
                      <span className="size-5 shrink-0 rounded-full border border-border" />
                    )}
                    <span className={done ? "text-emerald-800/80 line-through" : ""}>
                      {kindLabel(k)}
                    </span>
                    {done ? (
                      <span className="text-xs font-medium text-emerald-700">Uploaded</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Upload the documents your credit team requested.
            </p>
          )}
          {allRequestedDone ? (
            <p className="mt-3 text-sm font-medium text-emerald-700">
              All requested documents are in. You can close this window, or add another file below.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Upload one document at a time. You can reopen this link later if you don't have
              everything now.
            </p>
          )}
          <div className="mt-4 space-y-1.5">
            <Label>Document type</Label>
            <Select value={selectedKind || undefined} onValueChange={setSelectedKind}>
              <SelectTrigger>
                <SelectValue placeholder="Select type…" />
              </SelectTrigger>
              <SelectContent>
                {dropdownKinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {kindLabel(k)}
                    {isKindUploaded(k, uploadedKinds) ? " (add another)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            type="file"
            accept="image/*,application/pdf"
            className="mt-4"
            disabled={busy || !selectedKind}
            onChange={(e) => {
              void onUpload(e.target.files?.[0] || null);
              e.target.value = "";
            }}
          />
          {count > 0 && !allRequestedDone ? (
            <p className="mt-3 text-sm text-emerald-700">
              {count} file(s) received. You may close this window or upload another.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={busy || notified || (count === 0 && uploadedKinds.length === 0)}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await finishPublicDocUpload({ data: { token } });
                  setNotified(true);
                  toast.success(
                    res.complete
                      ? "Credit has been notified — you can close this window"
                      : "Credit has been notified. You can still add missing files later.",
                  );
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not notify credit");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {notified ? "Credit notified" : "I'm finished"}
            </Button>
            <Button variant="outline" onClick={() => window.close()}>
              Close
            </Button>
          </div>
          {notified ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Paul Motor Leasing credit has this package.
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}