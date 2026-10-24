import test from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
test("bounded symmetric position requires both tokens and respects budget", () => {
  const lo = TickUtil.getSqrtPriceAtTick(-600),
    hi = TickUtil.getSqrtPriceAtTick(600),
    price = new BN(2).pow(new BN(64));
  const budget = new BN(20000000);
  const l = LiquidityMathUtil.getLiquidityFromAmounts(
    price,
    lo,
    hi,
    budget,
    budget
  );
  const a = LiquidityMathUtil.getAmountsForLiquidity(price, lo, hi, l, true);
  assert(l.gtn(0));
  assert(a.amountA.gtn(0) && a.amountB.gtn(0));
  assert(a.amountA.lte(budget) && a.amountB.lte(budget));
});
test("withdraw rounding never promises more principal than deposit rounding", () => {
  for (const t of [-500, -1, 0, 500]) {
    const lo = TickUtil.getSqrtPriceAtTick(-600),
      hi = TickUtil.getSqrtPriceAtTick(600),
      price = TickUtil.getSqrtPriceAtTick(t);
    const l = new BN("123456789012345678");
    const up = LiquidityMathUtil.getAmountsForLiquidity(price, lo, hi, l, true),
      down = LiquidityMathUtil.getAmountsForLiquidity(price, lo, hi, l, false);
    assert(up.amountA.gte(down.amountA) && up.amountB.gte(down.amountB));
    assert(
      up.amountA.sub(down.amountA).lten(1) &&
        up.amountB.sub(down.amountB).lten(1)
    );
  }
});
