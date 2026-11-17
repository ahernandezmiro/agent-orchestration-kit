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

test("subagent (sidechain) messages count toward usage but not toward lead models", () => {
  const sidechain = { ...usage(2000, "model-haiku"), sidechain: true };
  const rows = attribute(WINDOWS, [usage(3000, "model-a"), sidechain]);
  assert.deepEqual(rows[0].lead_models, ["model-a"]);
  assert.equal(rows[0].messages, 2);
});

test("loadUsage marks records from subagent transcripts", async (t) => {
  const { loadUsage } = await import("../scripts/lead-usage.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-usage-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const line = (id, model, isSidechain) => JSON.stringify({
    type: "assistant", timestamp: "2026-11-17T10:00:00Z", cwd: "/repo", isSidechain,
    message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } }
  });
  fs.writeFileSync(path.join(dir, "s.jsonl"), `${line("m1", "model-a", false)}\n${line("m2", "model-haiku", true)}\n`);
  const records = await loadUsage(dir);
  assert.deepEqual(records.map((r) => [r.model, r.sidechain]), [["model-a", false], ["model-haiku", true]]);
});

test("client-generated <synthetic> messages are not a lead model", () => {
  const rows = attribute(WINDOWS, [usage(3000, "model-a"), usage(3500, "<synthetic>")]);
  assert.deepEqual(rows[0].lead_models, ["model-a"]);
});
