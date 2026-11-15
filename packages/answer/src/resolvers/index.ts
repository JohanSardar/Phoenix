import type { Resolver } from "../types.ts";
import { recorded } from "./recorded.ts";
import { emulator } from "./emulator.ts";
import { overlay } from "./overlay.ts";
import { prefetch } from "./prefetch.ts";

export const resolvers: readonly Resolver[] = [recorded, overlay, emulator, prefetch];
