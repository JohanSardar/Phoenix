// Generated from spec/schemas/plan.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A resolved replay plan (plan.json). Its hash is the Replay's identity.
 */
export interface ReplayPlan {
  /**
   * Major version of this format.
   */
  phoenix_plan: 1;
  /**
   * Bundle digest.
   */
  bundle: string;
  /**
   * Check hash.
   */
  check: string;
  /**
   * A SHA-256 digest, written sha256:<64 hex digits>.
   */
  base_tree: string;
  /**
   * A SHA-256 digest, written sha256:<64 hex digits>.
   */
  candidate_tree: string;
  /**
   * A SHA-256 digest, written sha256:<64 hex digits>.
   */
  harness_image: string;
  model: {
    /**
     * The model identifier as the provider reported it.
     */
    id: string;
    /**
     * True when id is an alias rather than a pinned model.
     */
    alias?: boolean;
    /**
     * Model parameters.
     */
    parameters?: {
      [k: string]: unknown;
    };
  };
  start:
    | ("beginning" | "mark" | "echo")
    | {
        /**
         * An event id within a capture.
         */
        at: string;
      };
  samples: {
    base: number;
    tiebreak: number;
  };
  /**
   * Resolved plugin versions, by plugin name.
   */
  plugins: {
    [k: string]: string;
  };
  simulator?: {
    model: {
      /**
       * The model identifier as the provider reported it.
       */
      id: string;
      /**
       * True when id is an alias rather than a pinned model.
       */
      alias?: boolean;
      /**
       * Model parameters.
       */
      parameters?: {
        [k: string]: unknown;
      };
    };
    config?: {
      [k: string]: unknown;
    };
  };
  container_runtime: string;
  /**
   * A command as an argv array, never a joined shell string.
   *
   * @minItems 1
   */
  clock_probe: string[];
  /**
   * The recipe's declared login context, copied from recipe.yaml model.login_context.
   */
  login_context?: {
    name: string;
    pattern: string;
  }[];
  /**
   * Version of the engine's matching rules.
   */
  matching_rules: string;
  /**
   * Live internet for shell lines the box runs. Absent means off: the box reaches only the LLM.
   */
  network?: {
    /**
     * packages: only the package registry hosts in allow. open: every public host except those in deny.
     */
    level: "packages" | "open";
    /**
     * With packages: the registry hosts the box may reach, from the runner's network config.
     */
    allow?: string[];
    /**
     * With open: hosts a plan's plugins cover. They keep their copies and are never reached live.
     */
    deny?: string[];
  };
}
