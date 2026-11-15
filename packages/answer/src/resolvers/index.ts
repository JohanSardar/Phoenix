import type { Resolver } from "../types.ts";
import { recorded } from "./recorded.ts";
import { emulator } from "./emulator.ts";

export const resolvers: readonly Resolver[] = [recorded, emulator];
