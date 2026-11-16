import { canonicalJson } from "@phoenix/wire";
import type { Resolver } from "../types.ts";

export const world: Resolver = {
  name: "world",
  async resolve(call, ctx) {
    const written = ctx.index.exchanges.filter(e => e.provenance === "seeded" && e.connector === call.connector && e.op === call.op);
    const exact = written.find(e => !e.anyArgs && canonicalJson(e.args) === canonicalJson(call.args));
    const answer = exact ?? written.find(e => e.anyArgs);
    if (!answer) return { miss: true, why: "the made-up world has no answer for this tool" };
    return { raw: answer.response, provenance: "seeded", resolver: "world", note: exact ? "written for these arguments" : "written for any arguments", exchange: answer };
  },
};
