import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { ClmmInstrument } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import * as c from "./client";
import * as p from "./position";
const bn = (n: string | number) => new BN(n);
// A restarted command must resolve every earlier write before advancing any stage.
export async function reconcileAll() {
  const m = c.load(),
    labels = Object.keys(m.transactions);
  if (!labels.length) return;
  const statuses = (
    await c.connection.getSignatureStatuses(
      labels.map((l) => m.transactions[l].signature),
      { searchTransactionHistory: true }
    )
  ).value;
  for (let i = 0; i < labels.length; i++) {
    const s = statuses[i];
    if (
      !s ||
      s.err !== null ||
      !["confirmed", "finalized"].includes(s.confirmationStatus ?? "")
    )
      await c.reconcile(m, labels[i]);
  }
  // Reconstruct post-confirmation evidence if the process stopped before saving it.
  for (const [label, field, accounts] of [
    ["collect", "collected", [c.tokenVault, c.quoteVault]],
    ["decrease", "returned", [c.tokenVault, c.quoteVault]],
    ["withdraw", "withdrawnAssets", [c.userAssets]],
  ] as [string, string, PublicKey[]][]) {
    if (!m.transactions[label] || m[field]) continue;
    const tx = await c.connection.getTransaction(
      m.transactions[label].signature,
      { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    );
    assert(tx?.meta && tx.meta.err === null);
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    });
    const values = accounts.map((account) => {
      const pre = tx.meta!.preTokenBalances?.find((b) =>
          keys.get(b.accountIndex)?.equals(account)
        ),
        post = tx.meta!.postTokenBalances?.find((b) =>
          keys.get(b.accountIndex)?.equals(account)
        );
      assert(pre && post);
      const delta =
        BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount);
      assert(delta > 0n);
      return delta.toString();
    });
    m[field] = values.length === 1 ? values[0] : { a: values[0], b: values[1] };
    c.save(m);
  }
}
async function negative(
  m: c.Journal,
  label: string,
  build: () => Promise<Transaction>,
  expected: RegExp,
  signers: Keypair[] = []
) {
  if (m.negativeTests[label]) return;
  await c.reject(m, label, await build(), expected, signers);
}
async function snapshot(m: c.Journal, label: string) {
  m.snapshots ??= {};
  m.snapshots[label] = await p.read();
  c.save(m);
  return m.snapshots[label];
}
const openTx = async (m: c.Journal, lower = m.lower, upper = m.upper) =>
  p.budget(
    await c
      .program()
      .methods.openClmmPosition(lower, upper)
      .accountsStrict(p.openAccounts(m))
      .transaction()
  );
const manageTx = async (
  name: string,
  args: BN[],
  overrides: Record<string, any> = {}
) =>
  p.budget(
    await c
      .program()
      .methods[name](...args)
      .accountsStrict({ ...p.manageAccounts(), ...overrides })
      .transaction()
  );
