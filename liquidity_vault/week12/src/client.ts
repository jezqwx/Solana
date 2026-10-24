import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  Signer,
} from "@solana/web3.js";
import {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Raydium,
  DEV_API_URLS,
  DEVNET_PROGRAM_ID,
  PoolInfoLayout,
  swapInternal,
  TickArrayBitmapExtensionLayout,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import bs58 from "bs58";
import { boundedFetch, verifyBaseline } from "../../week11/src/runtime";

export const ROOT = path.resolve(__dirname, "..");
export const FILE = path.join(ROOT, "manifest.devnet.json");
export const w11 = JSON.parse(
  fs.readFileSync(path.join(ROOT, "../week11/manifest.devnet.json"), "utf8")
);
export const pid = new PublicKey(w11.vaultProgram),
  clmm = new PublicKey(w11.clmmProgram),
  owner = new PublicKey(w11.wallet);
export const poolId = new PublicKey(w11.pool.id),
  assetMint = new PublicKey(w11.tokens[0].mint),
  quoteMint = new PublicKey(w11.tokens[1].mint);
// Bound concurrent HTTP connections and request bursts on public Devnet.
// This schedules each request once; only boundedFetch retries read operations.
let requestQueue: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
const pacedFetch: typeof fetch = (input, init) => {
  const request = requestQueue.then(async () => {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextRequestAt = Date.now() + 1100;
    return boundedFetch(input, init);
  });
  requestQueue = request.catch(() => undefined);
  return request;
};
export const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: pacedFetch,
});
export const pda = (...seeds: Buffer[]) =>
  PublicKey.findProgramAddressSync(seeds, pid)[0];
export const vault = pda(Buffer.from("vault"), assetMint.toBuffer()),
  shareMint = pda(Buffer.from("share-mint"), vault.toBuffer());
export const strategy = pda(Buffer.from("strategy"), vault.toBuffer()),
  position = pda(Buffer.from("position"), vault.toBuffer(), owner.toBuffer());
export const tokenVault = getAssociatedTokenAddressSync(assetMint, vault, true),
  quoteVault = getAssociatedTokenAddressSync(quoteMint, vault, true);
export const userAssets = getAssociatedTokenAddressSync(assetMint, owner),
  userShares = getAssociatedTokenAddressSync(shareMint, owner);
