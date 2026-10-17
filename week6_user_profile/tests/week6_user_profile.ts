import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Week6UserProfile } from "../target/types/week6_user_profile";

describe("week6_user_profile", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.week6UserProfile as Program<Week6UserProfile>;
  const [profilePda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user-profile"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  it("creates and edits a user profile", async () => {
    console.log("Program ID:", program.programId.toBase58());
    console.log("Wallet:", provider.wallet.publicKey.toBase58());
    console.log("Profile PDA:", profilePda.toBase58());
    console.log("Bump:", bump);

    const createSignature = await program.methods
      .createProfile("jezqwx", "Solana student profile")
      .accountsStrict({
        profile: profilePda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("Create transaction signature:", createSignature);

    const createdProfile = await program.account.userProfile.fetch(profilePda);
    expect(createdProfile.authority.equals(provider.wallet.publicKey)).to.be.true;
    expect(createdProfile.displayName).to.equal("jezqwx");
    expect(createdProfile.about).to.equal("Solana student profile");
    expect(createdProfile.bump).to.equal(bump);
    console.log("Created profile:", {
      authority: createdProfile.authority.toBase58(),
      displayName: createdProfile.displayName,
      about: createdProfile.about,
      bump: createdProfile.bump,
    });

    const editSignature = await program.methods
      .editProfile("jezqwx Web3", "Updated on-chain profile with PDA")
      .accountsStrict({
        profile: profilePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();
    console.log("Edit transaction signature:", editSignature);

    const editedProfile = await program.account.userProfile.fetch(profilePda);
    expect(editedProfile.authority.equals(provider.wallet.publicKey)).to.be.true;
    expect(editedProfile.displayName).to.equal("jezqwx Web3");
    expect(editedProfile.about).to.equal("Updated on-chain profile with PDA");
    expect(editedProfile.bump).to.equal(bump);
    console.log("Updated profile:", {
      authority: editedProfile.authority.toBase58(),
      displayName: editedProfile.displayName,
      about: editedProfile.about,
      bump: editedProfile.bump,
    });
  });
});
