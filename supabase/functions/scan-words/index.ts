// Scans a photo / PDF of a vocabulary page with Claude and returns the word list as JSON.
// Needs the ANTHROPIC_API_KEY secret. Callers must be signed in; each family gets a daily scan limit.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const DAILY_LIMIT = 30;
const MAX_FILES = 6;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "sections", "words", "notes"],
  properties: {
    title: { type: "string", description: "Short title for this word list, e.g. the unit or page name" },
    notes: { type: "string", description: "Anything the parent should check (unclear words, cut-off text). Empty if none." },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title"],
        properties: {
          key: { type: "string", description: "short lowercase id, e.g. nouns, verbs, adjectives, other" },
          title: { type: "string", description: "heading as on the page plus Hebrew, e.g. 'NOUNS · שמות עצם'" },
        },
      },
    },
    words: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["en", "he", "pos", "section", "forms"],
        properties: {
          en: { type: "string", description: "the word or phrase exactly as printed in the list" },
          he: { type: "string", description: "Hebrew translation for a 10-12 year old; for words with two common meanings use 'meaning1; meaning2'" },
          pos: { type: "string", enum: ["noun", "verb", "nounverb", "adj", "phrase", "fixed"] },
          section: { type: "string", description: "key of the section this word is listed under" },
          forms: {
            type: "array",
            items: { type: "string" },
            description: "every lowercase spelling that should count as this word in song lyrics: the base form, inflections (plural, past, past participle, -ing, 3rd person), sung forms like lovin', British/American spellings. For phrases give the full phrase variants, e.g. 'fall in love', 'fell in love', 'falling in love'. Do not include different words (e.g. not 'lovely' for 'love').",
          },
        },
      },
    },
  },
};

const PROMPT = `This is a page from an English vocabulary list that an Israeli child (age 10-12) has to learn.
Extract the vocabulary words that the page asks the child to learn, grouped by the sections printed on the page (for example NOUNS, VERBS, ADJECTIVES, OTHER). Skip exercise text, instructions and example sentences that are not part of the word list.
If there is no clear word list, extract the English words that are being taught.
Keep the words in the order they appear. Translate each word to natural, simple Hebrew.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // who is calling?
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "not signed in" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin.from("scan_log").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= DAILY_LIMIT) return json({ error: "daily scan limit reached" }, 429);

  // input: { files: [{ media_type, data (base64) }] }
  let files: { media_type: string; data: string }[];
  try {
    ({ files } = await req.json());
  } catch {
    return json({ error: "bad request" }, 400);
  }
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return json({ error: `send 1-${MAX_FILES} files` }, 400);
  const total = files.reduce((n, f) => n + (f?.data?.length ?? 0) * 0.75, 0);
  if (total > MAX_TOTAL_BYTES) return json({ error: "files too large" }, 413);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of files) {
    if (f.media_type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    } else if ((IMAGE_TYPES as readonly string[]).includes(f.media_type)) {
      content.push({ type: "image", source: { type: "base64", media_type: f.media_type as ImageType, data: f.data } });
    } else {
      return json({ error: `unsupported file type ${f.media_type}` }, 400);
    }
  }
  content.push({ type: "text", text: PROMPT });

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });

    await admin.from("scan_log").insert({
      user_id: user.id,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });

    if (response.stop_reason === "refusal") return json({ error: "the page could not be processed" }, 422);
    if (response.stop_reason === "max_tokens") return json({ error: "the page has too many words; scan it in parts" }, 422);
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return json({ error: "no result" }, 502);
    return json(JSON.parse(text.text));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "busy, try again in a minute" }, 429);
    if (e instanceof Anthropic.BadRequestError) return json({ error: "the file could not be read" }, 400);
    if (e instanceof Anthropic.APIError) return json({ error: `scan failed (${e.status})` }, 502);
    console.error(e);
    return json({ error: "scan failed" }, 500);
  }
});
