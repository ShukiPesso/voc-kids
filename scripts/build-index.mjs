// Builds data/index.json: for every vocabulary word, the song lines that contain it.
// Usage: node scripts/build-index.mjs   (lyrics are cached in data/.cache, so re-runs are fast)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildMatcher, parseLRC, indexLyrics, pickLyrics } from "../lib/matcher.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const cacheDir = path.join(dataDir, ".cache");
const UA = "voc-kids/0.1 (personal vocabulary app)";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lrclib(params) {
  const url = "https://lrclib.net/api/search?" + new URLSearchParams(params);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return res.json();
    await sleep(1500 * (attempt + 1));
  }
  return [];
}

async function lyricsFor(title, artist) {
  const file = path.join(cacheDir, `${slug(artist)}--${slug(title)}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  let best = pickLyrics(await lrclib({ track_name: title, artist_name: artist }), title, artist);
  if (!best) best = pickLyrics(await lrclib({ q: `${title} ${artist}` }), title, artist);
  const out = best
    ? { id: best.id, trackName: best.trackName, artistName: best.artistName, duration: best.duration, syncedLyrics: best.syncedLyrics }
    : null;
  await writeFile(file, JSON.stringify(out));
  await sleep(150);
  return out;
}

await mkdir(cacheDir, { recursive: true });
const { songs } = JSON.parse(await readFile(path.join(dataDir, "songs.json"), "utf8"));
const { lists } = JSON.parse(await readFile(path.join(dataDir, "words.json"), "utf8"));
const matchers = lists.flatMap((l) => l.words).map(buildMatcher);

const outSongs = [];
const hits = {};
const missing = [];
for (const [title, artist, group] of songs) {
  const lyr = await lyricsFor(title, artist);
  if (!lyr) { missing.push(`${title} – ${artist}`); continue; }
  const s = outSongs.length;
  outSongs.push({ title, artist, group, duration: lyr.duration, lrclib: lyr.id });
  const found = indexLyrics(parseLRC(lyr.syncedLyrics), matchers);
  // No lyric text in the published index: only where the line is. The app loads the line live from LRCLIB.
  for (const [id, hit] of Object.entries(found)) (hits[id] ||= []).push({ s, t: hit.t, start: hit.start, end: hit.end });
  process.stdout.write(".");
}

await writeFile(path.join(dataDir, "index.json"), JSON.stringify({ builtAt: new Date().toISOString(), songs: outSongs, hits }));

console.log(`\n${outSongs.length} songs indexed, ${missing.length} without synced lyrics.`);
if (missing.length) console.log("Missing:\n  " + missing.join("\n  "));
for (const l of lists) {
  const rows = l.words.map((w) => [w.en, (hits[buildMatcher(w).id] || []).length]);
  const none = rows.filter(([, n]) => !n).map(([w]) => w);
  console.log(`\n${l.title}: ${rows.length - none.length}/${rows.length} words have at least one song.`);
  console.log(rows.map(([w, n]) => `${w}:${n}`).join("  "));
  if (none.length) console.log("No song yet: " + none.join(", "));
}