export type Journal = Record<string, any>;
export function save(m: Journal) {
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(m, null, 2) + "\n");
  fs.renameSync(FILE + ".tmp", FILE);
}
export function load(): Journal {
  assert(fs.existsSync(FILE), "Run check:env first");
  const m = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.equal(m.genesisHash, w11.genesisHash);
  assert.equal(m.programId, pid.toBase58());
  return m;
}
export function wallet() {
  const k = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), ".config/solana/jezqwx/id.json"),
          "utf8"
        )
      )
    )
  );
  assert(k.publicKey.equals(owner));
  return k;
}
export async function guard() {
  assert.equal(
    await connection.getGenesisHash(),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  );
  assert(clmm.equals(DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID));
  const infos = await connection.getMultipleAccountsInfo([pid, clmm, poolId]);
  assert(
    infos[0]?.executable && infos[1]?.executable && infos[2]?.owner.equals(clmm)
  );
  const p = PoolInfoLayout.decode(infos[2]!.data);
  assert(
    p.mintA.equals(assetMint) &&
      p.mintB.equals(quoteMint) &&
      p.liquidity.gt(new BN(0))
  );
  assert.equal(p.vaultA.toBase58(), w11.pool.vault0);
  assert.equal(p.vaultB.toBase58(), w11.pool.vault1);
  assert.equal(p.observationId.toBase58(), w11.pool.observation);
}
export function program() {
  const k = wallet();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(k), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "../target/idl/liquidity_vault.json"),
      "utf8"
    )
  );
  assert.equal(idl.address, pid.toBase58());
  return new anchor.Program(idl, provider);
}
export const base = () => ({
  admin: owner,
  vault,
  assetMint,
  shareMint,
  tokenVault,
  quoteMint,
  quoteVault,
  strategy,
  tokenProgram: TOKEN_PROGRAM_ID,
});
export const swapAccounts = () => ({
  ...base(),
  pool: poolId,
  ammConfig: new PublicKey(w11.pool.config),
  poolVaultA: new PublicKey(w11.pool.vault0),
  poolVaultB: new PublicKey(w11.pool.vault1),
  observation: new PublicKey(w11.pool.observation),
  raydiumProgram: clmm,
  tokenProgram2022: TOKEN_2022_PROGRAM_ID,
  memoProgram: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
});
export const depositAccounts = () => ({
  user: owner,
  vault,
  position,
  assetMint,
  shareMint,
  tokenVault,
  userAssetAccount: userAssets,
  userShareAccount: userShares,
  tokenProgram: TOKEN_PROGRAM_ID,
});
export const initAccounts = () => ({
  ...base(),
  pool: poolId,
  raydiumProgram: clmm,
  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  systemProgram: anchor.web3.SystemProgram.programId,
});
export const protectedKeys = () => [
  vault,
  shareMint,
  tokenVault,
  quoteVault,
  strategy,
  position,
  userAssets,
  userShares,
  poolId,
  new PublicKey(w11.pool.vault0),
  new PublicKey(w11.pool.vault1),
  new PublicKey(w11.pool.observation),
  new PublicKey(w11.position.tickArrayLower),
  new PublicKey(w11.position.tickArrayUpper),
];
export async function snapshot(keys = protectedKeys()) {
  return (await connection.getMultipleAccountsInfo(keys, "confirmed")).map(
    (a) =>
      a && {
        owner: a.owner.toBase58(),
        data: createHash("sha256").update(a.data).digest("hex"),
        lamports: a.lamports,
      }
  );
}
export async function state() {
  const [a, b, s, p] = await Promise.all([
    getAccount(connection, tokenVault),
    getAccount(connection, quoteVault),
    getMint(connection, shareMint),
    connection.getAccountInfo(poolId),
  ]);
  assert(
    a.owner.equals(vault) &&
      b.owner.equals(vault) &&
      a.mint.equals(assetMint) &&
      b.mint.equals(quoteMint)
  );
  const pool = PoolInfoLayout.decode(p!.data);
  return {
    assets: a.amount.toString(),
    quote: b.amount.toString(),
    supply: s.supply.toString(),
    shareAuthority: s.mintAuthority?.toBase58(),
    sqrtPriceX64: pool.sqrtPriceX64.toString(),
    price: new Decimal(pool.sqrtPriceX64.toString())
      .div(new Decimal(2).pow(64))
      .pow(2)
      .toString(),
    tick: pool.tickCurrent,
  };
}
export function minimumOut(expected: BN, bps = 100): BN {
  assert(Number.isInteger(bps) && bps >= 0 && bps < 10000);
  const minimum = expected.muln(10000 - bps).divn(10000);
  assert(minimum.gt(new BN(0)), "Zero minimum is forbidden");
  return minimum;
}
export async function quote(amount: BN, aToB: boolean) {
  await guard();
  assert(amount.gt(new BN(0)));
  const raydium = await Raydium.load({
    owner,
    connection,
    cluster: "devnet",
    disableLoadToken: true,
    disableFeatureCheck: true,
    urlConfigs: DEV_API_URLS,
  });
  const { rpcData, configInfo, tickArrays } =
    await raydium.clmm.getSwapPoolInfo(poolId, aToB);
  const bitmap = new PublicKey(w11.pool.bitmap);
  const bitmapInfo = await connection.getAccountInfo(bitmap);
  assert(bitmapInfo);
  assert(bitmapInfo.owner.equals(clmm));
  const simulation = swapInternal({
    programId: clmm,
    poolId,
    poolInfo: rpcData,
    configInfo,
    tickArrays,
    tickarrayBitmapExtension: TickArrayBitmapExtensionLayout.decode(
      bitmapInfo.data
    ),
    amountSpecified: amount,
    sqrtPriceLimitX64: new BN(0),
    zeroForOne: aToB,
    isBaseInput: true,
    blockTimestamp: Math.floor(Date.now() / 1000),
    includeExtraTickArrays: true,
  });
  assert(simulation.allTrade && simulation.amountSpecifiedRemaining.isZero());
  const accounts = [
    ...new Map(
      [bitmap, ...simulation.accounts].map((p) => [p.toBase58(), p])
    ).values(),
  ];
  return {
    amount,
    aToB,
    expected: simulation.amountCalculated,
    minimum: minimumOut(simulation.amountCalculated),
    accounts,
    observedAt: Date.now(),
    beforeSqrt: rpcData.sqrtPriceX64.toString(),
  };
}
export type Quote = Awaited<ReturnType<typeof quote>>;
export async function swapTx(
  q: Quote,
  overrides: Record<string, PublicKey> = {},
  minimum = q.minimum,
  amount = q.amount
) {
  assert(
    Date.now() - q.observedAt < 90_000,
    "Quote expired; fetch a new quote"
  );
  return (
    await program()
      .methods.swap(amount, minimum, q.aToB)
      .accountsStrict({ ...swapAccounts(), ...overrides })
      .remainingAccounts(
        q.accounts.map((pubkey) => ({
          pubkey,
          isWritable: true,
          isSigner: false,
        }))
      )
      .transaction()
  ).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 650_000 }));
}
async function signed(tx: Transaction, signers: Signer[] = []) {
  await guard();
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(wallet(), ...signers);
  assert(tx.signature);
  const signature = bs58.encode(tx.signature);
  const versioned = new VersionedTransaction(
    tx.compileMessage(),
    tx.signatures.map((s) => {
      assert(s.signature);
      return Uint8Array.from(s.signature);
    })
  );
  return { latest, signature, versioned, bytes: tx.serialize() };
}
export async function reconcile(m: Journal, label: string) {
  const entry = m.transactions[label];
  if (!entry) return false;
  let status;
  try {
    status = (
      await connection.getSignatureStatuses([entry.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
  } catch (e) {
    console.error("Status unavailable", String(e));
  }
  if (
    status &&
    ["confirmed", "finalized"].includes(status.confirmationStatus ?? "") &&
    status.err === null
  ) {
    entry.status = "confirmed";
    save(m);
    return true;
  }
  console.error(
    "Unresolved signature",
    entry.signature,
    status,
    "Current snapshot",
    await snapshot()
  );
  throw new Error(
    `STOP: ${label} unresolved/failed. Never re-sign or resend; inspect this signature first.`
  );
}
export async function send(
  m: Journal,
  label: string,
  build: () => Promise<Transaction>
) {
  if (await reconcile(m, label)) {
    console.log(label, "already confirmed; no resend");
    return;
  }
  await verifyBaseline();
  const tx = await build();
  const s = await signed(tx);
  const sim = await connection.simulateTransaction(s.versioned, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  if (sim.value.err) {
    console.error(sim.value.err, sim.value.logs);
    throw new Error(label + " preflight simulation failed; no broadcast");
  }
  assert(
    (
      await connection.isBlockhashValid(s.latest.blockhash, {
        commitment: "confirmed",
      })
    ).value
  );
  m.transactions[label] = {
    signature: s.signature,
    ...s.latest,
    status: "prepared",
    before: await snapshot(),
  };
  save(m);
  fs.mkdirSync(path.join(ROOT, ".runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, ".runtime", label + ".signed.json"),
    JSON.stringify({
      signature: s.signature,
      bytes: s.bytes.toString("base64"),
    }),
    { mode: 0o600 }
  );
  try {
    assert.equal(
      await connection.sendRawTransaction(s.bytes, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
        minContextSlot: sim.context.slot,
      }),
      s.signature
    );
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), 45000);
    try {
      const confirmation = await connection.confirmTransaction(
        { signature: s.signature, ...s.latest, abortSignal: abort.signal },
        "confirmed"
      );
      assert.equal(confirmation.value.err, null);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error(label, String(error));
    await reconcile(m, label);
  }
  m.transactions[label].status = "confirmed";
  save(m);
  console.log(label, "confirmed", s.signature);
}
export async function reject(
  m: Journal,
  label: string,
  tx: Transaction,
  expected: RegExp,
  extra: Signer[] = [],
  requireRaydium = false
) {
  const before = await snapshot();
  const s = await signed(tx, extra);
  const sim = await connection.simulateTransaction(s.versioned, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
  });
  assert(sim.value.err, `${label}: simulation must fail`);
  const logs = sim.value.logs ?? [];
  assert.match(
    logs.join("\n"),
    expected,
    `${label}: must fail for the expected business reason`
  );
  if (requireRaydium) {
    assert(logs.includes(`Program ${clmm} invoke [2]`));
    assert(logs.some((l) => l.startsWith(`Program ${clmm} failed:`)));
  }
  assert.deepEqual(
    await snapshot(),
    before,
    `${label}: rejected simulation changed state`
  );
  m.negativeTests[label] = {
    status: "passed",
    signature: s.signature,
    published: false,
    stage: "preflight simulation",
    error: sim.value.err,
    logs,
    unchanged: true,
  };
  save(m);
  console.log(
    "PASS negative:",
    label,
    "(simulation only, not an on-chain signature)"
  );
}
export async function check() {
  await guard();
  await verifyBaseline();
  const balance = await connection.getBalance(owner);
  if (!fs.existsSync(FILE)) {
    assert.equal(
      await connection.getAccountInfo(vault),
      null,
      "Existing GUL-A vault: stop to protect unknown deposits"
    );
    save({
      schema: 1,
      genesisHash: w11.genesisHash,
      programId: pid.toBase58(),
      poolId: poolId.toBase58(),
      wallet: owner.toBase58(),
      assetMint: assetMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      vault: vault.toBase58(),
      shareMint: shareMint.toBase58(),
      tokenVault: tokenVault.toBase58(),
      quoteVault: quoteVault.toBase58(),
      strategy: strategy.toBase58(),
      position: position.toBase58(),
      startBalanceLamports: balance,
      transactions: {},
      negativeTests: {},
    });
  }
  console.log("Devnet ready", {
    balanceSOL: balance / 1e9,
    vault: vault.toBase58(),
    tokenVault: tokenVault.toBase58(),
    quoteVault: quoteVault.toBase58(),
  });
}
