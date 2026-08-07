import { isDmsLab } from "@/lib/app-track";
import { FlaskConical } from "lucide-react";

/** Persistent strip on the DMS lab deploy so nobody mistakes it for production CRM. */
export function LabBanner() {
  if (!isDmsLab()) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-amber-700/40 bg-amber-500 px-3 py-1.5 text-center text-xs font-bold tracking-wide text-amber-950"
    >
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>
        DMS LAB — not production · safe to experiment · CRM updates merge in from{" "}
        <code className="rounded bg-amber-600/30 px-1">main</code> weekly
      </span>
    </div>
  );
}
