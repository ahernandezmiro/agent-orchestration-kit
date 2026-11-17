// Tests for the offline lead-usage estimate.
//
//   node --test claude/global/test/lead-usage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { attribute } from "../scripts/lead-usage.mjs";

const WINDOWS = [{ run_id: "r1", role: "luna-implement", outcome: "accepted", root: "/repo", from: 1000, to: 5000 }];
const usage = (ts, model, cwd = "/repo") => ({ ts, cwd, model, input: 1, cache_creation: 0, cache_read: 0, output: 1 });

test("rows list the distinct lead models in the window", () => {
  const rows = attribute(WINDOWS, [
    usage(2000, "model-b"), usage(3000, "model-a"), usage(3500, "model-b"),
    usage(9000, "model-c"), usage(2500, "model-d", "/other")
  ]);
  assert.deepEqual(rows[0].lead_models, ["model-a", "model-b"]);
  assert.equal(rows[0].messages, 3);
});

test("no matching messages gives an empty list", () => {
  assert.deepEqual(attribute(WINDOWS, [])[0].lead_models, []);
});
