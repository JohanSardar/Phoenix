// Generated from spec/schemas/moment.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A moment manifest (moment.yaml).
 */
export type MomentManifest = {
  /**
   * Major version of this format.
   */
  phoenix_moment: 1;
  id: string;
  source: "snapshot" | "scenario";
  run?: {
    capture: string;
    /**
     * Task key; empty or absent when the capture is one run.
     */
    task?: string;
  };
  /**
   * An event id within a capture.
   */
  mark?: string;
  /**
   * Default start point.
   */
  start?:
    | ("beginning" | "mark")
    | {
        /**
         * An event id within a capture.
         */
        at: string;
      };
  clock?: {
    time: string;
    timezone: string;
  };
  prompt?: string;
  /**
   * Reference to the working-directory snapshot under data/workdir/.
   */
  workdir?: string;
  model?: {
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
  harness?: {
    name: string;
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    tree: string;
    commit?: string;
  };
  recipe_version?: string;
  connectors?: {
    [k: string]: {
      surface: "mcp" | "cli" | "http";
      routes: string[];
      tier: "stateful" | "recorded" | "synthesized" | "blocked";
      origin: "captured" | "seeded";
      /**
       * The connector's coverage statement.
       */
      coverage?: {
        [k: string]: unknown;
      };
      read_only?: {
        op: string;
        /**
         * Anything but plugin is unverified.
         */
        source: "plugin" | "annotation" | "http-safe-method";
      }[];
      plugin?: {
        name: string;
        /**
         * Version range.
         */
        version: string;
      };
      /**
       * The recorded tool list.
       */
      tools?: {
        [k: string]: unknown;
      }[];
      mcp?: {
        protocol_version?: string;
        era?: string;
      };
      data?: {
        path: string;
        kind: "run-evidence" | "capture-time" | "confirmation";
      }[];
      /**
       * Allow the simulator for this connector. Off unless set.
       */
      allow_synthesized?: boolean;
      /**
       * Set false to turn off answering read-only calls with the last current observation.
       */
      repeat_reads?: boolean;
      /**
       * Answer-chain steps removed for this connector.
       */
      skip_resolvers?: ("recorded" | "overlay" | "emulator" | "prefetch" | "simulator" | "world")[];
    };
  };
  fills?: {
    /**
     * The fill file under data/fills/.
     */
    path: string;
    tag: "derived" | "synthesized";
    basis: {
      /**
       * Name of the mechanical derivation rule.
       */
      rule?: string;
      /**
       * Evidence locations the fill rests on.
       */
      evidence?: string[];
    };
    producer: string;
  }[];
  /**
   * Custom-check files, named as executable content.
   */
  executable?: string[];
  /**
   * Lock without approval. Seeded scenarios only.
   */
  lock?: "auto";
  include_ignored?: boolean;
  /**
   * Set on a packed revision.
   */
  packed?: {
    /**
     * Hash of the revision this was packed from.
     */
    from: string;
    /**
     * Locations scrubbed of personal data.
     */
    scrubbed?: string[];
    withheld?: {
      at: string;
      size: number;
      reason: string;
    }[];
  };
  /**
   * Set when the moment resumes the harness's own session file. The recipe cuts the session and resumes it in the box.
   */
  resume?: {
    /**
     * Name of the recipe that resumes this session.
     */
    recipe: string;
    /**
     * Bundle path of the copied session file.
     */
    session: string;
    /**
     * Bundle path of the recipe's reading of the session at the moment: the cut, the prompt, the LLM, the tool loadout and the recorded tool answers.
     */
    moment: string;
    /**
     * The replay starts at the session's first message, with its original prompt.
     */
    from_beginning?: boolean;
    /**
     * Session lines of recorded tool answers that a person changed before the replay.
     */
    changed_answers?: number[];
    /**
     * The moment never happened live. A person wrote its messages and its world.
     */
    made_up?: boolean;
    /**
     * Set when the moment came from phoenix mark.
     */
    marked?: {
      /**
       * When the mark was made.
       */
      at: string;
      note?: string;
      /**
       * What the mark saved of the world at that time.
       */
      world: {
        /**
         * saved: a copy of the project's files as they were at the mark.
         */
        files: "saved" | "not saved";
        /**
         * Per service with a working copy, saved or why not.
         */
        services: {
          [k: string]: string;
        };
      };
    };
  };
};
