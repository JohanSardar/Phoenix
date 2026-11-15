import { completeCall, sameWriteHistory, type WriteHistories } from "@phoenix/wire";
import type { Divergence } from "./divergence.ts";
import { resolvers } from "./resolvers/index.ts";
import type { Answer, Call, ConnectorPolicy, Exchange, ExchangeIndex, ReplayCtx } from "./types.ts";

export function replayCtx(index: ExchangeIndex, policy: (connector: string) => ConnectorPolicy): ReplayCtx {
  return { index, histories: {}, served: new Set(), policy };
}

const served = (call: Call, ctx: ReplayCtx): void => { ctx.histories = completeCall(ctx.histories, call) as WriteHistories; };
const described = (call: Call) => ({ connector: call.connector, surface: call.surface, op: call.op, key: call.key });

export function matchFrozen(call: Call, ctx: ReplayCtx): Exchange | Divergence {
  const exchange = ctx.index.frozen.find(e => !ctx.served.has(e.id) && e.connector === call.connector && e.key === call.key && sameWriteHistory(e.history, ctx.histories[call.connector] ?? []));
  if (!exchange) return { trigger: "prefix-drift", detail: `${call.op} on ${call.connector} is not a recorded call of the frozen prefix`, call: described(call) };
  ctx.served.add(exchange.id);
  served(call, ctx);
  return exchange;
}

export async function answerCall(call: Call, ctx: ReplayCtx): Promise<{ answer: Answer } | { divergence: Divergence }> {
  const skip = new Set(ctx.policy(call.connector).skip_resolvers ?? []);
  const misses: { resolver: string; why: string }[] = [];
  for (const resolver of resolvers) {
    if (skip.has(resolver.name)) { misses.push({ resolver: resolver.name, why: "removed for this connector by the manifest" }); continue; }
    const result = await resolver.resolve(call, ctx);
    if ("miss" in result) { misses.push({ resolver: resolver.name, why: result.why }); continue; }
    served(call, ctx);
    return { answer: result };
  }
  const lifecycle = call.surface === "mcp" && !call.op.startsWith("tools/call:");
  return { divergence: { trigger: lifecycle ? "lifecycle" : "no-answer", detail: `no resolver answered ${call.op} on ${call.connector}`, call: described(call), misses } };
}
