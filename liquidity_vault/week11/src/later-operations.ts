import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, EXPECTED_WALLET, VAULT } from "./config";
import { connection } from "./runtime";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Later weeks legitimately move tokens from/to the wallet. Keep the Week 11
// balance equation exact by deriving those movements from confirmed metadata,
// never from an asserted amount or an overwritten Week 11 baseline.
export async function laterWalletDeltas(
  tokens: { mint: string; ata: string }[]
) {
  const deltas = new Map(tokens.map((t) => [t.mint, BigInt(0)]));
  const operations: { signature: string; funding: boolean }[] = [];
  for (const [week, labels] of [
    ["week12", ["deposit", "deposit-after-unlock", "withdraw-after-unlock"]],
    ["week13", ["deposit", "withdraw", "fund-trader", "refund-trader"]],
  ] as [string, string[]][]) {
    const file = path.join(ROOT, "../" + week + "/manifest.devnet.json");
    if (!fs.existsSync(file)) continue;
    const journal = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(journal.wallet, EXPECTED_WALLET);
    assert.equal(journal.programId, VAULT.toBase58());
    for (const label of labels)
      if (journal.transactions[label])
        operations.push({
          signature: journal.transactions[label].signature,
          funding: label === "fund-trader" || label === "refund-trader",
        });
  }
  const signatures = operations.map((o) => o.signature);
  assert.equal(new Set(signatures).size, signatures.length);
  if (!signatures.length) return deltas;
  const statuses = (
    await connection.getSignatureStatuses(signatures, {
      searchTransactionHistory: true,
    })
  ).value;
  for (let i = 0; i < signatures.length; i++) {
    const status = statuses[i];
    assert(
      status &&
        ["confirmed", "finalized"].includes(status.confirmationStatus ?? "") &&
        status.err === null,
      "Later wallet movement must be confirmed"
    );
    const tx = await connection.getTransaction(signatures[i], {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert(
      tx?.meta && tx.meta.err === null,
      "Later transaction metadata unavailable; stop rather than assume balances"
    );
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    });
    assert.equal(keys.get(0)?.toBase58(), EXPECTED_WALLET);
    assert(
      tx.transaction.message.compiledInstructions.some((ix) =>
        keys
          .get(ix.programIdIndex)
          ?.equals(operations[i].funding ? TOKEN_PROGRAM_ID : VAULT)
      ),
      "Expected confirmed Vault instruction or explicit test-wallet token movement"
    );
    for (const token of tokens) {
      const pre = tx.meta.preTokenBalances?.find(
        (b) =>
          b.mint === token.mint &&
          keys.get(b.accountIndex)?.toBase58() === token.ata
      );
      const post = tx.meta.postTokenBalances?.find(
        (b) =>
          b.mint === token.mint &&
          keys.get(b.accountIndex)?.toBase58() === token.ata
      );
      if (!pre && !post) continue;
      assert(
        pre &&
          post &&
          pre.owner === EXPECTED_WALLET &&
          post.owner === EXPECTED_WALLET
      );
      deltas.set(
        token.mint,
        deltas.get(token.mint)! +
          BigInt(post.uiTokenAmount.amount) -
          BigInt(pre.uiTokenAmount.amount)
      );
    }
  }
  return deltas;
}
