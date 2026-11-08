// supabase/functions/media-worker/index.ts — the background parser (Extraction Engine Stage A).
//
// DEPLOY: Supabase dashboard → Edge Functions → Deploy new function → name it `media-worker`,
// paste this file. Secrets needed: ANTHROPIC_API_KEY (SUPABASE_URL / SERVICE_ROLE are injected
// automatically). The CLIENT kicks it (supabase.functions.invoke) after uploading; each
// invocation claims ONE unit of work, processes it, then re-invokes itself until the entry is
// done — so processing continues after the app closes. The Media tab re-kicks processing
// entries on every poll, which also revives a chain that died mid-flight.
//
// Units: with sentences ON, first NUMBER each page (Haiku reads the printed page number), then
// EXTRACT window by window (Sonnet, consecutive pages in pairs). Sentences OFF skips numbering
// and extracts every page solo. On completion every image is deleted from storage.
//
// deno-lint-ignore-file no-explicit-any
// @ts-nocheck — Deno module; excluded from the app's tsconfig.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const EXTRACT_MODEL = "claude-sonnet-5";
const NUMBER_MODEL = "claude-haiku-4-5-20251001";
const BUCKET = "media-pages";
/** A 'working' row older than this is considered orphaned (its invocation died) and reclaimable. */
const STUCK_MS = 3 * 60 * 1000;

const db = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ─── Language names (prompt text) ────────────────────────────────────────────
const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  bg: "Bulgarian", el: "Greek", ru: "Russian", uk: "Ukrainian", pl: "Polish", cs: "Czech",
  ro: "Romanian", nl: "Dutch", sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish",
  hu: "Hungarian", tr: "Turkish", ar: "Arabic", he: "Hebrew", fa: "Persian", hi: "Hindi",
  ko: "Korean", ja: "Japanese", zh: "Chinese", vi: "Vietnamese", th: "Thai", id: "Indonesian",
  sr: "Serbian", hr: "Croatian", sk: "Slovak", sl: "Slovenian", lt: "Lithuanian", lv: "Latvian",
  et: "Estonian", ca: "Catalan", eu: "Basque", gl: "Galician", sq: "Albanian", mk: "Macedonian",
};
const langName = (code: string) => LANG_NAMES[code?.toLowerCase()] ?? code;

// ─── Prompt composition (the arsenal — no user free text ever enters these) ──

interface EntryOptions { circled?: boolean; underlined?: boolean; sentences?: boolean; nounArticle?: boolean }

function markerBlock(o: EntryOptions): string {
  const parts: string[] = [];
  if (o.circled) parts.push("- CIRCLED: a hand-drawn loop fully or partially enclosing a word or phrase, in pen or pencil, possibly sloppy or broken");
  if (o.underlined) parts.push("- UNDERLINED: a hand-drawn line under a word or phrase (single or multiple strokes; wavy counts)");
  return parts.join("\n");
}

function extractionPrompt(o: EntryOptions, src: string, tgt: string, two: boolean): string {
  const S = langName(src), T = langName(tgt);
  const nounForm = o.nounArticle
    ? `nominative singular WITH its definite article (the way a learner cards gender); a word that only exists in the plural keeps its plural`
    : `nominative singular, NO article; a word that only exists in the plural keeps its plural`;
  const sentenceField = o.sentences
    ? `\n- "sentence": the COMPLETE printed sentence it appears in, copied exactly. If the sentence starts on the first page and finishes on the second, use both pages to return the WHOLE sentence.`
    : ``;
  const sentenceShape = o.sentences ? `, "sentence": "..."` : ``;
  return `These are ${two ? "two consecutive pages" : "one page"} of a printed ${S} book, photographed by a reader who marks words they don't know. IGNORE the reader's handwriting entirely — only PRINTED text ever counts.

THE READER'S MARKS — extract every word or phrase carrying any of these:
${markerBlock(o)}

For EVERY marked item${two ? ", on either page" : ""}, report:
- "text": the item exactly as printed (keep accents, casing, hyphens).
- "kind": "word" or "phrase". A phrase is any multi-word lexical UNIT — an idiom, a phrasal verb, a fixed expression — whose meaning is not just its words added up. A reflexive verb with its pronoun is ONE unit but counts as a "word" (a verb).
- "display": the form the learner would put on a flashcard. Nouns: ${nounForm}. Verbs: the infinitive (keep a reflexive pronoun when the citation form carries it). Adjectives: masculine singular. PHRASES: keep them EXACTLY as printed — same conjugation, same words, change nothing.
- "lemma": the bare ${S} dictionary citation form, lowercase, NO article. For a phrase, repeat the printed phrase unchanged.
- "gloss": the ${T} meaning AS USED here. Give ONE translation almost always; only a word with genuinely distinct meanings may have two, at most three, separated by "; ".${sentenceField}
- "marker": which mark it carries (circled / underlined).

SEPARATELY, report "allLemmas": the bare ${S} citation form of every distinct CONTENT word printed on the page${two ? "s" : ""} — nouns, verbs, adjectives, adverbs — marked or not. One entry per distinct lemma, no duplicates. EXCLUDE pure function words (articles, pronouns, prepositions, conjunctions, auxiliaries), proper names of people/places, and numerals. The reader's unmarked words are evidence of vocabulary they know — completeness matters.

Also report "pageLanguage": the two-letter ISO 639-1 code of the language the printed text is ACTUALLY written in — report what you see, not what is expected.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{ "occurrences": [ { "text": "...", "kind": "word", "display": "...", "lemma": "..."${sentenceShape}, "gloss": "...", "marker": "underlined" } ],
  "allLemmas": [ "...", "..." ],
  "pageLanguage": "${src.toLowerCase()}" }`;
}

