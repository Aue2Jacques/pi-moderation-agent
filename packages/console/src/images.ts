// Images of contents in the console. A content's image is content like its text: only preset demo screenshots (public
// sample files) and images this tab uploaded itself (kept as object URLs for the session) are shown directly; any other
// image is fetched through the restricted view (reviewer sign-in, confirmation, audited server side).
import { authHeaders, type Reviewer } from "./api.ts";

/** content id -> object URL of an image this tab uploaded */
export const localImages = new Map<string, string>();

/** Fetch one image through the restricted view; resolves to an object URL. */
export async function restrictedImage(contentId: string, n: number, reviewer: Reviewer): Promise<string> {
  const res = await fetch(`/api/contents/${encodeURIComponent(contentId)}/images/${n}`, { headers: { ...authHeaders(reviewer), "x-confirm": "yes" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
