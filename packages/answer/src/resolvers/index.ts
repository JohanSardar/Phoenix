import type { Resolver } from "../types.ts";
import { recorded } from "./recorded.ts";

export const resolvers: readonly Resolver[] = [recorded];
