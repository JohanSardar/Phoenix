// Generated from spec/schemas/trace.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * One event in a trace: one line of a segment, import or notes JSON Lines file.
 */
export interface TraceEvent {
  /**
   * Major version of this format.
   */
  v: 1;
  /**
   * Capture id.
   */
  capture: string;
  /**
   * Stream id, assigned by the tap.
   */
  stream: string;
  /**
   * Sequence number within the stream, assigned by the tap.
   */
  seq: number;
  ts: {
    /**
     * Wall-clock time.
     */
    wall: string;
    /**
     * Host monotonic time in nanoseconds, where the route has one. A string because it may not fit a JSON number.
     */
    mono?: string;
  };
  kind: "call" | "result" | "meta" | "prefetch" | "mark" | "task" | "correction" | "gap" | "divergence" | "close";
  route?: "tap" | "transcript" | "import";
  /**
   * Task key.
   */
  task?: string;
  surface?: "mcp" | "cli" | "http";
  layer?: "agent" | "under";
  /**
   * For layer under: the agent-level call this event is linked to.
   */
  parent?: string;
  /**
   * Why parent was chosen. sole-in-flight marks an inference, not proof.
   */
  parent_basis?: "sole-in-flight";
  connector?: string;
  /**
   * An event id within a capture.
   */
  id?: string;
  /**
   * Operation, e.g. tools/call:move_event.
   */
  op?: string;
  body?:
    | {
        /**
         * The body as received, apart from stripped secrets.
         */
        inline: string;
        /**
         * Original content encoding, noted when the body is stored decoded.
         */
        content_encoding?: string;
      }
    | {
        /**
         * A SHA-256 digest, written sha256:<64 hex digits>.
         */
        blob: string;
        /**
         * Original content encoding, noted when the body is stored decoded.
         */
        content_encoding?: string;
      };
  /**
   * Streamed body chunks.
   */
  chunks?: {
    offset: number;
    /**
     * Arrival time, host monotonic nanoseconds.
     */
    at: string;
  }[];
  /**
   * The message lost frames; only the frames that arrived are present.
   */
  partial?: boolean;
  /**
   * Partial only because the transport closed before EOF, with no known missing body frames. A protocol terminal event may establish completion.
   */
  transport_partial?: boolean;
  /**
   * Copies dropped before this one, carried after a drop.
   */
  dropped?: {
    from: number;
    to: number;
    bytes: number;
  };
  /**
   * For imported events: the fields that came from the log as written.
   */
  verbatim?: string[];
  provenance?: "real" | "recorded" | "derived" | "synthesized" | "seeded";
  /**
   * On replay results: the resolver that answered.
   */
  resolver?: string;
  /**
   * On replay results: true when an earlier write to this service got a made-up answer because its working copy could not take it, so neither the session nor the copy knows what the service would say now.
   */
  after_untaken_write?: boolean;
  secrets?:
    | "unscanned"
    | {
        at: string;
        rule: string;
      }[];
}
