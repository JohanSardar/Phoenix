import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TraceEvent, LedgerEntry, WorkdirSnapshot } from "@phoenix/formats";
import { checked } from "./io.ts";
import { BlobStore, type CaptureMetadata } from "./capture.ts";

export interface StoreIssue {
  kind: "torn" | "corruption" | "sequence-hole" | "drop" | "unclosed" | "partial" | "snapshot" | "unattributed" | "approximate-order";
  file?: string;
  line?: number;
  event?: string;
  stream?: string;
  detail: string;
}

export class StoreCorruption extends Error {
  issues: StoreIssue[];
  constructor(issues: StoreIssue[]) {
    super("Store corruption: " + issues.filter((i) => i.kind === "corruption").map((i) => `${i.file}:${i.line ?? ""} ${i.detail}`).join("; "));
    this.issues = issues;
  }
}

export async function readJsonLines<T>(path: string, parse: (value: unknown) => T): Promise<{ values: T[]; issues: StoreIssue[] }> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const values: T[] = [], issues: StoreIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    let value: unknown;
    try { value = JSON.parse(lines[i]!); }
    catch {
      issues.push({ kind: i === lines.length - 1 ? "torn" : "corruption", file: path, line: i + 1, detail: "Invalid JSON line" });
      continue;
    }
    try { values.push(parse(value)); }
    catch (error) { issues.push({ kind: "corruption", file: path, line: i + 1, detail: (error as Error).message }); }
  }
  if (issues.some((i) => i.kind === "corruption")) throw new StoreCorruption(issues);
  return { values, issues };
}

export interface RunRef { capture: string; task: string }
export interface RunSummary extends RunRef { events: number; incomplete: boolean }
export interface ReaderOptions {
  modelToolUses?: (event: TraceEvent) => readonly string[];
  toolUseId?: (event: TraceEvent) => string | undefined;
  taskMarker?: (event: TraceEvent) => "start" | "end" | undefined;
}
export interface CaptureView {
  metadata: CaptureMetadata;
  issues: StoreIssue[];
  unattributed: TraceEvent[];
  runs(): RunSummary[];
  events(run: RunRef, from?: string): AsyncIterable<TraceEvent>;
  allEvents: readonly TraceEvent[];
  snapshots: ReadonlyMap<string, WorkdirSnapshot>;
  coverage: readonly unknown[];
}

const eventId = (e: TraceEvent) => e.id ?? `${e.stream}:${e.seq}`;
const tie = (a: TraceEvent, b: TraceEvent) => a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.seq - b.seq;
const compareMono = (a: TraceEvent, b: TraceEvent) => {
  const x = BigInt(a.ts.mono!), y = BigInt(b.ts.mono!);
  return x < y ? -1 : x > y ? 1 : tie(a, b);
};
const optionalNames = async (dir: string): Promise<string[]> => readdir(dir).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return []; throw error;
});

