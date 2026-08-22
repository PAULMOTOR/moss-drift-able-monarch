import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Calculator,
  Car,
  CheckCircle2,
  Columns3,
  FolderOpen,
  HelpCircle,
  Mail,
  PauseCircle,
  Share2,
  Zap,
} from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/help")({
  component: () => (
    <AuthGate>
      <HelpPage />
    </AuthGate>
  ),
});

const sections = [
  { id: "start", label: "Quick start" },
  { id: "leads", label: "Leads & pipeline" },
  { id: "email", label: "Email import" },
  { id: "quote", label: "Lease quotes" },
  { id: "drive", label: "Push to Drive" },
  { id: "tips", label: "Best practices" },
] as const;

function HelpPage() {
  return (
    <>
      <PageHeader
        title="Help & user guide"
        description="How sales reps get the most out of the Paul Motor Co. CRM — leads, pipeline, quotes, and Drive."
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-sm border border-border bg-card px-3 py-1.5 text-xs font-semibold text-primary hover:bg-muted"
          >
            {s.label}
          </a>
        ))}
      </div>

      <div className="mx-auto max-w-3xl space-y-6 pb-12">
        <Section id="start" icon={Zap} title="Quick start (daily flow)">
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-foreground">
            <li>
              Open <strong>New Lead</strong> for walk-ins and phone calls — fill name, phone, source, vehicle interest, assign yourself, save.
            </li>
            <li>
              Check <strong>Home</strong> / <strong>Leads</strong> for email leads auto-imported to{" "}
              <code className="rounded bg-muted px-1">client@paulmotorcompany.com</code> (CarGurus, AutoTrader, TAdvantage, brokers).
            </li>
            <li>
              Open the lead → confirm type (Inventory / Lease / General), assign if needed, add a short note after every contact.
            </li>
            <li>
              Move the card on <strong>Pipeline</strong> as you progress (or use the stage dropdown on the lead).
            </li>
            <li>
              Build numbers on <strong>Lease quote</strong> → <strong>Share quote</strong> when you send options to the customer (sets{" "}
              <em>Quote Sent</em>).
            </li>
            <li>
              When the customer picks an option: <strong>Quote Accepted</strong> → then on the lead{" "}
              <strong>Push to Drive</strong> for the deal folder + accepted PDF.
            </li>
          </ol>
        </Section>

        <Section id="leads" icon={Columns3} title="Leads & pipeline">
          <ul className="space-y-2 text-sm leading-relaxed">
            <li>
              <strong>Three pipelines</strong> (switch boards at the top of Pipeline):
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  <strong>Lead</strong> — New → Contacted → Paused → Quote Sent → Lease Accepted → Lost
                </li>
                <li>
                  <strong>Credit</strong> — App sent → received → IDs → underwriting → GSM queue → Approved / Declined
                </li>
                <li>
                  <strong>Compliance</strong> — after GSM/Admin approval: funding package checklist → Closed Won
                </li>
              </ul>
            </li>
            <li>
              <strong>Deal tabs</strong> on every lead: <em>Lead</em> (early contact & quotes),{" "}
              <em>Credit</em> (underwriting), <em>Approval</em> (GSM/Admin recap),{" "}
              <em>Compliance</em> (signed lease, void check, insurance, trackers, DOD, liens, bank funding, reg/title, 2nd key).
              Opening a pipeline card jumps to the right tab.
            </li>
            <li>
              <strong>Paused:</strong> schedule a call-back appointment on the lead. Automatic weekday/daily reminders skip paused leads until the date.
            </li>
            <li>
              <strong>Quote Sent</strong> only when you:
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Click <strong>Share quote</strong> on the lease quote screen, or</li>
                <li>Choose the stage in the dropdown, or</li>
                <li>Drag the card on Pipeline</li>
              </ul>
              Draft saves do <em>not</em> change the stage. Accepting an option moves the lead to{" "}
              <em>Lease Accepted</em>.
            </li>
            <li>
              <strong>Lead types:</strong> Inventory (stock units), Lease (broker / quote request), General Interest (TAdvantage contact forms).
            </li>
            <li>
              Always set <strong>source</strong> (Phone, Walk-in, Email, Broker, CarGurus, AutoTrader, etc.) — Data analysis depends on it.
            </li>
            <li>
              Delete false leads permanently from the lead page (admin/rep) instead of marking Closed Lost if they would skew ratios.
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <LinkChip to="/capture" label="New Lead" />
            <LinkChip to="/pipeline" label="Pipeline" />
            <LinkChip to="/leads" label="All leads" />
          </div>
        </Section>

        <Section id="email" icon={Mail} title="Email leads (automatic)">
          <p className="text-sm leading-relaxed text-muted-foreground">
            The CRM reads <strong>client@paulmotorcompany.com</strong> on a schedule and creates leads when it recognizes known sources.
          </p>
          <ul className="mt-2 space-y-2 text-sm leading-relaxed">
            <li>
              <strong>CarGurus / AutoTrader</strong> → Inventory leads (stock / vehicle from the message when possible).
            </li>
            <li>
              <strong>TAdvantage</strong> financing / leasing forms → Lease type; general contact → General Interest.
            </li>
            <li>
              Duplicates for the same person + same vehicle are avoided when possible — still scan for near-duplicates before working a new card.
            </li>
            <li>
              You can still paste a full email into the capture / parse flow if something was missed.
            </li>
          </ul>
        </Section>

        <Section id="quote" icon={Calculator} title="Lease quotes">
          <ul className="space-y-2 text-sm leading-relaxed">
            <li>
              Open from the lead (<strong>Lease quote</strong>) so client + vehicle prefill. Or open{" "}
              <Link to="/quote" className="font-semibold text-primary underline-offset-2 hover:underline">
                Lease quote
              </Link>{" "}
              and link a lead.
            </li>
            <li>
              <strong>Option 1</strong> is your working column. Options 2–3 start empty — use <strong>Copy from left</strong>, then tweak term/rate/residual.
            </li>
            <li>
              <strong>Origin (dealer / broker):</strong> pick Ferrari of Alberta, Marianetti, Lease Sniper, or add a partner on New Lead. Search finds them. Client emails stay partner-safe.
            </li>
            <li>
              <strong>Trade-in tax credit (individuals):</strong> tax is calculated on (price − cash down − trade), but the payment is calculated on (price − cash down − trade + payout). Businesses get no tax credit. <strong>Financed</strong> payouts already include tax; <strong>leased</strong> buyouts are pre-tax so we fund buyout + tax.
            </li>
            <li>
              <strong>Cash down % / Residual %</strong> stay in sync with the dollar fields (based on price + profit). Cash down is taxed and reduces the loan balance; <strong>Security deposit</strong> is refundable, not taxed, and does not reduce the balance.
            </li>
            <li>
              <strong>Yield %</strong> is for <em>you</em> only (interest + handling). Customers never see it on shared PDFs.
            </li>
            <li>
              Click <strong>Lease quote</strong> on a lead to land on the latest saved quote — no extra click.
            </li>
            <li>
              <strong>Update draft</strong> — saves without changing stage.
            </li>
            <li>
              <strong>Share quote</strong> — opens a PDF of the options and sets the lead to <strong>Quote Sent</strong>. Allow pop-ups if the PDF tab is blocked.
            </li>
            <li>
              <strong>Staff accept</strong> locks an option in-house. <strong>Email lessee to accept</strong> sends a token link: they confirm that exact option (payment, term, cash down). We store time + IP. GSM <strong>Approve</strong> always emails the rep + Chris; referring dealer is on by default; lessee is off unless you check it. Add a one-line “what’s next.”
            </li>
            <li>
              <strong>Back to lead</strong> (top and bottom of the quote screen) always saves a draft first so you don’t lose work.
            </li>
          </ul>
        </Section>

        <Section id="drive" icon={FolderOpen} title="Push to Drive (deal folder)">
          <ul className="space-y-2 text-sm leading-relaxed">
            <li>
              On the lead, after an option is accepted, click <strong>Push to Drive</strong>.
            </li>
            <li>
              Creates the deal folder under:
              <code className="mt-1 block rounded-sm bg-muted px-2 py-1.5 text-xs">
                … / 0. SALES - ALL / 2026 / August 2026 / YEAR Make Model - Lessee (Guarantors)
              </code>
              and uploads the <strong>full lease package</strong>:
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>Accepted quote PDF (selected option only)</li>
                <li>Lease contract + first invoice (when generated after approval)</li>
                <li>Customer IDs (DL front/back, second ID)</li>
                <li>Credit docs (NOA/payslips, bank statements, Equifax, etc.)</li>
                <li>Other quote files attached on the lead</li>
                <li>Inventory vehicle photo when available</li>
              </ul>
            </li>
            <li>
              Re-running <strong>Push to Drive</strong> / <strong>Update Drive package</strong>{" "}
              replaces the same canonical file names with the latest CRM version (e.g.{" "}
              <code className="rounded bg-muted px-1">02-Lease-Contract.pdf</code>). Google Drive
              keeps prior versions in each file’s version history — you won’t get a pile of
              “contract v2 / v3” copies. Confirm when the deal folder already exists.
            </li>
            <li>
              Requires Google Drive access for <code className="rounded bg-muted px-1">client@</code>. If you see “File not found”, ask an admin to re-check Drive sharing.
            </li>
            <li>
              Stage moves to <strong>Ready for Business Central</strong> when Push succeeds. Activity log lists every file uploaded.
            </li>
          </ul>
        </Section>

        <Section id="tips" icon={CheckCircle2} title="Best practices">
          <ul className="space-y-2 text-sm leading-relaxed">
            <li>
              <strong>Speed on the floor:</strong> use New Lead first; polish details after. Capture phone + source every time.
            </li>
            <li>
              <strong>Same-day contact:</strong> unworked New leads appear in one email at <strong>9:00 AM</strong> and another at <strong>2:00 PM</strong> on weekdays (Toronto) listing all of your uncontacted leads. After <strong>3 days</strong> still New, GSM and Admins get a single intervention digest. Call or mark Contacted promptly.
            </li>
            <li>
              <strong>One owner:</strong> always assign the lead so reminders and reporting hit the right rep.
            </li>
            <li>
              <strong>Calendar:</strong> team appointments (test drive, delivery, anti-theft install, repair, detailing). Use filters Mine / I organize / Invited / Team and Sales · Compliance · Service.
            </li>
            <li>
              <strong>Tasks:</strong> personal calls and follow-ups by day — complete them to clear the list. Link a task to a lead when it belongs to a deal.
            </li>
            <li>
              <strong>Notes after every touch:</strong> date, channel, next step — history lives on the lead for the whole team.
            </li>
            <li>
              <strong>Google reviews:</strong> track Not requested / Requested / Received on the lead after delivery.
            </li>
            <li>
              <strong>Quotes:</strong> Share when the customer sees numbers; Accept when they choose; Push to Drive only for real deals.
            </li>
            <li>
              <strong>Pause</strong> instead of ignoring — set the call-back so the system doesn’t nag you on parked deals.
            </li>
            <li>
              Prefer the CRM phone/tablet on the floor — layout is mobile-first.
            </li>
          </ul>
          <div className="mt-4 rounded-sm border border-primary/30 bg-primary/5 p-3 text-sm">
            <p className="font-semibold text-primary">Need admin help?</p>
            <p className="mt-1 text-muted-foreground">
              Users, passwords, Gmail import, Resend email, and Drive setup are under{" "}
              <strong>Admin</strong> (Jeremy / Guillaume). Reps: ask an admin for account changes.
            </p>
          </div>
        </Section>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Car className="size-4 text-primary" />
              Shortcut map
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <Shortcut icon={Zap} title="New Lead" body="Walk-in / phone capture" to="/capture" />
            <Shortcut icon={Columns3} title="Pipeline" body="Drag stages & filter by rep" to="/pipeline" />
            <Shortcut icon={Calculator} title="Lease quote" body="Calculate, share PDF, accept" to="/quote" />
            <Shortcut icon={Share2} title="Share quote" body="Customer PDF + Quote Sent stage" to="/quote" />
            <Shortcut icon={PauseCircle} title="Pause" body="Schedule follow-up, mute auto-reminders" to="/leads" />
            <Shortcut icon={FolderOpen} title="Push to Drive" body="Deal folder + accepted PDF" to="/leads" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Section({
  id,
  icon: Icon,
  title,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-20">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-lg">
          <span className="flex size-8 items-center justify-center rounded-sm bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-foreground">{children}</CardContent>
    </Card>
  );
}

function LinkChip({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center rounded-sm border border-border bg-background px-2.5 py-1 text-xs font-semibold text-primary hover:bg-muted"
    >
      {label} →
    </Link>
  );
}

function Shortcut({
  icon: Icon,
  title,
  body,
  to,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="flex gap-2 rounded-sm border border-border px-3 py-2 transition-colors hover:bg-muted/60"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground">{body}</span>
      </span>
    </Link>
  );
}
