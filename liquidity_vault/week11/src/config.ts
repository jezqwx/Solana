import { PublicKey } from "@solana/web3.js";
import path from "node:path";
import os from "node:os";

export const ROOT = path.resolve(__dirname, "..");
export const RPC = "https://api.devnet.solana.com";
export const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const CLMM = new PublicKey(
  "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH"
);
export const VAULT = new PublicKey(
  "DVpRhnW4ZE76uRq2gQBJsEPiikmV4cTH5tqXNinJHQK9"
);
export const WALLET = path.join(os.homedir(), ".config/solana/jezqwx/id.json");
export const AMM_CONFIG = new PublicKey(
  "CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu"
);
export const EXPECTED_WALLET = "bnCwyNq3mqquCp3bQksZnrMk7t4wR8iw2NU2x21pjDe";
export const DECIMALS = 6;
export const SUPPLY = BigInt("1000000000000"); // 1,000,000 of each test token.
export const MAX_SPEND_LAMPORTS = 500_000_000;
export const SOURCES = {
  sdk: "@raydium-io/raydium-sdk-v2@0.2.74-alpha",
  sdkCommit: "e2e8bcd865189c994682a9477ec8eaf1e2da8aaf",
  demoCommit: "003d9045830033e5ef4178d6db129d83f93e1c7f",
  demo: "https://github.com/raydium-io/raydium-sdk-V2-demo",
};
