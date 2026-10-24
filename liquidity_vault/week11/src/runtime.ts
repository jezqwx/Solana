import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  Signer,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ROOT,
  RPC,
  GENESIS,
  CLMM,
  VAULT,
  WALLET,
  EXPECTED_WALLET,
  SOURCES,
  MAX_SPEND_LAMPORTS,
} from "./config";

export type RecordData = Record<string, any>;
export const manifestPath = path.join(ROOT, "manifest.devnet.json");
export const baselinePath = path.join(ROOT, "vault-baseline.devnet.json");
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export const hash = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const readJSON = (file: string): RecordData =>
  JSON.parse(fs.readFileSync(file, "utf8"));
export function atomicJSON(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(file + ".tmp", file);
}

export function isReadMethod(method: string): boolean {
  return (
    method.startsWith("get") ||
    method === "isBlockhashValid" ||
    method === "simulateTransaction"
  );
}
// Only reads are retried. A send or faucet request is attempted exactly once.
export const boundedFetch: typeof fetch = async (input, init) => {
  const method = JSON.parse(String(init?.body ?? "{}")).method ?? "";
  const attempts = isReadMethod(method) ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      });
      if (
        ![429, 502, 503, 504].includes(response.status) ||
        attempt === attempts - 1
      )
        return response;
      await response.text();
      console.warn(
        `[RPC ${method}] HTTP ${response.status}; bounded read retry ${
          attempt + 1
        }`
      );
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      console.warn(
        `[RPC ${method}] read transport failure; retry ${attempt + 1}`
      );
    }
    await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 400));
  }
  throw new Error("Unreachable retry state");
};
export const connection = new Connection(RPC, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: boundedFetch,
});

export async function guard() {
  assert.equal(await connection.getGenesisHash(), GENESIS, "Devnet required");
  const program = await connection.getAccountInfo(CLMM, "confirmed");
  assert(program?.executable, "Official CLMM program must be executable");
  assert.equal(
    program.owner.toBase58(),
    "BPFLoaderUpgradeab1e11111111111111111111111"
  );
}
export function manifest(): RecordData {
  assert(fs.existsSync(manifestPath), "Run yarn check:env first");
  const m = readJSON(manifestPath);
  assert.equal(m.genesisHash, GENESIS);
  assert.equal(m.clmmProgram, CLMM.toBase58());
  assert.equal(m.wallet, EXPECTED_WALLET);
  return m;
}
export const save = (m: RecordData) => atomicJSON(manifestPath, m);
export function signingWallet(): Keypair {
  // Read the existing wallet in memory only; never log or persist key material.
  const key = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8")))
  );
  assert.equal(key.publicKey.toBase58(), EXPECTED_WALLET, "Unexpected wallet");
  return key;
}

