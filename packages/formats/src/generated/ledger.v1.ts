// Generated from spec/schemas/ledger.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * One entry in the approvals ledger (append-only JSON Lines in PHOENIX_HOME).
 */
export type LedgerEntry = {
  /**
   * Major version of this format.
   */
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
