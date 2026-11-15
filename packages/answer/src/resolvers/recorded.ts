import { sameWriteHistory } from "@phoenix/wire";
import type { Resolver } from "../types.ts";

export const recorded: Resolver = {
  name: "recorded",
  async resolve(call, ctx) {
    const history = call.history ?? ctx.histories[call.connector] ?? [];
    const sameKey = ctx.index.exchanges.filter(e => e.connector === call.connector && e.key === call.key);
    if (!sameKey.length) return { miss: true, why: "no recorded exchange has this call key" };
    const later = sameKey.filter(e => !e.frozen);
    const current = later.filter(e => sameWriteHistory(e.history, history));
    const next = current.find(e => !ctx.served.has(e.id));
    if (next) {
      ctx.served.add(next.id);
      return { raw: next.response, provenance: next.provenance, resolver: "recorded", exchange: next };
    }
    const policy = ctx.policy(call.connector);
    const observed = sameKey.filter(e => (e.frozen || ctx.served.has(e.id)) && sameWriteHistory(e.history, history)).at(-1);
    if (call.readOnly && observed && policy.repeat_reads !== false && !policy.volatile?.includes(call.op))
      return { raw: observed.response, provenance: "derived", resolver: "recorded", note: "repeat of last observation", exchange: observed };
    if (later.length && !current.length)
      return { miss: true, why: `stale: ${later.length} recorded answer(s) with this key were observed after a different write history on ${call.connector}` };
    return { miss: true, why: `all ${current.length} current recorded answer(s) with this key were already served` };
  },
};
