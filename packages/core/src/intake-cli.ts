// Batch intake from JSONL (§13.6). Python never writes content directly; it calls this.
// usage: node --experimental-strip-types packages/core/src/intake-cli.ts --db data/app.db --jsonl file.jsonl
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ensureSchema, openAppDb } from "./db.ts";
import { redact } from "./redact.ts";
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
  let bad = 0;
  let lineNo = 0;
  for await (const line of createInterface({ input: createReadStream(get("--jsonl")) })) {
    lineNo++;
    if (!line.trim()) continue;
    n++;
    let c: NewContent;
    try {
      c = JSON.parse(line) as NewContent;
    } catch (e) {
      // dev plan R9d: JSON.parse messages quote the start of the input; report position and error type only
      bad++;
      console.error(`line ${lineNo}: ${(e as Error).name} (invalid JSON, ${line.length} chars) — skipped`);
      continue;
    }
    if (intakeInsert(db, c, Date.now()).inserted) inserted++;
  }
  console.log(JSON.stringify({ read: n, inserted, bad }));
  if (bad > 0) process.exitCode = 1;   // a bad line is reported, not silently accepted
}

main().catch((e) => {
  console.error(redact(e));
  process.exit(1);
});
