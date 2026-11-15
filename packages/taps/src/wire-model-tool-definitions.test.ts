import assert from "node:assert/strict";
import test from "node:test";
import { modelDialects } from "@phoenix/wire";

test("Responses function definitions are not tool invocations", () => {
  const request = {
    model: "model",
    input: [{ role: "user", content: "Hello" }],
    tools: [{
      type: "function",
      name: "get_weather",
      parameters: { type: "object", properties: { location: { type: "string" } } },
    }],
  };
  assert.deepEqual(modelDialects.responses.toolUses(request), []);
});
