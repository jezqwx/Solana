import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
} from "@solana/web3.js";
import {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PoolInfoLayout,
  PersonalPositionLayout,
  TickArrayLayout,
  PositionUtils,
  TickUtil,
  LiquidityMathUtil,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import * as c from "./client";
export const binding = c.pda(Buffer.from("clmm-position"), c.vault.toBuffer());
export const metaProgram = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
export const runtime = path.join(c.ROOT, ".runtime");
export function localKey(name: string) {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(runtime, name + "-keypair.json"), "utf8")
      )
    )
  );
}
function createKey(name: string) {
  const file = path.join(runtime, name + "-keypair.json");
  assert(
    !fs.existsSync(file),
    "Unjournalled key exists; inspect before continuing"
  );
  const k = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify([...k.secretKey]), {
    mode: 0o600,
    flag: "wx",
  });
  return k.publicKey;
}
export function nftKeys(m = c.load()) {
  const nft = new PublicKey(m.nftMint);
  const lower = Buffer.alloc(4),
    upper = Buffer.alloc(4);
  lower.writeInt32BE(m.lower);
  upper.writeInt32BE(m.upper);
  return {
    nftMint: nft,
    nftAccount: getAssociatedTokenAddressSync(nft, c.vault, true),
    personalPosition: PublicKey.findProgramAddressSync(
      [Buffer.from("position"), nft.toBuffer()],
      c.clmm
    )[0],
    protocolPosition: PublicKey.findProgramAddressSync(
      [Buffer.from("position"), c.poolId.toBuffer(), lower, upper],
      c.clmm
    )[0],
    metadata: PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), metaProgram.toBuffer(), nft.toBuffer()],
      metaProgram
    )[0],
  };
}
export function openAccounts(m = c.load()) {
  return {
    ...c.base(),
    clmmPosition: binding,
    pool: c.poolId,
    poolVaultA: new PublicKey(c.w11.pool.vault0),
    poolVaultB: new PublicKey(c.w11.pool.vault1),
    tickLower: new PublicKey(c.w11.position.tickArrayLower),
    tickUpper: new PublicKey(c.w11.position.tickArrayUpper),
    bitmap: new PublicKey(c.w11.pool.bitmap),
    ...nftKeys(m),
    raydiumProgram: c.clmm,
    tokenProgram2022: new PublicKey(
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    ),
    metadataProgram: metaProgram,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };
}
export function manageAccounts(m = c.load()): Record<string, any> {
  const a = openAccounts(m);
  const {
    metadata,
    metadataProgram,
    associatedTokenProgram,
    rent,
    pool,
    poolVaultA,
    poolVaultB,
    tickLower,
    tickUpper,
    bitmap,
    protocolPosition,
    ...rest
  } = a;
  return {
    ...rest,
    raydium: {
      pool,
      poolVaultA,
      poolVaultB,
      tickLower,
      tickUpper,
      bitmap,
      protocolPosition,
    },
    memoProgram: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  };
}
export const budget = (tx: Transaction) =>
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 650000 }));
export const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export async function manualUnchanged(m = c.load()) {
  const keys = m.manualKeys.map((s: string) => new PublicKey(s));
  const infos = await c.connection.getMultipleAccountsInfo(keys);
  assert.deepEqual(
    infos.map((i) => i && hash(i.data)),
    m.manualHashes,
    "Week 11 manual position/NFT must be unchanged"
  );
}
export async function preflight() {
  await c.guard();
  const state = await c.state();
  const balance = await c.connection.getBalance(c.owner);
  const data = await c.connection.getAccountInfo(c.poolId);
  assert(data);
  const pool = PoolInfoLayout.decode(data.data);
  assert.equal(pool.tickSpacing, 60);
  assert(pool.liquidity.gt(new BN(0)));
  assert(
    pool.rewardInfos.every((r) => r.mint.equals(PublicKey.default)),
    "Reward campaigns unsupported"
  );
  for (const mint of [c.assetMint, c.quoteMint]) {
    const token = await getMint(c.connection, mint);
    assert.equal(token.decimals, 6);
    assert.equal(token.freezeAuthority, null);
    const a = await getAccount(
      c.connection,
      getAssociatedTokenAddressSync(mint, c.owner)
    );
    assert(a.amount > 100000000n);
  }
  if (!fs.existsSync(c.FILE)) {
    assert.equal(state.assets, "0");
    assert.equal(state.quote, "0");
    assert.equal(state.supply, "0");
    assert.equal(state.shareAuthority, c.vault.toBase58());
    assert.equal(await c.connection.getAccountInfo(binding), null);
    assert(balance > 2_000_000_000, "Insufficient deployment reserve");
    assert(pool.tickCurrent > -600 && pool.tickCurrent < 600);
    fs.mkdirSync(runtime, { recursive: true });
    const nft = createKey("nft"),
      trader = createKey("trader");
    const manualKeys = [
      c.w11.position.personalPosition,
      c.w11.position.nftMint,
      c.w11.position.positionNftAccount,
    ];
    const infos = await c.connection.getMultipleAccountsInfo(
      manualKeys.map((s: string) => new PublicKey(s))
    );
    assert(infos.every(Boolean));
    const v = await c.connection.getAccountInfo(c.vault),
      u = await c.connection.getAccountInfo(c.position);
    assert(v && u);
    const m = {
      schema: 1,
      genesisHash: c.w11.genesisHash,
      programId: c.pid.toBase58(),
      poolId: c.poolId.toBase58(),
      wallet: c.owner.toBase58(),
      vault: c.vault.toBase58(),
      strategy: c.strategy.toBase58(),
      binding: binding.toBase58(),
      assetMint: c.assetMint.toBase58(),
      quoteMint: c.quoteMint.toBase58(),
      tokenVault: c.tokenVault.toBase58(),
      quoteVault: c.quoteVault.toBase58(),
      nftMint: nft.toBase58(),
      trader: trader.toBase58(),
      lower: -600,
      upper: 600,
      initial: state,
      startBalanceLamports: balance,
      initialVaultHistory: v.data.readBigUInt64LE(136).toString(),
      initialPositionHistory: u.data.readBigUInt64LE(72).toString(),
      manualKeys,
      manualHashes: infos.map((i) => hash(i!.data)),
      transactions: {},
      negativeTests: {},
    };
    c.save(m);
  }
  const m = c.load();
  await manualUnchanged(m);
  console.log("PREFLIGHT PASS", {
    wallet: c.owner.toBase58(),
    balanceSOL: balance / 1e9,
    state,
    poolLiquidity: pool.liquidity.toString(),
    tickSpacing: pool.tickSpacing,
    range: [m.lower, m.upper],
    nftMint: m.nftMint,
    trader: m.trader,
  });
}
export async function read() {
  await c.guard();
  const m = c.load(),
    k = nftKeys(m);
  await manualUnchanged(m);
  const infos = await c.connection.getMultipleAccountsInfo([
    c.poolId,
    k.personalPosition,
    new PublicKey(c.w11.position.tickArrayLower),
    new PublicKey(c.w11.position.tickArrayUpper),
    binding,
  ]);
  const pool = PoolInfoLayout.decode(infos[0]!.data);
  const position = infos[1]
    ? PersonalPositionLayout.decode(infos[1].data)
    : null;
  let feeA = "0",
    feeB = "0";
  if (position) {
    assert(
      position.nftMint.equals(k.nftMint) && position.poolId.equals(c.poolId)
    );
    const low = TickArrayLayout.decode(infos[2]!.data),
      high = TickArrayLayout.decode(infos[3]!.data);
    const fees = PositionUtils.GetPositionFees(
      pool,
      position,
      low.ticks[(m.lower - low.startTickIndex) / 60],
      high.ticks[(m.upper - high.startTickIndex) / 60]
    );
    feeA = fees.tokenFeeAmountA.toString();
    feeB = fees.tokenFeeAmountB.toString();
  }
  const result = {
    ...(await c.state()),
    positionExists: !!position,
    liquidity: position?.liquidity.toString() ?? "0",
    feeA,
    feeB,
    bindingOpen: infos[4] ? !!infos[4].data[144] : false,
    poolLiquidity: pool.liquidity.toString(),
  };
  return result;
}
export async function amountQuote(liquidity?: BN) {
  const m = c.load();
  const data = await c.connection.getAccountInfo(c.poolId);
  assert(data);
  const pool = PoolInfoLayout.decode(data.data);
  const lo = TickUtil.getSqrtPriceAtTick(m.lower),
    hi = TickUtil.getSqrtPriceAtTick(m.upper);
  const l =
    liquidity ??
    LiquidityMathUtil.getLiquidityFromAmounts(
      pool.sqrtPriceX64,
      lo,
      hi,
      new BN(20000000),
      new BN(20000000)
    );
  const amounts = LiquidityMathUtil.getAmountsForLiquidity(
    pool.sqrtPriceX64,
    lo,
    hi,
    l,
    !liquidity
  );
  return { liquidity: l, a: amounts.amountA, b: amounts.amountB };
}
export async function lookup(m: c.Journal) {
  if (!m.lookupTable && m.transactions["lookup-create"]) {
    await c.reconcile(m, "lookup-create");
    assert(m.lookupTablePlanned);
    m.lookupTable = m.lookupTablePlanned;
    c.save(m);
  }
  if (!m.lookupTable) {
    const slot = await c.connection.getSlot("finalized");
    const [ix, address] = AddressLookupTableProgram.createLookupTable({
      authority: c.owner,
      payer: c.owner,
      recentSlot: slot,
    });
    m.lookupTablePlanned = address.toBase58();
    c.save(m);
    await c.send(m, "lookup-create", async () => new Transaction().add(ix));
    m.lookupTable = address.toBase58();
    c.save(m);
  }
  const addresses = [
    ...new Map(
      Object.values(openAccounts(m)).map((k) => [k.toBase58(), k])
    ).values(),
  ];
  for (let i = 0; i < addresses.length; i += 15)
    await c.send(m, "lookup-extend-" + i, async () =>
      new Transaction().add(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: new PublicKey(m.lookupTable),
          authority: c.owner,
          payer: c.owner,
          addresses: addresses.slice(i, i + 15),
        })
      )
    );
}
