import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listTestDrives, updateTestDrive } from "@/lib/crm/server";
import { DRIVE_STATUSES, type TestDrive } from "@/lib/crm/types";
import { formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/test-drives")({
  component: () => (
    <AuthGate>
      <TestDrivesPage />
    </AuthGate>
  ),
});

function TestDrivesPage() {
  const [drives, setDrives] = useState<TestDrive[]>([]);
  const update = useServerFn(updateTestDrive);

  async function load() {
    setDrives(await listTestDrives());
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        title="Test drives"
        description="Schedule from a lead profile. Update status after the appointment."
      />

      <div className="space-y-3">
        {drives.map((d) => (
          <Card key={d.id}>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Link
                  to="/leads/$leadId"
                  params={{ leadId: d.lead_id }}
                  className="font-medium hover:text-primary"
                >
                  {d.lead_name || "Lead"}
                </Link>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(d.scheduled_at)} · {d.duration_minutes} min
                </p>
                <p className="text-sm">{d.vehicle_label || "Vehicle TBD"}</p>
                {d.notes ? <p className="text-xs text-muted-foreground">{d.notes}</p> : null}
              </div>
              <Select
                value={d.status}
                onValueChange={async (v) => {
                  try {
                    await update({ data: { id: d.id, status: v } });
                    toast.success("Status updated");
                    await load();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  }
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DRIVE_STATUSES.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        ))}
        {drives.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No test drives yet. Book one from a lead profile.
          </p>
        ) : null}
      </div>
    </>
  );
}
