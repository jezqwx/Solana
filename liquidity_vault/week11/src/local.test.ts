import test from "node:test";
import assert from "node:assert/strict";
import { range } from "./workflow";
import {
  connection,
  isConfirmedSuccess,
  isReadMethod,
  reconcile,
} from "./runtime";

test("outward rounded ticks bracket 0.9..1.1 and initial price 1", () => {
  const r = range(60);
  assert.equal(r.tickLower % 60, -0);
  assert.equal(r.tickUpper % 60, 0);
  assert(Number(r.priceLower) <= 0.9 && Number(r.priceUpper) >= 1.1);
  assert(r.tickLower < 0 && r.tickUpper > 0);
});
test("unknown, processed and failed transactions never count as confirmed success", () => {
  assert(!isConfirmedSuccess(null));
  assert(!isConfirmedSuccess({ confirmationStatus: "processed", err: null }));
  assert(
    !isConfirmedSuccess({
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    })
  );
  assert(isConfirmedSuccess({ confirmationStatus: "confirmed", err: null }));
  assert(isConfirmedSuccess({ confirmationStatus: "finalized", err: null }));
});
test("RPC backoff never automatically repeats writes or airdrops", () => {
  assert(!isReadMethod("sendTransaction"));
  assert(!isReadMethod("requestAirdrop"));
  assert(isReadMethod("getSignatureStatuses"));
  assert(isReadMethod("getMultipleAccounts"));
  assert(isReadMethod("simulateTransaction"));
});

test("unavailable signature status still checks expected accounts and stops without changing the journal", async () => {
  const originalStatus = connection.getSignatureStatuses;
  const originalAccounts = connection.getMultipleAccountsInfo;
  let checkedAccounts = false;
  const m = {
    transactions: {
      pool: {
        signature: "offline-test",
        expectedAccounts: ["11111111111111111111111111111111"],
        status: "prepared",
      },
    },
  };
  const before = JSON.stringify(m);
  try {
    connection.getSignatureStatuses = async () => {
      throw new Error("simulated RPC timeout");
    };
    connection.getMultipleAccountsInfo = async () => {
      checkedAccounts = true;
      return [null];
    };
    await assert.rejects(
      () => reconcile(m, "pool"),
      /STOP: pool status unresolved/
    );
    assert(checkedAccounts);
    assert.equal(JSON.stringify(m), before);
  } finally {
    connection.getSignatureStatuses = originalStatus;
    connection.getMultipleAccountsInfo = originalAccounts;
  }
});
