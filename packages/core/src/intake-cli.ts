// Batch intake from JSONL (§13.6). Python never writes content directly; it calls this.
// usage: node --experimental-strip-types packages/core/src/intake-cli.ts --db data/app.db --jsonl file.jsonl
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ensureSchema, openAppDb } from "./db.ts";
import { intakeInsert, type NewContent } from "./review.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (k: string): string => {
    const i = args.indexOf(k);
    if (i < 0 || !args[i + 1]) throw new Error(`missing ${k}`);
    return args[i + 1]!;
  };
  const db = openAppDb(get("--db"), "tool");
  ensureSchema(db);
  let n = 0;
  let inserted = 0;
  for await (const line of createInterface({ input: createReadStream(get("--jsonl")) })) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as NewContent;
    n++;
    if (intakeInsert(db, c, Date.now()).inserted) inserted++;
  }
  console.log(JSON.stringify({ read: n, inserted }));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
