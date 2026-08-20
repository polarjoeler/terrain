/** Turn a screenshot of a store table into import-ready CSV using Claude vision.
 *
 *  Admin uploads an image (e.g. a StoreLeads grid); we ask Claude to read every
 *  visible store row and return CSV in the columns importCsv() understands. The
 *  admin reviews/edits the CSV before it's committed — OCR is strong but not
 *  perfect, so a human confirm step is deliberate. Matches the app's existing
 *  raw-HTTP Anthropic pattern (scripts/ai-enrich.mjs); no SDK dependency. */

const VISION_MODEL = process.env.VISION_MODEL ?? "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type VisionMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const PROMPT = `You are extracting a table of e-commerce stores from a screenshot (e.g. a StoreLeads grid, a spreadsheet, or a directory listing).

Output ONLY CSV — no prose, no explanation, no markdown code fence.

The FIRST line must be exactly this header:
domain,name,country,products,price_min,price_max,plus,payments

Then one line per store visible in the image. Rules:
- "domain" is REQUIRED — the store's web domain (e.g. example.co.za). Strip https:// and www. If a row has no readable domain, skip that row entirely.
- "country" as a 2-letter code when obvious (ZA, NG, KE…), else blank.
- "products" = product count if shown, else blank. price_min/price_max = numbers only (no currency symbols), else blank.
- "plus" = true only if the row clearly indicates Shopify Plus, else blank.
- "payments" = semicolon-separated provider names if shown, else blank.
- Leave any cell blank if it isn't clearly visible. Do NOT guess or invent values or rows.
- Quote any value that contains a comma.`;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Returns import-ready CSV text (header + rows). Throws with a clear message on
 *  a missing key or an API/network error. */
export async function extractStoresCsv(base64: string, mediaType: VisionMediaType): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set on the server");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Vision request failed (${res.status}) ${detail.slice(0, 300)}`);
  }
  const data: any = await res.json();
  const text: string = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();

  // Strip an accidental ```csv fence if the model added one.
  const csv = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
  if (!/^domain\b/i.test(csv)) {
    throw new Error("Could not read a store table from that image — try a clearer screenshot.");
  }
  return csv;
}
