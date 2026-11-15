import { startServingPlugin, type InstalledPlugin, type ServingOptions, type ServingPlugin } from "@phoenix/plugin-host";
import { canonicalJson } from "@phoenix/wire";
import type { Answer, Call, Miss } from "./types.ts";

export interface EmulatorConfig { plugin: InstalledPlugin; options: ServingOptions }
export interface EmulatorDifference { connector: string; op: string; expected: string; actual: string }

export class Emulators {
  readonly #plugins = new Map<string, ServingPlugin>();
  readonly #now: () => Date;
  readonly #difference: (difference: EmulatorDifference) => Promise<void>;

  private constructor(now: () => Date, difference: (difference: EmulatorDifference) => Promise<void>) {
    this.#now = now;
    this.#difference = difference;
  }

  static async start(configs: readonly EmulatorConfig[], now: () => Date, difference: (difference: EmulatorDifference) => Promise<void> = async () => {}): Promise<Emulators> {
    const world = new Emulators(now, difference);
    try {
      for (const { plugin, options } of configs) {
        const connector = plugin.descriptor.connector;
        if (world.#plugins.has(connector)) throw new Error(`Two emulator plugins configured for ${connector}`);
        world.#plugins.set(connector, await startServingPlugin(plugin, options, now().toISOString()));
      }
      return world;
    } catch (error) { await world.close(); throw error; }
  }

  async resolve(call: Call, at = this.#now().toISOString()): Promise<Answer | Miss> {
    const plugin = this.#plugins.get(call.connector);
    if (!plugin) return { miss: true, why: "No emulator configured for this connector" };
    const reply = await plugin.call(call, at);
    if (reply.status === "unsupported") return { miss: true, why: reply.reason };
    if (reply.status !== "answer") throw new Error(`Emulator ${call.connector}: ${reply.status}: ${reply.reason}`);
    return { raw: reply.value, provenance: "derived", resolver: "emulator" };
  }

  has(connector: string): boolean { return this.#plugins.has(connector); }

  async observe(call: Call, answer: Answer, at?: string): Promise<void> {
    if (!this.#plugins.has(call.connector) || answer.resolver === "emulator" || answer.provenance === "synthesized") return;
    const actual = await this.resolve(call, at);
    if ("miss" in actual) {
      if (!call.readOnly) throw new Error(`Emulator cannot mirror write on ${call.connector}: ${actual.why}`);
      return;
    }
    const describe = (a: Answer) => canonicalJson({ body: Buffer.from(a.raw.body).toString("base64"), head: a.raw.head ?? null });
    const expected = describe(answer), observed = describe(actual);
    if (expected !== observed) await this.#difference({ connector: call.connector, op: call.op, expected, actual: observed });
  }

  async state(connector: string): Promise<unknown> {
    const plugin = this.#plugins.get(connector);
    if (!plugin) throw new Error(`No emulator configured for ${connector}`);
    const reply = await plugin.state(this.#now().toISOString());
    if (reply.status !== "answer") throw new Error(`Emulator state ${connector}: ${reply.status}: ${reply.reason}`);
    return reply.value;
  }

  async close(): Promise<void> { await Promise.all([...this.#plugins.values()].map(p => p.stop())); }
}
