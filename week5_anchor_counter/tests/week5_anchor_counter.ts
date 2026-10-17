import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Week5AnchorCounter } from "../target/types/week5_anchor_counter";

describe("week5_anchor_counter", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .week5AnchorCounter as Program<Week5AnchorCounter>;

  it("initializes and increases the counter", async () => {
    const counter = anchor.web3.Keypair.generate();

    console.log("Program ID:", program.programId.toBase58());
    console.log("Counter account:", counter.publicKey.toBase58());

    await program.methods
      .initializeCounter()
      .accountsStrict({
        counter: counter.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([counter])
      .rpc();

    const initialState = await program.account.counterState.fetch(
      counter.publicKey
    );
    console.log("Initial value:", initialState.value.toString());
    expect(initialState.value.toNumber()).to.equal(0);
    expect(initialState.authority.equals(provider.wallet.publicKey)).to.equal(
      true
    );

    const signature = await program.methods
      .increaseCounter()
      .accountsStrict({
        counter: counter.publicKey,
        authority: provider.wallet.publicKey,
      })
      .rpc();
    console.log("Increase transaction signature:", signature);

    const updatedState = await program.account.counterState.fetch(
      counter.publicKey
    );
    console.log("Updated value:", updatedState.value.toString());
    expect(updatedState.value.toNumber()).to.equal(1);
  });
});
