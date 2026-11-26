// Checks candidate songs (not yet in songs.json) for words that have few or no songs.
// Usage: node scripts/suggest-songs.mjs candidates.json [maxExistingHits=1]
// candidates.json: { "songs": [[title, artist, group], ...] }
// Prints a JSON report: for each thin word, the candidate songs whose timed lyrics contain it.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildMatcher, parseLRC, indexLyrics, pickLyrics, wordId } from "../lib/matcher.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const cacheDir = path.join(dataDir, ".cache");
const UA = "voc-kids/0.1 (personal vocabulary app)";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lyricsFor(title, artist) {
  const file = path.join(cacheDir, `${slug(artist)}--${slug(title)}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  const search = async (params) => {
    const res = await fetch("https://lrclib.net/api/search?" + new URLSearchParams(params), { headers: { "User-Agent": UA } });
    return res.ok ? res.json() : [];
  };
  let best = pickLyrics(await search({ track_name: title, artist_name: artist }), title, artist);
  if (!best) best = pickLyrics(await search({ q: `${title} ${artist}` }), title, artist);
  const out = best ? { id: best.id, trackName: best.trackName, artistName: best.artistName, duration: best.duration, syncedLyrics: best.syncedLyrics } : null;
  await writeFile(file, JSON.stringify(out));
  await sleep(150);
  return out;
}

await mkdir(cacheDir, { recursive: true });
const [candFile, maxArg] = process.argv.slice(2);
const maxExisting = Number(maxArg ?? 1);
const { songs: candidates } = JSON.parse(await readFile(candFile, "utf8"));
const { songs: existing } = JSON.parse(await readFile(path.join(dataDir, "songs.json"), "utf8"));
const index = JSON.parse(await readFile(path.join(dataDir, "index.json"), "utf8"));
const { lists } = JSON.parse(await readFile(path.join(dataDir, "words.json"), "utf8"));
const words = lists.flatMap((l) => l.words);
const thin = words.filter((w) => (index.hits[wordId(w)] || []).length <= maxExisting);
const matchers = thin.map(buildMatcher);
const have = new Set(existing.map(([t, a]) => `${a}|${t}`.toLowerCase()));

const report = Object.fromEntries(thin.map((w) => [w.en, { existing: (index.hits[wordId(w)] || []).length, found: [] }]));
let checked = 0, noLyrics = [];
for (const [title, artist, group] of candidates) {
  if (have.has(`${artist}|${title}`.toLowerCase())) continue;
  const lyr = await lyricsFor(title, artist);
  checked++;
  if (!lyr) { noLyrics.push(`${title} – ${artist}`); continue; }
  const hits = indexLyrics(parseLRC(lyr.syncedLyrics), matchers);
  for (const w of thin) {
    const h = hits[wordId(w)];
    if (h) report[w.en].found.push({ title, artist, group, lrclib: `${lyr.trackName} – ${lyr.artistName}`, line: h.line });
  }
}
console.log(JSON.stringify({ checked, noLyrics, report }, null, 1));
