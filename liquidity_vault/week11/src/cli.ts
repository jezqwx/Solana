import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";
import {
  check,
  faucet,
  tokens,
  pool,
  position,
  verify,
  readPool,
} from "./workflow";

async function main() {
  const command = process.argv[2];
  const commands: Record<string, () => Promise<unknown>> = {
    check,
    faucet,
    tokens,
    pool,
    position,
    verify,
    read: readPool,
  };
  if (!commands[command])
    throw new Error(
      "Use check | faucet | tokens | pool | position | verify | read"
    );
  // Fail closed on concurrent or interrupted mutation processes.
  const mutates = !["verify", "read"].includes(command);
  const lock = path.join(ROOT, ".runtime", "command.lock");
  if (mutates) {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, command }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      throw new Error(
        "Existing .runtime/command.lock: check that its process has stopped and inspect manifest signatures before manually removing the lock."
      );
    }
  }
  try {
    await commands[command]();
  } finally {
    if (mutates) fs.unlinkSync(lock);
  }
}
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
