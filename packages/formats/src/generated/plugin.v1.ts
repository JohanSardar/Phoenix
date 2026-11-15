// Generated from spec/schemas/plugin.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A connector plugin descriptor (phoenix-plugin.json). phoenix_plugin is the plugin-interface major version.
 */
export interface PluginDescriptor {
  /**
   * Major version of this format.
   */
  phoenix_plugin: 1;
  connector: string;
  recognize: {
    mcp_servers?: string[];
    hosts?: string[];
    commands?: string[];
  };
  /**
   * Declared tier, a ceiling.
   */
  tier: "stateful" | "recorded" | "synthesized";
  operations: string[];
  read_only?: string[];
  volatile?: string[];
  key_rules?: {
    op: string;
    version: string;
    /**
     * Argument paths removed from the call key.
     */
    remove: string[];
  }[];
  /**
   * By tool.
   */
  entity_map?: {
    [k: string]: {
      kind: "list" | "get" | "create" | "update" | "delete";
      entity: string;
      id_path?: string;
      items_path?: string;
      /**
       * How a list result shows it is complete.
       */
      complete?: string;
      filters?: {
        arg: string;
        field: string;
        match: "equality" | "range";
      }[];
    };
  };
  capture?: {
    /**
     * A command as an argv array, never a joined shell string.
     *
     * @minItems 1
     */
    command: string[];
    /**
     * Newline-delimited JSON on stdio, or plain HTTP.
     */
    protocol: "stdio" | "http";
  };
  serve?: {
    /**
     * A command as an argv array, never a joined shell string.
     *
     * @minItems 1
     */
    command: string[];
    /**
     * Newline-delimited JSON on stdio, or plain HTTP.
     */
    protocol: "stdio" | "http";
    level: "http" | "tool";
  };
}
