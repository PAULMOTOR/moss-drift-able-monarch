import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Users,
} from "lucide-react";
import { AuthGate, PageHeader } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  deleteCalendarEvent,
  listCalendarEvents,
  upsertCalendarEvent,
} from "@/lib/crm/calendar";
import { listProfiles } from "@/lib/crm/server";
import {
  CALENDAR_DOMAINS,
  CALENDAR_EVENT_TYPES,
  calendarTypeMeta,
  type CalendarDomain,
  type CalendarEvent,
  type CalendarScope,
  type Profile,
} from "@/lib/crm/types";
import { cn, formatDateTime, toLocalInputValue } from "@/lib/utils";

export const Route = createFileRoute("/calendar")({
  component: () => (
    <AuthGate>
      <CalendarPage />
    </AuthGate>
  ),
});

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function domainClass(domain: string) {
  if (domain === "compliance") return "border-amber-300 bg-amber-50 text-amber-950";
  if (domain === "service") return "border-slate-300 bg-slate-100 text-slate-900";
  return "border-primary/30 bg-primary/10 text-primary";
}

function CalendarPage() {
  const [view, setView] = useState<"day" | "week">("week");
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [scope, setScope] = useState<CalendarScope>("mine");
  const [domain, setDomain] = useState<CalendarDomain | "all">("all");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [me, setMe] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<null | Partial<CalendarEvent> & { open: boolean }>(null);

  const range = useMemo(() => {
    if (view === "day") {
      const from = new Date(anchor);
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      return { from, to, days: [from] };
    }
    const from = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const to = addDays(from, 7);
    return { from, to, days };
  }, [anchor, view]);

  const load = useCallback(async () => {
    try {
      const [res, people] = await Promise.all([
        listCalendarEvents({
          data: {
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            scope,
            domain,
          },
        }),
        listProfiles({ data: {} }),
      ]);
      setEvents(res.events);
      setMe(res.me);
      setProfiles(people);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load calendar");
    }
  }, [range.from, range.to, scope, domain]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate(day?: Date) {
    const start = day ? new Date(day) : new Date();
    if (day) start.setHours(10, 0, 0, 0);
    else {
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() + 1);
    }
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    setEditor({
      open: true,
      title: "",
      event_type: "test_drive",
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      location: "",
      notes: "",
      participant_ids: me ? [me.id] : [],
      visibility: "team",
      status: "scheduled",
    });
  }

  function openEdit(ev: CalendarEvent) {
    setEditor({ open: true, ...ev });
  }

  const titleLabel =
    view === "day"
      ? anchor.toLocaleDateString("en-CA", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : `${range.days[0]!.toLocaleDateString("en-CA", { month: "short", day: "numeric" })} – ${range.days[6]!.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}`;

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Team appointments — sales, compliance installs, and service."
        actions={
          <Button size="sm" onClick={() => openCreate()}>
            <Plus className="size-4" />
            New event
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={() => setAnchor((a) => addDays(a, view === "day" ? -1 : -7))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const d = new Date();
              d.setHours(0, 0, 0, 0);
              setAnchor(d);
            }}
          >
            Today
          </Button>
          <Button
            size="icon"
            variant="outline"
            onClick={() => setAnchor((a) => addDays(a, view === "day" ? 1 : 7))}
          >
            <ChevronRight className="size-4" />
          </Button>
          <p className="min-w-[12rem] text-sm font-semibold">{titleLabel}</p>
          <div className="ml-auto flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={view === "day" ? "default" : "outline"}
              onClick={() => setView("day")}
            >
              Day
            </Button>
            <Button
              size="sm"
              variant={view === "week" ? "default" : "outline"}
              onClick={() => setView("week")}
            >
              Week
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: "mine", label: "Mine" },
              { id: "organize", label: "I organize" },
              { id: "invited", label: "I'm invited" },
              { id: "team", label: "Team" },
            ] as const
          ).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setScope(s.id)}
              className={cn(
                "rounded-sm border px-3 py-1.5 text-xs font-semibold transition-colors",
                scope === s.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card hover:bg-muted",
              )}
            >
              {s.label}
            </button>
          ))}
          <span className="mx-1 hidden h-6 w-px bg-border sm:inline" />
          <button
            type="button"
            onClick={() => setDomain("all")}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-xs font-semibold",
              domain === "all"
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card",
            )}
          >
            All types
          </button>
          {CALENDAR_DOMAINS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDomain(d.id)}
              className={cn(
                "rounded-sm border px-3 py-1.5 text-xs font-semibold",
                domain === d.id ? domainClass(d.id) + " ring-1 ring-offset-1" : "border-border bg-card",
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {view === "week" ? (
        <div className="grid gap-2 md:grid-cols-7">
          {range.days.map((day) => {
            const dayStart = day.getTime();
            const dayEnd = addDays(day, 1).getTime();
            const dayEvents = events.filter((e) => {
              const s = new Date(e.starts_at).getTime();
              return s >= dayStart && s < dayEnd;
            });
            const isToday = new Date().toDateString() === day.toDateString();
            return (
              <Card
                key={day.toISOString()}
                className={cn("min-h-[140px] border-border", isToday && "ring-1 ring-primary/40")}
              >
                <CardContent className="space-y-2 p-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-left"
                    onClick={() => openCreate(day)}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {day.toLocaleDateString("en-CA", { weekday: "short" })}
                    </span>
                    <span className={cn("text-sm font-bold", isToday && "text-primary")}>
                      {day.getDate()}
                    </span>
                  </button>
                  <ul className="space-y-1.5">
                    {dayEvents.map((ev) => (
                      <li key={ev.id}>
                        <button
                          type="button"
                          onClick={() => openEdit(ev)}
                          className={cn(
                            "w-full rounded-sm border px-1.5 py-1 text-left text-[11px] leading-snug",
                            domainClass(ev.domain),
                          )}
                        >
                          <span className="font-semibold">
                            {new Date(ev.starts_at).toLocaleTimeString("en-CA", {
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone: "America/Toronto",
                            })}
                          </span>{" "}
                          {ev.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-2 p-3">
            {events.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <CalendarDays className="size-8 opacity-40" />
                <p>No events in this view.</p>
                <Button size="sm" onClick={() => openCreate(anchor)}>
                  Add event
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((ev) => (
                  <li key={ev.id}>
                    <button
                      type="button"
                      onClick={() => openEdit(ev)}
                      className="flex w-full flex-col gap-1 px-2 py-3 text-left hover:bg-muted/50 sm:flex-row sm:items-start sm:gap-4"
                    >
                      <div className="w-28 shrink-0 text-sm font-semibold tabular-nums">
                        {new Date(ev.starts_at).toLocaleTimeString("en-CA", {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: "America/Toronto",
                        })}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                              domainClass(ev.domain),
                            )}
                          >
                            {calendarTypeMeta(ev.event_type).label}
                          </span>
                          <p className="font-semibold">{ev.title}</p>
                        </div>
                        {ev.location ? (
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="size-3" />
                            {ev.location}
                          </p>
                        ) : null}
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="size-3" />
                          {ev.organizer_name || "—"}
                          {ev.participant_names && ev.participant_names.length > 1
                            ? ` · +${ev.participant_names.length - 1}`
                            : ""}
                          {ev.lead_name ? ` · ${ev.lead_name}` : ""}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <EventEditor
        open={!!editor?.open}
        initial={editor}
        profiles={profiles}
        me={me}
        busy={busy}
        setBusy={setBusy}
        onClose={() => setEditor(null)}
        onSaved={async () => {
          setEditor(null);
          await load();
        }}
      />
    </>
  );
}

function EventEditor({
  open,
  initial,
  profiles,
  me,
  busy,
  setBusy,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: (Partial<CalendarEvent> & { open?: boolean }) | null;
  profiles: Profile[];
  me: Profile | null;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [eventType, setEventType] = useState("test_drive");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");

  useEffect(() => {
    if (!open || !initial) return;
    setTitle(initial.title || "");
    setEventType(initial.event_type || "test_drive");
    setStarts(
      initial.starts_at
        ? toLocalInputValue(new Date(initial.starts_at))
        : toLocalInputValue(new Date()),
    );
    setEnds(
      initial.ends_at
        ? toLocalInputValue(new Date(initial.ends_at))
        : toLocalInputValue(new Date(Date.now() + 3600000)),
    );
    setLocation(initial.location || "");
    setNotes(initial.notes || "");
    setParticipants(
      initial.participant_ids?.length
        ? initial.participant_ids
        : me
          ? [me.id]
          : [],
    );
    setLeadId(initial.lead_id || "");
  }, [open, initial, me]);

  const canDelete = Boolean(
    initial?.id &&
      me &&
      (initial.organizer_id === me.id || me.role === "admin" || me.role === "gsm"),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Edit event" : "New event"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Title</Label>
            <Input className="mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALENDAR_EVENT_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label} · {t.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label>Starts</Label>
              <Input
                type="datetime-local"
                className="mt-1"
                value={starts}
                onChange={(e) => setStarts(e.target.value)}
              />
            </div>
            <div>
              <Label>Ends</Label>
              <Input
                type="datetime-local"
                className="mt-1"
                value={ends}
                onChange={(e) => setEnds(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Location / supplier</Label>
            <Input
              className="mt-1"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Lot, client, or install shop"
            />
          </div>
          <div>
            <Label>Participants (who is involved)</Label>
            <ul className="mt-2 max-h-36 space-y-1.5 overflow-y-auto rounded-sm border border-border p-2">
              {profiles
                .filter((p) => p.active)
                .map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={participants.includes(p.id)}
                        onCheckedChange={(c) => {
                          setParticipants((prev) =>
                            c === true
                              ? [...prev, p.id]
                              : prev.filter((id) => id !== p.id),
                          );
                        }}
                      />
                      {p.name}
                      <span className="text-xs text-muted-foreground">{p.role}</span>
                    </label>
                  </li>
                ))}
            </ul>
          </div>
          <div>
            <Label>Lead ID (optional)</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              placeholder="Paste lead id to link the deal"
            />
            {initial?.lead_id && initial.lead_name ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Linked:{" "}
                <Link
                  to="/leads/$leadId"
                  params={{ leadId: initial.lead_id }}
                  search={{ tab: "lead" }}
                  className="text-primary underline"
                >
                  {initial.lead_name}
                </Link>
              </p>
            ) : null}
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              className="mt-1"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div>
            {canDelete ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (!initial?.id) return;
                  if (!window.confirm("Delete this event?")) return;
                  setBusy(true);
                  try {
                    await deleteCalendarEvent({ data: { id: initial.id } });
                    toast.success("Event deleted");
                    await onSaved();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Delete failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy || !title.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await upsertCalendarEvent({
                    data: {
                      id: initial?.id,
                      title,
                      event_type: eventType,
                      starts_at: new Date(starts).toISOString(),
                      ends_at: new Date(ends).toISOString(),
                      location: location || null,
                      notes: notes || null,
                      participant_ids: participants,
                      lead_id: leadId.trim() || null,
                    },
                  });
                  toast.success(initial?.id ? "Event updated" : "Event created");
                  await onSaved();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Save failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
        {initial?.starts_at ? (
          <p className="text-[11px] text-muted-foreground">
            Saved time: {formatDateTime(initial.starts_at)}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
