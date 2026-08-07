import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { getPublicDocRequest, uploadPublicCreditDoc } from "@/lib/crm/credit";
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

function PublicDocUploadPage() {
  const { token } = Route.useParams();
  const urlKinds = useMemo(() => parseKindsFromSearch(), []);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);
  const [pendingKinds, setPendingKinds] = useState<string[]>(urlKinds);
  const [selectedKind, setSelectedKind] = useState<string>(urlKinds[0] || "");

  useEffect(() => {
    void getPublicDocRequest({ data: { token } })
      .then((r) => {
        setName(r.leadName);
        const fromServer = r.pendingKinds?.length ? r.pendingKinds : urlKinds;
        if (fromServer.length) {
          setPendingKinds(fromServer);
          setSelectedKind((prev) => prev || fromServer[0] || "");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Invalid link"));
  }, [token, urlKinds]);

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
      await uploadPublicCreditDoc({
        data: {
          token,
          kind: selectedKind,
          fileName: file.name,
          mimeType: file.type || "application/pdf",
          fileData: data,
          via: "doc",
        },
      });
      setCount((c) => c + 1);
      toast.success("Document uploaded — you can add more or close this window");
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

  const kinds =
    pendingKinds.length > 0
      ? pendingKinds
      : LESSEE_DOC_TYPES.map((d) => d.key);

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
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
              {pendingKinds.map((k) => (
                <li key={k}>{kindLabel(k)}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Upload the documents your credit team requested.
            </p>
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            Upload one document at a time. You can reopen this link later if you don't have
            everything now.
          </p>
          <div className="mt-4 space-y-1.5">
            <Label>Document type</Label>
            <Select value={selectedKind || undefined} onValueChange={setSelectedKind}>
              <SelectTrigger>
                <SelectValue placeholder="Select type…" />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {kindLabel(k)}
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
            onChange={(e) => void onUpload(e.target.files?.[0] || null)}
          />
          {count > 0 ? (
            <p className="mt-3 text-sm text-emerald-700">
              {count} file(s) received. You may close this window or upload another.
            </p>
          ) : null}
          <Button className="mt-4" variant="outline" onClick={() => window.close()}>
            Close
          </Button>
        </div>
      </main>
    </div>
  );
}
