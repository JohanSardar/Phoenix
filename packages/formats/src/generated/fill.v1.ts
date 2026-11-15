// Generated from spec/schemas/fill.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * One filled item in a moment's data/fills/.
 */
export interface Fill {
  /**
   * Major version of this format.
   */
  phoenix_fill: 1;
  /**
   * What is filled, e.g. an MCP result envelope, a model response, a tool list or a protocol version.
   */
  item: string;
  connector?: string;
  /**
   * The event the fill belongs to.
   */
  at?: string;
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
  /**
   * A wire rule or the setup agent's model.
   */
  producer: string;
  /**
   * The filled item.
   */
  value: {} | unknown[] | string | number | boolean | null;
}
