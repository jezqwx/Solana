import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMint,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { assert } from "chai";
import { LiquidityVault } from "../target/types/liquidity_vault";

// This opt-in scenario sends Devnet transactions. Build/typecheck never run it.
const describeIntegration =
  process.env.RUN_DEVNET_INTEGRATION === "1" ? describe : describe.skip;

// Shared raw-send strategy: preserve the signed blockhash, no retries.
async function sendTransactionWithDiagnostics(
  provider: anchor.AnchorProvider,
  label: string,
  transaction: anchor.web3.Transaction,
  signers: anchor.web3.Keypair[] = []
): Promise<string> {
  console.log(`[${label}] Starting instruction`);
  try {
    const latest = await provider.connection.getLatestBlockhash(
      "confirmed"
    );
    transaction.recentBlockhash = latest.blockhash;
    transaction.feePayer = provider.wallet.publicKey;
    if (signers.length > 0) transaction.partialSign(...signers);
    const signed = await provider.wallet.signTransaction(transaction);
    assert.equal(signed.recentBlockhash, latest.blockhash);
    const validity = await provider.connection.isBlockhashValid(
      latest.blockhash,
      { commitment: "confirmed" }
    );
    console.log(`[${label}] Signed transaction blockhash:`, {
      blockhash: signed.recentBlockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      valid: validity.value,
      contextSlot: validity.context.slot,
    });
    const signature = await provider.connection.sendRawTransaction(
      signed.serialize(),
      {
        preflightCommitment: "confirmed",
        skipPreflight: false,
        maxRetries: 0,
      }
    );
    console.log(`[${label}] Transaction submitted:`, signature);
    const confirmation = await provider.connection.confirmTransaction(
      { signature, ...latest },
      "confirmed"
    );
    if (confirmation.value.err !== null) {
      throw new anchor.web3.SendTransactionError({
        action: "send",
        signature,
        transactionMessage: JSON.stringify(confirmation.value.err),
      });
    }
    return signature;
  } catch (error: unknown) {
    console.error(
      `[${label}] Failed:`,
      error instanceof Error ? error.message : String(error)
    );
    let logs = (error as { logs?: string[] } | null)?.logs;
    if (
      logs === undefined &&
      error instanceof anchor.web3.SendTransactionError
    ) {
      try {
        logs = await error.getLogs(provider.connection);
      } catch (logError: unknown) {
        console.error(
          `[${label}] Could not fetch RPC logs:`,
          logError instanceof Error ? logError.message : String(logError)
        );
      }
    }
    console.error(`[${label}] RPC logs:`, logs ?? "Not available");
    throw error;
  }
}

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
          // Diagnostic sample only: the sending callback obtains its transaction blockhash.
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
      const openSignature = await sendTransactionWithDiagnostics(
        provider,
        "openPosition",
        await program.methods
          .openPosition()
          .accountsStrict({
            user,
            vault,
            position,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .transaction()
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

describeIntegration(
  "liquidity_vault — Week 9 deposits (explicit opt-in)",
  () => {
    let provider: anchor.AnchorProvider;
    let program: Program<LiquidityVault>;
    const initialBalance = 1_000_000;
    type DepositAccounts = {
      user: anchor.web3.PublicKey;
      vault: anchor.web3.PublicKey;
      position: anchor.web3.PublicKey;
      assetMint: anchor.web3.PublicKey;
      shareMint: anchor.web3.PublicKey;
      tokenVault: anchor.web3.PublicKey;
      userAssetAccount: anchor.web3.PublicKey;
      userShareAccount: anchor.web3.PublicKey;
      tokenProgram: anchor.web3.PublicKey;
    };

    before(async () => {
      const env = anchor.AnchorProvider.env();
      provider = new anchor.AnchorProvider(env.connection, env.wallet, {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      });
      assert.equal(
        await provider.connection.getGenesisHash(),
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        "Week 9 tests must only run on Devnet"
      );
      anchor.setProvider(provider);
      program = anchor.workspace.liquidityVault as Program<LiquidityVault>;
      assert.equal(
        program.programId.toBase58(),
        "DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9"
      );
    });

    // Keep Week 9 call sites unchanged while sharing the transport with Week 8.
    async function send(
      label: string,
      transaction: anchor.web3.Transaction,
      signers: anchor.web3.Keypair[] = []
    ): Promise<string> {
      return sendTransactionWithDiagnostics(provider, label, transaction, signers);
    }

    async function createFixture(): Promise<DepositAccounts> {
      const user = provider.wallet.publicKey;
      const mintKeypair = anchor.web3.Keypair.generate();
      const assetMint = mintKeypair.publicKey;
      const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), assetMint.toBuffer()],
        program.programId
      );
      const [shareMint] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("share-mint"), vault.toBuffer()],
        program.programId
      );
      const [position] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vault.toBuffer(), user.toBuffer()],
        program.programId
      );
      const tokenVault = getAssociatedTokenAddressSync(assetMint, vault, true);
      const accounts: DepositAccounts = {
        user,
        vault,
        position,
        assetMint,
        shareMint,
        tokenVault,
        userAssetAccount: getAssociatedTokenAddressSync(assetMint, user),
        userShareAccount: getAssociatedTokenAddressSync(shareMint, user),
        tokenProgram: TOKEN_PROGRAM_ID,
      };
      await send(
        "Week 9: create test asset mint",
        new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.createAccount({
            fromPubkey: user,
            newAccountPubkey: assetMint,
            lamports:
              await provider.connection.getMinimumBalanceForRentExemption(
                MINT_SIZE,
                "confirmed"
              ),
            space: MINT_SIZE,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMintInstruction(assetMint, 6, user, null)
        ),
        [mintKeypair]
      );
      console.log(
        "[Week 9 assetMint] Created successfully:",
        assetMint.toBase58()
      );
      await send(
        "Week 9: initializeVault",
        await program.methods
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
          .transaction()
      );
      await prepareUser(accounts);
      return accounts;
    }

    async function prepareUser(
      accounts: DepositAccounts,
      signer?: anchor.web3.Keypair
    ) {
      const transaction = new anchor.web3.Transaction();
      if (signer) {
        // Only the fresh test user receives Devnet SOL to pay for its position rent.
        transaction.add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: accounts.user,
            lamports: 10_000_000,
          })
        );
      }
      transaction.add(
        createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey,
          accounts.userAssetAccount,
          accounts.user,
          accounts.assetMint
        ),
        createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey,
          accounts.userShareAccount,
          accounts.user,
          accounts.shareMint
        ),
        createMintToInstruction(
          accounts.assetMint,
          accounts.userAssetAccount,
          provider.wallet.publicKey,
          initialBalance
        ),
        await program.methods
          .openPosition()
          .accountsStrict({
            user: accounts.user,
            vault: accounts.vault,
            position: accounts.position,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction()
      );
      await send(
        "Week 9: prepare user and openPosition",
        transaction,
        signer ? [signer] : []
      );
    }

    async function secondUser(accounts: DepositAccounts) {
      const signer = anchor.web3.Keypair.generate();
      const user = signer.publicKey;
      const [position] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("position"), accounts.vault.toBuffer(), user.toBuffer()],
        program.programId
      );
      const other: DepositAccounts = {
        ...accounts,
        user,
        position,
        userAssetAccount: getAssociatedTokenAddressSync(
          accounts.assetMint,
          user
        ),
        userShareAccount: getAssociatedTokenAddressSync(
          accounts.shareMint,
          user
        ),
      };
      await prepareUser(other, signer);
      return { accounts: other, signer };
    }

    async function deposit(
      accounts: DepositAccounts,
      amount: number,
      minimum: number,
      signers: anchor.web3.Keypair[] = []
    ) {
      return send(
        "deposit",
        await program.methods
          .deposit(new anchor.BN(amount), new anchor.BN(minimum))
          .accountsStrict(accounts)
          .transaction(),
        signers
      );
    }

    async function donate(accounts: DepositAccounts, amount: number) {
      await send(
        "Week 9: direct donation",
        new anchor.web3.Transaction().add(
          createTransferCheckedInstruction(
            accounts.userAssetAccount,
            accounts.assetMint,
            accounts.tokenVault,
            accounts.user,
            amount,
            6
          )
        )
      );
    }

    async function balances(accounts: DepositAccounts) {
      const [vault, position, mint, tokens, assets, shares] = await Promise.all(
        [
          program.account.vaultConfig.fetch(accounts.vault, "confirmed"),
          program.account.userPosition.fetch(accounts.position, "confirmed"),
          getMint(provider.connection, accounts.shareMint, "confirmed"),
          getAccount(provider.connection, accounts.tokenVault, "confirmed"),
          getAccount(
            provider.connection,
            accounts.userAssetAccount,
            "confirmed"
          ),
          getAccount(
            provider.connection,
            accounts.userShareAccount,
            "confirmed"
          ),
        ]
      );
      return {
        total: vault.totalDeposited.toString(),
        deposited: position.depositedAmount.toString(),
        supply: mint.supply.toString(),
        assets: tokens.amount.toString(),
        userAssets: assets.amount.toString(),
        userShares: shares.amount.toString(),
      };
    }

    // Compare raw account state, including any substituted accounts, after a rejected deposit.
    async function expectDepositError(
      accounts: DepositAccounts,
      amount: number,
      minimum: number,
      expected: string,
      overrides: Partial<DepositAccounts> = {}
    ) {
      const addresses = [
        accounts.vault,
        accounts.position,
        accounts.assetMint,
        accounts.shareMint,
        accounts.tokenVault,
        accounts.userAssetAccount,
        accounts.userShareAccount,
        ...Object.values(overrides),
      ];
      const snapshot = async () =>
        (
          await provider.connection.getMultipleAccountsInfo(
            addresses,
            "confirmed"
          )
        ).map(
          (info) =>
            info && {
              owner: info.owner.toBase58(),
              data: info.data.toString("base64"),
            }
        );
      const before = await snapshot();
      let failure: unknown;
      try {
        await deposit({ ...accounts, ...overrides }, amount, minimum);
      } catch (error: unknown) {
        failure = error;
      }
      assert.exists(failure, `Expected ${expected}`);
      const logs = (failure as { logs?: string[] })?.logs ?? [];
      // A network/blockhash error must not count as a successful negative test.
      assert.include(logs.join("\n"), `Error Code: ${expected}.`);
      assert.deepEqual(
        await snapshot(),
        before,
        "Rejected deposit changed account state"
      );
    }

    it("mints 1:1, prices later deposits from live assets, rounds down and isolates users", async () => {
      const accounts = await createFixture();
      await deposit(accounts, 100, 100);
      assert.deepEqual(await balances(accounts), {
        total: "100",
        deposited: "100",
        supply: "100",
        assets: "100",
        userAssets: "999900",
        userShares: "100",
      });
      await deposit(accounts, 50, 50);
      assert.deepEqual(await balances(accounts), {
        total: "150",
        deposited: "150",
        supply: "150",
        assets: "150",
        userAssets: "999850",
        userShares: "150",
      });
      await donate(accounts, 150);
      assert.deepEqual(await balances(accounts), {
        total: "150",
        deposited: "150",
        supply: "150",
        assets: "300",
        userAssets: "999700",
        userShares: "150",
      });
      await deposit(accounts, 51, 25); // floor(51 * 150 / 300) = 25, exactly the minimum.
      assert.deepEqual(await balances(accounts), {
        total: "201",
        deposited: "201",
        supply: "175",
        assets: "351",
        userAssets: "999649",
        userShares: "175",
      });
      const other = await secondUser(accounts);
      await deposit(other.accounts, 100, 49, [other.signer]); // floor(100 * 175 / 351) = 49.
      assert.deepEqual(await balances(other.accounts), {
        total: "301",
        deposited: "100",
        supply: "224",
        assets: "451",
        userAssets: "999900",
        userShares: "49",
      });
      assert.deepEqual(await balances(accounts), {
        total: "301",
        deposited: "201",
        supply: "224",
        assets: "451",
        userAssets: "999649",
        userShares: "175",
      });
    });

    it("rejects zero amount, insufficient funds, zero shares and slippage without changing state", async () => {
      const accounts = await createFixture();
      await expectDepositError(accounts, 0, 0, "ZeroDeposit");
      await expectDepositError(accounts, 100, 101, "SlippageExceeded");
      await expectDepositError(
        accounts,
        initialBalance + 1,
        0,
        "InsufficientAssetBalance"
      );
      await deposit(accounts, 100, 100);
      await donate(accounts, 100);
      await expectDepositError(accounts, 1, 0, "ZeroShares");
      await expectDepositError(accounts, 51, 26, "SlippageExceeded");
    });

    it("rejects substituted PDAs, mints, token accounts, owners and token program", async () => {
      const accounts = await createFixture();
      const other = await secondUser(accounts);
      const cases: Array<[Partial<DepositAccounts>, string]> = [
        [{ assetMint: accounts.shareMint }, "ConstraintSeeds"],
        [{ shareMint: accounts.assetMint }, "InvalidShareMint"],
        [{ tokenVault: accounts.userAssetAccount }, "InvalidTokenVault"],
        [{ position: other.accounts.position }, "ConstraintSeeds"],
        [
          { userAssetAccount: accounts.userShareAccount },
          "ConstraintTokenMint",
        ],
        [
          { userAssetAccount: other.accounts.userAssetAccount },
          "ConstraintTokenOwner",
        ],
        [
          { userShareAccount: accounts.userAssetAccount },
          "ConstraintTokenMint",
        ],
        [
          { userShareAccount: other.accounts.userShareAccount },
          "ConstraintTokenOwner",
        ],
        [
          { tokenProgram: anchor.web3.SystemProgram.programId },
          "InvalidProgramId",
        ],
      ];
      for (const [overrides, expected] of cases) {
        await expectDepositError(accounts, 10, 10, expected, overrides);
      }
    });

    it("rejects a pre-funded vault with zero share supply", async () => {
      const accounts = await createFixture();
      await donate(accounts, 1);
      await expectDepositError(accounts, 10, 0, "InvalidVaultState");
    });
  }
);
