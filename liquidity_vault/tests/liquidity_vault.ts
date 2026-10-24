import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { assert } from "chai";
import { LiquidityVault } from "../target/types/liquidity_vault";

// This opt-in scenario sends Devnet transactions. Build/typecheck never run it.
const describeIntegration =
  process.env.RUN_DEVNET_INTEGRATION === "1" ? describe : describe.skip;

describeIntegration(
  "liquidity_vault — Devnet integration (explicit opt-in)",
  () => {
    it("initializes a vault and opens an empty user position", async () => {
      const envProvider = anchor.AnchorProvider.env();
      const provider = new anchor.AnchorProvider(
        envProvider.connection,
        envProvider.wallet,
        {
          commitment: "confirmed",
          preflightCommitment: "confirmed",
        }
      );
      assert.equal(
        await provider.connection.getGenesisHash(),
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        "This integration test must only run on Devnet"
      );
      anchor.setProvider(provider);
      const program = anchor.workspace
        .liquidityVault as Program<LiquidityVault>;
      const programId = new anchor.web3.PublicKey(
        "DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9"
      );
      assert.isTrue(program.programId.equals(programId));

      const payer = (provider.wallet as anchor.Wallet).payer;
      const user = provider.wallet.publicKey;
      // A fresh mint gives every manual run a separate set of vault PDAs.
      const assetMint = await createMint(
        provider.connection,
        payer,
        user,
        null,
        6,
        undefined,
        { commitment: "confirmed" },
        TOKEN_PROGRAM_ID
      );
      console.log("[assetMint] Created successfully:", assetMint.toBase58());
      const [vault, vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), assetMint.toBuffer()],
        programId
      );
      const [shareMint] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("share-mint"), vault.toBuffer()],
        programId
      );
      const tokenVault = getAssociatedTokenAddressSync(
        assetMint,
        vault,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const [position, positionBump] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("position"), vault.toBuffer(), user.toBuffer()],
          programId
        );

      const sendWithDiagnostics = async (
        instruction: string,
        send: () => Promise<string>
      ): Promise<string> => {
        console.log(`[${instruction}] Starting instruction`);
        try {
          // Diagnostic sample only: MethodsBuilder.rpc still selects its own blockhash.
          const latest = await provider.connection.getLatestBlockhash(
            "confirmed"
          );
          const validity = await provider.connection.isBlockhashValid(
            latest.blockhash,
            { commitment: "confirmed" }
          );
          console.log(`[${instruction}] Fresh blockhash check:`, {
            commitment: "confirmed",
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
            valid: validity.value,
            contextSlot: validity.context.slot,
          });
          return await send();
        } catch (error: unknown) {
          console.error(
            `[${instruction}] Failed:`,
            error instanceof Error ? error.message : String(error)
          );
          const rpcError = error as {
            logs?: string[];
            data?: { logs?: string[] };
          } | null;
          let logs = rpcError?.logs ?? rpcError?.data?.logs;
          if (
            logs === undefined &&
            error instanceof anchor.web3.SendTransactionError
          ) {
            try {
              logs = await error.getLogs(provider.connection);
            } catch (logError: unknown) {
              console.error(
                `[${instruction}] Could not fetch RPC logs:`,
                logError instanceof Error ? logError.message : String(logError)
              );
            }
          }
          console.error(`[${instruction}] RPC logs:`, logs ?? "Not available");
          throw error;
        }
      };

      const initializeSignature = await sendWithDiagnostics(
        "initializeVault",
        async () => {
          const transaction = await program.methods
            .initializeVault()
            .accountsStrict({
              admin: user,
              assetMint,
              vault,
              shareMint,
              tokenVault,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .transaction();
          const latest = await provider.connection.getLatestBlockhash(
            "confirmed"
          );
          transaction.recentBlockhash = latest.blockhash;
          transaction.feePayer = provider.wallet.publicKey;
          const signedTransaction = await provider.wallet.signTransaction(
            transaction
          );
          const signedBlockhash = signedTransaction.recentBlockhash;
          if (signedBlockhash !== latest.blockhash) {
            throw new Error("Wallet changed the initializeVault blockhash");
          }
          const validity = await provider.connection.isBlockhashValid(
            signedBlockhash,
            { commitment: "confirmed" }
          );
          console.log("[initializeVault] Signed transaction blockhash before send:", {
            blockhash: signedBlockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
            valid: validity.value,
            contextSlot: validity.context.slot,
          });
          const signature = await provider.connection.sendRawTransaction(
            signedTransaction.serialize(),
            {
              preflightCommitment: "confirmed",
              skipPreflight: false,
              maxRetries: 0,
            }
          );
          console.log("[initializeVault] Transaction submitted:", signature);
          const confirmation = await provider.connection.confirmTransaction(
            {
              signature,
              blockhash: signedBlockhash,
              lastValidBlockHeight: latest.lastValidBlockHeight,
            },
            "confirmed"
          );
          if (confirmation.value.err !== null) {
            // The existing diagnostics catch can fetch RPC logs using this signature.
            throw new anchor.web3.SendTransactionError({
              action: "send",
              signature,
              transactionMessage: `Transaction confirmation failed: ${JSON.stringify(
                confirmation.value.err
              )}`,
            });
          }
          return signature;
        }
      );
      const openSignature = await sendWithDiagnostics("openPosition", () =>
        program.methods
          .openPosition()
          .accountsStrict({
            user,
            vault,
            position,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" })
      );

      const config = await program.account.vaultConfig.fetch(
        vault,
        "confirmed"
      );
      const userPosition = await program.account.userPosition.fetch(
        position,
        "confirmed"
      );
      assert.isTrue(config.admin.equals(user));
      assert.isTrue(config.assetMint.equals(assetMint));
      assert.isTrue(config.shareMint.equals(shareMint));
      assert.isTrue(config.tokenVault.equals(tokenVault));
      assert.equal(config.totalDeposited.toString(), "0");
      assert.equal(config.bump, vaultBump);
      assert.isTrue(userPosition.owner.equals(user));
      assert.isTrue(userPosition.vault.equals(vault));
      assert.equal(userPosition.depositedAmount.toString(), "0");
      assert.equal(userPosition.bump, positionBump);

      const asset = await getMint(provider.connection, assetMint, "confirmed");
      const shares = await getMint(provider.connection, shareMint, "confirmed");
      const tokens = await getAccount(
        provider.connection,
        tokenVault,
        "confirmed"
      );
      assert.isTrue(asset.isInitialized);
      assert.isTrue(asset.mintAuthority?.equals(user));
      assert.isNull(asset.freezeAuthority);
      assert.equal(asset.decimals, 6);
      assert.equal(asset.supply.toString(), "0");
      assert.isTrue(shares.isInitialized);
      assert.isTrue(shares.mintAuthority?.equals(vault));
      assert.isNull(shares.freezeAuthority);
      assert.equal(shares.decimals, asset.decimals);
      assert.equal(shares.supply.toString(), "0");
      assert.isTrue(tokens.isInitialized);
      assert.isFalse(tokens.isFrozen);
      assert.isTrue(tokens.owner.equals(vault));
      assert.isTrue(tokens.mint.equals(assetMint));
      assert.isNull(tokens.delegate);
      assert.isNull(tokens.closeAuthority);
      assert.equal(tokens.amount.toString(), "0");

      const expectedAccounts = [
        { address: vault, owner: programId, size: 8 + 4 * 32 + 8 + 1 },
        { address: position, owner: programId, size: 8 + 2 * 32 + 8 + 1 },
        { address: assetMint, owner: TOKEN_PROGRAM_ID, size: MINT_SIZE },
        { address: shareMint, owner: TOKEN_PROGRAM_ID, size: MINT_SIZE },
        { address: tokenVault, owner: TOKEN_PROGRAM_ID, size: ACCOUNT_SIZE },
      ];
      const infos = await provider.connection.getMultipleAccountsInfo(
        expectedAccounts.map(({ address }) => address),
        "confirmed"
      );
      expectedAccounts.forEach(({ address, owner, size }, index) => {
        const info = infos[index];
        assert.isNotNull(info, `Missing account ${address.toBase58()}`);
        assert.isTrue(info!.owner.equals(owner), address.toBase58());
        assert.equal(info!.data.length, size, address.toBase58());
      });

      console.log({
        assetMint: assetMint.toBase58(),
        vault: vault.toBase58(),
        shareMint: shareMint.toBase58(),
        tokenVault: tokenVault.toBase58(),
        position: position.toBase58(),
        initializeSignature,
        openSignature,
      });
    });
  }
);
