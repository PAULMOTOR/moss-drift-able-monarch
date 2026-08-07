import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Circle, ListTodo, Plus, Trash2 } from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteTask,
  listTasks,
  setTaskStatus,
  upsertTask,
  torontoDateKey,
} from "@/lib/crm/tasks";
import { TASK_TYPES, type CrmTask, type TaskListView } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tasks")({
  component: () => (
    <AuthGate>
      <TasksPage />
    </AuthGate>
  ),
});

function TasksPage() {
  const [view, setView] = useState<TaskListView>("today");
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [today, setToday] = useState(torontoDateKey());
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState("");
  const [taskType, setTaskType] = useState("call");
  const [dueDate, setDueDate] = useState(torontoDateKey());
  const [notes, setNotes] = useState("");
  const [leadId, setLeadId] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await listTasks({ data: { view } });
      setTasks(res.tasks);
      setToday(res.today);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load tasks");
    }
  }, [view]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleDone(task: CrmTask) {
    setBusy(true);
    try {
      const next = task.status === "done" ? "open" : "done";
      await setTaskStatus({ data: { id: task.id, status: next } });
      if (next === "done") toast.success("Task completed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  const views: { id: TaskListView; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "overdue", label: "Overdue" },
    { id: "upcoming", label: "Upcoming" },
    { id: "completed", label: "Completed" },
  ];

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Your calls, emails, and follow-ups for the day. Complete them to clear the list."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setTitle("");
              setTaskType("call");
              setDueDate(today);
              setNotes("");
              setLeadId("");
              setShowNew(true);
            }}
          >
            <Plus className="size-4" />
            New task
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-sm font-semibold transition-colors",
              view === v.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:bg-muted",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center text-sm text-muted-foreground">
              <ListTodo className="size-8 opacity-40" />
              <p>
                {view === "completed"
                  ? "No completed tasks in the last 30 days."
                  : view === "overdue"
                    ? "Nothing overdue — nice work."
                    : "No tasks here. Add a call or follow-up."}
              </p>
              {view !== "completed" ? (
                <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                  Add task
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {tasks.map((t) => {
                const typeLabel =
                  TASK_TYPES.find((x) => x.id === t.task_type)?.label || t.task_type;
                const done = t.status === "done";
                return (
                  <li
                    key={t.id}
                    className={cn(
                      "flex items-start gap-3 px-3 py-3 sm:px-4",
                      done && "bg-muted/30 opacity-80",
                    )}
                  >
                    <button
                      type="button"
                      className="mt-0.5 shrink-0 text-primary"
                      disabled={busy}
                      onClick={() => void toggleDone(t)}
                      aria-label={done ? "Reopen task" : "Complete task"}
                    >
                      {done ? (
                        <CheckCircle2 className="size-5" />
                      ) : (
                        <Circle className="size-5 text-muted-foreground" />
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm font-medium", done && "line-through")}>
                        {t.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {typeLabel}
                        {t.due_date ? ` · due ${t.due_date}` : ""}
                        {t.lead_name && t.lead_id ? (
                          <>
                            {" · "}
                            <Link
                              to="/leads/$leadId"
                              params={{ leadId: t.lead_id }}
                              search={{ tab: "lead" }}
                              className="text-primary underline"
                            >
                              {t.lead_name}
                            </Link>
                          </>
                        ) : null}
                      </p>
                      {t.notes ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t.notes}</p>
                      ) : null}
                    </div>
                    {!done ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={busy}
                        onClick={async () => {
                          if (!window.confirm("Delete this task?")) return;
                          setBusy(true);
                          try {
                            await deleteTask({ data: { id: t.id } });
                            await load();
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Delete failed");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>What do you need to do?</Label>
              <Input
                className="mt-1"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Call client about quote…"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>Type</Label>
                <Select value={taskType} onValueChange={setTaskType}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_TYPES.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Due date</Label>
                <Input
                  type="date"
                  className="mt-1"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label>Lead ID (optional)</Label>
              <Input
                className="mt-1 font-mono text-xs"
                value={leadId}
                onChange={(e) => setLeadId(e.target.value)}
                placeholder="Link to a deal"
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                className="mt-1"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNew(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !title.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await upsertTask({
                    data: {
                      title,
                      task_type: taskType,
                      due_date: dueDate,
                      notes: notes || null,
                      lead_id: leadId.trim() || null,
                    },
                  });
                  toast.success("Task added");
                  setShowNew(false);
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Save failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
