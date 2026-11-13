import assert from "node:assert/strict";
import test from "node:test";

import { singleFlight } from "../src/single-flight.ts";

test("concurrent callers share one in-flight start", async () => {
  const start = singleFlight();
  let starts = 0;
  let finish: (() => void) | undefined;
  const create = () => {
    starts += 1;
    return new Promise<number>((resolve) => {
      finish = () => resolve(starts);
    });
  };
  const callers = [start(create), start(create), start(create)];
  finish?.();
  assert.deepEqual(await Promise.all(callers), [1, 1, 1]);
  assert.equal(starts, 1);
});

test("a failed start is retried by the next caller", async () => {
  const start = singleFlight();
  let attempts = 0;
  const create = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("cold start failed");
    return attempts;
  };
  await assert.rejects(start(create), /cold start failed/u);
  assert.equal(await start(create), 2);
});
