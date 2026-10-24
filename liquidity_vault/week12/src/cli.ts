import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import * as c from "./client";
import { run, verify } from "./integration";
async function main() {
  const command = process.argv[2];
  if (command === "quote") {
    const q = await c.quote(new BN("1000000"), true);
    console.log({
      input: q.amount.toString(),
      expected: q.expected.toString(),
      minimum: q.minimum.toString(),
      ticks: q.accounts.map((p) => p.toBase58()),
    });
    return;
  }
  if (command === "verify") {
    await verify();
    return;
  }
  if (!["check", "run"].includes(command))
    throw new Error("Use check | quote | run | verify");
  const lock = path.join(c.ROOT, ".runtime", "command.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    if (command === "check") await c.check();
    else await run();
  } finally {
    fs.unlinkSync(lock);
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  });
