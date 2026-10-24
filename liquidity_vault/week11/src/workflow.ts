import assert from "node:assert/strict";
import fs from "node:fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
} from "@solana/spl-token";
import {
  Raydium,
  TxVersion,
  DEVNET_PROGRAM_ID,
  DEV_API_URLS,
  ClmmConfigLayout,
  PoolInfoLayout,
  ObservationLayout,
  PersonalPositionLayout,
  ProtocolPositionLayout,
  TickArrayLayout,
  TickArrayBitmapExtensionLayout,
  TickUtil,
  TickArrayUtil,
  LiquidityMathUtil,
  getPdaAmmConfigId,
  getPdaPoolId,
  getPdaPoolVaultId,
  getPdaObservationAccount,
  getPdaExBitmapAccount,
  getPdaPersonalPositionAddress,
  getPdaTickArrayAddress,
  toApiV3Token,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import type { ClmmKeys } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import {
  AMM_CONFIG,
  CLMM,
  DECIMALS,
  EXPECTED_WALLET,
  SUPPLY,
  MAX_SPEND_LAMPORTS,
} from "./config";
import {
  connection,
  guard,
  manifest,
  manifestPath,
  baselinePath,
  atomicJSON,
  initialManifest,
  save,
  snapshotVaults,
  verifyBaseline,
  signingWallet,
  reconcile,
  send,
  RecordData,
} from "./runtime";

const owner = new PublicKey(EXPECTED_WALLET);
const pk = (key: string) => new PublicKey(key);
async function owned(address: PublicKey, program: PublicKey, size?: number) {
  const info = await connection.getAccountInfo(address, "confirmed");
  assert(info, `Missing ${address}`);
  assert(info.owner.equals(program), `Wrong program owner: ${address}`);
  if (size !== undefined)
    assert.equal(info.data.length, size, `Unexpected layout size: ${address}`);
  return info;
}
export async function config() {
  assert(CLMM.equals(DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID));
  assert(getPdaAmmConfigId(CLMM, 0).publicKey.equals(AMM_CONFIG));
  const info = await owned(AMM_CONFIG, CLMM, ClmmConfigLayout.span);
  const c = ClmmConfigLayout.decode(info.data);
  assert.equal(c.index, 0);
  assert.equal(c.tickSpacing, 60);
  assert.equal(c.tradeFeeRate, 2500);
  return {
    id: AMM_CONFIG,
    index: c.index,
    tickSpacing: c.tickSpacing,
    tradeFeeRate: c.tradeFeeRate,
    protocolFeeRate: c.protocolFeeRate,
    fundFeeRate: c.fundFeeRate,
    fundOwner: c.fundOwner.toBase58(),
    description: "Devnet 0.25%, spacing 60",
  };
}
export function range(spacing: number) {
  const lower =
    Math.floor(
      TickUtil.priceToTick(new Decimal("0.9"), DECIMALS, DECIMALS) / spacing
    ) * spacing;
  const upper =
    Math.ceil(
      TickUtil.priceToTick(new Decimal("1.1"), DECIMALS, DECIMALS) / spacing
    ) * spacing;
  assert(
    lower < 0 && upper > 0 && lower % spacing === 0 && upper % spacing === 0
  );
  return {
    tickLower: lower,
    tickUpper: upper,
    priceLower: TickUtil.tickToPrice(lower, DECIMALS, DECIMALS).toString(),
    priceUpper: TickUtil.tickToPrice(upper, DECIMALS, DECIMALS).toString(),
  };
}
async function sdk() {
  // Official V2 demo workflow, with RPC reads instead of mainnet token/pool lists.
  // SDK execute() is never used: signing and broadcast are journalled by runtime.ts.
  return Raydium.load({
    connection,
    owner: signingWallet(),
    cluster: "devnet",
    disableLoadToken: true,
    disableFeatureCheck: true,
    blockhashCommitment: "confirmed",
    urlConfigs: DEV_API_URLS,
  });
}
export async function check() {
  await guard();
  assert.equal(signingWallet().publicKey.toBase58(), EXPECTED_WALLET);
  const cfg = await config();
  const balance = await connection.getBalance(owner, "confirmed");
  const items: [string, number, number][] = [
    ["asset mints", MINT_SIZE, 2],
    ["wallet asset ATAs", ACCOUNT_SIZE, 2],
    ["pool", PoolInfoLayout.span, 1],
    ["pool token vaults", ACCOUNT_SIZE, 2],
    ["observation", ObservationLayout.span, 1],
    ["bitmap extension", TickArrayBitmapExtensionLayout.span, 1],
    ["tick arrays", TickArrayLayout.span, 2],
    ["personal position", PersonalPositionLayout.span, 1],
    ["legacy protocol position reserve", ProtocolPositionLayout.span, 1],
    ["classic NFT mint", MINT_SIZE, 1],
    ["NFT ATA", ACCOUNT_SIZE, 1],
    ["metadata reserve (not requested)", 679, 1],
  ];
  const rent = [];
  for (const [name, bytes, count] of items)
    rent.push({
      name,
      bytes,
      count,
      lamports:
        count *
        (await connection.getMinimumBalanceForRentExemption(
          bytes,
          "confirmed"
        )),
    });
  const estimatedRent = rent.reduce((sum, r) => sum + r.lamports, 0);
  const required = estimatedRent + 10_000_000; // generous fee/rounding reserve, no priority tip.
  assert(required < MAX_SPEND_LAMPORTS);
  let m: RecordData;
  if (fs.existsSync(manifestPath)) {
    m = manifest();
    await verifyBaseline();
  } else {
    m = initialManifest(balance);
    atomicJSON(baselinePath, await snapshotVaults());
  }
  m.ammConfig = { ...cfg, id: cfg.id.toBase58() };
  m.budget = {
    rent,
    estimatedRentLamports: estimatedRent,
    feeReserveLamports: 10_000_000,
    remainingRequiredLamports: required,
    maxSpendLamports: MAX_SPEND_LAMPORTS,
  };
  m.range = range(cfg.tickSpacing);
  save(m);
  console.log(
    JSON.stringify(
      {
        wallet: EXPECTED_WALLET,
        balanceSOL: balance / 1e9,
        requiredSOL: required / 1e9,
        shortfallSOL: Math.max(0, required - balance) / 1e9,
        config: m.ammConfig,
        range: m.range,
        rent,
      },
      null,
      2
    )
  );
  if (balance < required)
    throw new Error(
      "Insufficient SOL: run yarn faucet once, then yarn check:env. Do not spend before funding."
    );
}
export async function faucet() {
  await guard();
  const m = manifest();
  assert(
    !m.faucet,
    "Faucet already attempted; do not repeatedly request an airdrop"
  );
  const before = await connection.getBalance(owner, "confirmed");
  m.faucet = {
    requestedLamports: 1_000_000_000,
    beforeLamports: before,
    status: "requested",
  };
  save(m);
  try {
    const signature = await connection.requestAirdrop(owner, 1_000_000_000);
    m.faucet.signature = signature;
    save(m);
    const confirmation = await connection.confirmTransaction(
      signature,
      "confirmed"
    );
    assert.equal(confirmation.value.err, null);
    m.faucet.status = "confirmed";
  } catch (error) {
    m.faucet.status = "unavailable-or-unconfirmed";
    m.faucet.message = error instanceof Error ? error.message : String(error);
    console.error("Official faucet:", m.faucet.message);
  }
  const after = await connection.getBalance(owner, "confirmed");
  m.faucet.creditedLamports = Math.max(0, after - before);
  save(m);
  console.log(JSON.stringify(m.faucet, null, 2));
  assert(
    after >= m.budget.remainingRequiredLamports,
    `STOP: faucet unavailable, shortfall ${
      (m.budget.remainingRequiredLamports - after) / 1e9
    } Devnet SOL`
  );
}
export async function verifyTokens(m: RecordData) {
  assert(m.tokens?.length === 2);
  for (const t of m.tokens) {
    await owned(pk(t.mint), TOKEN_PROGRAM_ID, MINT_SIZE);
    const mint = await getMint(
      connection,
      pk(t.mint),
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    assert.equal(mint.decimals, DECIMALS);
    assert.equal(mint.supply, SUPPLY);
    assert(mint.mintAuthority?.equals(owner));
    assert.equal(mint.freezeAuthority, null);
    assert(getAssociatedTokenAddressSync(pk(t.mint), owner).equals(pk(t.ata)));
    const account = await getAccount(
      connection,
      pk(t.ata),
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    assert(account.owner.equals(owner) && account.mint.equals(pk(t.mint)));
    assert(!account.isFrozen && account.amount > BigInt(0));
    const expense = BigInt(m.position?.spent?.[t.mint] ?? "0");
    assert.equal(
      account.amount + expense,
      SUPPLY,
      `${t.label}: wallet balance plus recorded liquidity contribution`
    );
  }
  console.log(
    "PASS: classic SPL mints, supply, authority, decimals, ATAs and balances"
  );
}
export async function tokens() {
  await guard();
  const m = manifest();
  if (await reconcile(m, "tokens")) {
    await verifyTokens(m);
    return;
  }
  if (m.tokens) {
    for (const t of m.tokens)
      assert.equal(
        await connection.getAccountInfo(pk(t.mint)),
        null,
        "Unjournalled mint exists; stop for recovery"
      );
  }
  const keys = [Keypair.generate(), Keypair.generate()].sort((a, b) =>
    Buffer.compare(a.publicKey.toBuffer(), b.publicKey.toBuffer())
  );
  m.tokens = keys.map((key, i) => ({
    label: i === 0 ? "GUL-A" : "GUL-B",
    mint: key.publicKey.toBase58(),
    ata: getAssociatedTokenAddressSync(key.publicKey, owner).toBase58(),
    decimals: DECIMALS,
    supplyRaw: SUPPLY.toString(),
  }));
  save(m);
  const rent = await connection.getMinimumBalanceForRentExemption(
    MINT_SIZE,
    "confirmed"
  );
  const tx = new Transaction();
  keys.forEach((key, i) => {
    const ata = pk(m.tokens[i].ata);
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: owner,
        newAccountPubkey: key.publicKey,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(key.publicKey, DECIMALS, owner, null),
      createAssociatedTokenAccountInstruction(owner, ata, owner, key.publicKey),
      createMintToCheckedInstruction(
        key.publicKey,
        ata,
        owner,
        SUPPLY,
        DECIMALS
      )
    );
  });
  await send(
    m,
    "tokens",
    tx,
    keys,
    m.tokens.flatMap((t: RecordData) => [pk(t.mint), pk(t.ata)])
  );
  await verifyTokens(m);
}
export async function poolState(m: RecordData) {
  assert(m.pool?.id, "Create the pool first");
  const id = pk(m.pool.id);
  const raw = await owned(id, CLMM, PoolInfoLayout.span);
  const p = PoolInfoLayout.decode(raw.data);
  assert(p.configId.equals(AMM_CONFIG) && p.creator.equals(owner));
  assert(
    p.mintA.equals(pk(m.tokens[0].mint)) && p.mintB.equals(pk(m.tokens[1].mint))
  );
  assert(Buffer.compare(p.mintA.toBuffer(), p.mintB.toBuffer()) < 0);
  assert(getPdaPoolId(CLMM, AMM_CONFIG, p.mintA, p.mintB).publicKey.equals(id));
  assert.equal(p.tickSpacing, m.ammConfig.tickSpacing);
  assert.equal(p.mintDecimalsA, DECIMALS);
  assert.equal(p.mintDecimalsB, DECIMALS);
  assert(getPdaPoolVaultId(CLMM, id, p.mintA).publicKey.equals(p.vaultA));
  assert(getPdaPoolVaultId(CLMM, id, p.mintB).publicKey.equals(p.vaultB));
  assert(getPdaObservationAccount(CLMM, id).publicKey.equals(p.observationId));
  const obs = ObservationLayout.decode(
    (await owned(p.observationId, CLMM, ObservationLayout.span)).data
  );
  assert(obs.poolId.equals(id));
  const bitmap = TickArrayBitmapExtensionLayout.decode(
    (
      await owned(
        getPdaExBitmapAccount(CLMM, id).publicKey,
        CLMM,
        TickArrayBitmapExtensionLayout.span
      )
    ).data
  );
  assert(bitmap.poolId.equals(id));
  for (const [vault, mint] of [
    [p.vaultA, p.mintA],
    [p.vaultB, p.mintB],
  ]) {
    const account = await getAccount(
      connection,
      vault,
      "confirmed",
      TOKEN_PROGRAM_ID
    );
    assert(account.owner.equals(id) && account.mint.equals(mint));
  }
  return p;
}
export async function pool() {
  await guard();
  const m = manifest();
  await verifyTokens(m);
  if (await reconcile(m, "pool")) {
    await poolState(m);
    return;
  }
  const cfg = await config();
  const id = getPdaPoolId(
    CLMM,
    AMM_CONFIG,
    pk(m.tokens[0].mint),
    pk(m.tokens[1].mint)
  ).publicKey;
  assert.equal(
    await connection.getAccountInfo(id),
    null,
    "Pool already exists without journal; stop for recovery"
  );
  const raydium = await sdk();
  const built = await raydium.clmm.createPool({
    programId: CLMM,
    mint1: toApiV3Token({
      address: m.tokens[0].mint,
      decimals: DECIMALS,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    }),
    mint2: toApiV3Token({
      address: m.tokens[1].mint,
      decimals: DECIMALS,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    }),
    ammConfig: cfg,
    initialPrice: new Decimal(1),
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: { units: 400_000, microLamports: 0 },
  });
  assert.equal(built.extInfo.address.id, id.toBase58());
  const keys = built.extInfo.address;
  m.pool = {
    id: id.toBase58(),
    config: AMM_CONFIG.toBase58(),
    token0: m.tokens[0].mint,
    token1: m.tokens[1].mint,
    vault0: keys.vault.A,
    vault1: keys.vault.B,
    observation: keys.observationId,
    bitmap: keys.exBitmapAccount,
    initialPrice: "1",
    initialSqrtPriceX64: "18446744073709551616",
  };
  save(m);
  await send(m, "pool", built.transaction, built.signers, [
    id,
    pk(m.pool.vault0),
    pk(m.pool.vault1),
    pk(m.pool.observation),
    pk(m.pool.bitmap),
  ]);
  const p = await poolState(m);
  assert.equal(p.sqrtPriceX64.toString(), m.pool.initialSqrtPriceX64);
  assert.equal(p.tickCurrent, 0);
  console.log("PASS: pool created at 1 GUL-A = 1 GUL-B", m.pool);
}
async function positionAccounting(m: RecordData) {
  const tx = await connection.getTransaction(
    m.transactions.position.signature,
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
  );
  assert(
    tx?.meta && tx.meta.err === null,
    "Position transaction metadata required; retry the same command read-only if unavailable"
  );
  const spent: Record<string, string> = {};
  for (const t of m.tokens) {
    const before = tx.meta.preTokenBalances?.find(
      (b) => b.mint === t.mint && b.owner === EXPECTED_WALLET
    );
    const after = tx.meta.postTokenBalances?.find(
      (b) => b.mint === t.mint && b.owner === EXPECTED_WALLET
    );
    assert(
      before && after && before.accountIndex === after.accountIndex,
      "Missing token balance metadata"
    );
    spent[t.mint] = (
      BigInt(before.uiTokenAmount.amount) - BigInt(after.uiTokenAmount.amount)
    ).toString();
  }
  assert(
    Object.values(spent).every((v) => BigInt(v) > BigInt(0)),
    "Both tokens must be contributed"
  );
  m.position.spent = spent;
}
export async function position() {
  await guard();
  const m = manifest();
  if (await reconcile(m, "position")) {
    await positionAccounting(m);
    save(m);
    m.verification = await verify();
    save(m);
    return;
  }
  await verifyTokens(m);
  const p = await poolState(m);
  assert.equal(
    p.sqrtPriceX64.toString(),
    m.pool.initialSqrtPriceX64,
    "Pool price changed before initial position"
  );
  if (m.position)
    assert.equal(
      await connection.getAccountInfo(pk(m.position.personalPosition)),
      null,
      "Unjournalled position exists; stop"
    );
  const r = range(p.tickSpacing);
  const lower = TickUtil.getSqrtPriceAtTick(r.tickLower),
    upper = TickUtil.getSqrtPriceAtTick(r.tickUpper);
  const result = LiquidityMathUtil.getLiquidityAndAmountsFromAmount({
    sqrtPriceCurrentX64: p.sqrtPriceX64,
    sqrtPriceLowerX64: lower,
    sqrtPriceUpperX64: upper,
    amountInfo: { type: "amountA", amount: new BN("1000000000") },
  });
  const amounts = LiquidityMathUtil.getAmountsForLiquidity(
    p.sqrtPriceX64,
    lower,
    upper,
    result.liquidity,
    true
  );
  assert(result.liquidity.gt(new BN(0)));
  const maxA = amounts.amountA.muln(101).divn(100).addn(1),
    maxB = amounts.amountB.muln(101).divn(100).addn(1);
  assert(
    maxA.lte(new BN(SUPPLY.toString())) && maxB.lte(new BN(SUPPLY.toString()))
  );
  const raydium = await sdk();
  // A new pool has no tick arrays. SDK 0.2.74 getPoolInfoFromRpc assumes
  // tickData[poolId] exists and calls Object.values(undefined). Its public
  // getSimplePoolInfo handles this bootstrap state without fetching tick arrays.
  const { poolInfo } = await raydium.clmm.getSimplePoolInfo(m.pool.id);
  const poolKeys: ClmmKeys = {
    id: m.pool.id,
    programId: CLMM.toBase58(),
    openTime: p.startTime.toString(),
    mintA: toApiV3Token(poolInfo.mintA),
    mintB: toApiV3Token(poolInfo.mintB),
    vault: { A: p.vaultA.toBase58(), B: p.vaultB.toBase58() },
    observationId: p.observationId.toBase58(),
    exBitmapAccount: m.pool.bitmap,
    config: { ...m.ammConfig, defaultRange: 0, defaultRangePoint: [] },
    rewardInfos: [],
  };
  assert.equal(poolInfo.programId, CLMM.toBase58());
  const built = await raydium.clmm.openPositionFromLiquidity({
    poolInfo,
    poolKeys,
    ownerInfo: { useSOLBalance: false },
    tickLower: r.tickLower,
    tickUpper: r.tickUpper,
    liquidity: result.liquidity,
    amountMaxA: maxA,
    amountMaxB: maxB,
    nft2022: false,
    withMetadata: "no-create",
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: { units: 600_000, microLamports: 0 },
  });
  const addresses = Object.fromEntries(
    Object.entries(built.extInfo.address).map(([name, key]) => [
      name,
      key.toBase58(),
    ])
  );
  m.position = {
    ...addresses,
    ...r,
    liquidity: result.liquidity.toString(),
    maxAmount0Raw: maxA.toString(),
    maxAmount1Raw: maxB.toString(),
    nftTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    metadataCreated: false,
  };
  save(m);
  await send(m, "position", built.transaction, built.signers, [
    pk(m.position.nftMint),
    pk(m.position.positionNftAccount),
    pk(m.position.personalPosition),
    pk(m.position.tickArrayLower),
    pk(m.position.tickArrayUpper),
  ]);
  await positionAccounting(m);
  save(m);
  m.verification = await verify();
  save(m);
}
export async function verify() {
  await guard();
  const m = manifest();
  await config();
  // This command never signs, sends, requests SOL or writes the manifest.
  for (const stage of ["tokens", "pool", "position"]) {
    const entry = m.transactions[stage];
    assert(entry?.signature, `Missing ${stage} signature`);
    const status = (
      await connection.getSignatureStatuses([entry.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    assert(
      status &&
        ["confirmed", "finalized"].includes(status.confirmationStatus ?? "") &&
        status.err === null,
      `${stage}: confirmed success required`
    );
  }
  await verifyTokens(m);
  const p = await poolState(m);
  assert(p.liquidity.gt(new BN(0)), "Pool needs active liquidity");
  const pos = m.position;
  assert(pos, "Position not recorded");
  const nft = pk(pos.nftMint),
    positionId = pk(pos.personalPosition);
  assert(getPdaPersonalPositionAddress(CLMM, nft).publicKey.equals(positionId));
  assert(
    getAssociatedTokenAddressSync(nft, owner).equals(pk(pos.positionNftAccount))
  );
  const positionInfo = PersonalPositionLayout.decode(
    (await owned(positionId, CLMM, PersonalPositionLayout.span)).data
  );
  assert(
    positionInfo.nftMint.equals(nft) &&
      positionInfo.poolId.equals(pk(m.pool.id))
  );
  assert(positionInfo.liquidity.gt(new BN(0)));
  assert.equal(positionInfo.liquidity.toString(), pos.liquidity);
  assert.equal(positionInfo.tickLower, pos.tickLower);
  assert.equal(positionInfo.tickUpper, pos.tickUpper);
  assert(pos.tickLower <= 0 && 0 < pos.tickUpper);
  assert.equal(pos.tickLower % p.tickSpacing, -0);
  assert.equal(pos.tickUpper % p.tickSpacing, 0);
  const nftMint = await getMint(connection, nft, "confirmed", TOKEN_PROGRAM_ID);
  assert.equal(nftMint.supply, BigInt(1));
  assert.equal(nftMint.decimals, 0);
  const nftAccount = await getAccount(
    connection,
    pk(pos.positionNftAccount),
    "confirmed",
    TOKEN_PROGRAM_ID
  );
  assert(nftAccount.mint.equals(nft) && nftAccount.owner.equals(owner));
  assert.equal(nftAccount.amount, BigInt(1));
  for (const [tick, address] of [
    [pos.tickLower, pos.tickArrayLower],
    [pos.tickUpper, pos.tickArrayUpper],
  ] as [number, string][]) {
    const start = TickArrayUtil.getTickArrayStartIndex(tick, p.tickSpacing);
    assert(
      getPdaTickArrayAddress(CLMM, pk(m.pool.id), start).publicKey.equals(
        pk(address)
      )
    );
    const array = TickArrayLayout.decode(
      (await owned(pk(address), CLMM, TickArrayLayout.span)).data
    );
    assert(array.poolId.equals(pk(m.pool.id)));
    assert.equal(array.startTickIndex, start);
  }
  await verifyBaseline();
  const balance = await connection.getBalance(owner, "confirmed");
  const report = {
    status: "PASS",
    verifiedAt: new Date().toISOString(),
    commitment: "confirmed",
    pool: m.pool.id,
    nft: pos.nftMint,
    position: pos.personalPosition,
    poolLiquidity: p.liquidity.toString(),
    positionLiquidity: positionInfo.liquidity.toString(),
    sqrtPriceX64: p.sqrtPriceX64.toString(),
    priceToken1PerToken0: new Decimal(p.sqrtPriceX64.toString())
      .div(new Decimal(2).pow(64))
      .pow(2)
      .toString(),
    tickCurrent: p.tickCurrent,
    range: {
      lower: pos.priceLower,
      upper: pos.priceUpper,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
    },
    contributionRaw: pos.spent,
    finalBalanceLamports: balance,
    totalSpentLamports:
      m.startBalanceLamports + (m.faucet?.creditedLamports ?? 0) - balance,
    transactionFeeLamports: Object.values(m.transactions).reduce(
      (sum: number, entry: any) => sum + entry.feeLamports,
      0
    ),
    balanceSOL: balance / 1e9,
    spentSOL:
      (m.startBalanceLamports + (m.faucet?.creditedLamports ?? 0) - balance) /
      1e9,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}
export async function readPool() {
  await guard();
  const m = manifest();
  const p = await poolState(m);
  console.log(
    JSON.stringify(
      {
        pool: m.pool,
        tick: p.tickCurrent,
        sqrtPriceX64: p.sqrtPriceX64.toString(),
        liquidity: p.liquidity.toString(),
        priceToken1PerToken0: new Decimal(p.sqrtPriceX64.toString())
          .div(new Decimal(2).pow(64))
          .pow(2)
          .toString(),
      },
      null,
      2
    )
  );
}
