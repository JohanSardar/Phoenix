import { completeCall, sameWriteHistory, type WriteHistories } from "@phoenix/wire";
import type { Divergence } from "./divergence.ts";
import { resolvers } from "./resolvers/index.ts";
import { simulatorConfig, type SimulatorOptions } from "./simulator.ts";
import type { Answer, Call, ConnectorPolicy, Exchange, ExchangeIndex, ReplayCtx } from "./types.ts";
import type { Emulators } from "./emulators.ts";

export function replayCtx(index: ExchangeIndex, policy: (connector: string) => ConnectorPolicy, emulators?: Emulators, simulator?: SimulatorOptions): ReplayCtx {
  return { index, histories: {}, served: new Set(), policy, emulators, ...(simulator ? { simulator: simulatorConfig(simulator) } : {}) };
}

const served = (call: Call, ctx: ReplayCtx): void => { ctx.histories = completeCall(ctx.histories, call) as WriteHistories; };
const described = (call: Call) => ({ connector: call.connector, surface: call.surface, op: call.op, key: call.key });

export function matchFrozen(call: Call, ctx: ReplayCtx): Exchange | Divergence {
  const exchange = ctx.index.frozen.find(e => !ctx.served.has(e.id) && e.connector === call.connector && e.key === call.key && sameWriteHistory(e.history, call.history ?? ctx.histories[call.connector] ?? []));
  if (!exchange) return { trigger: "prefix-drift", detail: `${call.op} on ${call.connector} is not a recorded call of the frozen prefix`, call: described(call) };
  ctx.served.add(exchange.id);
  for (const resolver of resolvers) resolver.observe?.(call, { raw: exchange.response, provenance: exchange.provenance, resolver: "frozen-prefix", exchange }, ctx);
  served(call, ctx);
  return exchange;
}

export function answeredOutside(call: Call, answer: Answer, ctx: ReplayCtx): void {
  for (const observer of resolvers) observer.observe?.(call, answer, ctx);
  served(call, ctx);
}

export async function answerCall(call: Call, ctx: ReplayCtx, without: readonly string[] = []): Promise<{ answer: Answer } | { divergence: Divergence }> {
  const skip = new Set([...ctx.policy(call.connector).skip_resolvers ?? [], ...without]);
  const misses: { resolver: string; why: string }[] = [];
  for (const resolver of resolvers) {
    if (skip.has(resolver.name)) { misses.push({ resolver: resolver.name, why: "removed for this connector by the manifest" }); continue; }
    const result = await resolver.resolve(call, ctx);
    if ("miss" in result) { misses.push({ resolver: resolver.name, why: result.why }); continue; }
    if (!skip.has("emulator")) await ctx.emulators?.observe(call, result);
    for (const observer of resolvers) observer.observe?.(call, result, ctx);
    served(call, ctx);
    return { answer: result };
  }
  const lifecycle = call.surface === "mcp" && !call.op.startsWith("tools/call:");
  return { divergence: { trigger: lifecycle ? "lifecycle" : "no-answer", detail: `no resolver answered ${call.op} on ${call.connector}`, call: described(call), misses } };
}
