import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import BN from "bn.js";
import {
  Transaction,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { verifyBaseline } from "../../week11/src/runtime";
import * as c from "./client";

export async function run() {
  await c.guard();
  const m = c.load();
  const p = c.program();
  assert(m.initialCheckPassed !== false);
  await c.send(m, "initialize-vault", () =>
    p.methods
      .initializeVault()
      .accountsStrict({
        admin: c.owner,
        assetMint: c.assetMint,
        vault: c.vault,
        shareMint: c.shareMint,
        tokenVault: c.tokenVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction()
  );
  await c.send(m, "open-position", async () =>
    (
      await p.methods
        .openPosition()
        .accountsStrict({
          user: c.owner,
          vault: c.vault,
          position: c.position,
          systemProgram: SystemProgram.programId,
        })
        .transaction()
    ).add(
      createAssociatedTokenAccountIdempotentInstruction(
        c.owner,
        c.userShares,
        c.owner,
        c.shareMint
      )
    )
  );
  await c.send(m, "initialize-strategy", () =>
    p.methods
      .initializeStrategy()
      .accountsStrict(c.initAccounts())
      .transaction()
  );
  const strategyInfo = await c.connection.getAccountInfo(c.strategy);
  assert.equal(strategyInfo?.data.length, 138);
  const second = await getAccount(c.connection, c.quoteVault);
  assert(second.owner.equals(c.vault) && second.mint.equals(c.quoteMint));
  await c.send(m, "deposit", () =>
    p.methods
      .deposit(new BN("100000000"), new BN("100000000"))
      .accountsStrict(c.depositAccounts())
      .transaction()
  );

  if (!m.transactions.forward) {
    let q = await c.quote(new BN("1000000"), true);
    const rogue = Keypair.generate();
    const cases: [string, Record<string, PublicKey>, RegExp, Keypair[]?][] = [
      [
        "admin-only",
        { admin: rogue.publicKey },
        /Error Code: UnauthorizedAdmin\./,
        [rogue],
      ],
      [
        "wrong-pool",
        { pool: new PublicKey(c.w11.pool.config) },
        /Error Code: AccountDiscriminatorMismatch\./,
      ],
      [
        "wrong-mint",
        { quoteMint: c.assetMint },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "wrong-source",
        { tokenVault: c.userAssets },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "foreign-destination",
        { quoteVault: new PublicKey(c.w11.tokens[1].ata) },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "fake-cpi-target",
        { raydiumProgram: TOKEN_PROGRAM_ID },
        /Error Code: InvalidProgramId\./,
      ],
      [
        "wrong-pool-vault",
        { poolVaultA: new PublicKey(c.w11.pool.vault1) },
        /Error Code: Constraint(Address|TokenMint)\./,
      ],
      [
        "wrong-observation",
        { observation: c.poolId },
        /Error Code: ConstraintAddress\./,
      ],
    ];
    for (const [label, overrides, error, signers] of cases) {
      if (Date.now() - q.observedAt > 30_000)
        q = await c.quote(new BN("1000000"), true);
      await c.reject(m, label, await c.swapTx(q, overrides), error, signers);
    }
    q = await c.quote(new BN("1000000"), true);
    await c.reject(
      m,
      "zero-input",
      await c.swapTx(q, {}, q.minimum, new BN(0)),
      /Error Code: InvalidSwapAmount\./
    );
    await c.reject(
      m,
      "zero-minimum",
      await c.swapTx(q, {}, new BN(0)),
      /Error Code: InvalidSwapAmount\./
    );
    await c.reject(
      m,
      "wrong-tick-array",
      await c.swapTx({ ...q, accounts: [c.assetMint] }),
      /Error Code: InvalidRaydiumAccount\./
    );
    await c.reject(
      m,
      "insufficient-input",
      await c.swapTx(q, {}, q.minimum, new BN("1000000000000")),
      /Error Code: InsufficientAssetBalance\./
    );
    await c.reject(
      m,
      "initial-slippage-lock-rollback",
      await c.swapTx(q, {}, q.expected.muln(10)),
      /Error Code: TooLittleOutputReceived\./,
      [],
      true
    );
    const before = await c.state();
    assert.equal(before.shareAuthority, c.vault.toBase58());
    q = await c.quote(new BN("1000000"), true);
    m.forwardQuote = {
      input: q.amount.toString(),
      expected: q.expected.toString(),
      minimum: q.minimum.toString(),
      slippageBps: 100,
      before,
    };
    c.save(m);
    console.log("Fresh forward quote", m.forwardQuote);
    await c.send(m, "forward", () => c.swapTx(q));
  } else {
    await c.reconcile(m, "forward");
  }

  if (!m.transactions.reverse) {
    const after = await c.state(),
      before = m.forwardQuote.before;
    assert.equal(
      BigInt(before.assets) - BigInt(after.assets),
      BigInt("1000000")
    );
    assert(
      BigInt(after.quote) - BigInt(before.quote) >=
        BigInt(m.forwardQuote.minimum)
    );
    assert.equal(after.shareAuthority, c.strategy.toBase58());
    assert.equal(after.supply, before.supply);
    assert(BigInt(after.sqrtPriceX64) < BigInt(before.sqrtPriceX64));
    m.forwardResult = after;
    c.save(m);
    await c.reject(
      m,
      "deposit-locked",
      await p.methods
        .deposit(new BN(1), new BN(1))
        .accountsStrict(c.depositAccounts())
        .transaction(),
      /Error Code: StrategyActive\./
    );
    await c.reject(
      m,
      "withdraw-locked",
      await p.methods
        .withdraw(new BN(1), new BN(1))
        .accountsStrict(c.depositAccounts())
        .transaction(),
      /Error Code: StrategyActive\./
    );
    await c.reject(
      m,
      "cannot-unlock-with-quote",
      await p.methods.endStrategy().accountsStrict(c.base()).transaction(),
      /Error Code: StrategyNotSettled\./
    );
    // Reinitialization succeeds but must leave the active lock unchanged.
    await c.send(m, "reinitialize-strategy", () =>
      p.methods
        .initializeStrategy()
        .accountsStrict(c.initAccounts())
        .transaction()
    );
    assert.equal((await c.state()).shareAuthority, c.strategy.toBase58());
    const badQuote = await c.quote(new BN("1000000"), true);
    await c.reject(
      m,
      "slippage",
      await c.swapTx(badQuote, {}, badQuote.expected.muln(10)),
      /Error Code: TooLittleOutputReceived\./,
      [],
      true
    );
    const reverse = await c.quote(new BN(after.quote), false);
    m.reverseQuote = {
      input: reverse.amount.toString(),
      expected: reverse.expected.toString(),
      minimum: reverse.minimum.toString(),
      before: after,
    };
    c.save(m);
    console.log("Fresh reverse quote", m.reverseQuote);
    await c.send(m, "reverse", () => c.swapTx(reverse));
  } else {
    await c.reconcile(m, "reverse");
  }
  if (!m.transactions["end-strategy"]) {
    const s = await c.state();
    assert.equal(s.quote, "0");
    assert.equal(s.shareAuthority, c.strategy.toBase58());
    m.reverseResult = s;
    c.save(m);
  }
  await c.send(m, "end-strategy", () =>
    p.methods.endStrategy().accountsStrict(c.base()).transaction()
  );
  assert.equal((await c.state()).shareAuthority, c.vault.toBase58());
  await c.send(m, "deposit-after-unlock", () =>
    p.methods
      .deposit(new BN("1000000"), new BN("999000"))
      .accountsStrict(c.depositAccounts())
      .transaction()
  );
  await c.send(m, "withdraw-after-unlock", async () => {
    const shares = await getMint(c.connection, c.shareMint);
    return p.methods
      .withdraw(new BN(shares.supply.toString()), new BN("100000000"))
      .accountsStrict(c.depositAccounts())
      .transaction();
  });
  m.tests = { positive: 8, negative: Object.keys(m.negativeTests).length };
  m.verification = await verify();
  c.save(m);
}
export async function verify() {
  await c.guard();
  const m = c.load();
  await verifyBaseline();
  assert.deepEqual(
    Object.keys(m.transactions).sort(),
    [
      "initialize-vault",
      "open-position",
      "initialize-strategy",
      "deposit",
      "forward",
      "reinitialize-strategy",
      "reverse",
      "end-strategy",
      "deposit-after-unlock",
      "withdraw-after-unlock",
    ].sort(),
    "Every successful scenario must have a recorded transaction"
  );
  const entries = Object.values(m.transactions) as c.Journal[];
  const statuses = (
    await c.connection.getSignatureStatuses(
      entries.map((t) => t.signature),
      { searchTransactionHistory: true }
    )
  ).value;
  statuses.forEach((s) =>
    assert(
      s &&
        ["confirmed", "finalized"].includes(s.confirmationStatus ?? "") &&
        s.err === null
    )
  );
  const current = await c.state();
  assert.equal(current.quote, "0");
  assert.equal(current.assets, "0");
  assert.equal(current.supply, "0");
  assert.equal(current.shareAuthority, c.vault.toBase58());
  const strategyInfo = await c.connection.getAccountInfo(c.strategy);
  assert(strategyInfo);
  assert.equal(strategyInfo.data.length, 138);
  assert.equal(strategyInfo.data[136], 0);
  const vaultInfo = await c.connection.getAccountInfo(c.vault),
    positionInfo = await c.connection.getAccountInfo(c.position);
  assert.equal(vaultInfo?.data.length, 145);
  assert.equal(positionInfo?.data.length, 81);
  const historical = BigInt("101000000") + (await confirmedWeek13Deposit());
  assert.equal(vaultInfo!.data.readBigUInt64LE(136), historical);
  assert.equal(positionInfo!.data.readBigUInt64LE(72), historical);
  assert.equal(Object.keys(m.negativeTests).length, 17);
  for (const test of Object.values(m.negativeTests) as c.Journal[])
    assert(
      test.status === "passed" && test.unchanged && test.published === false
    );
  const forward = await c.connection.getTransaction(
    m.transactions.forward.signature,
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );
  assert(forward?.meta && forward.meta.err === null);
  const keys = forward.transaction.message.getAccountKeys();
  const inner =
    forward.meta.innerInstructions?.flatMap((i) => i.instructions) ?? [];
  assert(
    inner.some((i) => keys.get(i.programIdIndex)?.equals(c.clmm)),
    "Raydium must appear in inner instructions"
  );
  const balance = await c.connection.getBalance(c.owner);
  const report = {
    status: "PASS",
    verifiedAt: new Date().toISOString(),
    positiveChecks: 8,
    negativeChecks: 17,
    oldVaultAccountsUnchanged: 136,
    forward: m.forwardResult,
    reverse: m.reverseResult,
    current,
    finalBalanceLamports: balance,
    totalSpentLamports: m.startBalanceLamports - balance,
    innerRaydiumCpi: true,
    failedSwapPublished: false,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}
async function confirmedWeek13Deposit(): Promise<bigint> {
  const file = path.join(c.ROOT, "../week13/manifest.devnet.json");
  if (!fs.existsSync(file)) return 0n;
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const deposit = m.transactions?.deposit;
  if (!deposit) return 0n;
  assert.equal(m.vault, c.vault.toBase58());
  assert.equal(m.wallet, c.owner.toBase58());
  const tx = await c.connection.getTransaction(deposit.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  assert(tx?.meta && tx.meta.err === null);
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  const discriminator = createHash("sha256")
    .update("global:deposit")
    .digest()
    .subarray(0, 8);
  const ix = tx.transaction.message.compiledInstructions.filter(
    (ix) =>
      keys.get(ix.programIdIndex)?.equals(c.pid) &&
      Buffer.from(ix.data).subarray(0, 8).equals(discriminator)
  );
  assert.equal(ix.length, 1);
  assert(ix[0].accountKeyIndexes.some((i) => keys.get(i)?.equals(c.vault)));
  assert(ix[0].accountKeyIndexes.some((i) => keys.get(i)?.equals(c.position)));
  const amount = Buffer.from(ix[0].data).readBigUInt64LE(8);
  const pre = tx.meta.preTokenBalances?.find((b) =>
    keys.get(b.accountIndex)?.equals(c.tokenVault)
  );
  const post = tx.meta.postTokenBalances?.find((b) =>
    keys.get(b.accountIndex)?.equals(c.tokenVault)
  );
  assert(pre && post);
  assert.equal(
    BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount),
    amount
  );
  return amount;
}
