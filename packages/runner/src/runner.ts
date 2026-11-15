import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startEngine, type Engine, type EngineOptions } from "@phoenix/engine";
import { ContainerSandbox, writeClockFile, type Sandbox, type SandboxProcess } from "@phoenix/sandbox";
import { compareBaseline, customCheckHost, evaluateCheck, momentVerdict, sampleVerdict } from "@phoenix/checks";
import { fidelityReport, weakestTier, type FidelityContext, type FidelityReport } from "@phoenix/fidelity";
import { BlobStore, bundleApproval, digest, readApprovalsLedger, readCapture, readMomentBundle, type MomentBundle } from "@phoenix/store";
import type { ReplayResult, TraceEvent } from "@phoenix/formats";
import { bundleEvidence, canonical, checked, claim, eventId, hydrate, load, optional, save } from "./files.ts";
import { materialize, treeDigest } from "./materialize.ts";
import { resolvePlan, type ReplayRequest, type ResolvedPlan } from "./plan.ts";

type Sample = ReplayResult["samples"][number];
type Attempt = Sample["attempts"][number] & { container?: string; recovered?: boolean; fresh_after_drift?: boolean };
type SampleState = Omit<Sample, "attempts"> & { attempts: Attempt[]; complete: boolean };
export interface ReplayStatus {
  id: string;
  state: "pending" | "running" | "interrupted" | "finished";
  samples: SampleState[];
  result?: ReplayResult;
  error?: string;
}

export interface RunnerOptions {
  root: string;
  ledger: string;
  concurrency?: number;
  sandbox?: Sandbox;
}

const execute = promisify(execFile);
const body = async (event: TraceEvent): Promise<Uint8Array> => Buffer.from(event.body && "inline" in event.body ? event.body.inline : "");

