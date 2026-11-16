import { entityCurrent } from "./overlay.ts";
import type { Resolver } from "../types.ts";

export const recorded: Resolver = {
  name: "recorded",
  async resolve(call, ctx) {
    if (ctx.emulators?.wrote(call.connector)) return { miss: true, why: "a working copy owns this connector and has taken a write in this replay, so the recording may be stale" };
    const sameKey = ctx.index.exchanges.filter(e => e.connector === call.connector && e.key === call.key);
    if (!sameKey.length) return { miss: true, why: "no recorded exchange has this call key" };
    const history = [...call.history ?? ctx.histories[call.connector] ?? []];
    for (const key of ctx.emulators?.untaken(call.connector) ?? []) {
      const at = history.lastIndexOf(key);
      if (at >= 0) history.splice(at, 1);
    }
    const asked = { ...call, history };
    const later = sameKey.filter(e => !e.frozen);
    const current = later.filter(e => entityCurrent(e, asked, ctx));
    const next = current.find(e => !ctx.served.has(e.id));
    if (next) {
      ctx.served.add(next.id);
      return { raw: next.response, provenance: next.provenance, resolver: "recorded", exchange: next };
    }
    const policy = ctx.policy(call.connector);
    const observed = sameKey.filter(e => (e.frozen || ctx.served.has(e.id)) && entityCurrent(e, asked, ctx)).at(-1);
    if (call.readOnly && observed && policy.repeat_reads !== false && !policy.volatile?.includes(call.op))
      return { raw: observed.response, provenance: "derived", resolver: "recorded", note: "repeat of last observation" };
    if (later.length && !current.length)
      return { miss: true, why: `stale: ${later.length} recorded answer(s) with this key were observed after a different write history on ${call.connector}` };
    return { miss: true, why: `all ${current.length} current recorded answer(s) with this key were already served` };
  },
};