export async function open() {
  const m = c.load();
  await p.manualUnchanged(m);
  await p.lookup(m);
  await c.send(m, "deposit", () =>
    c
      .program()
      .methods.deposit(bn(100000000), bn(100000000))
      .accountsStrict(c.depositAccounts())
      .transaction()
  );
  if (!m.transactions["prepare-swap"]) {
    await negative(
      m,
      "invalid-ticks",
      () => openTx(m, -601, 600),
      /Error Code: InvalidClmmTicks\./,
      [p.localKey("nft")]
    );
    await negative(
      m,
      "end-with-empty-quote-and-open-position",
      async () => {
        const tx = await openTx(m);
        tx.add(
          await c
            .program()
            .methods.endStrategy()
            .accountsStrict(c.base())
            .instruction()
        );
        return tx;
      },
      /Error Code: InvalidStrategyLock\./,
      [p.localKey("nft")]
    );
    const q = await c.quote(bn(50000000), true);
    m.prepareQuote = {
      input: q.amount.toString(),
      expected: q.expected.toString(),
      minimum: q.minimum.toString(),
    };
    c.save(m);
    await c.send(m, "prepare-swap", () => c.swapTx(q));
  }
  await c.send(m, "open", () => openTx(m), [p.localKey("nft")]);
  if (!m.transactions.add) {
    const s = await snapshot(m, "opened");
    assert(s.positionExists && s.bindingOpen && s.liquidity === "0");
    assert.equal(s.shareAuthority, p.binding.toBase58());
    const n = await getAccount(c.connection, p.nftKeys().nftAccount);
    assert(n.owner.equals(c.vault) && n.amount === 1n);
    m.nftOwnership = {
      authority: n.owner.toBase58(),
      amount: n.amount.toString(),
      account: p.nftKeys().nftAccount.toBase58(),
    };
    c.save(m);
  }
}
export async function add() {
  const m = c.load();
  const rogue = Keypair.generate();
  const a = p.manageAccounts(m);
  if (!m.transactions.add) {
    const cases: [string, Record<string, any>, RegExp, Keypair[]?][] = [
      [
        "admin-only",
        { admin: rogue.publicKey },
        /Error Code: UnauthorizedAdmin\./,
        [rogue],
      ],
      [
        "wrong-pool",
        { raydium: { ...a.raydium, pool: new PublicKey(c.w11.pool.config) } },
        /Error Code: AccountDiscriminatorMismatch\./,
      ],
      [
        "wrong-mint",
        { quoteMint: c.assetMint },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "wrong-vault",
        { tokenVault: c.userAssets },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "wrong-position",
        { personalPosition: new PublicKey(c.w11.position.personalPosition) },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "wrong-nft-authority",
        { nftAccount: new PublicKey(c.w11.position.positionNftAccount) },
        /Error Code: InvalidClmmPosition\./,
      ],
      [
        "wrong-fee-recipient",
        { quoteVault: getAssociatedTokenAddressSync(c.quoteMint, c.owner) },
        /Error Code: ConstraintHasOne\./,
      ],
      [
        "wrong-cpi-target",
        { raydiumProgram: SystemProgram.programId },
        /Error Code: InvalidProgramId\./,
      ],
      [
        "wrong-tick-array",
        { raydium: { ...a.raydium, tickLower: c.assetMint } },
        /Error Code: ConstraintOwner\./,
      ],
    ];
    for (const [label, overrides, error, signers] of cases)
      await negative(
        m,
        label,
        () => manageTx("collectClmmFees", [bn(0), bn(0)], overrides),
        error,
        signers
      );
    await negative(
      m,
      "zero-liquidity",
      () => manageTx("increaseClmmLiquidity", [bn(0), bn(1), bn(1)]),
      /Error Code: InvalidClmmLiquidity\./
    );
    await negative(
      m,
      "excess-liquidity",
      () => manageTx("decreaseClmmLiquidity", [bn(1), bn(1), bn(1)]),
      /Error Code: InvalidClmmLiquidity\./
    );
    const q = await p.amountQuote();
    m.addQuote = {
      liquidity: q.liquidity.toString(),
      a: q.a.toString(),
      b: q.b.toString(),
      maxA: q.a.muln(101).divn(100).addn(1).toString(),
      maxB: q.b.muln(101).divn(100).addn(1).toString(),
    };
    c.save(m);
    await c.send(m, "add", () =>
      manageTx("increaseClmmLiquidity", [
        q.liquidity,
        bn(m.addQuote.maxA),
        bn(m.addQuote.maxB),
      ])
    );
  }
  if (!m.transactions["trade-forward"]) {
    const s = await snapshot(m, "invested");
    assert(BigInt(s.liquidity) > 0n);
    assert.equal(s.shareAuthority, p.binding.toBase58());
    for (const [label, name] of [
      ["deposit-invested", "deposit"],
      ["withdraw-invested", "withdraw"],
    ])
      await negative(
        m,
        label,
        () =>
          c
            .program()
            .methods[name](bn(1), bn(1))
            .accountsStrict(c.depositAccounts())
            .transaction(),
        /Error Code: StrategyActive\./
      );
    await negative(
      m,
      "end-invested",
      () =>
        c
          .program()
          .methods.endStrategy()
          .accountsStrict(c.base())
          .transaction(),
      /Error Code: (StrategyNotSettled|InvalidStrategyLock)\./
    );
    await negative(
      m,
      "close-funded-position",
      () => manageTx("closeClmmPosition", []),
      /Error Code: ClmmPositionNotEmpty\./
    );
  }
}
export async function trade() {
  const m = c.load(),
    trader = p.localKey("trader");
  assert(!trader.publicKey.equals(c.owner));
  const ta = getAssociatedTokenAddressSync(c.assetMint, trader.publicKey),
    tb = getAssociatedTokenAddressSync(c.quoteMint, trader.publicKey);
  await c.send(m, "fund-trader", async () =>
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: c.owner,
        toPubkey: trader.publicKey,
        lamports: 20000000,
      }),
      createAssociatedTokenAccountIdempotentInstruction(
        c.owner,
        ta,
        trader.publicKey,
        c.assetMint
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        c.owner,
        tb,
        trader.publicKey,
        c.quoteMint
      ),
      createTransferCheckedInstruction(
        c.userAssets,
        c.assetMint,
        ta,
        c.owner,
        15000000n,
        6
      )
    )
  );
  for (const forward of [true, false]) {
    const label = forward ? "trade-forward" : "trade-reverse";
    if (m.transactions[label]) {
      await c.reconcile(m, label);
      continue;
    }
    const amount = forward
      ? bn(10000000)
      : bn((await getAccount(c.connection, tb)).amount.toString());
    const q = await c.quote(amount, forward);
    m[label + "Quote"] = {
      input: amount.toString(),
      expected: q.expected.toString(),
      minimum: q.minimum.toString(),
      payer: trader.publicKey.toBase58(),
    };
    c.save(m);
    const ix = ClmmInstrument.swapV2Instruction(
      c.clmm,
      trader.publicKey,
      c.poolId,
      new PublicKey(c.w11.pool.config),
      forward ? ta : tb,
      forward ? tb : ta,
      new PublicKey(forward ? c.w11.pool.vault0 : c.w11.pool.vault1),
      new PublicKey(forward ? c.w11.pool.vault1 : c.w11.pool.vault0),
      forward ? c.assetMint : c.quoteMint,
      forward ? c.quoteMint : c.assetMint,
      q.accounts.filter((k) => k.toBase58() !== c.w11.pool.bitmap),
      new PublicKey(c.w11.pool.observation),
      amount,
      q.minimum,
      bn(0),
      true,
      new PublicKey(c.w11.pool.bitmap)
    );
    await c.send(
      m,
      label,
      async () => p.budget(new Transaction().add(ix)),
      [],
      trader
    );
  }
  if (!m.transactions.collect) {
    const s = await snapshot(m, "fees-accrued");
    assert(
      BigInt(s.feeA) > 0n && BigInt(s.feeB) > 0n,
      "Both trading fees must accrue from actual pool/tick/position state"
    );
  }
}
export async function collect() {
  const m = c.load();
  if (!m.transactions.collect) {
    const before = await snapshot(m, "before-collect");
    assert(BigInt(before.feeA) > 0n && BigInt(before.feeB) > 0n);
    await c.send(m, "collect", () =>
      manageTx("collectClmmFees", [bn(1), bn(1)])
    );
    const after = await snapshot(m, "after-collect");
    assert.equal(after.liquidity, before.liquidity);
    const a = BigInt(after.assets) - BigInt(before.assets),
      b = BigInt(after.quote) - BigInt(before.quote);
    assert(a > 0n && b > 0n);
    assert.equal(a.toString(), before.feeA);
    assert.equal(b.toString(), before.feeB);
    m.collected = { a: a.toString(), b: b.toString() };
    c.save(m);
  }
}
export async function decrease() {
  const m = c.load();
  if (m.transactions.decrease) {
    await c.reconcile(m, "decrease");
    return;
  }
  const before = await snapshot(m, "before-decrease");
  const q = await p.amountQuote(bn(before.liquidity));
  const minA = q.a.muln(99).divn(100),
    minB = q.b.muln(99).divn(100);
  assert(minA.gtn(0) || minB.gtn(0));
  m.decreaseQuote = {
    liquidity: q.liquidity.toString(),
    expectedA: q.a.toString(),
    expectedB: q.b.toString(),
    minA: minA.toString(),
    minB: minB.toString(),
  };
  c.save(m);
  await c.send(m, "decrease", () =>
    manageTx("decreaseClmmLiquidity", [q.liquidity, minA, minB])
  );
  const after = await snapshot(m, "after-decrease");
  assert.equal(after.liquidity, "0");
  assert(
    BigInt(after.assets) > BigInt(before.assets) &&
      BigInt(after.quote) > BigInt(before.quote)
  );
  m.returned = {
    a: (BigInt(after.assets) - BigInt(before.assets)).toString(),
    b: (BigInt(after.quote) - BigInt(before.quote)).toString(),
  };
  c.save(m);
}
export async function close() {
  const m = c.load();
  await c.send(m, "close", () => manageTx("closeClmmPosition", []));
  const k = p.nftKeys();
  assert.equal(await c.connection.getAccountInfo(k.personalPosition), null);
  assert.equal(await c.connection.getAccountInfo(k.nftAccount), null);
  assert.equal((await getMint(c.connection, k.nftMint)).supply, 0n);
  if (!m.transactions.end) {
    const s = await snapshot(m, "closed");
    assert(!s.positionExists && !s.bindingOpen);
    assert.equal(s.shareAuthority, c.strategy.toBase58());
  }
  await negative(
    m,
    "double-close",
    () => manageTx("closeClmmPosition", []),
    /Error Code: (AccountNotInitialized|ClmmPositionClosed)\./
  );
}
export async function reverse() {
  const m = c.load();
  if (m.transactions.reverse) {
    await c.reconcile(m, "reverse");
    return;
  }
  const s = await p.read();
  assert(!s.positionExists && !s.bindingOpen);
  const q = await c.quote(bn(s.quote), false);
  m.reverseQuote = {
    input: q.amount.toString(),
    expected: q.expected.toString(),
    minimum: q.minimum.toString(),
  };
  c.save(m);
  await c.send(m, "reverse", () => c.swapTx(q));
  assert.equal((await p.read()).quote, "0");
}
export async function end() {
  const m = c.load();
  await c.send(m, "end", () =>
    c.program().methods.endStrategy().accountsStrict(c.base()).transaction()
  );
  assert.equal((await c.state()).shareAuthority, c.vault.toBase58());
  if (!m.transactions.withdraw) {
    const s = await snapshot(m, "before-withdraw");
    const shares = (await getMint(c.connection, c.shareMint)).supply;
    const userBefore = (await getAccount(c.connection, c.userAssets)).amount;
    await c.send(m, "withdraw", () =>
      c
        .program()
        .methods.withdraw(bn(shares.toString()), bn(s.assets))
        .accountsStrict(c.depositAccounts())
        .transaction()
    );
    const after = (await getAccount(c.connection, c.userAssets)).amount;
    assert.equal(after - userBefore, BigInt(s.assets));
    m.withdrawnAssets = (after - userBefore).toString();
    c.save(m);
  }
  const trader = p.localKey("trader"),
    ta = getAssociatedTokenAddressSync(c.assetMint, trader.publicKey),
    tb = getAssociatedTokenAddressSync(c.quoteMint, trader.publicKey);
  await c.send(
    m,
    "refund-trader",
    async () => {
      const a = await getAccount(c.connection, ta),
        b = await getAccount(c.connection, tb);
      const sol = await c.connection.getBalance(trader.publicKey);
      const tx = new Transaction();
      if (a.amount)
        tx.add(
          createTransferCheckedInstruction(
            ta,
            c.assetMint,
            c.userAssets,
            trader.publicKey,
            a.amount,
            6
          )
        );
      if (b.amount)
        tx.add(
          createTransferCheckedInstruction(
            tb,
            c.quoteMint,
            getAssociatedTokenAddressSync(c.quoteMint, c.owner),
            trader.publicKey,
            b.amount,
            6
          )
        );
      tx.add(
        createCloseAccountInstruction(ta, c.owner, trader.publicKey),
        createCloseAccountInstruction(tb, c.owner, trader.publicKey),
        SystemProgram.transfer({
          fromPubkey: trader.publicKey,
          toPubkey: c.owner,
          lamports: sol,
        })
      );
      return tx;
    },
    [trader]
  );
}
export async function verify() {
  const m = c.load();
  await c.guard();
  await p.manualUnchanged(m);
  const required = [
    "lookup-create",
    "lookup-extend-0",
    "lookup-extend-15",
    "deposit",
    "prepare-swap",
    "open",
    "add",
    "fund-trader",
    "trade-forward",
    "trade-reverse",
    "collect",
    "decrease",
    "close",
    "reverse",
    "end",
    "withdraw",
    "refund-trader",
  ];
  for (const label of required)
    assert(m.transactions[label], `Missing ${label}`);
  const statuses = (
    await c.connection.getSignatureStatuses(
      required.map((l) => m.transactions[l].signature),
      { searchTransactionHistory: true }
    )
  ).value;
  assert(
    statuses.every(
      (s) =>
        s?.err === null &&
        ["confirmed", "finalized"].includes(s.confirmationStatus ?? "")
    )
  );
  const s = await p.read();
  assert.equal(s.assets, "0");
  assert.equal(s.quote, "0");
  assert.equal(s.supply, "0");
  assert.equal(s.shareAuthority, c.vault.toBase58());
  assert(!s.positionExists && !s.bindingOpen);
  const v = await c.connection.getAccountInfo(c.vault),
    u = await c.connection.getAccountInfo(c.position),
    b = await c.connection.getAccountInfo(p.binding),
    st = await c.connection.getAccountInfo(c.strategy);
  assert.equal(v?.data.length, 145);
  assert.equal(u?.data.length, 81);
  assert.equal(b?.data.length, 146);
  assert.equal(st?.data.length, 138);
  assert.equal(st!.data[136], 0);
  assert.equal(
    v!.data.readBigUInt64LE(136),
    BigInt(m.initialVaultHistory) + 100000000n
  );
  assert.equal(
    u!.data.readBigUInt64LE(72),
    BigInt(m.initialPositionHistory) + 100000000n
  );
  const k = p.nftKeys();
  assert.equal(await c.connection.getAccountInfo(k.nftAccount), null);
  assert.equal((await getMint(c.connection, k.nftMint)).supply, 0n);
  assert.equal(Object.keys(m.negativeTests).length, 18);
  assert(
    Object.values(m.negativeTests).every(
      (t: any) => t.unchanged && t.published === false && t.status === "passed"
    )
  );
  assert(BigInt(m.collected.a) > 0n && BigInt(m.collected.b) > 0n);
  assert.equal(await c.connection.getBalance(new PublicKey(m.trader)), 0);
  const tx = await c.connection.getTransaction(
    m.transactions.collect.signature,
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );
  assert(tx?.meta && tx.meta.err === null);
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  assert(
    tx.meta.innerInstructions?.some((g) =>
      g.instructions.some((ix) => keys.get(ix.programIdIndex)?.equals(c.clmm))
    )
  );
  const balance = await c.connection.getBalance(c.owner);
  const report = {
    status: "PASS",
    positiveTransactions: required.length,
    negativeSimulations: 18,
    collected: m.collected,
    returned: m.returned,
    withdrawnAssets: m.withdrawnAssets,
    manualPositionUnchanged: true,
    current: s,
    balanceLamports: balance,
    spentLamports: m.startBalanceLamports - balance,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}
export async function run() {
  await reconcileAll();
  for (const f of [open, add, trade, collect, decrease, close, reverse, end])
    await f();
  const m = c.load();
  m.verification = await verify();
  c.save(m);
}
