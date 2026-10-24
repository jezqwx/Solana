import fs from "node:fs";
import path from "node:path";
import * as c from "./client";
import * as p from "./position";
import * as w from "./workflow";
import BN from "bn.js";
async function main() {
  const command = process.argv[2];
  if (command === "quote") {
    const q = await c.quote(new BN(1000000), true);
    console.log({
      input: q.amount.toString(),
      expected: q.expected.toString(),
      minimum: q.minimum.toString(),
    });
    return;
  }
  if (command === "read") {
    console.log(await p.read());
    return;
  }
  if (command === "verify") {
    await w.verify();
    return;
  }
  const actions: Record<string, () => Promise<any>> = {
    preflight: p.preflight,
    run: w.run,
    open: w.open,
    add: w.add,
    trade: w.trade,
    collect: w.collect,
    decrease: w.decrease,
    close: w.close,
    reverse: w.reverse,
    end: w.end,
  };
  if (!actions[command]) throw Error("Unknown command");
  fs.mkdirSync(p.runtime, { recursive: true });
  const lock = path.join(p.runtime, "command.lock");
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    if (command !== "preflight" && command !== "run") await w.reconcileAll();
    await actions[command]();
  } finally {
    fs.unlinkSync(lock);
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
