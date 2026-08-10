import assert from "node:assert/strict";
import test from "node:test";

import { historyChangeRanges } from "../src/history-diff.ts";

test("historyChangeRanges finds inserted and replaced Markdown lines", () => {
  assert.deepEqual(historyChangeRanges("alpha\nomega\n", "alpha\nnew\nomega\n"), [
    { from: 6, to: 10 },
  ]);
  assert.deepEqual(historyChangeRanges("alpha\nold\nomega\n", "alpha\nnew\nomega\n"), [
    { from: 6, to: 10 },
  ]);
});

test("historyChangeRanges keeps separate change hunks", () => {
  assert.deepEqual(historyChangeRanges("alpha\nbeta\ngamma\n", "new alpha\nbeta\nnew gamma\n"), [
    { from: 0, to: 10 },
    { from: 15, to: 25 },
  ]);
});

test("historyChangeRanges anchors deleted lines in the newer source", () => {
  assert.deepEqual(historyChangeRanges("alpha\nremoved\nomega\n", "alpha\nomega\n"), [
    { from: 6, to: 6 },
  ]);
  assert.deepEqual(historyChangeRanges("alpha\nremoved\n", "alpha\n"), [{ from: 6, to: 6 }]);
});

test("historyChangeRanges ignores identical Markdown", () => {
  assert.deepEqual(historyChangeRanges("same\n", "same\n"), []);
});
