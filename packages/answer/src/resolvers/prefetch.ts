import { entityCurrent } from "./overlay.ts";
import type { Resolver } from "../types.ts";

export const prefetch: Resolver = {
  name: "prefetch",
  async resolve(call, ctx) {
    if (!call.readOnly || ctx.policy(call.connector).volatile?.includes(call.op)) return { miss: true, why: "prefetch requires a non-volatile read-only call" };
    const found = (ctx.index.prefetch ?? []).filter(e => e.connector === call.connector && e.key === call.key && entityCurrent(e, call, ctx)).at(-1);
    if (!found) return { miss: true, why: "no current capture-time read has this call key" };
    return { raw: found.response, provenance: "recorded", resolver: "prefetch", exchange: found };
  },
};
