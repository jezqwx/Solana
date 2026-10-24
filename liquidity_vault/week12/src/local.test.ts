import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { minimumOut } from "./client";
test("1% minimum floors exact raw integers", () => {
  assert.equal(minimumOut(new BN("997453")).toString(), "987478");
  assert.equal(
    minimumOut(new BN("18446744073709551615")).toString(),
    "18262276632972456098"
  );
});
test("zero and invalid slippage cannot create an unprotected swap", () => {
  assert.throws(() => minimumOut(new BN(0)));
  assert.throws(() => minimumOut(new BN(1), 100));
  assert.throws(() => minimumOut(new BN(100), 10000));
  assert.throws(() => minimumOut(new BN(100), -1));
});
