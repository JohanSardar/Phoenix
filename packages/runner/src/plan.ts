import { cp, mkdir, mkdtemp, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Bindings, HarnessContract, PluginDescriptor, ReplayPlan } from "@phoenix/formats";
import { bundleApproval, digest, readApprovalsLedger, readMomentBundle } from "@phoenix/store";
import { bundleEvidence, canonical, checked, eventId, hydrate, optional, save } from "./files.ts";
import { treeDigest, type TreeInput } from "./materialize.ts";

export interface ReplayRequest {
  moment: string;
  base: TreeInput;
  candidate: TreeInput;
  harness: HarnessContract;
  bindings?: Bindings;
  image: string;
  model: ReplayPlan["model"] & { connector: string; url: string; headers?: Record<string, { env: string }> };
  start: ReplayPlan["start"];
  samples?: ReplayPlan["samples"];
  runtime?: { cli: string[]; version: string };
  clockProbe?: string[];
  env?: Record<string, string>;
  plugins?: { name: string; version: string; directory: string; image: string; snapshot?: string; seed?: string; env?: Record<string, string> }[];
}

export interface ResolvedPlugin {
  name: string; version: string; tree: string; image: string; descriptor: PluginDescriptor; snapshot?: string; seed?: string; env?: Record<string, string>;
}

export type ResolvedPlan = ReplayPlan & {
  runner: { harness: HarnessContract; bindings?: Bindings; model: ReplayRequest["model"]; env: Record<string, string>; cli: string[]; plugins: ResolvedPlugin[] };
};

export async function resolvePlan(root: string, ledger: string, request: ReplayRequest): Promise<{ id: string; plan: ResolvedPlan }> {
  const bundle = await readMomentBundle(request.moment);
  bundleApproval(bundle, (await readApprovalsLedger(ledger)).entries);
  checked("harness", request.harness);
  if (request.bindings) checked("bindings", request.bindings);
  for (const tree of [request.base, request.candidate]) if (await treeDigest(tree.directory) !== tree.digest) throw new Error(`Tree digest mismatch: ${tree.digest}`);
  if (request.start === "echo" && request.base.digest !== request.candidate.digest) throw new Error("Echo replays require the unedited base tree");
  if (bundle.manifest.harness && bundle.manifest.harness.tree !== request.base.digest) throw new Error("Base tree does not match the locked harness");
  const events = hydrate(bundleEvidence(bundle), bundle.files);
  if (request.start !== "beginning" && request.start !== "echo") {
    const mark = events.findIndex(e => eventId(e) === bundle.manifest.mark);
    const at = request.start === "mark" ? mark : events.findIndex(e => eventId(e) === request.start.at);
    if (mark < 0 || at < 0 || at > mark) throw new Error("Start must be a cut between the beginning and the mark");
    const echo = await optional<{ result: string }>(join(root, "echo-drift", request.base.digest.slice(7) + ".json"));
    if (echo) throw new Error(`This base tree supports only beginning; echo drift: ${echo.result}`);
  }
  if (!events.length && request.start !== "beginning") throw new Error("A scenario with no staged run starts only at beginning");
  const modelUrl = new URL(request.model.url);
  if (modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash || !["http:", "https:"].includes(modelUrl.protocol)) throw new Error("Model URL must not carry credentials or query parameters");
  for (const ref of Object.values(request.model.headers ?? {})) if (!ref || Object.keys(ref).length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env)) throw new Error("Model credentials must be host environment references");
  const plugins: ResolvedPlugin[] = [];
  for (const plugin of request.plugins ?? []) {
    if (plugins.some(p => p.name === plugin.name)) throw new Error(`Duplicate plugin: ${plugin.name}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(plugin.image)) throw new Error("Plugin image must be digest-pinned");
    const descriptor = checked("plugin", JSON.parse(await readFile(join(plugin.directory, "phoenix-plugin.json"), "utf8")));
    if (!plugin.name || !plugin.version || /[~^*<>=| ]/.test(plugin.version)) throw new Error("Plugin versions must be resolved, not ranges");
    if (!bundle.manifest.connectors?.[descriptor.connector]) throw new Error(`Plugin connector is not in this moment: ${descriptor.connector}`);
    for (const path of [plugin.snapshot, plugin.seed]) if (path && !bundle.files.has(path)) throw new Error(`Plugin input is not locked bundle data: ${path}`);
    const { directory: _, ...settings } = plugin;
    plugins.push({ ...settings, descriptor, tree: await treeDigest(plugin.directory) });
  }
  const plan: ResolvedPlan = {
    phoenix_plan: 1, bundle: bundle.lockHash, check: bundle.lock.check, base_tree: request.base.digest, candidate_tree: request.candidate.digest,
    harness_image: request.image, model: { id: request.model.id, ...(request.model.alias !== undefined ? { alias: request.model.alias } : {}), ...(request.model.parameters ? { parameters: request.model.parameters } : {}) },
    start: request.start, samples: request.samples ?? bundle.check.samples ?? { base: 2, tiebreak: 1 }, plugins: Object.fromEntries(plugins.map(p => [p.name, p.version])),
    container_runtime: request.runtime?.version ?? "docker", clock_probe: request.clockProbe ?? ["node", "-e", "console.log(Date.now())"], matching_rules: "1",
    runner: { harness: request.harness, ...(request.bindings ? { bindings: request.bindings } : {}), model: request.model, env: request.env ?? {}, cli: request.runtime?.cli ?? ["docker"], plugins },
  };
  checked("plan", plan);
  const id = digest(canonical(plan));
  const directory = join(root, "replays", id.slice(7));
  const existing = await optional<ResolvedPlan>(join(directory, "plan.json"));
  if (existing) { if (canonical(existing) !== canonical(plan)) throw new Error("Replay identity collision"); return { id, plan: existing }; }
  await mkdir(join(root, "replays"), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(root, "replays/.resolve-"));
  await mkdir(join(stage, "inputs"));
  await cp(request.moment, join(stage, "inputs/bundle"), { recursive: true, errorOnExist: true, force: false });
  await cp(request.base.directory, join(stage, "inputs/base"), { recursive: true, errorOnExist: true, force: false });
  await cp(request.candidate.directory, join(stage, "inputs/candidate"), { recursive: true, errorOnExist: true, force: false });
  for (const [index, plugin] of (request.plugins ?? []).entries()) {
    await cp(plugin.directory, join(stage, "inputs/plugins", String(index)), { recursive: true, errorOnExist: true, force: false });
    if (await treeDigest(join(stage, "inputs/plugins", String(index))) !== plugins[index]!.tree) throw new Error("Plugin changed while resolving the plan");
  }
  for (const [name, hash] of [["base", plan.base_tree], ["candidate", plan.candidate_tree]] as const) if (await treeDigest(join(stage, "inputs", name)) !== hash) throw new Error("Tree changed while resolving the plan");
  await save(join(stage, "plan.json"), plan);
  await rename(stage, directory);
  return { id, plan };
}
