// Generated from spec/schemas/made-up.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A made-up moment (moment.yaml in a made-up folder): a moment that never happened live. A person writes the messages before it, the prompt, the tools the agent has, and what those tools answer.
 */
export interface MadeUpMoment {
  /**
   * Major version of this format.
   */
  phoenix_made_up: 1;
  /**
   * When the moment happens. The box's clock starts here.
   */
  time: string;
  /**
   * IANA time zone for the box, such as America/Chicago.
   */
  timezone?: string;
  /**
   * The folder the agent works in. Files in the folder's files/ are laid out here in the box.
   */
  cwd?: string;
  /**
   * The LLM the harness talks to, as the harness names it.
   */
  llm: {
    provider: string;
    id: string;
    thinking?: string;
  };
  /**
   * Tools the agent has in this moment, besides the harness's own.
   */
  tools?: {
    /**
     * The tool's name as the agent sees it.
     */
    name: string;
    /**
     * The service the tool reaches. Checks name the tool as <service>.<op>.
     */
    service: string;
    /**
     * The service's name for the operation. Defaults to name.
     */
    op?: string;
    description: string;
    /**
     * JSON Schema of the tool's arguments.
     */
    parameters: {};
  }[];
  /**
   * Turns before the prompt, oldest first.
   */
  messages?: {
    role: "user" | "assistant";
    text?: string;
    /**
     * Tool calls the assistant made in this turn, each with the answer it got.
     */
    calls?: {
      /**
       * The tool's name as the agent sees it.
       */
      tool: string;
      args?: {};
      answer: unknown;
      error?: boolean;
    }[];
  }[];
  /**
   * The user's message that starts the moment.
   */
  prompt: string;
  /**
   * What the tools answer during the replay. An entry without args answers that tool for any arguments.
   */
  world?: {
    /**
     * <service>.<op>, as in checks.
     */
    tool: string;
    args?: {};
    /**
     * The answer, as text or JSON.
     */
    answer: {
      [k: string]: unknown;
    };
    /**
     * The answer is a tool error.
     */
    error?: boolean;
  }[];
}