export async function snapshotVaults(): Promise<RecordData> {
  const addresses = new Set<string>();
  let vaultCount = 0;
  for (const size of [145, 81]) {
    const accounts = await connection.getProgramAccounts(VAULT, {
      commitment: "confirmed",
      filters: [{ dataSize: size }],
    });
    for (const { pubkey, account } of accounts) {
      addresses.add(pubkey.toBase58());
      if (size === 145) {
        vaultCount++;
        addresses.add(new PublicKey(account.data.subarray(72, 104)).toBase58());
        addresses.add(
          new PublicKey(account.data.subarray(104, 136)).toBase58()
        );
      }
    }
  }
  assert(
    vaultCount > 0,
    "Expected existing Week 8–10 vaults for regression snapshot"
  );
  const result: RecordData = {};
  const keys = [...addresses].sort();
  for (let offset = 0; offset < keys.length; offset += 80) {
    const batch = keys.slice(offset, offset + 80);
    const infos = await connection.getMultipleAccountsInfo(
      batch.map((key) => new PublicKey(key)),
      "confirmed"
    );
    infos.forEach((info, i) => {
      assert(info, `Missing baseline account ${batch[i]}`);
      result[batch[i]] = {
        owner: info.owner.toBase58(),
        bytes: info.data.length,
        lamports: info.lamports,
        sha256: hash(info.data),
      };
    });
  }
  return { vaultCount, accounts: result };
}
export async function verifyBaseline() {
  const baseline = readJSON(baselinePath);
  const keys = Object.keys(baseline.accounts);
  for (let offset = 0; offset < keys.length; offset += 80) {
    const batch = keys.slice(offset, offset + 80);
    const infos = await connection.getMultipleAccountsInfo(
      batch.map((key) => new PublicKey(key)),
      "confirmed"
    );
    infos.forEach((info, i) => {
      assert(info, `Missing protected vault account ${batch[i]}`);
      assert.deepEqual(
        {
          owner: info.owner.toBase58(),
          bytes: info.data.length,
          lamports: info.lamports,
          sha256: hash(info.data),
        },
        baseline.accounts[batch[i]],
        `Vault account changed: ${batch[i]}`
      );
    });
  }
  console.log(
    `PASS: ${keys.length} existing VaultConfig/UserPosition/ShareMint/Token Vault accounts unchanged`
  );
}

