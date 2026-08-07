import { createFileRoute, Link } from "@tanstack/react-router";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { isDmsLab } from "@/lib/app-track";
import { bcStatusMessage, getBcConfig } from "@/lib/dms/bc-config";
import { BookOpen, GitBranch, Link2 } from "lucide-react";

export const Route = createFileRoute("/dms")({
  component: () => (
    <AuthGate>
      <DmsLabPage />
    </AuthGate>
  ),
});

function DmsLabPage() {
  const lab = isDmsLab();
  const bc = getBcConfig();

  return (
    <>
      <PageHeader
        title="DMS lab"
        description="Parallel track for the future dealer management system and Business Central."
      />

      {!lab ? (
        <Card className="mb-4 border-amber-500/40 bg-amber-500/10">
          <CardContent className="p-4 text-sm">
            You are on the <strong>production CRM track</strong>. DMS work should
            run on the <code className="rounded bg-muted px-1">dms</code> branch /
            lab Vercel project (<code className="rounded bg-muted px-1">VITE_APP_TRACK=dms</code>
            ). This page is only a pointer.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <GitBranch className="size-4" />
              Dual-track strategy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              CRM feedback ships on <strong>main</strong>. This lab branch receives{" "}
              <strong>main → dms</strong> merges every Monday so nothing is left behind.
            </p>
            <p>
              Docs: <code className="text-foreground">docs/BRANCHING.md</code> ·{" "}
              <code className="text-foreground">deploy/DMS_LAB.md</code>
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/help">CRM help</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" />
              Business Central
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{bcStatusMessage(bc)}</p>
            <p>
              Start with a <strong>BC sandbox</strong> company and read-only sync.
              Posting (invoices, payments) comes after sandbox QA.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Env: BC_ENABLED, BC_TENANT_ID, BC_CLIENT_ID, BC_COMPANY_ID</li>
              <li>Code stubs: <code className="text-foreground">src/lib/dms/bc-config.ts</code></li>
            </ul>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="size-4" />
              Near-term DMS backlog (lab only)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Deal journal / funding package attached to accepted leases</li>
              <li>Service RO cost & WIP (hide internal cost from techs)</li>
              <li>BC customer + item read sync</li>
              <li>First write path: first invoice or cash receipt → BC sandbox</li>
              <li>AR open items / arrears bridge (later BC collections)</li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
