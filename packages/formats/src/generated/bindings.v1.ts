// Generated from spec/schemas/bindings.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * Bindings (bindings.yaml beside a moment set).
 */
export interface Bindings {
  /**
   * Major version of this format.
   */
  phoenix_bindings: 1;
  connectors: {
    [k: string]: {
      mcp_server?: string;
      command?: string;
      serve: "recorded" | "real";
    };
  };
}
