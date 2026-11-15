import type { Resolver } from "../types.ts";
import { recorded } from "./recorded.ts";
import { emulator } from "./emulator.ts";
import { simulator } from "./simulator.ts";

export const resolvers: readonly Resolver[] = [recorded, emulator, simulator];
