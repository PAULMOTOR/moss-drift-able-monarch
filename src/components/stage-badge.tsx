import { Badge } from "@/components/ui/badge";
import { stageLabel, type StageId } from "@/lib/crm/types";

const map: Record<StageId, "new" | "contacted" | "qualified" | "proposal" | "negotiation" | "won" | "lost"> = {
  new: "new",
  contacted: "contacted",
  test_drive: "qualified",
  quote_sent: "proposal",
  ready_bc: "negotiation",
  won: "won",
  lost: "lost",
};

export function StageBadge({ stage }: { stage: string }) {
  const key = (stage in map ? stage : "new") as StageId;
  return <Badge variant={map[key]}>{stageLabel(key)}</Badge>;
}
