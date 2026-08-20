import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getPublicQuoteAccept, submitPublicQuoteAccept } from "@/lib/crm/quote-accept";
import { formatMoney } from "@/lib/crm/lease-quote";

export const Route = createFileRoute("/quote-accept/$token")({
  component: QuoteAcceptPage,
});

function QuoteAcceptPage() {
  const { token } = Route.useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof getPublicQuoteAccept>> | null>(
    null,
  );

  useEffect(() => {
    void getPublicQuoteAccept({ data: { token } })
      .then((res) => {
        setData(res);
        setDone(res.alreadyAccepted);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Invalid link");
        setLoading(false);
      });
  }, [token]);

  async function accept() {
    if (!data) return;
    setBusy(true);
    try {
      await submitPublicQuoteAccept({
        data: { token, optionNumber: data.optionNumber },
      });
      setDone(true);
      toast.success(`Option ${data.optionNumber} accepted`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not accept");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-[#f4f1ea] text-sm text-muted-foreground">
        Loading your quote…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-[#f4f1ea] p-6">
        <p className="max-w-md text-center text-sm text-red-800">{error || "Not found"}</p>
      </div>
    );
  }

  const s = data.snapshot;

  return (
    <div className="min-h-svh bg-[#f4f1ea] px-4 py-10 text-[#1a1a1a]">
      <main className="mx-auto max-w-lg space-y-4">
        <div className="text-center">
          <img
            src="/palmetto.png"
            alt="Paul Motor Leasing"
            className="mx-auto h-16 w-16 object-contain"
          />
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#008272]">
            Paul Motor Leasing
          </p>
        </div>
        <h1 className="text-center font-display text-2xl font-semibold">
          {done ? "Quote accepted" : `Accept Option ${data.optionNumber}`}
        </h1>
        <p className="text-center text-sm text-muted-foreground">
          {data.clientName}
          {data.vehicle ? ` · ${data.vehicle}` : ""}
        </p>

        <section className="overflow-hidden rounded-sm border border-border bg-white shadow-sm">
          {data.heroImage ? (
            <div className="flex justify-center border-b border-border/60 bg-white px-5 pt-5 pb-4">
              <img
                src={data.heroImage}
                alt={data.vehicle || "Vehicle"}
                className="h-52 w-52 object-contain"
              />
            </div>
          ) : null}
          <div className="p-5">
            <h2 className="mb-3 text-sm font-semibold text-[#008272]">
              Exact terms you are accepting
            </h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Option</dt>
              <dd className="font-medium">{data.optionNumber}</dd>
              <dt className="text-muted-foreground">Term</dt>
              <dd className="font-medium">{s.termMonths} months</dd>
              <dt className="text-muted-foreground">Monthly payment</dt>
              <dd className="font-semibold">{formatMoney(s.totalPayment)} taxes in</dd>
              <dt className="text-muted-foreground">Cash down</dt>
              <dd className="font-medium">
                {formatMoney(s.cashDown)}
                <span className="mt-0.5 block text-[11px] font-normal leading-snug text-muted-foreground">
                  Before tax — {data.provinceName} {data.taxCaption} is added at delivery
                </span>
              </dd>
              <dt className="text-muted-foreground">Security deposit</dt>
              <dd className="font-medium">
                {formatMoney(s.securityDeposit)}
                <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                  Refundable, not taxed
                </span>
              </dd>
              <dt className="text-muted-foreground">Rate</dt>
              <dd className="font-medium">{Number(s.ratePct).toFixed(2)}%</dd>
              <dt className="text-muted-foreground">Due on delivery</dt>
              <dd className="font-medium">{formatMoney(s.dueTotal)}</dd>
            </dl>
            <p className="mt-4 rounded-sm bg-[#f4f1ea] px-3 py-2 text-[11px] leading-snug text-muted-foreground">
              Taxes calculated for <strong className="text-[#1a1a1a]">{data.provinceName}</strong>
              {data.province ? ` (${data.province})` : ""} — {data.taxCaption}. Monthly payment is
              taxes in.
            </p>
          </div>
        </section>

        {done ? (
          <section className="rounded-sm border border-[#008272]/40 bg-white p-5 text-sm shadow-sm">
            <p className="font-medium text-[#008272]">
              Option {data.optionNumber} is accepted
              {data.acceptedAt
                ? ` · ${new Date(data.acceptedAt).toLocaleString("en-CA")}`
                : ""}
            </p>
            <p className="mt-2 text-muted-foreground">
              Thank you. Paul Motor Leasing has this on file. You may close this window.
            </p>
          </section>
        ) : (
          <section className="space-y-3">
            <p className="text-xs text-muted-foreground">
              By clicking Accept, you are not committing to a lease, accepting credit, or being
              approved for a loan. This action does not give us permission to pull your credit
              report. You are simply confirming your choice for Option {data.optionNumber} at{" "}
              {formatMoney(s.totalPayment)} per month for {s.termMonths} months so we can move
              forward.
            </p>
            <Button className="h-12 w-full text-base" disabled={busy} onClick={() => void accept()}>
              {busy
                ? "Recording…"
                : `I accept Option ${data.optionNumber} — ${formatMoney(s.totalPayment)}/mo for ${s.termMonths} months`}
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}
