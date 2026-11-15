// Generated from spec/schemas/result.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A replay result (one moment, one plan).
 */
export interface ReplayResult {
  /**
   * Major version of this format.
   */
  phoenix_result: 1;
  /**
   * Plan hash.
   */
  plan: string;
  /**
   * Check hash.
   */
  check: string;
  ledger_entry: {
    phoenix_ledger: 1;
    /**
     * Moment id.
     */
    moment: string;
    /**
     * Moment revision.
     */
    revision: string;
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    lock_hash?: string;
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    result_hash?: string;
    how: "approved" | "auto" | "accepted" | "pass-accepted";
    who: string;
    at: string;
  };
  start:
    | ("beginning" | "mark" | "echo")
    | {
        /**
         * An event id within a capture.
         */
        at: string;
      };
  prefix_edits: {
    /**
     * The configuration field that differs from the recording.
     */
    field: string;
  }[];
  samples: {
    sample: number;
    tiebreak: boolean;
    status: "pass" | "fail" | "unassessed";
    discounted?: boolean;
    attempts: {
      attempt: number;
      status: "running" | "interrupted" | "finished";
      cause?: string;
    }[];
    expectations: {
      /**
       * Index into the check's expect list.
       */
      expectation: number;
      outcome: "pass" | "fail" | "error";
      tainted: boolean;
      error?: string;
    }[];
    intent?: {
      met: boolean;
      reason: string;
    };
  }[];
  tiebreak_ran: boolean;
  baseline?: {
    pass: number;
    fail: number;
    unassessed: number;
  };
  meets_check?: boolean;
  improved?: boolean;
  verdict: "fails" | "meets-check" | "incomplete";
  discount: {
    discounted: boolean;
    /**
     * How a discounted verdict was confirmed. Absent while unconfirmed.
     */
    confirmed?: "stateful-fake" | "fresh-recording" | "pass-accepted";
  };
  fidelity_grade?: "stateful" | "recorded" | "synthesized" | "blocked";
}
