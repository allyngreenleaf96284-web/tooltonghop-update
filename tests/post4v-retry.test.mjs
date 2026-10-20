import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnknownFailure, isRetryableFailure, startAutoRetryBatch } from "../modules/batch_retry.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unknown = () => ({ status: "error", result: { trangThai: "lỗi", chiTiet: 'Loi o buoc "dang bai 4v shipping": Execution context was destroyed' } });

test("4v step labels do not hide unknown errors, while known failures stay excluded", () => {
  assert.equal(isUnknownFailure(unknown()), true);
  assert.equal(isRetryableFailure(unknown()), true);
  for (const trangThai of ["lỗi sp", "lỗi link sp", "die cho", "cp282", "cp956", "limitdb", "loi publish", "hetproxy"]) {
    assert.equal(isRetryableFailure({ status: "error", result: { trangThai, chiTiet: "dang bai 4v" } }), false, trangThai);
  }
  assert.equal(isRetryableFailure({ status: "error", result: { trangThai: "loi", chiTiet: "Workflow dang bai chua ho tro 4v" } }), false);
  assert.equal(isRetryableFailure({ status: "success", result: { trangThai: "tụt 2v" } }), false);
});

for (const maxRetries of [0, 1, 2]) {
  test(`4v retry count ${maxRetries} finishes each pass and removes recovered profiles`, async () => {
    const runtime = { jobs: new Map(), running: false };
    const passes = [];
    const profileIds = ["first", "persistent", "product-error", "link-error", "completed"];
    const module = {
      async runQueue(ids) {
        assert.equal(runtime.running, false, "The previous pass must finish before another starts");
        passes.push([...ids]);
        runtime.running = true;
        runtime.jobs.clear();
        for (const id of ids) runtime.jobs.set(id, { profileId: id, tool: "dang bai 4v", status: "running" });
        setImmediate(() => {
          for (const id of ids) {
            const outcome = id === "completed" || (id === "first" && passes.length >= 2)
              ? { status: "success", result: { trangThai: "thành công" } }
              : id === "product-error" || id === "link-error"
                ? { status: "error", result: { trangThai: id === "product-error" ? "lỗi sp" : "lỗi link sp" } }
                : unknown();
            Object.assign(runtime.jobs.get(id), outcome);
          }
          runtime.running = false;
        });
        return { started: ids.length };
      }
    };
    const result = await startAutoRetryBatch({ runtime, module, tool: "dang bai 4v", profileIds, config: {}, maxRetries });
    assert.equal(result.maxRetries, maxRetries);
    for (let attempt = 0; attempt < 300 && runtime.batch.active; attempt += 1) await pause(10);
    assert.equal(runtime.batch.active, false);
    const expected = [profileIds];
    if (maxRetries >= 1) expected.push(["first", "persistent"]);
    if (maxRetries >= 2) expected.push(["persistent"]);
    assert.deepEqual(passes, expected);
    assert.equal(runtime.jobs.size, profileIds.length);
    assert.equal(runtime.jobs.get("completed").status, "success");
    if (maxRetries) {
      assert.equal(runtime.jobs.get("first").status, "success");
      assert.equal(runtime.jobs.get("persistent").phaseState, "retry_failed");
    }
  });
}

test("a manual stop prevents all 4v retry passes", async () => {
  const runtime = { jobs: new Map(), running: false };
  let passes = 0;
  await startAutoRetryBatch({ runtime, tool: "dang bai 4v", profileIds: ["p1"], config: {}, maxRetries: 2, module: {
    async runQueue() {
      passes += 1;
      runtime.jobs.set("p1", unknown());
      runtime.batch.stopRequested = true;
      return {};
    }
  } });
  for (let attempt = 0; attempt < 100 && runtime.batch.active; attempt += 1) await pause(10);
  assert.equal(runtime.batch.active, false);
  assert.equal(passes, 1);
  assert.equal(runtime.batch.phase, "stopped");
});
