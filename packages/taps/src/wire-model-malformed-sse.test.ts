import assert from "node:assert/strict";
import test from "node:test";
import { decodeModelBody } from "@phoenix/wire";

test("a malformed model SSE decode returns the original wire bytes", () => {
  const bytes = Buffer.from("event: message\r\nid: 17\r\ndata: not-json\r\n\r\n");
  const decoded = decodeModelBody(bytes, "text/event-stream");
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.deepEqual(Buffer.from(decoded.bytes), bytes);
});
