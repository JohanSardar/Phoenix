import type { Resolver } from "../types.ts";

export const emulator: Resolver = {
  name: "emulator",
  async resolve(call, ctx) {
    return ctx.emulators ? ctx.emulators.resolve(call) : { miss: true, why: "No emulator configured" };
  },
};
