import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "@phoenix/wire";

test("RFC 8785 sorts ordinary JSON properties named toJSON", () => {
  const args: unknown = JSON.parse('{"b":1,"toJSON":"data","a":2}');
  assert.equal(canonicalJson(args), '{"a":2,"b":1,"toJSON":"data"}');
});
