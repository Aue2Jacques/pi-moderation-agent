// Show the exact HTTP request the fast path sends to Jev, without contacting Jev: the client is pointed at a local
// capture server. usage: node --experimental-strip-types scripts/dump-judge-request.ts [ref=fx/a1-2]
import { createServer } from "node:http";
import { createModels } from "@earendil-works/pi-ai/models";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";
import { loadRefs, sceneQuestions, sentence } from "./lib/contract-fixtures.ts";

const ref = process.argv[2] ?? "fx/a1-2";
const captured: { method?: string; url?: string; headers?: Record<string, unknown>; body?: string } = {};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { authorization: _a, ...headers } = req.headers;
    Object.assign(captured, { method: req.method, url: req.url, headers, body });
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "capture only" }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const models = createModels();
models.setProvider(jevProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "capture-only" }));
const judge = piJudge(models, jevModel(models), { inCallConfirm: true, timeoutMs: 5000 });
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const e = loadRefs()[ref]!;
await judge.classify({ contentId: "dump", text: sentence(e), scene: e.scene, evidence: [], questions: sceneQuestions(bundle, e.scene) });
server.close();
console.log(`${captured.method} ${captured.url}`);
console.log(JSON.stringify(captured.headers, null, 1));
console.log(JSON.stringify(JSON.parse(captured.body ?? "{}"), null, 2));
