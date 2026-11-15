// Generated from spec/schemas/workdir.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A working-directory snapshot manifest (workdir/<run>.json).
 */
export interface WorkdirSnapshot {
  /**
   * Major version of this format.
   */
  phoenix_workdir: 1;
  /**
   * The working directory's path.
   */
  path: string;
  /**
   * HEAD commit, when the directory is a git repository.
   */
  commit?: string;
  entries: {
    path: string;
    /**
     * File mode, octal.
     */
    mode?: string;
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    blob?: string;
    state: "committed" | "copied" | "uncertain" | "ignored" | "ignored-copied";
    size?: number;
    mtime?: string;
  }[];
  /**
   * Whether ignored files were copied.
   */
  ignored_copied: boolean;
  /**
   * Paths that were not read.
   */
  unread: string[];
  /**
   * The snapshot could not finish.
   */
  incomplete?: boolean;
}
