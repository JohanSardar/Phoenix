// Generated from spec/schemas/recipe.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A capture recipe (recipe.yaml).
 */
export interface RecipeDescriptor {
  /**
   * Major version of this format.
   */
  phoenix_recipe: 1;
  name: string;
  /**
   * @minItems 1
   */
  harness_versions: string[];
  login_modes?: string[];
  /**
   * @minItems 1
   */
  routes: {
    versions: string;
    login_mode: string;
    /**
     * Routes offered, by surface.
     */
    surfaces: {
      [k: string]: string[];
    };
  }[];
  model?: {
    /**
     * The model base-URL setting.
     */
    setting: string;
    dialect: string;
    /**
     * Context the harness injects into model-request history depending on how it is signed in. The frozen-prefix comparison leaves out history text blocks whose whole text matches a pattern and reports every difference in them.
     */
    login_context?: {
      name: string;
      /**
       * A JavaScript regular expression that must match a history text block's whole text.
       */
      pattern: string;
      /**
       * Why the harness injects this context and why it depends on the login.
       */
      reason: string;
    }[];
  };
  mcp?: {
    file: string;
    format: string;
  };
  /**
   * CLI commands to shim.
   */
  shim?: string[];
  transcript_reader?: {
    /**
     * A command as an argv array, never a joined shell string.
     *
     * @minItems 1
     */
    command: string[];
    /**
     * @minItems 1
     */
    harness_versions: string[];
  };
  task_keys?: (
    | {
        header: string;
      }
    | {
        /**
         * A field in a request's _meta.
         */
        meta: string;
      }
    | {
        /**
         * A JSON path in model requests.
         */
        json_path: string;
      }
  )[];
  /**
   * Sandbox image.
   */
  image?: string;
  clock?: {
    /**
     * A command as an argv array, never a joined shell string.
     *
     * @minItems 1
     */
    probe: string[];
    dont_fake_monotonic?: boolean;
  };
  copy_ignored?: boolean;
}
