import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { startToolStandIn, type ToolStandIn } from "@phoenix/engine";
import { parse } from "yaml";
import type { RecipeDescriptor } from "@phoenix/formats";
import { writeClockFile, type Sandbox, type SandboxProcess } from "@phoenix/sandbox";
import type { MomentBundle } from "@phoenix/store";
import type { ResolvedPlan } from "./plan.ts";
import { optional, save } from "./files.ts";

const execute = promisify(execFile);
const TOOLS_HOST = "phoenix-tools";

interface SessionMoment {
  cut_lines: number;
  prompt: string;
  model: { provider: string; id: string; thinking?: string };
  loadout: unknown;
  box?: unknown;
  answers: { id: string; connector: string; op: string; args: unknown; result: unknown; observed_at: string; before_cut: boolean; world?: "exact" | "any-args" }[];
}

export type Outcome = { kind: "finished"; code: number | null } | { kind: "interrupted"; why: string } | { kind: "diverged"; trigger: string; detail: string };

export async function resumeAttempt(input: {
  id: string; directory: string; root: string; plan: ResolvedPlan; bundle: MomentBundle; sandbox: Sandbox; hmacKey: Uint8Array; capture: string;
  started(container: string): Promise<void>;
}): Promise<Outcome> {
  const { directory, root, plan, bundle, sandbox } = input;
  const recipe = plan.runner.recipe!;
  const resume = bundle.manifest.resume!;
  const recipeDirectory = join(directory, "inputs/recipe");
  const moment = JSON.parse(Buffer.from(bundle.files.get(resume.moment)!).toString("utf8")) as SessionMoment;
  const session = Buffer.from(bundle.files.get(resume.session)!).toString("utf8").split("\n");
  const hosts = recipe.resume.llm_hosts[moment.model.provider];
  if (!hosts) throw new Error(`The ${recipe.name} recipe names no LLM host for provider ${moment.model.provider}`);
  const box = join(root, "box");
  for (const part of ["moment", "agent", "out"]) await mkdir(join(box, part), { recursive: true, mode: 0o700 });
  await writeFile(join(box, "moment/cut.jsonl"), session.slice(0, moment.cut_lines).join("\n") + "\n", { mode: 0o600 });
  const { answers: _answers, loadout, ...reading } = moment;
  await writeFile(join(box, "moment/moment.json"), JSON.stringify(reading), { mode: 0o600 });
  await writeFile(join(box, "moment/loadout.json"), JSON.stringify(loadout), { mode: 0o600 });
  if (resume.files) for (const [path, bytes] of bundle.files) {
    if (!path.startsWith(`${resume.files}/`)) continue;
    const target = join(box, "moment/files", path.slice(resume.files.length + 1));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }
  const plugins = new Map(plan.runner.plugins.map(plugin => [plugin.descriptor.connector, plugin.descriptor]));
  const standIn: ToolStandIn = await startToolStandIn({
    host: TOOLS_HOST,
    answers: moment.answers.map(a => ({ id: a.id, connector: a.connector, op: a.op, args: a.args, result: a.result, observedAt: a.observed_at, beforeCut: a.before_cut, ...(a.world ? { world: a.world } : {}) })),
    policy: connector => {
      const plugin = plugins.get(connector);
      return { ...bundle.manifest.connectors?.[connector], ...(plugin ? { entity_map: plugin.entity_map, read_only: (plugin.read_only ?? []).map(op => ({ op, source: "plugin" as const })), volatile: plugin.volatile ?? [] } : {}) };
    },
    sample: { root: join(root, "trace"), metadata: { capture: input.capture, harness: { name: plan.runner.harness.name, tree: plan.candidate_tree }, recipe: { name: recipe.name, version: "1" }, routes: ["tap"], started_at: new Date().toISOString(), boot_id: input.capture } },
    hmacKey: input.hmacKey,
  });
  let process: SandboxProcess | undefined;
  let outcome: Outcome;
  try {
    const [login, ...loginArgs] = recipe.resume.login;
    await execute(login!, [...loginArgs, join(box, "agent"), moment.model.provider], { cwd: recipeDirectory });
    const time = bundle.manifest.clock?.time ?? new Date().toISOString();
    await writeClockFile(join(root, "clock"), time);
    const { clock } = parse(await readFile(join(recipeDirectory, recipe.file), "utf8")) as RecipeDescriptor;
    const running = await sandbox.start({
      image: plan.harness_image, argv: recipe.resume.command, env: { PHOENIX_TOOLS_URL: `http://${TOOLS_HOST}`, TZ: bundle.manifest.clock?.timezone ?? "UTC" },
      mounts: [
        { source: recipeDirectory, target: "/phoenix/recipe", readOnly: true },
        { source: join(box, "moment"), target: "/phoenix/moment", readOnly: true },
        { source: join(box, "agent"), target: "/phoenix/agent" },
        { source: join(box, "out"), target: "/phoenix/out" },
        { source: join(directory, "inputs/candidate"), target: "/worktree", readOnly: true },
      ],
      clockFile: join(root, "clock"), virtualTime: time, ...(clock ? { clockProbe: clock.probe } : {}), workdir: "/worktree", dontFakeMonotonic: true, directHosts: hosts,
    });
    process = running.process;
    await save(join(root, "clock-report.json"), process.clock);
    await input.started(process.id);
    process.stdin.end();
    process.stdout.resume(); process.stderr.resume();
    const connections = (async () => { for await (const connection of running.channel) standIn.accept(connection); })().then(() => ({ kind: "interrupted" as const, why: "engine channel closed" }), () => ({ kind: "interrupted" as const, why: "engine channel closed" }));
    outcome = await Promise.race([
      process.exited.then(({ code }) => ({ kind: "finished" as const, code })),
      process.interrupted.then(error => ({ kind: "interrupted" as const, why: error.message })),
      standIn.stopped.then(divergence => ({ kind: "diverged" as const, trigger: divergence.trigger, detail: divergence.detail })),
      connections,
    ]);
    const egress = await process.egress?.();
    await standIn.note("sandbox.egress", { llm_hosts: hosts, direct_rules: egress?.stdout ?? null, tool_answers_from_phoenix: standIn.served() });
    const result = await optional<{ session: string | null; final_text: string }>(join(box, "out/result.json"));
    if (result?.final_text) await standIn.note("final_text", result.final_text);
    if (result?.session) {
      const entries = (await readFile(join(box, "out", result.session), "utf8")).split("\n").filter(Boolean);
      await standIn.note("session.resumed", entries.slice(moment.cut_lines).map(line => JSON.parse(line)));
    }
  } catch (error) { outcome = { kind: "interrupted", why: error instanceof Error ? error.message : String(error) }; }
  finally {
    await process?.stop().catch(() => {});
    await rm(join(box, "agent"), { recursive: true, force: true });
    await standIn.close();
  }
  return outcome;
}
