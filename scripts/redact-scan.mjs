// heuristic only (dev-doc §12.6): flag >=20 consecutive CJK chars in tracked files outside docs/, rules/, fixtures/benign/
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !/^(docs|rules|fixtures\/benign|reports)\//.test(f) && !f.endsWith(".md"));
const re = /[一-鿿]{20,}/;
const hits = files.filter((f) => { try { return re.test(readFileSync(f, "utf8")); } catch { return false; } });
if (hits.length) { console.error("redact-scan: suspicious long CJK runs in:\n" + hits.join("\n")); process.exit(1); }
console.log(`redact-scan: ${files.length} files ok`);
