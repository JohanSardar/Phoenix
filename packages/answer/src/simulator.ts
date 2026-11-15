import { HttpModelProvider, type ModelConfiguration, type ModelProvider } from "@phoenix/model";
import { canonicalJson } from "@phoenix/wire";
import { SimulatorStore } from "./simulator-store.ts";

export interface SimulatorOptions {
  moment: string;
  provider: ModelProvider;
  improverModel: string;
  store: SimulatorStore;
  clock(): unknown;
  outputSchemas?: Readonly<Record<string, Readonly<Record<string, object | boolean>>>>;
  attempts?: number;
}

export function createSimulator(options: { moment: string; root: string; configuration: ModelConfiguration; headers: Readonly<Record<string, string>>; improverModel: string; attempts?: number; outputSchemas?: SimulatorOptions["outputSchemas"] }): Omit<SimulatorOptions, "clock"> {
  const { root, configuration, headers, ...rest } = options;
  const provider = new HttpModelProvider(configuration, headers);
  const { clock: _, ...resolved } = simulatorConfig({ ...rest, provider, store: new SimulatorStore(root), clock: () => undefined });
  return resolved;
}

export function simulatorConfig(options: SimulatorOptions): SimulatorOptions {
  const model = (id: string) => id.trim().toLowerCase().split("/").at(-1);
  if (!options.moment || !options.improverModel.trim() || model(options.provider.configuration.model) === model(options.improverModel))
    throw new Error("Simulator requires a moment and a different model from the Improver");
  if (!Number.isInteger(options.attempts ?? 3) || (options.attempts ?? 3) < 1 || (options.attempts ?? 3) > 10)
    throw new Error("Simulator attempts must be between 1 and 10");
  canonicalJson(options.provider.configuration);
  return { ...options };
}

export { SimulatorStore } from "./simulator-store.ts";
