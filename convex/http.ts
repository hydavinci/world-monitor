import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const aArr = new Uint8Array(sigA);
  const bArr = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < aArr.length; i++) diff |= aArr[i]! ^ bArr[i]!;
  return diff === 0;
}

function extractConvexErrorCode(error: unknown): string | null {
  let data = (error as { data?: unknown } | undefined)?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return data as string; }
  }
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const code = record.code ?? record.kind;
  return typeof code === "string" ? code : null;
}

const http = httpRouter();

// Public edge validation precedes this service-authenticated storage boundary.
http.route({
  path: "/leads/submit-contact",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.CONVEX_SERVER_SHARED_SECRET ?? "";
    const provided = request.headers.get("x-convex-shared-secret") ?? "";
    if (!expected || !(await timingSafeEqualStrings(provided, expected))) {
      return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "INVALID_CONTACT" }, { status: 400 });
    }
    const contact = body as Record<string, unknown>;
    if (typeof contact.name !== "string" || typeof contact.email !== "string"
      || typeof contact.source !== "string"
      || [contact.organization, contact.phone, contact.message].some(
        value => value !== undefined && typeof value !== "string",
      )) {
      return Response.json({ error: "INVALID_CONTACT" }, { status: 400 });
    }
    try {
      return Response.json(await ctx.runMutation(internal.contactMessages.submit, {
        name: contact.name,
        email: contact.email,
        source: contact.source,
        organization: contact.organization as string | undefined,
        phone: contact.phone as string | undefined,
        message: contact.message as string | undefined,
      }));
    } catch (error) {
      const code = extractConvexErrorCode(error);
      if (code === "rate_limited") return Response.json({ error: code }, { status: 429 });
      if (code === "FREE_EMAIL_NOT_ALLOWED") return Response.json({ error: code }, { status: 422 });
      return Response.json({ error: "CONTACT_STORAGE_FAILED" }, { status: 503 });
    }
  }),
});

export default http;
