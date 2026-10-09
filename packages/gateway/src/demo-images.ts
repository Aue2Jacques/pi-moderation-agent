// Images in demo mode ("pretend, but say so"): a scripted image checker behind the existing image channel (image.ts:
// ImageStore + ImageChecker; fastpath.ts records its answers as the scene's image_check question), and the image intake
// shared by demo and real mode (validation, storing by content hash). The scripted checker knows the preset screenshots
// (DEMO_IMAGE_SAMPLES) by their hash and answers with their fixed probability; any other image gets 0.5, the middle of
// the band, so it is never decided automatically (it goes to the agent, which cannot pass an image, and then to a
// person). Real mode keeps its own checker (or none: image content goes to a person) and only uses the intake part.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@mod/core";
import { DEMO_JUDGE_PROVIDER, DEMO_VISION_MODEL, imageRefOf, type LoadedDemoImage } from "@mod/worker";
import type { ImageChecker } from "./image.ts";

/** Uploads larger than this are refused (413); the image store itself accepts up to 5 MB. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** The image types accepted, by their leading bytes (the declared type is not trusted). */
const SIGNATURES: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: "png", mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "webp", mime: "image/webp", test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "gif", mime: "image/gif", test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")) },
];

export type ImageInputError = { status: 400 | 413 | 415; code: "E_IMAGE_INVALID" | "E_IMAGE_TOO_LARGE" | "E_IMAGE_TYPE"; message: string };

/** Decode a base64 image (plain or a data: URL) and check size and type. */
export function decodeImage(data: unknown): { bytes: Buffer; ext: string; mime: string } | ImageInputError {
  if (typeof data !== "string" || !data) return { status: 400, code: "E_IMAGE_INVALID", message: "image.data must be a base64 string or a data: URL" };
  const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(b64)) return { status: 400, code: "E_IMAGE_INVALID", message: "image.data is not valid base64" };
  if ((b64.length * 3) / 4 > MAX_IMAGE_BYTES + 4) return { status: 413, code: "E_IMAGE_TOO_LARGE", message: `image larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) return { status: 400, code: "E_IMAGE_INVALID", message: "image is empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { status: 413, code: "E_IMAGE_TOO_LARGE", message: `image larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  const sig = SIGNATURES.find((s) => s.test(bytes));
  if (!sig) return { status: 415, code: "E_IMAGE_TYPE", message: "only PNG, JPEG, WebP and GIF images are accepted" };
  return { bytes, ext: sig.ext, mime: sig.mime };
}

/** Store an image in `dir` under its content-hash ref (idempotent); returns the ref for content.image_refs. */
export function storeImage(dir: string, bytes: Buffer, ext: string): string {
  const ref = imageRefOf(core.sha256(bytes.toString("base64")), ext);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, ref);
  if (!existsSync(p)) writeFileSync(p, bytes, { mode: 0o600 });
  return ref;
}

/** Scripted image check: fixed answers for the preset screenshots, 0.5 for anything else. `delayMs` stands for the
 *  vision encoder and the image questions (Kev: about 0.3 s per image, reports/2026-10-09-kev-inference-speed.md §11). */
export function demoImageChecker(presets: readonly LoadedDemoImage[], o: { delayMs?: number } = {}): ImageChecker {
  const byRef = new Map(presets.map((p) => [p.ref, p] as const));
  const delayMs = o.delayMs ?? 300;
  return {
    provider: DEMO_JUDGE_PROVIDER,
    model: DEMO_VISION_MODEL,
    async check({ images, question }) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const ps = images.map((im) => byRef.get(im.ref)?.imageP ?? 0.5);
      const p = Math.max(...ps);
      const unknown = Object.keys(question.criteria).includes("unknown") ? 0.004 : 0;
      const pass = question.passChoices[0] ?? "none";
      const probs: Record<string, number> = { [question.violationOption]: p * (1 - unknown), [pass]: (1 - p) * (1 - unknown), ...(unknown ? { unknown } : {}) };
      return { status: "ok", model: DEMO_VISION_MODEL, choice: p >= 0.5 ? question.violationOption : pass, probs, usage: { input: 280 * images.length, output: 4 }, latencyMs: delayMs };
    },
  };
}