export async function readCapture(root: string, options: ReaderOptions = {}): Promise<CaptureView> {
  const metadata = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as CaptureMetadata;
  if (typeof metadata.capture !== "string") throw new Error("Invalid capture metadata");
  const issues: StoreIssue[] = [], events: TraceEvent[] = [];
  const files = [
    ...(await optionalNames(join(root, "seg"))).filter((n) => n.endsWith(".jsonl")).sort().map((n) => `seg/${n}`),
    ...(await optionalNames(join(root, "import"))).filter((n) => n.endsWith(".jsonl")).sort().map((n) => `import/${n}`),
    ...(await optionalNames(root)).filter((n) => n === "notes.jsonl"),
  ];
  for (const file of files) {
    const result = await readJsonLines(join(root, file), (value) => checked("trace", value));
    issues.push(...result.issues);
    for (const event of result.values) {
      if (event.capture !== metadata.capture) throw new StoreCorruption([{ kind: "corruption", file, detail: "Event belongs to another capture" }]);
      events.push(event);
      if (event.dropped) issues.push({ kind: "drop", event: eventId(event), stream: event.stream, detail: JSON.stringify(event.dropped) });
      if (event.partial) issues.push({ kind: "partial", event: eventId(event), stream: event.stream, detail: "Incomplete message" });
    }
    if (file.startsWith("seg/") && result.values.at(-1)?.kind !== "close")
      issues.push({ kind: "unclosed", file, detail: "Segment has no close; unknown tail" });
  }
  const byStream = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const list = byStream.get(event.stream) ?? [];
    list.push(event); byStream.set(event.stream, list);
  }
  for (const [stream, list] of byStream) {
    list.sort((a, b) => a.seq - b.seq);
    let previous = -1;
    for (const event of list) {
      if (event.seq > previous + 1) issues.push({ kind: "sequence-hole", stream, event: eventId(event), detail: `${previous + 1}..${event.seq - 1}` });
      if (event.seq === previous) throw new StoreCorruption([{ kind: "corruption", stream, detail: `Duplicate sequence ${event.seq}` }]);
      previous = event.seq;
    }
  }
  const spools = await new BlobStore(root).recoverSpools();
  for (const { event, spool } of spools) {
    const found = events.findIndex((e) => eventId(e) === eventId(event));
    if (found >= 0 && events[found]!.body && !events[found]!.partial) continue;
    if (found < 0) events.push(event);
    else if (!events[found]!.body) events[found] = { ...events[found]!, body: event.body, chunks: event.chunks, partial: true };
    issues.push({ kind: "partial", file: `blobs/tmp/${spool}`, event: eventId(event), detail: "Orphaned or still-open spool attached as partial body" });
  }
  const monotonic = events.filter((e) => e.ts.mono !== undefined).sort(compareMono);
  const wall = events.filter((e) => e.ts.mono === undefined).sort((a, b) => Date.parse(a.ts.wall) - Date.parse(b.ts.wall) || tie(a, b));
  const ordered: TraceEvent[] = [];
  let wi = 0;
  for (const event of monotonic) {
    while (wi < wall.length && Date.parse(wall[wi]!.ts.wall) <= Date.parse(event.ts.wall)) ordered.push(wall[wi++]!);
    ordered.push(event);
  }
  ordered.push(...wall.slice(wi));
  if (wall.length && monotonic.length) issues.push({ kind: "approximate-order", detail: "Cross-clock order uses wall time; tap order remains monotonic" });
  const snapshots = new Map<string, WorkdirSnapshot>();
  for (const file of await optionalNames(join(root, "workdir"))) {
    if (!file.endsWith(".json")) continue;
    const snapshot = checked("workdir", JSON.parse(await readFile(join(root, "workdir", file), "utf8")));
    snapshots.set(file.slice(0, -5), snapshot);
    if (snapshot.incomplete || snapshot.unread.length)
      issues.push({ kind: "snapshot", file: `workdir/${file}`, detail: `Incomplete snapshot: ${snapshot.unread.join(", ")}` });
  }
  const marker = options.taskMarker ?? ((e: TraceEvent) => e.kind === "task" ? e.op === "start" ? "start" : e.op === "end" ? "end" : undefined : undefined);
  const hasTasks = metadata.task_key !== undefined || ordered.some((e) => e.task !== undefined || e.kind === "task");
  const openTasks = new Set<string>();
  const assigned = new Map<TraceEvent, string>();
  for (const event of ordered) {
    const action = marker(event);
    if (action === "start" && event.task !== undefined) openTasks.add(event.task);
    const task = event.task ?? (!hasTasks ? "" : openTasks.size === 1 ? [...openTasks][0] : undefined);
    if (task !== undefined) assigned.set(event, task);
    if (action === "end" && event.task !== undefined) openTasks.delete(event.task);
  }
  const modelTasks = new Map<string, Set<string>>();
  for (const event of ordered) {
    const task = assigned.get(event);
    if (task === undefined) continue;
    for (const id of options.modelToolUses?.(event) ?? []) {
      const tasks = modelTasks.get(id) ?? new Set(); tasks.add(task); modelTasks.set(id, tasks);
    }
  }
  const unattributed: TraceEvent[] = [];
  for (const event of ordered) {
    if (event.task === undefined) {
      const id = options.toolUseId?.(event), tasks = id === undefined ? undefined : modelTasks.get(id);
      if (tasks?.size === 1) assigned.set(event, [...tasks][0]!);
    }
    if (!assigned.has(event)) {
      unattributed.push(event);
      issues.push({ kind: "unattributed", event: eventId(event), detail: "No own task, unambiguous model pairing or sole open task" });
    }
  }
  const summaries = new Map<string, RunSummary>();
  for (const event of ordered) {
    const task = assigned.get(event);
    if (task === undefined) continue;
    const run = summaries.get(task) ?? { capture: metadata.capture, task, events: 0, incomplete: false };
    run.events++;
    run.incomplete ||= openTasks.has(task) || issues.some((i) => ["unclosed", "snapshot", "torn", "sequence-hole", "drop", "partial"].includes(i.kind) && (!i.event || i.event === eventId(event)));
    summaries.set(task, run);
  }
  const coverage = (await optionalNames(root)).includes("coverage.jsonl")
    ? await readJsonLines(join(root, "coverage.jsonl"), (value) => value) : { values: [], issues: [] };
  issues.push(...coverage.issues);
  return {
    metadata, issues, unattributed, snapshots, coverage: coverage.values, allEvents: ordered,
    runs: () => [...summaries.values()],
    async *events(run, from) {
      if (run.capture !== metadata.capture) throw new Error("Run belongs to another capture");
      const selected = ordered.filter((e) => assigned.get(e) === run.task);
      const start = from === undefined ? 0 : selected.findIndex((e) => eventId(e) === from);
      if (start < 0) throw new Error(`Event not found in run: ${from}`);
      for (const event of selected.slice(start)) yield event;
    },
  };
}

export async function readApprovalsLedger(path: string): Promise<{ entries: LedgerEntry[]; issues: StoreIssue[] }> {
  const result = await readJsonLines(path, (value) => checked("ledger", value)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { values: [], issues: [] }; throw error;
  });
  return { entries: result.values, issues: result.issues };
}
