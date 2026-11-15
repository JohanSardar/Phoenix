// Generated from spec/schemas/lock.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A moment lock (moment.lock.json).
 */
export type MomentLock = {
  /**
   * Major version of this format.
   */
  phoenix_lock: 1;
  /**
   * Moment id.
   */
  moment: string;
  /**
   * A SHA-256 digest, written sha256:<64 hex digits>.
   */
  manifest: string;
  /**
   * A SHA-256 digest, written sha256:<64 hex digits>.
   */
  check: string;
  /**
   * Hash of every custom-check file, by path.
   */
  checks: {
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    [k: string]: string;
  };
  /**
   * Hash of every data file, by path.
   */
  data: {
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    [k: string]: string;
  };
  /**
   * Hash of every fill, by path.
   */
  fills: {
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    [k: string]: string;
  };
  how: "approved" | "auto";
  approved_by?: string;
  approved_at: string;
};