export function isConfirmedSuccess(
  status: { confirmationStatus?: string; err: unknown } | null
): boolean {
  return (
    !!status &&
    ["confirmed", "finalized"].includes(status.confirmationStatus ?? "") &&
    status.err === null
  );
}
export async function reconcile(
  m: RecordData,
  stage: string
): Promise<boolean> {
  const entry = m.transactions?.[stage];
  if (!entry) return false;
  let status: Awaited<
    ReturnType<Connection["getSignatureStatuses"]>
  >["value"][number] = null;
  try {
    status = (
      await connection.getSignatureStatuses([entry.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
  } catch (error) {
    console.error(
      `[${stage}] Signature status unavailable; checking expected accounts without resending:`,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (isConfirmedSuccess(status)) {
    entry.status = "confirmed";
    save(m);
    console.log(
      `[${stage}] Existing confirmed signature ${entry.signature}; no resend`
    );
    return true;
  }
  const accounts = await connection.getMultipleAccountsInfo(
    entry.expectedAccounts.map((key: string) => new PublicKey(key)),
    "confirmed"
  );
  const observed = accounts.map((info, i) => ({
    address: entry.expectedAccounts[i],
    exists: !!info,
    owner: info?.owner.toBase58(),
    bytes: info?.data.length,
  }));
  console.error(`[${stage}] Existing signature status and expected accounts:`, {
    signature: entry.signature,
    status,
    observed,
  });
  throw new Error(
    `STOP: ${stage} status unresolved or failed. Do not recreate/re-sign/resend. Inspect manifest signature and accounts, then run the same command to reconcile.`
  );
}

export async function send(
  m: RecordData,
  stage: string,
  transaction: Transaction,
  signers: Signer[],
  expected: PublicKey[]
) {
  assert(
    !m.transactions?.[stage],
    "Reconcile existing signature before building a replacement"
  );
  await guard();
  await verifyBaseline();
  const protectedAccounts = new Set(
    Object.keys(readJSON(baselinePath).accounts)
  );
  const allowedPrograms = new Set(
    [
      CLMM,
      SystemProgram.programId,
      ComputeBudgetProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ].map((p) => p.toBase58())
  );
  for (const instruction of transaction.instructions) {
    assert(
      allowedPrograms.has(instruction.programId.toBase58()),
      "Unexpected top-level program in Week 11 transaction"
    );
    for (const key of instruction.keys)
      assert(
        !protectedAccounts.has(key.pubkey.toBase58()),
        "Week 11 must not reference existing vault accounts"
      );
  }
  const wallet = signingWallet();
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = wallet.publicKey;
  transaction.sign(wallet, ...signers);
  assert(transaction.signature);
  const signature = bs58.encode(transaction.signature);
  const signed = new VersionedTransaction(
    transaction.compileMessage(),
    transaction.signatures.map((s) => {
      assert(s.signature);
      return Uint8Array.from(s.signature);
    })
  );
  const simulation = await connection.simulateTransaction(signed, {
    commitment: "confirmed",
    sigVerify: true,
    replaceRecentBlockhash: false,
    accounts: { encoding: "base64", addresses: [wallet.publicKey.toBase58()] },
  });
  if (simulation.value.err) {
    console.error(
      `[${stage}] Simulation failed`,
      simulation.value.err,
      simulation.value.logs
    );
    throw new Error(
      `${stage}: preflight simulation rejected; nothing broadcast`
    );
  }
  const validity = await connection.isBlockhashValid(latest.blockhash, {
    commitment: "confirmed",
  });
  assert(validity.value, "Signed blockhash expired before send");
  const fee = (
    await connection.getFeeForMessage(transaction.compileMessage(), "confirmed")
  ).value;
  assert(fee !== null, "Cannot determine transaction fee");
  const balance = await connection.getBalance(wallet.publicKey, "confirmed");
  assert(
    balance >= m.budget.remainingRequiredLamports,
    "Insufficient balance for remaining rent and fees"
  );
  const spent =
    m.startBalanceLamports + (m.faucet?.creditedLamports ?? 0) - balance;
  const simulatedBalance = simulation.value.accounts?.[0]?.lamports;
  assert(simulatedBalance !== undefined, "Missing simulated payer balance");
  const simulatedDebit = balance - simulatedBalance;
  assert(
    simulatedDebit >= fee && spent + simulatedDebit < MAX_SPEND_LAMPORTS,
    "Week 11 rent/fee spend cap exceeded"
  );
  console.log(
    `[${stage}] Simulation OK, units=${simulation.value.unitsConsumed}, fee=${fee}, signature=${signature}`
  );
  // Write the signature and public expected accounts BEFORE broadcast. Raw signed
  // bytes are not secret keys; they are kept only in ignored recovery storage.
  const bytes = transaction.serialize();
  atomicJSON(path.join(ROOT, ".runtime", stage + ".signed.json"), {
    signature,
    bytes: bytes.toString("base64"),
    ...latest,
  });
  m.transactions ??= {};
  m.transactions[stage] = {
    signature,
    ...latest,
    feeLamports: fee,
    simulatedDebitLamports: simulatedDebit,
    simulatedUnits: simulation.value.unitsConsumed,
    status: "prepared",
    expectedAccounts: expected.map((p) => p.toBase58()),
  };
  save(m);
  try {
    const returned = await connection.sendRawTransaction(bytes, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
      minContextSlot: validity.context.slot,
    });
    assert.equal(returned, signature);
    m.transactions[stage].status = "submitted";
    save(m);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const confirmation = await connection.confirmTransaction(
        { signature, ...latest, abortSignal: controller.signal },
        "confirmed"
      );
      assert.equal(
        confirmation.value.err,
        null,
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error(
      `[${stage}] Send/confirmation error`,
      error instanceof Error ? error.message : String(error)
    );
    const logs = (error as { logs?: string[] }).logs;
    if (logs) console.error("RPC logs:", logs);
    await reconcile(m, stage); // Read-only recovery. Never resend.
  }
  m.transactions[stage].status = "confirmed";
  save(m);
  console.log(
    `[${stage}] Confirmed: https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
}

export function initialManifest(balance: number): RecordData {
  return {
    schema: 1,
    cluster: "devnet",
    genesisHash: GENESIS,
    rpc: RPC,
    wallet: EXPECTED_WALLET,
    clmmProgram: CLMM.toBase58(),
    vaultProgram: VAULT.toBase58(),
    sources: SOURCES,
    startBalanceLamports: balance,
    transactions: {},
  };
}
