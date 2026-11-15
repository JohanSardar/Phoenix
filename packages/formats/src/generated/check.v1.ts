// Generated from spec/schemas/check.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A success check (check.yaml).
 */
export type SuccessCheck = {
  /**
   * Major version of this format.
   */
  phoenix_check: 1;
  samples: {
    base: number;
    tiebreak: number;
  };
  scope: "continuation" | "run";
  /**
   * @minItems 1
   */
  expect?: (
    | {
        called: {
          tool: string;
          args?: {
            [k: string]: unknown;
          };
          times?: number;
        };
      }
    | {
        not_called: {
          tool: string;
          args?: {
            [k: string]: unknown;
          };
        };
      }
    | {
        /**
         * @minItems 2
         */
        order: string[];
      }
    | {
        max_calls: {
          tool: string;
          count: number;
        };
      }
    | {
        end_state: {
          connector: string;
          /**
           * Path of the expected state file in the bundle.
           */
          equals: string;
        };
      }
    | {
        final_text:
          | {
              contains: string;
            }
          | {
              /**
               * A regular expression.
               */
              matches: string;
            };
      }
    | {
        /**
         * A custom check module under checks/.
         */
        custom: string;
      }
  )[];
  intent?: string;
};