async function sampleTrace(root: string): Promise<TraceEvent[]> {
  try {
    const view = await readCapture(root);
    const blobs = new BlobStore(root);
    return await Promise.all(view.allEvents.map(async event => event.body && "blob" in event.body ? { ...event, body: { ...event.body, inline: Buffer.from(await blobs.get(event.body.blob)).toString("utf8") } } : event));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export class Runner {
  readonly #options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.#options = options;
    if (!Number.isInteger(options.concurrency ?? 2) || (options.concurrency ?? 2) < 1) throw new Error("Invalid runner concurrency");
  }

  directory(id: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("Invalid Replay id");
    return join(this.#options.root, "replays", id.slice(7));
  }

  async plan(request: ReplayRequest): Promise<string> {
    const release = await claim(join(this.#options.root, "resolve.lock"));
    try { return (await resolvePlan(this.#options.root, this.#options.ledger, request)).id; }
    finally { await release(); }
  }

  async replay(request: ReplayRequest): Promise<string> {
    const id = await this.plan(request);
    await this.resume(id);
    return id;
  }

  async status(id: string): Promise<ReplayStatus> {
    const directory = this.directory(id);
    const plan = await load<ResolvedPlan>(join(directory, "plan.json"));
    if (digest(canonical(plan)) !== id) throw new Error("Plan hash mismatch");
    return await optional<ReplayStatus>(join(directory, "journal.json")) ?? { id, state: "pending", samples: [] };
  }

  async resume(id: string): Promise<ReplayResult> {
    const directory = this.directory(id);
    const release = await claim(join(directory, "run.lock"));
    try {
      const status = await this.status(id);
      if (status.state === "finished" && status.result) return status.result;
      const plan = checked("plan", await load<ResolvedPlan>(join(directory, "plan.json"))) as ResolvedPlan;
      const bundle = await readMomentBundle(join(directory, "inputs/bundle"));
      if (bundle.lockHash !== plan.bundle || bundle.lock.check !== plan.check) throw new Error("Resolved bundle changed");
      const approval = bundleApproval(bundle, (await readApprovalsLedger(this.#options.ledger)).entries);
      for (const [name, hash] of [["base", plan.base_tree], ["candidate", plan.candidate_tree]] as const) if (await treeDigest(join(directory, "inputs", name)) !== hash) throw new Error("Resolved tree changed");
      let baseline: ReplayResult | undefined;
      if (plan.candidate_tree !== plan.base_tree && plan.start !== "echo") {
        const baselinePlan = { ...plan, candidate_tree: plan.base_tree };
        const baselineId = digest(canonical(baselinePlan));
        const baselineDirectory = this.directory(baselineId);
        if (!await optional(join(baselineDirectory, "plan.json"))) {
          const request: ReplayRequest = { moment: join(directory, "inputs/bundle"), base: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, candidate: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, harness: plan.runner.harness, bindings: plan.runner.bindings, image: plan.harness_image, model: plan.runner.model, start: plan.start, samples: plan.samples, runtime: { cli: plan.runner.cli, version: plan.container_runtime }, clockProbe: plan.clock_probe, env: plan.runner.env };
          const resolved = await this.plan(request);
          if (resolved !== baselineId) throw new Error("Baseline plan differs");
        }
        baseline = await this.resume(baselineId);
      }
      status.state = "running";
      delete status.error;
      let journalWrites = Promise.resolve();
      const persist = () => journalWrites = journalWrites.then(() => save(join(directory, "journal.json"), status));
      await persist();
      const evidence = hydrate(bundleEvidence(bundle), bundle.files);
      const sandbox = this.#options.sandbox ?? new ContainerSandbox({ cli: plan.runner.cli });
      const keyPath = join(directory, "hmac.key");
      try { await writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const hmacKey = await readFile(keyPath);
      const schedule = async (count: number, tiebreak: boolean): Promise<void> => {
        const first = tiebreak ? plan.samples.base : 0;
        for (let i = first; i < first + count; i++) if (!status.samples.some(s => s.sample === i)) status.samples.push({ sample: i, tiebreak, status: "unassessed", expectations: [], attempts: [], complete: false });
        await persist();
        const todo = status.samples.filter(s => s.tiebreak === tiebreak && !s.complete);
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(todo.length, this.#options.concurrency ?? 2) }, async () => {
          for (;;) {
            const sample = todo[cursor++];
            if (!sample) return;
            await this.#sample({ id, directory, plan, bundle, evidence, sample, sandbox, hmacKey, persist });
          }
        }));
      };
      await schedule(plan.samples.base, false);
      if (momentVerdict(status.samples, plan.samples).needsTiebreak) await schedule(plan.samples.tiebreak, true);
      const verdict = momentVerdict(status.samples, plan.samples);
      const reports: FidelityReport[] = [];
      const edits = new Set<string>();
      for (const sample of status.samples) {
        const attempt = sample.attempts.at(-1);
        if (!attempt) continue;
        const attemptRoot = join(directory, "samples", String(sample.sample), String(attempt.attempt));
        const report = await optional<FidelityReport>(join(attemptRoot, "fidelity.json"));
        if (report) { reports.push(report); for (const edit of report.context?.prefix_edits ?? []) edits.add(edit.field); }
      }
      const grades = reports.flatMap(r => r.grade ? [r.grade] : []);
      const result: ReplayResult = {
        phoenix_result: 1, plan: id, check: plan.check, ledger_entry: approval, start: plan.start, prefix_edits: [...edits].sort().map(field => ({ field })),
        samples: status.samples.map(({ complete: _, ...sample }) => sample), tiebreak_ran: status.samples.some(s => s.tiebreak),
        verdict: verdict.verdict, discount: verdict.discount, ...(verdict.meets_check !== undefined ? { meets_check: verdict.meets_check } : {}),
        ...(grades.length ? { fidelity_grade: weakestTier(...grades) } : {}),
      };
      if (baseline) {
        const compared = compareBaseline(verdict, momentVerdict(baseline.samples, plan.samples));
        result.baseline = momentVerdict(baseline.samples, plan.samples).counts;
        if (compared.improved !== undefined) result.improved = compared.improved;
        await save(join(directory, "comparison.json"), compared);
      }
      checked("result", result);
      await save(join(directory, "result.json"), result);
      status.result = result;
      status.state = status.samples.some(s => !s.complete) ? "interrupted" : "finished";
      await persist();
      return result;
    } catch (error) {
      const status = await this.status(id);
      status.state = "interrupted"; status.error = error instanceof Error ? error.message : String(error);
      await save(join(directory, "journal.json"), status);
      throw error;
    } finally { await release(); }
  }

  async #sample(input: {
    id: string; directory: string; plan: ResolvedPlan; bundle: MomentBundle; evidence: TraceEvent[]; sample: SampleState;
    sandbox: Sandbox; hmacKey: Uint8Array; persist(): Promise<void>;
  }): Promise<void> {
    const { id, directory, plan, bundle, evidence, sample, sandbox, hmacKey, persist } = input;
    const previous = sample.attempts.at(-1);
    if (previous?.status === "running") {
      previous.status = "interrupted"; previous.cause = "runner interrupted";
      if (previous.container && !this.#options.sandbox) await execute(plan.runner.cli[0]!, [...plan.runner.cli.slice(1), "rm", "-f", previous.container, previous.container.replace("phoenix-workload-", "phoenix-relay-")]).catch(() => {});
      await persist();
    }
    const recovery = previous?.status === "interrupted" ? await sampleTrace(join(directory, "samples", String(sample.sample), String(previous.attempt), "trace")) : [];
    const attempt: Attempt = { attempt: sample.attempts.length, status: "running", ...(recovery.length ? { recovered: true } : {}) };
    sample.attempts.push(attempt);
    const root = join(directory, "samples", String(sample.sample), String(attempt.attempt));
    await mkdir(root, { recursive: true, mode: 0o700 });
    await persist();
    let engine: Engine | undefined;
    let process: SandboxProcess | undefined;
    let clockWrites = Promise.resolve();
    let outcome: { kind: "finished"; code: number | null } | { kind: "interrupted"; why: string } | { kind: "diverged"; trigger: string; detail: string };
    try {
      const tree = await materialize({ bundle, base: { digest: plan.base_tree, directory: join(directory, "inputs/base") }, candidate: { digest: plan.candidate_tree, directory: join(directory, "inputs/candidate") }, contract: plan.runner.harness, bindings: plan.runner.bindings, directory: root, env: plan.runner.env });
      const dialect = plan.runner.harness.endpoints.model.dialect;
      const headers: Record<string, string> = {};
      for (const [name, ref] of Object.entries(plan.runner.model.headers ?? {})) {
        const value = globalThis.process.env[ref.env];
        if (!value) throw new Error(`Missing host model environment variable: ${ref.env}`);
        headers[name] = value;
      }
      const start = plan.start === "mark" ? { at: bundle.manifest.mark! } : plan.start;
      engine = await startEngine({ evidence: { events: evidence, body }, ...(recovery.length ? { resume: { events: recovery, body } } : {}), connectors: bundle.manifest.connectors, start,
        clock: { start: bundle.manifest.clock?.time ?? evidence[0]?.ts.wall }, routes: { ...tree.routes, http: { ...tree.routes.http, "phoenix-model": plan.runner.model.connector } },
        model: { connector: plan.runner.model.connector, dialect: dialect as NonNullable<EngineOptions["model"]>["dialect"], provider: { url: plan.runner.model.url, headers } },
        sample: { root: join(root, "trace"), metadata: { capture: `${id.slice(7)}-${sample.sample}-${attempt.attempt}`, harness: { name: plan.runner.harness.name, tree: plan.candidate_tree }, recipe: { name: "runner", version: "1" }, routes: ["tap"], started_at: bundle.manifest.clock?.time ?? evidence[0]?.ts.wall ?? new Date(0).toISOString(), boot_id: `${id}-${sample.sample}-${attempt.attempt}` } }, hmacKey });
      await writeClockFile(join(root, "clock"), engine.clock.now());
      engine.clock.onAnchor(time => { clockWrites = clockWrites.then(() => writeClockFile(join(root, "clock"), time)); });
      const running = await sandbox.start({ image: plan.harness_image, argv: tree.argv, env: { ...tree.env, TZ: bundle.manifest.clock?.timezone ?? "UTC" }, mounts: [{ source: tree.directory, target: "/worktree" }, { source: join(root, "support"), target: "/phoenix", readOnly: true }], clockFile: join(root, "clock"), workdir: "/worktree", virtualTime: engine.clock.now().toISOString(), clockProbe: plan.clock_probe, dontFakeMonotonic: true });
      process = running.process; attempt.container = process.id;
      await persist();
      process.stdin.end();
      process.stdout.resume(); process.stderr.resume();
      const connections = (async () => { for await (const connection of running.channel) engine!.accept(connection); })().then(() => ({ kind: "interrupted" as const, why: "engine channel closed" }), () => ({ kind: "interrupted" as const, why: "engine channel closed" }));
      outcome = await Promise.race([
        process.exited.then(({ code }) => ({ kind: "finished" as const, code })),
        process.interrupted.then(error => ({ kind: "interrupted" as const, why: error.message })),
        engine.stopped.then(stop => stop.kind === "diverged" ? { kind: "diverged" as const, trigger: stop.divergence.trigger, detail: stop.divergence.detail } : stop),
        connections,
      ]);
      if (outcome.kind === "finished" && plan.start === "echo" && !engine.prefixComplete()) outcome = { kind: "diverged", trigger: "prefix-drift", detail: "Harness exited before consuming the complete echo prefix" };
      await save(join(root, "clock-report.json"), process.clock);
    } catch (error) { outcome = { kind: "interrupted", why: error instanceof Error ? error.message : String(error) }; }
    finally {
      await process?.stop().catch(() => {});
      await engine?.close();
      await clockWrites;
    }
    const trace = await sampleTrace(join(root, "trace"));
    const expectedStates = Object.fromEntries((bundle.check.expect ?? []).flatMap(exp => "end_state" in exp ? [[exp.end_state.equals, JSON.parse(Buffer.from(bundle.files.get(exp.end_state.equals)!).toString())]] : []));
    const boundary = trace.find(e => e.kind === "meta" && e.op === "start-point");
    const assessed = await evaluateCheck(bundle.check, { trace, ...(boundary ? { startAfter: eventId(boundary) } : {}) }, { expectedStates, custom: customCheckHost({ checksDirectory: join(directory, "inputs/bundle/checks"), workDirectory: root, image: plan.harness_image, sandbox }) });
    const verdict = sampleVerdict({ ...assessed, diverged: outcome.kind === "diverged" });
    const context: FidelityContext = { source: bundle.manifest.source, connectors: Object.fromEntries(Object.entries(bundle.manifest.connectors ?? {}).map(([name, connector]) => [name, { coverage_tier: connector.tier, origin: connector.origin, routes: connector.routes, read_only: connector.read_only }])), start: plan.start, prefix_edits: engine?.prefixEdits() ?? [], container_runtime: plan.container_runtime, clock: await optional(join(root, "clock-report.json")) ?? { clock: "unknown" }, processes: [], ...("serve" in plan.runner.harness.run ? { earlier_tasks_not_replayed: true } : {}) };
    const contextEvent: TraceEvent = { v: 1, capture: id, stream: "runner", seq: 0, id: "runner:0", kind: "meta", op: "fidelity.context", ts: { wall: new Date().toISOString() }, body: { inline: JSON.stringify(context) } };
    const limitations: TraceEvent = { ...contextEvent, seq: 1, id: "runner:1", op: "fidelity.workdir", body: { inline: JSON.stringify({ raw_address_reporting: false, snapshot_unread: bundle.manifest.workdir ? JSON.parse(Buffer.from(bundle.files.get(bundle.manifest.workdir)!).toString()).unread : [] }) } };
    const report = fidelityReport([contextEvent, ...trace, limitations]);
    if (outcome.kind === "diverged" && !report.divergences.length) report.divergences.push({ event: "runner", detail: outcome });
    await save(join(root, "fidelity.json"), report);
    await save(join(root, "assessment.json"), assessed);
    await save(join(root, "outcome.json"), outcome);
    if (outcome.kind === "interrupted") {
      attempt.status = "interrupted"; attempt.cause = outcome.why;
      if (sample.attempts.slice(0, -1).some(a => a.status === "interrupted" && a.cause === outcome.why)) sample.complete = true;
    } else if (recovery.length && outcome.kind === "diverged" && outcome.trigger === "prefix-drift" && verdict.status !== "fail") {
      attempt.status = "finished"; attempt.cause = "recovery prefix drift; restarting at the original start point";
      attempt.fresh_after_drift = true;
      await persist();
      await this.#sample({ ...input, sample });
      return;
    } else {
      attempt.status = "finished";
      sample.complete = true;
      sample.status = verdict.status;
      sample.discounted = verdict.discounted;
      sample.expectations = assessed.expectations;
      if (outcome.kind === "finished" && outcome.code !== 0) { sample.status = "fail"; attempt.cause = `candidate exited ${outcome.code}`; }
      if (plan.start === "echo" && outcome.kind === "diverged") await save(join(this.#options.root, "echo-drift", plan.base_tree.slice(7) + ".json"), { result: id, cause: outcome.detail });
    }
    await persist();
  }
}
