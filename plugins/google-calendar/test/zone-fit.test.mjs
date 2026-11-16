import { test } from "node:test";
import assert from "node:assert/strict";
import { Copy } from "../src/google.mjs";
import { Unknown, formatInZone } from "../src/time.mjs";

// A calendar seen only through the adapter: Google wrote its event times at UTC-05:00 on 2026-11-17.
function adapterCalendar() {
  const copy = new Copy();
  copy.sawOffset("cal@example.com", "2026-11-17T15:00:00-05:00");
  copy.sawOffset("cal@example.com", "2026-11-17T17:30:00-05:00");
  return { copy, cal: copy.cal("cal@example.com") };
}

test("a time near the seen offsets is written with the offset every fitting zone agrees on", () => {
  const { copy, cal } = adapterCalendar();
  assert.equal(formatInZone(Date.parse("2026-11-17T21:30:00Z"), copy.zoneOf(cal)), "2026-11-17T16:30:00-05:00");
});

test("a time where the fitting zones disagree is not answered", () => {
  const { copy, cal } = adapterCalendar();
  // In July New York is at UTC-04:00 and Bogota at UTC-05:00; both fit the November offsets.
  assert.throws(() => formatInZone(Date.parse("2026-07-01T16:00:00Z"), copy.zoneOf(cal)), Unknown);
});

test("a calendar with no seen offsets still has no time zone", () => {
  const copy = new Copy();
  assert.throws(() => copy.zoneOf(copy.cal("other@example.com")), Unknown);
});