const NUMBER_PROMPT = `This is a photograph of a printed book page. Find the PRINTED page number — usually in the top or bottom margin. If the photo shows two facing pages, report the LEFT (lower) page's number. Ignore any handwriting. If no page number is legible, use null.

Respond with ONLY a JSON object, no other text: { "pageNumber": 42 }`;

// ─── Anthropic ────────────────────────────────────────────────────────────────

async function vision(model: string, maxTokens: number, images: Uint8Array[], prompt: string): Promise<any> {
  const content: any[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(img) },
  }));
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`anthropic-${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data?.content ?? []).find((b: any) => b?.type === "text")?.text ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("no-json");
  return JSON.parse(m[0]);
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function download(supabase: any, path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`download-failed: ${error?.message ?? "no data"}`);
  return new Uint8Array(await data.arrayBuffer());
}

// ─── Work claiming ───────────────────────────────────────────────────────────

/** Optimistic claim: flip pending (or orphaned working) → working; true if WE got it. */
async function claim(supabase: any, pageId: string, fromStatus: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  let q = supabase.from("media_pages")
    .update({ status: "working", updated_at: new Date().toISOString(), ...extra })
    .eq("id", pageId).eq("status", fromStatus);
  if (fromStatus === "working") q = q.lt("updated_at", new Date(Date.now() - STUCK_MS).toISOString());
  const { data, error } = await q.select("id");
  return !error && Array.isArray(data) && data.length > 0;
}

const claimable = (p: any) =>
  p.status === "pending" || (p.status === "working" && Date.parse(p.updated_at) < Date.now() - STUCK_MS);

/** Reading order: printed page number first (nulls keep upload order, after the numbered). */
function orderPages(pages: any[]): any[] {
  const known = pages.filter((p) => p.page_number != null)
    .sort((a, b) => (a.page_number - b.page_number) || (a.page_index - b.page_index));
  const unknown = pages.filter((p) => p.page_number == null).sort((a, b) => a.page_index - b.page_index);
  return [...known, ...unknown];
}

/** Pair windows over ordered pages (consecutive numbers or unknown pair up); solo otherwise.
 *  Returns window-key page → its window members. */
function windows(ordered: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  const covered = new Set<string>();
  const canPair = (a: any, b: any) => a.page_number == null || b.page_number == null || b.page_number - a.page_number === 1;
  for (let i = 0; i < ordered.length - 1; i++) {
    if (!canPair(ordered[i], ordered[i + 1])) continue;
    out.set(ordered[i].id, [ordered[i], ordered[i + 1]]);
    covered.add(ordered[i].id); covered.add(ordered[i + 1].id);
  }
  for (const p of ordered) if (!covered.has(p.id)) out.set(p.id, [p]);
  return out;
}

// ─── One unit of work ────────────────────────────────────────────────────────

/** Returns true when it did something (so the chain should continue). */
async function step(entryId: string): Promise<boolean> {
  const supabase = db();
  const { data: entry } = await supabase.from("media_entries").select("*").eq("id", entryId).single();
  if (!entry || entry.deleted_at || entry.status !== "processing") return false;
  const o: EntryOptions = entry.options ?? {};

  const { data: pages } = await supabase.from("media_pages").select("*").eq("entry_id", entryId).order("page_index");
  if (!pages || pages.length === 0) return false;

  // ── Numbering phase (sentences mode only) ──
  if (o.sentences) {
    const toNumber = pages.find((p) => !p.numbered && p.status !== "failed" && claimable(p));
    if (toNumber) {
      if (!(await claim(supabase, toNumber.id, toNumber.status))) return true; // raced — let the chain retry
      try {
        const img = await download(supabase, toNumber.storage_path);
        const parsed = await vision(NUMBER_MODEL, 300, [img], NUMBER_PROMPT);
        const n = typeof parsed?.pageNumber === "number" && parsed.pageNumber > 0 ? Math.round(parsed.pageNumber) : null;
        await supabase.from("media_pages").update({ page_number: n, numbered: true, status: "pending", updated_at: new Date().toISOString() }).eq("id", toNumber.id);
      } catch (e) {
        // Numbering failure is soft: the page keeps upload order (benefit-of-the-doubt pairing).
        await supabase.from("media_pages").update({ numbered: true, status: "pending", updated_at: new Date().toISOString(), error: `number: ${String(e).slice(0, 200)}` }).eq("id", toNumber.id);
      }
      return true;
    }
    // Extraction only starts once every uploaded page has been through numbering AND the
    // upload itself is complete (entry.pages is the client's final count).
    if (pages.length < (entry.pages ?? pages.length)) return false;
    if (pages.some((p) => !p.numbered && p.status !== "failed")) return false;
  }

  // ── Extraction phase ──
  const ordered = o.sentences ? orderPages(pages) : [...pages].sort((a, b) => a.page_index - b.page_index);
  const wins = o.sentences ? windows(ordered) : new Map(ordered.map((p) => [p.id, [p]]));

  const key = ordered.find((p) => wins.has(p.id) && p.result == null && !p.covered && claimable(p));
  if (key) {
    if (!(await claim(supabase, key.id, key.status))) return true;
    const members = wins.get(key.id)!;
    try {
      const images = await Promise.all(members.map((m: any) => download(supabase, m.storage_path)));
      const prompt = extractionPrompt(o, entry.source_language, entry.target_language, images.length === 2);
      const parsed = await vision(EXTRACT_MODEL, 16000, images, prompt);
      const occurrences = Array.isArray(parsed?.occurrences) ? parsed.occurrences : [];
      const allLemmas = Array.isArray(parsed?.allLemmas) ? parsed.allLemmas.filter((l: unknown) => typeof l === "string") : [];
      const pageLanguage = typeof parsed?.pageLanguage === "string" ? parsed.pageLanguage.trim().toLowerCase() : null;
      await supabase.from("media_pages").update({
        status: "done", result: { occurrences, allLemmas, pageLanguage }, updated_at: new Date().toISOString(),
      }).eq("id", key.id);
    } catch (e) {
      await supabase.from("media_pages").update({
        status: "failed", error: `extract: ${String(e).slice(0, 300)}`, updated_at: new Date().toISOString(),
      }).eq("id", key.id);
    }
    return true;
  }

  // Window keys all resolved → mark pure-tail pages covered/done.
  const keyIds = new Set(wins.keys());
  const tails = pages.filter((p) => !keyIds.has(p.id) && p.status !== "done" && p.status !== "failed");
  const keysSettled = [...keyIds].every((id) => {
    const p = pages.find((x) => x.id === id);
    return p && (p.status === "done" || p.status === "failed");
  });
  if (keysSettled && tails.length > 0) {
    await supabase.from("media_pages").update({ status: "done", covered: true, updated_at: new Date().toISOString() })
      .in("id", tails.map((t) => t.id));
    return true;
  }

  // ── Completion: everything settled → entry done, images deleted ──
  if (keysSettled && tails.length === 0 && pages.length >= (entry.pages ?? pages.length)) {
    const failed = pages.filter((p) => p.status === "failed").length;
    const paths = pages.map((p) => p.storage_path).filter(Boolean);
    if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths);
    await supabase.from("media_pages").update({ storage_path: null }).eq("entry_id", entryId);
    await supabase.from("media_entries").update({
      status: "done",
      stats: { ...(entry.stats ?? {}), failedPages: failed, engine: "v2" },
      updated_at: new Date().toISOString(),
    }).eq("id", entryId);
    return false;
  }
  return false; // nothing claimable right now (another invocation is mid-unit)
}

// ─── HTTP entry point ────────────────────────────────────────────────────────

// The browser invokes this (supabase.functions.invoke), which means a CORS preflight —
// without these headers every kick is silently blocked and nothing ever processes.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), { headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const entryId = body?.entry_id ?? body?.record?.entry_id;
  if (!entryId || typeof entryId !== "string") {
    return json({ ok: false, reason: "no-entry" });
  }

  let didWork = false;
  try {
    didWork = await step(entryId);
  } catch (e) {
    console.error("[media-worker]", e);
  }

  // Chain: more work may remain — re-invoke self without holding this request open.
  if (didWork) {
    const chain = fetch(`${SUPABASE_URL}/functions/v1/media-worker`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ entry_id: entryId }),
    }).catch(() => {});
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(chain);
    else await chain;
  }

  return json({ ok: true, didWork });
});
