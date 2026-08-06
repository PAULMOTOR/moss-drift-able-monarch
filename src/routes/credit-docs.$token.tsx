import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getPublicDocRequest, uploadPublicCreditDoc } from "@/lib/crm/credit";

export const Route = createFileRoute("/credit-docs/$token")({
  component: PublicDocUploadPage,
});

function PublicDocUploadPage() {
  const { token } = Route.useParams();
  const search =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const kindParam = search.get("kind") === "bank_statement" ? "bank_statement" : "noa_payslip";
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    void getPublicDocRequest({ data: { token } })
      .then((r) => setName(r.leadName))
      .catch((e) => setError(e instanceof Error ? e.message : "Invalid link"));
  }, [token]);

  async function onUpload(file: File | null) {
    if (!file) return;
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
          kind: kindParam,
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

  const label =
    kindParam === "bank_statement" ? "Bank / financial statements" : "NOA / payslips";

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
          <h2 className="font-semibold text-[#008272]">{label}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Upload one document at a time. You can reopen this link later if you don't have
            everything now — keep it until your package is complete.
          </p>
          <Input
            type="file"
            accept="image/*,application/pdf"
            className="mt-4"
            disabled={busy}
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
