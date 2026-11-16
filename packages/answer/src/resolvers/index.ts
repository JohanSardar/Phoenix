import type { Resolver } from "../types.ts";
import { recorded } from "./recorded.ts";
import { emulator } from "./emulator.ts";
import { simulator } from "./simulator.ts";
import { overlay } from "./overlay.ts";
import { prefetch } from "./prefetch.ts";
import { world } from "./world.ts";

export const resolvers: readonly Resolver[] = [world, recorded, overlay, emulator, prefetch, simulator];
