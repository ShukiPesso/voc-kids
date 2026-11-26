import { buildMatcher, wordId, parseLRC, indexLyrics, pickLyrics, hitFromLyrics, baseForm, formsFor, tokens, tokenHash } from "../lib/matcher.js?v=1795733156";
import * as sp from "./spotify.js?v=1795733156";
import * as be from "./backend.js?v=1795733156";
import { idbGet, idbSet } from "./idb.js?v=1795733156";

// ---------- game settings (easy to tweak) ----------
const LEVEL_FIRST = 100;       // points needed to finish level 1
const LEVEL_STEP = 25;         // each next level needs this many more points (100, 125, 150, ...)
const PTS_EXAM = 2;            // correct answer in the exam (any question type)
const PTS_GAME = 2;            // correct answer in the song game
const PTS_LISTEN = 1;          // playing a song snippet
const LISTEN_MIN_SECS = 3;     // a play counts once it has played this long (or reached its end)
const LISTEN_REPEATS_PER_DAY = 2; // the same snippet earns the listening point up to twice a day
const SNIPPET_TAIL_MS = 2500;  // keep playing this long after the line ends, so a word at the end of the line isn't cut off
const EXTRA_MAX_SECS = 15;     // the most extra seconds the user can add before / after a snippet

// ---------- static data: the built-in list and the song corpus ----------
const [builtinData, corpus] = await Promise.all([
  fetch("data/words.json?v=1795733156").then((r) => r.json()),
  fetch("data/index.json?v=1795733156").then((r) => r.json()),
]);
const BUILTIN_ID = "builtin";
const BUILTIN = {
  id: BUILTIN_ID, builtin: true, visibility: "builtin", author_name: "מילים בשירים",
  title: builtinData.lists[0].title, description: "הרשימה הראשונה",
  content: { sections: builtinData.sections, words: builtinData.lists[0].words },
  song_index: corpus,
};

const store = {
  get: (k, d) => JSON.parse(localStorage.getItem(k) || "null") ?? d,
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
let audioPrefs = store.get("vk.audio", { before: 0, after: 0 }); // per device

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = $("#app");
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanEn = (w) => w.en.replace(/ \(.*?\)/g, "").replace(/\.\.\.|[?.]/g, "").trim();
const EMPTY_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
const today = () => new Date().toISOString().slice(0, 10);
const songKey = (song) => `${song.artist}|${song.title}`.toLowerCase();
const seededRand = (seed) => { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296; };

function toast(msg, ms = 4000) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Simple modal: returns the textarea value (or "" with no textarea), or null if cancelled.
function ask({ title, text = "", input = null, ok = "אישור", cancel = "ביטול" }) {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="modal-card">
      <h2>${title}</h2>${text ? `<p>${text}</p>` : ""}
      ${input !== null ? `<textarea class="modal-input" rows="3" placeholder="${esc(input)}"></textarea>` : ""}
      <div class="row center"><button class="big-btn small" data-ok>${ok}</button><button class="ghost" data-cancel>${cancel}</button></div>
    </div>`;
    document.body.appendChild(m);
    const done = (v) => { m.remove(); resolve(v); };
    $("[data-ok]", m).addEventListener("click", () => done(input !== null ? $("textarea", m).value.trim() : ""));
    $("[data-cancel]", m).addEventListener("click", () => done(null));
    $("textarea", m)?.focus();
  });
}

// ---------- family state (synced to the server) ----------
let user = null;
let family = null;     // { profiles: [{id,name,emoji}], shelf: [libraryId], customSongs: [...], familyName }
let pstates = {};      // profileId -> { game, progress: {folderId: {wordId: ...}}, order: {folderId: {wordId: [songKey]}}, folders: {active, closed} }
let profileId = store.get("vk.profile", null); // which kid uses this device
let isAdmin = false;
let pendingCount = 0;

const newPState = () => ({ game: { points: 0, awards: [], listen: {} }, progress: {}, order: {}, folders: { active: null, closed: {} } });
const P = () => (pstates[profileId] ||= newPState());
const game = () => P().game;
const currentProfile = () => family?.profiles.find((p) => p.id === profileId);

const timers = {};
function later(key, fn) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, 1200); }
function saveFamilySoon() { later("family", () => be.saveFamily(family).catch(syncError)); }
function saveProfileSoon(pid = profileId) { if (pid) later("p:" + pid, () => be.saveProfile(pid, pstates[pid]).catch(syncError)); }
function syncError(e) { console.warn(e); toast("לא הצלחנו לשמור. בדקו את החיבור לאינטרנט."); }
function flushSaves() {
  for (const [k, t] of Object.entries(timers)) {
    clearTimeout(t); delete timers[k];
    if (k === "family") be.saveFamily(family).catch(() => {});
    else be.saveProfile(k.slice(2), pstates[k.slice(2)]).catch(() => {});
  }
}
addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSaves(); });

// Data saved by the previous (device-only) version of the app is moved into the family account once.
function migrateLocal() {
  const oldProfiles = store.get("vk.profiles", []);
  const custom = store.get("vk.custom", { songs: [] });
  const fam = { profiles: oldProfiles, shelf: [], customSongs: custom.songs.map(({ title, artist, uri, image, duration, group }) => ({ title, artist, uri, image, duration, group })), familyName: "" };
  const ps = {};
  const take = (key) => {
    const st = newPState();
    st.game = store.get(`vk.game.${key}`, st.game);
    const prog = store.get(`vk.progress.${key}`, null);
    const ord = store.get(`vk.order.${key}`, null);
    if (prog) st.progress[BUILTIN_ID] = prog;
    if (ord) st.order[BUILTIN_ID] = ord;
    if (prog || st.game.points) st.folders.active = BUILTIN_ID;
    return st;
  };
  for (const p of oldProfiles) ps[p.id] = take(p.id);
  if (!oldProfiles.length && (localStorage.getItem("vk.game.default") || localStorage.getItem("vk.progress.default"))) {
    const p = { id: "p" + Date.now().toString(36), name: "ילדה 1", emoji: "🦄" };
    fam.profiles.push(p);
    ps[p.id] = take("default");
  }
  return { fam, ps };
}

async function loadFamilyData() {
  const { family: fam, profiles } = await be.loadFamily();
  if (fam) {
    family = { profiles: [], shelf: [], customSongs: [], familyName: "", ...fam };
    pstates = profiles;
  } else {
    const m = migrateLocal();
    family = m.fam; pstates = m.ps;
    await be.saveFamily(family);
    for (const [pid, st] of Object.entries(pstates)) await be.saveProfile(pid, st);
    // moved into this account: remove from the device so no other account picks it up
    for (const k of Object.keys(localStorage)) if (/^vk\.(profiles|custom|game\.|progress\.|order\.)/.test(k)) localStorage.removeItem(k);
  }
  for (const p of family.profiles) pstates[p.id] ||= newPState();
  if (!family.profiles.some((p) => p.id === profileId)) profileId = null;
  isAdmin = await be.isAdmin().catch(() => false);
  pendingCount = isAdmin ? await be.pendingCount().catch(() => 0) : 0;
}

// ---------- lyrics (cached on this device) ----------
// LRCLIB limits bursts of requests: retry politely.
async function lrclibFetch(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status !== 429 && r.status < 500) return r;
      if (attempt >= 5) return r;
    } catch (e) {
      if (attempt >= 5) throw e; // a 429 without CORS headers shows up as a network error
    }
    await new Promise((res) => setTimeout(res, 800 * 2 ** attempt + Math.random() * 400));
  }
}

async function lrcFor(song) {
  const key = song.lrclib ? `lr:${song.lrclib}` : `sp:${song.uri}`;
  const cached = await idbGet(key);
  if (cached !== undefined) return cached;
  let lrc = "";
  if (song.lrclib) {
    const r = await lrclibFetch(`https://lrclib.net/api/get/${song.lrclib}`);
    if (!r.ok) throw new Error("lyrics " + r.status);
    lrc = (await r.json()).syncedLyrics || "";
  } else {
    lrc = (await lyricsForTrack({ name: song.title, artist: song.artist, album: song.album, durationMs: (song.duration || 0) * 1000 })) || "";
  }
  await idbSet(key, lrc);
  return lrc;
}
const linesMem = new Map();
function songLines(song) {
  const k = song.lrclib || song.uri;
  if (!linesMem.has(k)) linesMem.set(k, lrcFor(song).then(parseLRC).catch((e) => { linesMem.delete(k); throw e; }));
  return linesMem.get(k);
}

async function lyricsForTrack(t) {
  const artist = t.artist.split(",")[0];
  const dur = Math.round(t.durationMs / 1000);
  let r = await lrclibFetch(`https://lrclib.net/api/get?${new URLSearchParams({ track_name: t.name, artist_name: artist, album_name: t.album || "", duration: String(dur) })}`);
  if (r.ok) { const j = await r.json(); if (j.syncedLyrics) return j.syncedLyrics; }
  r = await lrclibFetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: t.name, artist_name: artist })}`);
  if (!r.ok) return null;
  return pickLyrics(await r.json(), t.name, artist, dur)?.syncedLyrics || null;
}

// ---------- the open folder ----------
let FOLDER = null, WORDS = [], WORD_BY_ID = {}, MATCHERS = [], MATCHER_BY_ID = {}, customHits = {};
const folderCache = new Map([[BUILTIN_ID, BUILTIN]]);

function withIds(words) {
  const seen = {};
  return words.map((w) => {
    let id = wordId(w) || "w";
    if (seen[id]) id = `${id}-${++seen[id]}`; else seen[id] = 1;
    return { ...w, id };
  });
}
function matchersFor(words) { return words.map((w) => ({ ...buildMatcher(w), id: w.id })); }

async function loadFolder(fid) {
  if (folderCache.has(fid)) return folderCache.get(fid);
  const lib = await be.getLibrary(fid);
  if (lib) folderCache.set(fid, lib);
  return lib;
}

let customToken = 0;
function useFolder(f) {
  if (FOLDER?.id === f.id && FOLDER === f) return;
  FOLDER = f;
  WORDS = withIds(f.content.words);
  WORD_BY_ID = Object.fromEntries(WORDS.map((w) => [w.id, w]));
  MATCHERS = matchersFor(WORDS);
  MATCHER_BY_ID = Object.fromEntries(MATCHERS.map((m) => [m.id, m]));
  customHits = {};
  resolved.clear();
  computeCustomHits();
}

// Songs the family added from Spotify: find this folder's words in their lyrics (cached on device).
async function computeCustomHits() {
  const token = ++customToken;
  const songs = family?.customSongs || [];
  const hits = {};
  await Promise.all(songs.map(async (song, s) => {
    try {
      const found = indexLyrics(await songLines(song), MATCHERS);
      for (const [wid, hit] of Object.entries(found)) (hits[wid] ||= []).push({ s, ...hit });
    } catch { /* no lyrics */ }
  }));
  if (token !== customToken) return;
  const changed = JSON.stringify(Object.keys(hits)) !== JSON.stringify(Object.keys(customHits)) || Object.values(hits).flat().length !== Object.values(customHits).flat().length;
  customHits = hits;
  if (changed && /^#\/f\/[^/]+\/?$/.test(location.hash)) render(); // refresh the word grid counts
}

const folderSongs = () => FOLDER.song_index?.songs || [];
const allSongs = () => [...folderSongs(), ...(family?.customSongs || [])];
const songIndex = (song) => allSongs().indexOf(song);

const progressF = () => (P().progress[FOLDER.id] ||= {});
const orderF = () => (P().order[FOLDER.id] ||= {});
const known = (id) => !!progressF()[id]?.known;
function setKnown(id, v) { progressF()[id] = { ...(progressF()[id] || {}), known: v }; saveProfileSoon(); }
function recordAnswer(id, right) {
  const p = progressF()[id] || {};
  p.right = right ? (p.right || 0) + 1 : 0;
  if (p.right >= 2) p.known = true;
  if (!right) p.known = false;
  progressF()[id] = p; saveProfileSoon();
}
const fhref = (path = "") => `#/f/${FOLDER.id}${path}`;

function hitsFor(id) {
  const fs = folderSongs();
  const custom = family?.customSongs || [];
  const mine = (customHits[id] || []).map((h) => ({ ...h, song: custom[h.s], mine: true }));
  const rnd = seededRand(id);
  const rest = (FOLDER.song_index?.hits?.[id] || []).map((h) => ({ ...h, song: fs[h.s], r: rnd() })).filter((h) => h.song).sort((a, b) => a.r - b.r);
  const seen = new Set(mine.map((h) => h.song.title.toLowerCase()));
  const all = [...mine, ...rest.filter((h) => !seen.has(h.song.title.toLowerCase()))];
  const mineOrder = orderF()[id] || [];
  const pos = (h) => { const i = mineOrder.indexOf(songKey(h.song)); return i < 0 ? 1e6 : i; };
  return all.map((h, i) => ({ h, i })).sort((a, b) => pos(a.h) - pos(b.h) || a.i - b.i).map((x) => x.h);
}
function saveOrder(id, keys) { orderF()[id] = keys; saveProfileSoon(); }
function moveToTop(id, key) { saveOrder(id, [key, ...hitsFor(id).map((h) => songKey(h.song)).filter((k) => k !== key)]); }

const resolved = new Map();
async function resolveHit(h, wid) {
  if (h.line) return h;
  const key = `${wid}|${songKey(h.song)}`;
  if (!resolved.has(key)) {
    try { resolved.set(key, hitFromLyrics(await songLines(h.song), MATCHER_BY_ID[wid], h.t)); } catch { return null; }
  }
  const full = resolved.get(key);
  return full ? Object.assign(h, full) : null;
}

// Find where the words of a list appear in the song corpus (the song index saved with a folder).
// Songs that may contain one of the words, using the hashed word index (no lyrics needed).
function candidateSongs(words) {
  const all = corpus.songs.map((_, i) => i);
  if (!corpus.tokens) return all;
  const out = new Set();
  for (const w of words) {
    const forms = formsFor(w);
    if (!forms) return all;
    for (const f of forms) {
      const ts = tokens(f);
      if (!ts.length) continue;
      let set = null;
      for (const t of ts) {
        const posting = new Set(corpus.tokens[tokenHash(t)] || []);
        set = set ? new Set([...set].filter((x) => posting.has(x))) : posting;
        if (!set.size) break;
      }
      for (const x of set) out.add(x);
    }
  }
  return [...out].sort((a, b) => a - b);
}

async function buildSongIndex(words, onProgress) {
  const matchers = matchersFor(withIds(words));
  const songs = [], hits = {};
  const queue = candidateSongs(words).map((i) => [corpus.songs[i], i]);
  const total = queue.length;
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const [song] = queue.shift();
      try {
        const found = indexLyrics(await songLines(song), matchers);
        if (Object.keys(found).length) {
          const s = songs.length;
          songs.push(song);
          for (const [wid, h] of Object.entries(found)) (hits[wid] ||= []).push({ s, t: h.t, start: h.start, end: h.end });
        }
      } catch { /* skip songs whose lyrics can't be loaded */ }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return { songs, hits };
}

// ---------- points & levels ----------
const levelNeed = (lvl) => LEVEL_FIRST + LEVEL_STEP * (lvl - 1);
function levelInfo(total) {
  let lvl = 1, rem = total;
  while (rem >= levelNeed(lvl)) { rem -= levelNeed(lvl); lvl++; }
  return { lvl, into: rem, need: levelNeed(lvl) };
}
function addPoints(n, anchor, icon = "⭐") {
  if (n <= 0 || !profileId) return;
  const g = game();
  const before = levelInfo(g.points).lvl;
  g.points += n;
  const after = levelInfo(g.points).lvl;
  for (let l = before + 1; l <= after; l++) if (!g.awards.some((a) => a.level === l)) g.awards.push({ level: l, date: today(), given: false });
  saveProfileSoon();
  floatPoints(`+${n} ${icon}`, anchor);
  updateScoreBar();
  if (after > before) setTimeout(() => levelUpModal(after), 700);
}
function floatPoints(text, anchor) {
  const r = (anchor && document.body.contains(anchor) ? anchor : $("#score") || document.body).getBoundingClientRect();
  const f = document.createElement("div");
  f.className = "float-pts";
  f.textContent = text;
  f.style.left = `${r.left + r.width / 2}px`;
  f.style.top = `${r.top + window.scrollY}px`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1400);
}
function levelUpModal(lvl) {
  const name = currentProfile()?.name;
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `
    <div class="confetti">${Array.from({ length: 24 }, (_, i) => `<span style="left:${(i * 41) % 100}%;animation-delay:${(i % 8) * 0.15}s">${["🎉", "⭐", "🎵", "🎈", "✨"][i % 5]}</span>`).join("")}</div>
    <div class="modal-card">
      <div class="modal-emoji">🏆</div>
      <h2>כל הכבוד${name ? `, ${esc(name)}` : ""}!</h2>
      <p class="modal-level">עלית לשלב ${lvl} ⭐</p>
      <p class="modal-gift">🎁 את מוזמנת לגשת להורים ולקבל מתנה על העבודה המאומצת!</p>
      <button class="big-btn">יש! 🎉</button>
    </div>`;
  document.body.appendChild(m);
  $("button", m).addEventListener("click", () => m.remove());
}

function playError(e) {
  if (e.code === "no-device") toast("לא מצאנו נגן ספוטיפיי פעיל 📱<br>פתחו את אפליקציית ספוטיפיי (בטלפון או במחשב), נגנו משהו לשנייה, ונסו שוב.", 7000);
  else if (e.status === 403) toast("ספוטיפיי לא מאפשר את זה. אם זה קרה אחרי עדכון, נסו להתנתק ולהתחבר מחדש בהגדרות.", 7000);
  else if (e.status === 401) { toast("צריך להתחבר מחדש לספוטיפיי"); sp.logout(); render(); }
  else toast("משהו השתבש: " + esc(e.message));
}

// ---------- playback + listening points ----------
let playingBtn = null;
let listening = null; // { key, t0, btn }

function finishListening(reachedEnd = false) {
  if (!listening) return;
  const { key, t0, btn } = listening;
  listening = null;
  if (!reachedEnd && Date.now() - t0 < LISTEN_MIN_SECS * 1000) return;
  const g = game();
  const day = today();
  if (!g.listen[day]) g.listen = { [day]: {} }; // keep only today
  const count = g.listen[day][key] || 0;
  if (count >= LISTEN_REPEATS_PER_DAY) return;
  g.listen[day][key] = count + 1;
  addPoints(PTS_LISTEN, btn, "🎧");
}

async function playHit(hit, btn, wordKey = "") {
  if (!sp.isLoggedIn()) { toast(`כדי לשמוע את השיר צריך <a href="#/settings">לחבר ספוטיפיי</a>`); return; }
  if (playingBtn === btn) { finishListening(); await sp.stop(); setPlaying(null); return; }
  finishListening();
  setPlaying(btn);
  try {
    const track = await sp.findTrack(hit.song);
    if (!track) { setPlaying(null); toast("לא מצאנו את השיר הזה בספוטיפיי 🤷"); return; }
    const start = Math.max(0, hit.start - audioPrefs.before * 1000);
    const end = hit.end + SNIPPET_TAIL_MS + audioPrefs.after * 1000;
    await sp.playSnippet(track.uri, start, end, () => {
      finishListening(true);
      if (playingBtn === btn) setPlaying(null);
    });
    listening = { key: `${FOLDER?.id}|${wordKey}|${songKey(hit.song)}`, t0: Date.now(), btn };
  } catch (e) { setPlaying(null); playError(e); }
}
function setPlaying(btn) {
  playingBtn?.classList.remove("playing");
  playingBtn = btn;
  btn?.classList.add("playing");
}

async function fillCovers(root) {
  if (!sp.isLoggedIn()) return;
  for (const img of root.querySelectorAll("img[data-song]")) {
    if (img.classList.contains("loaded")) continue;
    const song = allSongs()[+img.dataset.song];
    if (!song) continue;
    try {
      const t = song.image ? song : await sp.findTrack(song);
      if (t?.image) { img.src = t.image; img.classList.add("loaded"); }
    } catch (e) { if (e.status === 401) return; }
  }
}

// ---------- import songs from Spotify (playlists, search, top tracks) ----------
// Adds songs that have timed lyrics to the family's songs. Returns { [uri]: "added" | "known" | "nolyrics" | "explicit" }.
async function importTracks(tracks, label, onProgress) {
  const result = {};
  const noLyrics = new Set(store.get("vk.nolyrics", []));
  const queue = tracks.filter((t) => {
    if (t.explicit) { result[t.uri] = "explicit"; return false; }
    if (family.customSongs.some((s) => s.uri === t.uri)) { result[t.uri] = "known"; return false; }
    return true;
  });
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const lrc = noLyrics.has(t.uri) ? null : await lyricsForTrack(t);
        if (!lrc) { result[t.uri] = "nolyrics"; noLyrics.add(t.uri); }
        else {
          await idbSet(`sp:${t.uri}`, lrc);
          family.customSongs.push({ title: t.name, artist: t.artist, uri: t.uri, image: t.image, album: t.album, duration: t.durationMs / 1000, group: label });
          result[t.uri] = "added";
        }
      } catch (e) { console.warn(e); result[t.uri] = "nolyrics"; }
      onProgress?.(++done, Object.values(result).filter((x) => x === "added").length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  store.set("vk.nolyrics", [...noLyrics]);
  saveFamilySoon();
  if (FOLDER) await computeCustomHits();
  return result;
}
const songHasWord = (uri, id) => {
  const s = family.customSongs.findIndex((x) => x.uri === uri);
  return s >= 0 && (customHits[id] || []).some((h) => h.s === s);
};

// ---------- shared view parts ----------
function scoreBar() {
  if (!profileId) return "";
  const { lvl, into, need } = levelInfo(game().points);
  return `<div id="score" class="score" title="${game().points} נקודות בסך הכל">
    <span class="lvl">שלב ${lvl}</span>
    <span class="bar"><span style="width:${(100 * into) / need}%"></span></span>
    <span class="pts">${into}/${need}</span></div>`;
}
function updateScoreBar() { const el = $("#score"); if (el) el.outerHTML = scoreBar(); }

function header(back = null, title = null) {
  const prof = currentProfile();
  const attention = !sp.isLoggedIn() || pendingCount > 0;
  return `
  <header class="top">
    ${back ? `<a class="back" href="${back}">→</a>` : `<h1>${title || "🎵 מילים בשירים"}</h1>`}
    <div class="top-actions">
      ${scoreBar()}
      ${prof ? `<button class="chip" id="switch-profile">${esc(prof.emoji)} ${esc(prof.name)}</button>` : ""}
      <a class="gear ${attention ? "attention" : ""}" href="#/settings" title="הגדרות" aria-label="הגדרות">⚙️${pendingCount ? `<span class="gear-count">${pendingCount}</span>` : ""}</a>
    </div>
  </header>`;
}

const VIS = {
  builtin: ["מובנית", "vis-builtin"], private: ["פרטית 🔒", "vis-private"], pending: ["ממתינה לאישור ⏳", "vis-pending"],
  public: ["פתוחה לכולם 🌍", "vis-public"], rejected: ["לא אושרה", "vis-rejected"],
};
const visChip = (f) => { const [t, c] = VIS[f.visibility] || ["", ""]; return `<span class="vis ${c}">${t}</span>`; };

function folderProgress(f) {
  const words = withIds(f.content.words);
  const prog = P().progress[f.id] || {};
  const k = words.filter((w) => prog[w.id]?.known).length;
  return { known: k, total: words.length, pct: words.length ? Math.round((100 * k) / words.length) : 0 };
}

// ---------- login ----------
function loginView(mode = "in") {
  app.innerHTML = `
    <section class="login panel">
      <div class="login-logo">🎵</div>
      <h1>מילים בשירים</h1>
      <p class="muted">לומדים אוצר מילים באנגלית דרך שירים שאוהבים.</p>
      ${mode !== "reset" ? `<div class="login-tabs">
        <button class="login-tab ${mode === "up" ? "on" : ""}" data-mode="up">🆕 פעם ראשונה כאן</button>
        <button class="login-tab ${mode === "in" ? "on" : ""}" data-mode="in">🔑 כבר יש לי חשבון</button>
      </div>` : ""}
      <p class="login-hint">${mode === "up" ? "יוצרים חשבון משפחתי אחד. בוחרים סיסמה חדשה (לפחות 6 תווים), ואחר כך מאשרים את המייל שנשלח." : mode === "reset" ? "נשלח קישור לאיפוס הסיסמה למייל." : "נכנסים עם האימייל והסיסמה של החשבון המשפחתי."}</p>
      <form id="login-form">
        <input id="email" type="email" dir="ltr" placeholder="אימייל של ההורה" autocomplete="email" required>
        ${mode !== "reset" ? `<input id="password" type="password" dir="ltr" placeholder="סיסמה" autocomplete="${mode === "up" ? "new-password" : "current-password"}" minlength="6" required>` : ""}
        <button class="big-btn small wide">${mode === "up" ? "יצירת חשבון משפחתי" : mode === "reset" ? "שליחת קישור לאיפוס" : "כניסה"}</button>
      </form>
      <div id="login-msg"></div>
      <p class="login-links">
        ${mode === "in" ? `<button class="link-btn" data-mode="reset">שכחתי סיסמה</button>` : mode === "reset" ? `<button class="link-btn" data-mode="in">חזרה לכניסה</button>` : ""}
      </p>
      <p class="muted small">חשבון אחד לכל המשפחה. הילדים הם פרופילים בתוך החשבון, בלי אימייל משלהם.</p>
    </section>`;
  app.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => loginView(b.dataset.mode)));
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim(), password = $("#password")?.value;
    const msg = $("#login-msg");
    const btn = $("#login-form button");
    btn.disabled = true;
    try {
      if (mode === "up") {
        const res = await be.signUp(email, password);
        if (!res.session) { msg.innerHTML = `<p class="ok">שלחנו מייל אישור ל-<span dir="ltr">${esc(email)}</span>. לחצו על הקישור במייל וחזרו לכאן.</p>`; btn.disabled = false; return; }
      } else if (mode === "reset") {
        await be.resetPassword(email);
        msg.innerHTML = `<p class="ok">אם יש חשבון עם הכתובת הזאת, שלחנו אליו קישור לאיפוס הסיסמה.</p>`;
        btn.disabled = false; return;
      } else {
        await be.signIn(email, password);
      }
      await start();
    } catch (err) {
      btn.disabled = false;
      const m = err.message || "";
      msg.innerHTML = `<p class="err">${/invalid login/i.test(m) ? `האימייל או הסיסמה לא נכונים. אם זו הפעם הראשונה שלכם כאן, צריך קודם <button class="link-btn" data-mode="up">ליצור חשבון</button>.` : /not confirmed/i.test(m) ? "צריך קודם לאשר את המייל (בדקו את תיבת הדואר)" : /already registered/i.test(m) ? "כבר יש חשבון עם האימייל הזה. נסו להיכנס." : /rate limit/i.test(m) ? "נשלחו יותר מדי מיילים. נסו שוב בעוד שעה." : /password/i.test(m) ? "הסיסמה צריכה להיות לפחות 6 תווים" : esc(m)}</p>`;
      msg.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => loginView(b.dataset.mode)));
    }
  });
}

function newPasswordView() {
  app.innerHTML = `
    <section class="login panel">
      <h1>סיסמה חדשה</h1>
      <form id="pw-form"><input id="pw" type="password" dir="ltr" minlength="6" placeholder="סיסמה חדשה" required autocomplete="new-password"><button class="big-btn small wide">שמירה</button></form>
      <div id="pw-msg"></div>
    </section>`;
  $("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await be.setPassword($("#pw").value); toast("הסיסמה עודכנה ✓"); location.hash = "#/"; await start(); }
    catch (err) { $("#pw-msg").innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
}

// ---------- who's playing ----------
const EMOJIS = ["🦄", "🐬", "🌈", "🦊", "🐼", "🌻", "🐱", "🚀"];
function addProfile(name) {
  const p = { id: "p" + Date.now().toString(36), name, emoji: EMOJIS[family.profiles.length % EMOJIS.length] };
  family.profiles.push(p);
  pstates[p.id] = newPState();
  saveFamilySoon(); saveProfileSoon(p.id);
  return p;
}
function pickProfileView() {
  app.innerHTML = `
    <section class="picker">
      <h1>מי לומדת עכשיו? 👋</h1>
      <div class="picker-grid">
        ${family.profiles.map((p) => `<button class="picker-card" data-prof="${p.id}"><span class="picker-emoji">${esc(p.emoji)}</span>${esc(p.name)}</button>`).join("")}
      </div>
      <form class="row" id="add-prof"><input id="prof-name" placeholder="${family.profiles.length ? "להוסיף עוד ילד/ה" : "שם הילד/ה"}"><button class="big-btn small">הוספה</button></form>
    </section>`;
  app.querySelectorAll("[data-prof]").forEach((b) => b.addEventListener("click", () => switchProfile(b.dataset.prof)));
  $("#add-prof").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#prof-name").value.trim();
    if (name) switchProfile(addProfile(name).id);
  });
}
function switchProfile(id) {
  profileId = id; store.set("vk.profile", id);
  render();
}

// ---------- shelf: all the folders ----------
async function shelfView() {
  app.innerHTML = `${header()}<p class="loading">טוען את התיקיות…</p>`;
  let mine = [], added = [];
  try {
    [mine, added] = await Promise.all([be.myLibraries(), be.getLibraries(family.shelf)]);
  } catch (e) { toast("לא הצלחנו לטעון תיקיות: " + esc(e.message)); }
  added = added.filter((l) => l.visibility === "public" && !mine.some((m) => m.id === l.id));
  if (location.hash !== "" && location.hash !== "#/") return;
  const folders = [BUILTIN, ...mine, ...added];
  const { active, closed } = P().folders;
  const activeF = folders.find((f) => f.id === active);
  const openF = folders.filter((f) => f.id !== active && !closed[f.id]);
  const closedF = folders.filter((f) => closed[f.id]);
  const card = (f) => {
    const pr = folderProgress(f);
    return `<a class="folder-card ${closed[f.id] ? "closed" : ""}" href="#/f/${f.id}">
      <div class="folder-tab"></div>
      <div class="folder-title">${esc(f.title)}</div>
      <div class="folder-meta">${pr.total} מילים · ${f.builtin || f.owner === user.id ? visChip(f) : `<span class="vis">מאת ${esc(f.author_name || "משפחה אחרת")}</span>`}</div>
      <div class="progress small-bar"><div style="width:${pr.pct}%"></div></div>
      <div class="folder-meta">${closed[f.id] ? `נסגרה ב-${esc(closed[f.id])} · ` : ""}${pr.pct}% יודעים</div>
    </a>`;
  };
  app.innerHTML = `
    ${header()}
    ${activeF ? `
      <section class="hero">
        <div>
          <div class="muted-light">התיקייה הפתוחה עכשיו</div>
          <div class="list-title">📂 ${esc(activeF.title)}</div>
          <div class="progress"><div style="width:${folderProgress(activeF).pct}%"></div></div>
          <div class="muted-light">${folderProgress(activeF).known} מתוך ${folderProgress(activeF).total} מילים כבר יודעים</div>
        </div>
        <div class="hero-btns"><a class="big-btn" href="#/f/${activeF.id}">להמשיך ←</a></div>
      </section>` : `
      <section class="hero"><div><div class="list-title">בחרו תיקייה לעבוד עליה 📂</div><div class="muted-light">כל תיקייה היא רשימת מילים. פותחים אחת, לומדים, וכשמסיימים סוגרים אותה.</div></div></section>`}
    <div class="row wrap shelf-actions">
      <a class="big-btn small" href="#/new">➕ תיקייה חדשה</a>
      <a class="ghost" href="#/catalog">🌍 תיקיות של כולם</a>
    </div>
    ${openF.length ? `<h2 class="section">התיקיות שלנו</h2><div class="folder-grid">${openF.map(card).join("")}</div>` : ""}
    ${closedF.length ? `<h2 class="section">תיקיות סגורות ✅</h2><div class="folder-grid">${closedF.map(card).join("")}</div>` : ""}`;
}

// ---------- folder home ----------
async function openFolder(fid) {
  const f = await loadFolder(fid);
  if (!f) { toast("התיקייה לא נמצאה"); location.hash = "#/"; return null; }
  useFolder(f);
  const st = P().folders;
  if (st.active !== fid || st.closed[fid]) { st.active = fid; delete st.closed[fid]; saveProfileSoon(); }
  return f;
}

function folderHomeView() {
  const f = FOLDER;
  const pr = folderProgress(f);
  const isOwner = !f.builtin && f.owner === user.id;
  const sections = Object.entries(f.content.sections || {});
  const inSections = new Set(sections.map(([k]) => k));
  const loose = WORDS.filter((w) => !inSections.has(w.section));
  const tiles = (ws) => ws.map((w) => {
    const n = hitsFor(w.id).length;
    return `<a class="tile ${known(w.id) ? "known" : ""} ${n ? "" : "nosong"}" href="${fhref(`/word/${w.id}`)}">
      <span class="en" dir="ltr">${esc(w.en)}</span>
      <span class="he">${esc(w.he)}</span>
      <span class="badge">${known(w.id) ? "✓" : n ? `🎵 ${n}` : "—"}</span>
    </a>`;
  }).join("");
  app.innerHTML = `
    ${header("#/")}
    <section class="hero">
      <div>
        <div class="list-title">📂 ${esc(f.title)}</div>
        <div class="progress"><div style="width:${pr.pct}%"></div></div>
        <div class="muted-light">${pr.known} מתוך ${pr.total} מילים כבר יודעים</div>
      </div>
      <div class="hero-btns">
        <a class="big-btn" href="${fhref("/quiz")}">🎧 משחק שירים</a>
        <a class="big-btn" href="${fhref("/exam")}">📝 בחינה</a>
      </div>
    </section>
    <div class="row wrap folder-actions">
      <button class="ghost" id="close-folder">✅ סגירת התיקייה</button>
      ${isOwner ? `
        ${visChip(f)}
        ${f.visibility === "rejected" && f.review_note ? `<span class="muted">סיבה: ${esc(f.review_note)}</span>` : ""}
        <a class="ghost" href="#/edit/${f.id}">✏️ עריכה</a>
        ${f.visibility === "private" || f.visibility === "rejected" ? `<button class="ghost" id="publish">🌍 הצעה לכולם</button>` : ""}
        ${f.visibility === "pending" ? `<button class="ghost" id="unpublish">ביטול הבקשה</button>` : ""}
        ${f.visibility === "public" ? `<button class="ghost" id="unpublish">הפיכה לפרטית</button>` : ""}
        ${f.visibility !== "public" ? `<button class="ghost danger" id="delete">🗑️ מחיקה</button>` : ""}` : ""}
      ${!isOwner && !f.builtin && family.shelf.includes(f.id) ? `<button class="ghost" id="unshelve">הסרה מהמדף</button>` : ""}
    </div>
    ${sections.map(([key, title]) => {
      const ws = WORDS.filter((w) => w.section === key);
      return ws.length ? `<h2 class="section">${esc(title)}</h2><div class="grid">${tiles(ws)}</div>` : "";
    }).join("")}
    ${loose.length ? `<h2 class="section">${sections.length ? "מילים נוספות" : "המילים"}</h2><div class="grid">${tiles(loose)}</div>` : ""}
    <p class="muted foot">מילה בלי שיר? אפשר לחפש לה שיר בעמוד של המילה.</p>`;

  $("#close-folder").addEventListener("click", () => {
    const st = P().folders;
    st.closed[f.id] = today();
    if (st.active === f.id) st.active = null;
    saveProfileSoon();
    toast(`סגרת את "${esc(f.title)}" 🎉 אפשר לפתוח אותה שוב מתי שרוצים.`);
    location.hash = "#/";
  });
  $("#publish")?.addEventListener("click", async () => {
    const note = await ask({ title: "🌍 הצעה לכולם", text: "התיקייה תישלח לאישור. אחרי שתאושר, כל המשתמשים יוכלו להוסיף אותה למדף שלהם.", input: "הערה למנהל (לא חובה)", ok: "שליחה לאישור" });
    if (note === null) return;
    await updateFolder({ visibility: "pending", request_note: note, author_name: family.familyName || "" });
    toast("נשלח לאישור ⏳");
  });
  $("#unpublish")?.addEventListener("click", async () => { await updateFolder({ visibility: "private" }); });
  $("#delete")?.addEventListener("click", async () => {
    if (await ask({ title: "למחוק את התיקייה?", text: "התיקייה והמילים שבה יימחקו לתמיד. ההתקדמות והנקודות של הילדים נשארות.", ok: "מחיקה" }) === null) return;
    await be.deleteLibrary(f.id);
    folderCache.delete(f.id);
    for (const st of Object.values(pstates)) if (st.folders.active === f.id) { st.folders.active = null; }
    saveProfileSoon();
    location.hash = "#/";
  });
  $("#unshelve")?.addEventListener("click", () => {
    family.shelf = family.shelf.filter((x) => x !== f.id);
    P().folders.active = null;
    saveFamilySoon(); saveProfileSoon();
    location.hash = "#/";
  });
}
async function updateFolder(patch) {
  try {
    await be.updateLibrary(FOLDER.id, patch);
    Object.assign(FOLDER, patch);
    render();
  } catch (e) { toast("לא הצלחנו לעדכן: " + esc(e.message)); }
}

// ---------- word page ----------
function lyricHtml(h) {
  if (!h.line) return `<div class="main-line loading-line">♪ ♪ ♪</div>`;
  return `${h.prev ? `<div class="ctx">${esc(h.prev)}</div>` : ""}
        <div class="main-line">${highlight(h.line, h.ranges)}</div>
        ${h.next ? `<div class="ctx">${esc(h.next)}</div>` : ""}`;
}
function highlight(line, ranges, blank = false) {
  let out = "", pos = 0;
  for (const [a, b] of ranges) {
    out += esc(line.slice(pos, a));
    out += blank ? `<span class="blank">${"_".repeat(Math.max(4, b - a))}</span>` : `<mark>${esc(line.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(line.slice(pos));
}
async function hydrate(root, hits, wid) {
  const byKey = Object.fromEntries(hits.map((h) => [songKey(h.song), h]));
  await Promise.all([...root.querySelectorAll(".song-card[data-key]")].map(async (c) => {
    const h = byKey[c.dataset.key];
    if (!h || h.line) return;
    const full = await resolveHit(h, wid);
    const el = $(".lyric", c);
    if (el) el.innerHTML = full ? lyricHtml(full) : `<div class="ctx">לא הצלחנו לטעון את מילות השיר 😕</div>`;
  }));
}
function hitCard(h, { sortable = false } = {}) {
  return `
  <div class="song-card" data-key="${esc(songKey(h.song))}">
    ${sortable ? `<span class="handle" title="גררו כדי לשנות את הסדר">⠿</span>` : ""}
    <img data-song="${songIndex(h.song)}" alt="" src="${EMPTY_IMG}">
    <div class="song-body">
      <div class="song-meta">${esc(h.song.title)} · <span class="muted">${esc(h.song.artist)}</span>${h.mine ? ` <span class="mine">מהספוטיפיי שלכם</span>` : ""}</div>
      <div class="lyric" dir="ltr">${lyricHtml(h)}</div>
    </div>
    <button class="play" aria-label="נגן">▶</button>
  </div>`;
}

// Drag cards by their ⠿ handle (mouse and touch). onDrop gets the new order of data-keys.
function makeSortable(container, onDrop) {
  container.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".handle");
    if (!handle) return;
    e.preventDefault();
    const card = handle.closest(".song-card");
    const grabOffset = e.clientY - card.getBoundingClientRect().top;
    let shift = 0;
    card.classList.add("dragging");
    // listen on window: moving the card in the DOM would drop pointer capture
    const move = (ev) => {
      const y = ev.clientY;
      const others = [...container.querySelectorAll(".song-card")].filter((c) => c !== card);
      const before = others.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (before) { if (card.nextElementSibling !== before) container.insertBefore(card, before); }
      else if (container.lastElementChild !== card) container.appendChild(card);
      const natural = card.getBoundingClientRect().top - shift;
      shift = y - grabOffset - natural;
      card.style.transform = `translateY(${shift}px)`;
      if (y < 60) window.scrollBy(0, -10); else if (y > window.innerHeight - 60) window.scrollBy(0, 10);
    };
    const up = (ev) => {
      if (ev.type === "pointerup") move(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      card.classList.remove("dragging");
      card.style.transform = "";
      onDrop([...container.querySelectorAll(".song-card")].map((c) => c.dataset.key));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

function wordView(id) {
  const w = WORD_BY_ID[id];
  if (!w) { location.hash = fhref(); return; }
  let shown = 5;
  const renderCards = () => {
    const hits = hitsFor(id);
    const byKey = Object.fromEntries(hits.map((h) => [songKey(h.song), h]));
    $("#cards").innerHTML = hits.slice(0, shown).map((h) => hitCard(h, { sortable: hits.length > 1 })).join("") ||
      `<div class="empty">עוד לא מצאנו שיר עם המילה הזאת 🙈<br>מכירים שיר שיש בו את המילה? חפשו אותו כאן למטה 👇</div>`;
    $("#drag-hint").hidden = hits.length < 2;
    $("#more").hidden = shown >= hits.length;
    $("#more").textContent = `עוד שירים (${Math.max(0, hits.length - shown)})`;
    $("#cards").querySelectorAll(".song-card").forEach((c) => {
      $(".play", c).addEventListener("click", (e) => playHit(byKey[c.dataset.key], e.currentTarget, id));
    });
    fillCovers($("#cards"));
    hydrate($("#cards"), hits, id);
  };
  app.innerHTML = `
    ${header(fhref())}
    <section class="word-head">
      <div class="word-en" dir="ltr">${esc(w.en)}</div>
      <div class="word-he">${esc(w.he)}</div>
      <label class="known-toggle"><input type="checkbox" id="known" ${known(id) ? "checked" : ""}> אני יודע/ת את המילה הזאת</label>
    </section>
    <p id="drag-hint" class="muted hint">גררו את ⠿ כדי להעלות למעלה את השירים שאתן הכי מכירות</p>
    <div id="cards"></div>
    <button id="more" class="ghost"></button>

    <section class="panel find">
      <h3>🔍 מכירים עוד שיר עם <span dir="ltr">"${esc(cleanEn(w))}"</span>?</h3>
      ${sp.isLoggedIn() ? `
        <form class="row" id="find-form"><input id="find-q" placeholder="שם של שיר או של זמר/ת"><button class="big-btn small">חיפוש</button></form>
        <div class="row wrap">
          <button id="scan-artist" class="ghost">🎤 לחפש בכל השירים של הזמר/ת</button>
          <button id="scan-top" class="ghost">⭐ לחפש בשירים שאני הכי שומעת</button>
        </div>
        <div id="find-status"></div>
        <div id="find-results"></div>` : `<p class="muted">כדי לחפש שירים צריך <a href="#/settings">לחבר ספוטיפיי</a>.</p>`}
    </section>
    <nav class="word-nav">${neighbourLinks(id)}</nav>`;
  $("#known").addEventListener("change", (e) => setKnown(id, e.target.checked));
  $("#more").addEventListener("click", () => { shown += 5; renderCards(); });
  makeSortable($("#cards"), (keys) => {
    const rest = hitsFor(id).map((h) => songKey(h.song)).filter((k) => !keys.includes(k));
    saveOrder(id, [...keys, ...rest]);
  });
  renderCards();
  if (sp.isLoggedIn()) setupFind(id, renderCards);
}

function setupFind(id, renderCards) {
  const status = $("#find-status"), results = $("#find-results");
  const setStatus = (html) => { status.innerHTML = html; };
  const countFor = () => (customHits[id] || []).length;

  $("#find-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#find-q").value.trim();
    if (!q) return;
    setStatus("מחפשים…");
    try {
      const tracks = await sp.searchTracks(q, 10);
      setStatus(tracks.length ? "בחרו את השיר, ונבדוק אם המילה מופיעה בו:" : "לא מצאנו שירים כאלה");
      results.innerHTML = tracks.map((t, i) => `
        <div class="result">
          <img src="${esc(t.image || EMPTY_IMG)}" alt="">
          <div class="song-body"><b>${esc(t.name)}</b> · <span class="muted">${esc(t.artist)}</span></div>
          <button class="ghost" data-i="${i}">בדיקה</button>
        </div>`).join("");
      results.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", async () => {
        const t = tracks[+b.dataset.i];
        b.disabled = true; b.textContent = "בודקים…";
        const res = (await importTracks([t], "חיפוש"))[t.uri];
        if (songHasWord(t.uri, id)) {
          moveToTop(id, songKey({ title: t.name, artist: t.artist }));
          b.textContent = "נמצא! 🎉";
          setStatus(`<b>מצאנו!</b> השיר נוסף ראשון ברשימה 🎉`);
          renderCards();
          window.scrollTo({ top: 0, behavior: "smooth" });
        } else {
          b.textContent = res === "explicit" ? "לא מתאים 🙅" : res === "nolyrics" ? "אין מילים 😕" : "לא מופיעה 😕";
          setStatus(res === "explicit" ? "השיר הזה מסומן בספוטיפיי כלא מתאים לילדים." :
            res === "nolyrics" ? "לא מצאנו לשיר הזה מילים עם זמנים, אז אי אפשר לדעת איפה המילה." :
            `המילה <span dir="ltr">"${esc(cleanEn(WORD_BY_ID[id]))}"</span> לא מופיעה בשיר הזה. נסו שיר אחר!`);
        }
      }));
    } catch (err) { setStatus(""); playError(err); }
  });

  const scan = async (getTracks, label) => {
    const before = countFor();
    try {
      setStatus("אוספים שירים…");
      results.innerHTML = "";
      const tracks = await getTracks();
      if (!tracks) return;
      await importTracks(tracks, label, (done) => setStatus(`בדקנו ${done} מתוך ${tracks.length} שירים…`));
      const found = countFor() - before;
      setStatus(found ? `<b>מצאנו ${found} שירים חדשים עם המילה! 🎉</b>` : `בדקנו ${tracks.length} שירים, אבל המילה לא הופיעה באף אחד מהם 😕`);
      renderCards();
    } catch (err) { setStatus(""); playError(err); }
  };
  $("#scan-artist").addEventListener("click", () => scan(async () => {
    const a = $("#find-q").value.trim();
    if (!a) { setStatus("כתבו קודם שם של זמר/ת בתיבת החיפוש 👆"); return null; }
    return sp.searchTracks(`artist:${a}`, 30);
  }, "חיפוש"));
  $("#scan-top").addEventListener("click", () => scan(() => sp.topTracks(), "השירים שלי"));
}

function neighbourLinks(id) {
  const i = WORDS.findIndex((w) => w.id === id);
  const prev = WORDS[i - 1], next = WORDS[i + 1];
  return `${prev ? `<a href="${fhref(`/word/${prev.id}`)}">→ ${esc(prev.en)}</a>` : "<span></span>"}${next ? `<a href="${fhref(`/word/${next.id}`)}">${esc(next.en)} ←</a>` : ""}`;
}

// ---------- song game ----------
const quiz = { score: 0, total: 0, streak: 0 };
function pickQuizWord() {
  const pool = WORDS.filter((w) => hitsFor(w.id).length);
  if (!pool.length) return null;
  const weights = pool.map((w) => (known(w.id) ? 1 : 4));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((r -= weights[i]) < 0) return pool[i];
  return pool[0];
}

let quizToken = 0;
async function quizView() {
  const token = ++quizToken;
  const here = location.hash;
  app.innerHTML = `${header(fhref())}<p class="loading">♪ ♪ ♪</p>`;
  let w, hit;
  for (let tries = 0; tries < 6 && !hit; tries++) {
    w = pickQuizWord();
    if (!w) break;
    const hits = hitsFor(w.id);
    const pick = hits[Math.random() < 0.7 ? Math.floor(Math.random() * Math.min(3, hits.length)) : Math.floor(Math.random() * hits.length)];
    hit = await resolveHit(pick, w.id);
  }
  if (token !== quizToken || location.hash !== here) return;
  if (!hit) { app.innerHTML = `${header(fhref())}<div class="empty">${w ? "לא הצלחנו לטעון מילים של שירים. בדקו את החיבור לאינטרנט ונסו שוב." : "לאף מילה בתיקייה הזאת עוד אין שיר. נסו את הבחינה במקום 📝"}</div>`; return; }
  const mode = Math.random() < 0.5 ? "blank" : "meaning";
  const options = shuffle([w, ...shuffle(WORDS.filter((x) => x.id !== w.id && x.he !== w.he)).slice(0, 3)]);
  app.innerHTML = `
    ${header(fhref())}
    <section class="quiz">
      <div class="quiz-score">✔ ${quiz.score} / ${quiz.total}${quiz.streak >= 3 ? ` · 🔥 ${quiz.streak} ברצף` : ""}</div>
      <div class="quiz-q">${mode === "blank" ? "איזו מילה חסרה? הקשיבו לשיר 🎧" : "מה פירוש המילה המודגשת?"}</div>
      <div class="song-card quiz-card">
        <img data-song="${songIndex(hit.song)}" alt="" src="${EMPTY_IMG}">
        <div class="song-body">
          <div class="song-meta">${esc(hit.song.title)} · <span class="muted">${esc(hit.song.artist)}</span></div>
          <div class="lyric big" dir="ltr"><div class="main-line" id="qline">${highlight(hit.line, hit.ranges, mode === "blank")}</div></div>
        </div>
        <button class="play" aria-label="נגן">▶</button>
      </div>
      <div class="options">
        ${options.map((o) => `<button class="option" data-id="${o.id}" ${mode === "blank" ? 'dir="ltr"' : ""}>${esc(mode === "blank" ? cleanEn(o) : o.he)}</button>`).join("")}
      </div>
      <div id="feedback"></div>
    </section>`;
  const playBtn = $(".quiz .play");
  playBtn.addEventListener("click", () => playHit(hit, playBtn, w.id));
  fillCovers(app);
  app.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => {
    const right = b.dataset.id === w.id;
    quiz.total++;
    if (right) { quiz.score++; quiz.streak++; addPoints(PTS_GAME, b); } else quiz.streak = 0;
    recordAnswer(w.id, right);
    app.querySelectorAll(".option").forEach((o) => { o.disabled = true; if (o.dataset.id === w.id) o.classList.add("right"); });
    if (!right) b.classList.add("wrong");
    $("#qline").innerHTML = highlight(hit.line, hit.ranges);
    $("#feedback").innerHTML = `
      <div class="fb ${right ? "good" : "bad"}">${right ? shuffle(["מעולה! 🎉", "יפה מאוד! ⭐", "בול! 🎯", "אלופה! 🏆"])[0] : "כמעט! 💪"}
        <div><b dir="ltr">${esc(w.en)}</b> = ${esc(w.he)}</div></div>
      <button class="big-btn" id="next">הבא ←</button>`;
    $("#next").addEventListener("click", () => { finishListening(); sp.stop(); setPlaying(null); quizView(); });
    if (sp.isLoggedIn() && !playingBtn) playHit(hit, playBtn, w.id);
  }));
}

// ---------- exam ----------
function examView() {
  const n = WORDS.length;
  app.innerHTML = `
    ${header(fhref())}
    <section class="exam-start panel">
      <h2>📝 בחינה על המילים</h2>
      <p>כל תשובה נכונה שווה <b>${PTS_EXAM} נקודות</b>!</p>
      <p class="muted">יש שלושה סוגי שאלות: לתרגם לעברית, לבחור את המילה באנגלית, ולכתוב את המילה באנגלית (איות).</p>
      <label class="known-toggle"><input type="checkbox" id="with-spell" checked> כולל שאלות איות</label>
      <div class="exam-sizes">
        ${[...new Set([10, 20, n].filter((x) => x <= n))].map((x) => `<button class="big-btn small" data-n="${x}">${x === n ? `כל המילים (${x})` : `${x} שאלות`}</button>`).join("")}
      </div>
    </section>`;
  app.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", () => runExam(+b.dataset.n, $("#with-spell").checked)));
}

function runExam(count, withSpell) {
  const qs = shuffle([...WORDS]).sort((a, b) => known(a.id) - known(b.id)).slice(0, count);
  shuffle(qs);
  const questions = qs.map((w) => {
    const types = WORDS.length >= 4 ? ["en2he", "he2en"] : [];
    if ((withSpell || !types.length) && /^[a-z]+$/i.test(w.en)) types.push("spell");
    if (!types.length) types.push("en2he");
    return { w, type: types[Math.floor(Math.random() * types.length)] };
  });
  const state = { i: 0, correct: 0, earned: 0, mistakes: [] };

  const show = () => {
    const { w, type } = questions[state.i];
    const others = shuffle(WORDS.filter((x) => x.id !== w.id && x.he !== w.he && cleanEn(x) !== cleanEn(w))).slice(0, 3);
    const options = shuffle([w, ...others]);
    app.innerHTML = `
      ${header(fhref())}
      <section class="quiz exam">
        <div class="exam-progress"><div style="width:${(100 * state.i) / questions.length}%"></div></div>
        <div class="quiz-score">שאלה ${state.i + 1} מתוך ${questions.length} · ⭐ ${state.earned} נקודות בבחינה</div>
        ${type === "en2he" ? `<div class="quiz-q">מה התרגום?</div><div class="exam-word" dir="ltr">${esc(cleanEn(w))}</div>` :
          type === "he2en" ? `<div class="quiz-q">איך אומרים באנגלית?</div><div class="exam-word">${esc(w.he)}</div>` :
          `<div class="quiz-q">כתבו את המילה באנגלית ✍️</div><div class="exam-word">${esc(w.he)}</div>`}
        ${type === "spell" ? `
          <form id="spell-form" class="row spell"><input id="spell" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="..."><button class="big-btn small">בדיקה</button></form>` : `
          <div class="options">${options.map((o) => `<button class="option" data-id="${o.id}" ${type === "he2en" ? 'dir="ltr"' : ""}>${esc(type === "he2en" ? cleanEn(o) : o.he)}</button>`).join("")}</div>`}
        <div id="feedback"></div>
      </section>`;

    const answer = (right, anchor) => {
      recordAnswer(w.id, right);
      if (right) { state.correct++; state.earned += PTS_EXAM; addPoints(PTS_EXAM, anchor); } else state.mistakes.push(w);
      const hit = hitsFor(w.id)[0];
      const last = state.i === questions.length - 1;
      $("#feedback").innerHTML = `
        <div class="fb ${right ? "good" : "bad"}">${right ? shuffle(["נכון! 🎉", "מצוין! ⭐", "בול! 🎯"])[0] : "לא נורא 💪"}
          <div><b dir="ltr">${esc(cleanEn(w))}</b> = ${esc(w.he)}</div></div>
        ${hit ? hitCard(hit) : ""}
        <button class="big-btn" id="next">${last ? "לתוצאות 🏁" : "הבא ←"}</button>`;
      if (hit) { const pb = $("#feedback .play"); pb.addEventListener("click", () => playHit(hit, pb, w.id)); fillCovers($("#feedback")); hydrate($("#feedback"), [hit], w.id); }
      $("#next").addEventListener("click", () => {
        finishListening(); sp.stop(); setPlaying(null);
        state.i++;
        if (state.i < questions.length) show(); else results();
      });
      $("#next").focus();
    };

    if (type === "spell") {
      const input = $("#spell");
      input.focus();
      $("#spell-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const v = input.value.trim().toLowerCase();
        if (!v) return;
        const ok = [w.en, ...(w.extra || [])].some((x) => x.toLowerCase() === v);
        input.disabled = true;
        input.classList.add(ok ? "right" : "wrong");
        $("#spell-form button").disabled = true;
        answer(ok, input);
      });
    } else {
      app.querySelectorAll(".option").forEach((b) => b.addEventListener("click", () => {
        const right = b.dataset.id === w.id;
        app.querySelectorAll(".option").forEach((o) => { o.disabled = true; if (o.dataset.id === w.id) o.classList.add("right"); });
        if (!right) b.classList.add("wrong");
        answer(right, b);
      }));
    }
  };

  const results = () => {
    const grade = Math.round((100 * state.correct) / questions.length);
    const msg = grade === 100 ? "מושלם!!! 🏆" : grade >= 85 ? "מצוין! 🌟" : grade >= 70 ? "יפה מאוד! 👏" : grade >= 50 ? "בדרך הנכונה 💪" : "צריך עוד קצת תרגול, את יכולה! 💪";
    app.innerHTML = `
      ${header(fhref())}
      <section class="quiz exam-results">
        <div class="grade">${grade}</div>
        <div class="fb good">${msg}</div>
        <p>${state.correct} תשובות נכונות מתוך ${questions.length} · הרווחת <b>${state.earned} נקודות</b> ⭐</p>
        ${state.mistakes.length ? `
          <h3>מילים לחזור עליהן:</h3>
          <div class="grid">${state.mistakes.map((w) => `<a class="tile" href="${fhref(`/word/${w.id}`)}"><span class="en" dir="ltr">${esc(w.en)}</span><span class="he">${esc(w.he)}</span></a>`).join("")}</div>` : ""}
        <div class="row center"><a class="big-btn small" href="${fhref("/exam")}">בחינה חדשה</a><a class="ghost" href="${fhref()}">לרשימת המילים</a></div>
      </section>`;
  };
  show();
}

// ---------- create / edit a folder ----------
const POS_GUESS = (en) => (baseForm(en).includes(" ") ? "phrase" : "nounverb");

async function fileToPayload(file) {
  if (file.type === "application/pdf") {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { media_type: "application/pdf", data: btoa(bin) };
  }
  // images: shrink big phone photos before sending
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] };
}

async function editorView(fid = null) {
  let lib = null;
  if (fid) {
    lib = await loadFolder(fid);
    if (!lib || lib.owner !== user.id) { toast("אפשר לערוך רק תיקיות שלכם"); location.hash = "#/"; return; }
  }
  const state = {
    title: lib?.title || "", description: lib?.description || "",
    sections: { ...(lib?.content.sections || {}) },
    words: (lib?.content.words || []).map((w) => ({ ...w })),
  };
  const sectionOptions = () => Object.entries(state.sections);
  const renderRows = () => {
    $("#rows").innerHTML = state.words.map((w, i) => `
      <div class="word-row" data-i="${i}">
        <input class="w-en" dir="ltr" value="${esc(w.en)}" placeholder="English">
        <input class="w-he" value="${esc(w.he)}" placeholder="תרגום">
        ${sectionOptions().length ? `<select class="w-sec">${sectionOptions().map(([k, t]) => `<option value="${esc(k)}" ${w.section === k ? "selected" : ""}>${esc(t.split("·")[0].trim())}</option>`).join("")}</select>` : ""}
        <button class="del" title="מחיקה">✕</button>
      </div>`).join("") || `<p class="muted">עוד אין מילים. סרקו דף או הקלידו מילים למעלה.</p>`;
    $("#count").textContent = state.words.length;
    $("#rows").querySelectorAll(".word-row").forEach((row) => {
      const w = state.words[+row.dataset.i];
      $(".w-en", row).addEventListener("input", (e) => { w.en = e.target.value; delete w.forms; w.pos = POS_GUESS(w.en); });
      $(".w-he", row).addEventListener("input", (e) => { w.he = e.target.value; });
      $(".w-sec", row)?.addEventListener("change", (e) => { w.section = e.target.value; });
      $(".del", row).addEventListener("click", () => { state.words.splice(+row.dataset.i, 1); renderRows(); });
    });
  };

  app.innerHTML = `
    ${header(fid ? `#/f/${fid}` : "#/")}
    <h1 class="page-title">${fid ? "✏️ עריכת תיקייה" : "➕ תיקייה חדשה"}</h1>
    ${lib?.visibility === "public" ? `<p class="notice">התיקייה פתוחה לכולם. אחרי שמירה היא תחזור לאישור המנהל.</p>` : ""}
    <section class="panel">
      <label class="field">שם התיקייה<input id="title" value="${esc(state.title)}" placeholder="למשל: יחידה 3 – אוצר מילים"></label>
      <label class="field">תיאור (לא חובה)<input id="desc" value="${esc(state.description)}" placeholder="כיתה, ספר, עמוד…"></label>
    </section>
    <section class="panel">
      <h2>📷 סריקת דף</h2>
      <p class="muted">מצלמים את דף אוצר המילים (או מעלים PDF), והמילים והתרגומים יתמלאו לבד. אחר כך אפשר לתקן.</p>
      <div class="row wrap">
        <label class="big-btn small file-btn">בחירת תמונות / PDF<input id="files" type="file" accept="image/*,application/pdf" multiple hidden></label>
        <span id="file-names" class="muted"></span>
      </div>
      <button id="scan" class="big-btn small" disabled>סריקה ✨</button>
      <div id="scan-status"></div>
    </section>
    <section class="panel">
      <h2>⌨️ הקלדה</h2>
      <p class="muted">מילה אחת בכל שורה. אפשר להוסיף תרגום אחרי מקף, למשל: <span dir="ltr">journey - מסע</span></p>
      <textarea id="paste" rows="5" dir="auto" placeholder="journey - מסע&#10;bridge - גשר"></textarea>
      <button id="add-typed" class="ghost">הוספה לרשימה</button>
    </section>
    <section class="panel">
      <h2>המילים (<span id="count">0</span>)</h2>
      <div id="rows"></div>
      <button id="add-row" class="ghost">+ שורה</button>
    </section>
    <div class="row center"><button id="save" class="big-btn">💾 שמירה</button></div>
    <div id="save-status" class="center-text"></div>`;
  renderRows();

  let files = [];
  $("#files").addEventListener("change", (e) => {
    files = [...e.target.files];
    $("#file-names").textContent = files.map((f) => f.name).join(", ");
    $("#scan").disabled = !files.length;
  });
  $("#scan").addEventListener("click", async () => {
    const status = $("#scan-status");
    $("#scan").disabled = true;
    status.innerHTML = `<p class="working">סורקים את הדף… זה לוקח בערך חצי דקה ⏳</p>`;
    try {
      const payload = await Promise.all(files.map(fileToPayload));
      const res = await be.scanPages(payload);
      if (!state.title && res.title) $("#title").value = state.title = res.title;
      for (const s of res.sections || []) state.sections[s.key] ||= s.title;
      state.words.push(...(res.words || []).map((w) => ({ en: w.en, he: w.he, pos: w.pos, section: w.section, forms: w.forms })));
      renderRows();
      status.innerHTML = `<p class="ok">נמצאו ${res.words?.length || 0} מילים ✓ עברו על הרשימה ותקנו אם צריך.</p>${res.notes ? `<p class="muted">הערה: ${esc(res.notes)}</p>` : ""}`;
    } catch (e) {
      status.innerHTML = `<p class="err">הסריקה לא הצליחה: ${esc(e.message)}</p>`;
    } finally { $("#scan").disabled = !files.length; }
  });
  $("#add-typed").addEventListener("click", () => {
    const lines = $("#paste").value.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      const [en, ...he] = l.split(/\s+[-–—=:]\s+|\t/);
      if (!en.trim()) continue;
      state.words.push({ en: en.trim(), he: he.join(" ").trim(), pos: POS_GUESS(en), section: Object.keys(state.sections)[0] || "" });
    }
    $("#paste").value = "";
    renderRows();
  });
  $("#add-row").addEventListener("click", () => { state.words.push({ en: "", he: "", pos: "nounverb", section: Object.keys(state.sections)[0] || "" }); renderRows(); });
  $("#title").addEventListener("input", (e) => { state.title = e.target.value; });
  $("#desc").addEventListener("input", (e) => { state.description = e.target.value; });

  $("#save").addEventListener("click", async () => {
    const words = state.words.filter((w) => w.en.trim()).map((w) => ({ ...w, en: w.en.trim(), he: (w.he || "").trim(), pos: w.pos || POS_GUESS(w.en) }));
    const title = state.title.trim();
    if (!title) { toast("צריך לתת שם לתיקייה"); return; }
    if (!words.length) { toast("צריך לפחות מילה אחת"); return; }
    $("#save").disabled = true;
    const st = $("#save-status");
    try {
      st.innerHTML = `<p class="working">מחפשים את המילים בשירים… <span id="pct">0%</span></p>`;
      const song_index = await buildSongIndex(words, (d, n) => { const p = $("#pct"); if (p) p.textContent = `${Math.round((100 * d) / n)}%`; });
      const content = { sections: state.sections, words };
      const row = { title, description: state.description.trim(), content, song_index, author_name: family.familyName || "" };
      let id = fid;
      if (fid) {
        await be.updateLibrary(fid, { ...row, ...(lib.visibility === "public" ? { visibility: "pending", request_note: "עודכנה" } : {}) });
        folderCache.delete(fid);
      } else {
        id = await be.createLibrary(row);
      }
      const withSongs = Object.keys(song_index.hits).length;
      toast(`נשמר ✓ ל-${withSongs} מתוך ${words.length} מילים מצאנו שירים`, 6000);
      FOLDER = null;
      location.hash = `#/f/${id}`;
    } catch (e) {
      st.innerHTML = `<p class="err">השמירה לא הצליחה: ${esc(e.message)}</p>`;
      $("#save").disabled = false;
    }
  });
}

// ---------- catalog of public folders ----------
async function catalogView() {
  app.innerHTML = `${header("#/")}<p class="loading">טוען…</p>`;
  let libs = [];
  try { libs = await be.publicLibraries(); } catch (e) { toast(esc(e.message)); }
  const render1 = () => {
    app.innerHTML = `
      ${header("#/")}
      <h1 class="page-title">🌍 תיקיות של כולם</h1>
      <p class="muted">תיקיות שמשפחות אחרות שיתפו ואושרו. מוסיפים למדף ולומדים.</p>
      <div class="catalog">
        ${libs.length ? libs.map((l) => {
          const mine = l.owner === user.id, onShelf = mine || family.shelf.includes(l.id);
          const words = l.content?.words || [];
          return `<div class="panel cat-item">
            <div class="cat-head"><b>📂 ${esc(l.title)}</b><span class="muted">מאת ${esc(l.author_name || "משפחה")} · ${words.length} מילים</span></div>
            ${l.description ? `<p class="muted">${esc(l.description)}</p>` : ""}
            <p class="cat-words" dir="ltr">${words.slice(0, 12).map((w) => esc(w.en)).join(" · ")}${words.length > 12 ? " …" : ""}</p>
            ${onShelf ? `<a class="ghost" href="#/f/${l.id}">${mine ? "שלכם · פתיחה" : "במדף שלכם ✓ · פתיחה"}</a>` : `<button class="big-btn small" data-add="${l.id}">➕ הוספה למדף</button>`}
          </div>`;
        }).join("") : `<div class="empty">עוד אין תיקיות משותפות. אפשר להציע תיקייה שלכם לכולם מתוך התיקייה עצמה.</div>`}
      </div>`;
    app.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
      family.shelf.push(b.dataset.add);
      saveFamilySoon();
      toast("נוסף למדף ✓");
      render1();
    }));
  };
  render1();
}

// ---------- admin: approve folders for everyone ----------
async function adminView() {
  if (!isAdmin) { location.hash = "#/"; return; }
  app.innerHTML = `${header("#/settings")}<p class="loading">טוען…</p>`;
  let pending = [], pub = [];
  try { [pending, pub] = await Promise.all([be.pendingLibraries(), be.publicLibraries()]); } catch (e) { toast(esc(e.message)); }
  pendingCount = pending.length;
  const item = (l, actions) => `
    <div class="panel cat-item">
      <div class="cat-head"><b>📂 ${esc(l.title)}</b><span class="muted">מאת ${esc(l.author_name || "ללא שם")} · ${(l.content?.words || []).length} מילים</span></div>
      ${l.request_note ? `<p>💬 ${esc(l.request_note)}</p>` : ""}
      <details><summary>המילים</summary><div class="admin-words">${(l.content?.words || []).map((w) => `<span dir="ltr">${esc(w.en)}</span> = ${esc(w.he)}`).join("<br>")}</div></details>
      <div class="row wrap"><a class="ghost" href="#/f/${l.id}">צפייה</a>${actions}</div>
    </div>`;
  app.innerHTML = `
    ${header("#/settings")}
    <h1 class="page-title">🛡️ ניהול</h1>
    <h2 class="section">בקשות שמחכות לאישור (${pending.length})</h2>
    ${pending.map((l) => item(l, `<button class="big-btn small" data-approve="${l.id}">✅ אישור</button><button class="ghost danger" data-reject="${l.id}">❌ דחייה</button>`)).join("") || `<p class="muted">אין בקשות חדשות 🎉</p>`}
    <h2 class="section">פתוחות לכולם (${pub.length})</h2>
    ${pub.map((l) => item(l, `<button class="ghost" data-hide="${l.id}">החזרה לפרטית</button>`)).join("") || `<p class="muted">עוד אין.</p>`}`;
  const act = async (id, patch, msg) => {
    try { await be.updateLibrary(id, patch); folderCache.delete(id); toast(msg); adminView(); }
    catch (e) { toast("לא הצלחנו: " + esc(e.message)); }
  };
  app.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => act(b.dataset.approve, { visibility: "public", review_note: "" }, "אושר ✓ התיקייה פתוחה לכולם")));
  app.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", async () => {
    const note = await ask({ title: "דחיית הבקשה", input: "סיבה (תוצג למשפחה)", ok: "דחייה" });
    if (note !== null) act(b.dataset.reject, { visibility: "rejected", review_note: note }, "הבקשה נדחתה");
  }));
  app.querySelectorAll("[data-hide]").forEach((b) => b.addEventListener("click", () => act(b.dataset.hide, { visibility: "private" }, "התיקייה חזרה להיות פרטית")));
}

// ---------- settings ----------
function settingsView() {
  const g = game();
  const { lvl } = levelInfo(g.points);
  const prof = currentProfile();
  app.innerHTML = `
    ${header("#/")}
    <h1 class="page-title">⚙️ הגדרות</h1>
    <nav class="settings-nav">
      ${[["set-profiles", "👧 מי לומדת"], ["set-spotify", `🎧 ספוטיפיי${sp.isLoggedIn() ? "" : " ⚠️"}`], ["set-audio", "🔊 אורך הקטע"], ["set-songs", "📀 השירים שלנו"], ["set-points", "🏆 נקודות ומתנות"], ["set-account", "👤 החשבון"], ...(isAdmin ? [["set-admin", `🛡️ ניהול${pendingCount ? ` (${pendingCount})` : ""}`]] : [])]
        .map(([id, label]) => `<button class="chip" data-goto="${id}">${label}</button>`).join("")}
    </nav>

    <section class="panel" id="set-profiles">
      <h2>👧 מי לומדת?</h2>
      <p class="muted">לכל ילד/ה נקודות, שלבים, תיקיות והתקדמות משלו. הכל נשמר בחשבון המשפחתי ומסתנכרן בין המכשירים.</p>
      <div class="row wrap">${family.profiles.map((p) => `<button class="chip ${p.id === profileId ? "ok" : ""}" data-prof="${p.id}">${esc(p.emoji)} ${esc(p.name)}</button>`).join("")}</div>
      <form class="row" id="add-prof"><input id="prof-name" placeholder="שם"><button class="big-btn small">הוספה</button></form>
      ${prof ? `<button class="link danger-link" id="del-prof">מחיקת הפרופיל של ${esc(prof.name)}</button>` : ""}
    </section>

    <section class="panel" id="set-spotify">
      <h2>🎧 ספוטיפיי</h2>
      ${sp.isLoggedIn() ? `
        <p id="me">מחובר ✓</p>
        <div class="row"><button id="logout-sp" class="ghost">התנתקות מספוטיפיי</button></div>
      ` : `
        <p>לחצו כדי להתחבר עם חשבון הספוטיפיי של מי שמשתמש עכשיו במכשיר הזה.</p>
        <div class="row"><button id="login-sp" class="big-btn small">התחברות לספוטיפיי</button></div>
      `}
      <p class="muted">בדפדפן במחשב השיר מתנגן ישר מהדף. בטלפון השיר מתנגן באפליקציית ספוטיפיי, אז היא צריכה להיות פתוחה.</p>
    </section>

    <section class="panel" id="set-audio">
      <h2>🔊 אורך הקטע</h2>
      <p class="muted">רוצים לשמוע יותר מהשיר? מוסיפים שניות לפני הקטע ואחריו (במכשיר הזה).</p>
      ${[["before", "שניות לפני"], ["after", "שניות אחרי"]].map(([k, label]) => `
        <div class="stepper-row">
          <span>${label}</span>
          <div class="stepper" dir="ltr">
            <button class="step" data-k="${k}" data-d="-1" aria-label="פחות">−</button>
            <span class="step-val" id="val-${k}">${audioPrefs[k]}</span>
            <button class="step" data-k="${k}" data-d="1" aria-label="יותר">+</button>
          </div>
        </div>`).join("")}
    </section>

    <section class="panel" id="set-songs">
      <h2>📀 השירים שלנו</h2>
      <p>נחפש את המילים גם בשירים מהפלייליסטים שלכם. שירים מהספוטיפיי שלכם יופיעו ראשונים, בכל התיקיות.</p>
      ${sp.isLoggedIn() ? `
        <div class="row"><input id="pl-link" dir="ltr" placeholder="https://open.spotify.com/playlist/..."><button id="pl-add" class="big-btn small">הוספה</button></div>
        <div id="my-pls" class="pls muted">טוען פלייליסטים…</div>
        <div id="import-status"></div>` : `<p class="muted">קודם מתחברים לספוטיפיי.</p>`}
      <p class="muted">${family.customSongs.length} שירים מהספוטיפיי שלכם. ${family.customSongs.length ? `<button id="clear-custom" class="link">מחיקה</button>` : ""}</p>
    </section>

    <section class="panel" id="set-points">
      <h2>🏆 נקודות ומתנות${prof ? ` · ${esc(prof.name)}` : ""}</h2>
      <p>שלב <b>${lvl}</b> · <b>${g.points}</b> נקודות בסך הכל.</p>
      <p class="muted">איך מרוויחים נקודות: נקודה על כל השמעה של שיר (אותו קטע נותן נקודה עד ${LISTEN_REPEATS_PER_DAY} פעמים ביום), ${PTS_EXAM} נקודות על כל תשובה נכונה בבחינה, ו-${PTS_GAME} על תשובה נכונה במשחק השירים. שלב 1 דורש ${LEVEL_FIRST} נקודות, וכל שלב אחריו דורש ${LEVEL_STEP} נקודות יותר מהקודם.</p>
      ${g.awards.length ? `
        <h3>🎁 מתנות (להורים)</h3>
        <div class="awards">${g.awards.map((a, i) => `
          <label class="award ${a.given ? "given" : ""}"><input type="checkbox" data-award="${i}" ${a.given ? "checked" : ""}> שלב ${a.level} · ${esc(a.date)} · ${a.given ? "המתנה ניתנה ✓" : "מחכה למתנה 🎁"}</label>`).join("")}
        </div>` : `<p class="muted">עוד לא עברו שלב. בהצלחה! 🍀</p>`}
    </section>

    <section class="panel" id="set-account">
      <h2>👤 החשבון המשפחתי</h2>
      <p>מחוברים בתור <b dir="ltr">${esc(user.email)}</b></p>
      <label class="field">שם המשפחה (יוצג כשמשתפים תיקייה עם כולם)<input id="fam-name" value="${esc(family.familyName || "")}" placeholder="למשל: משפחת כהן"></label>
      <div class="row"><button id="logout" class="ghost">יציאה מהחשבון</button></div>
      <p id="admin-claim"></p>
    </section>

    ${isAdmin ? `
    <section class="panel" id="set-admin">
      <h2>🛡️ ניהול</h2>
      <p>${pendingCount ? `<b>${pendingCount}</b> תיקיות מחכות לאישור שלך.` : "אין בקשות חדשות."}</p>
      <a class="big-btn small" href="#/admin">לעמוד הניהול</a>
    </section>` : ""}`;

  app.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => document.getElementById(b.dataset.goto).scrollIntoView({ behavior: "smooth" })));
  app.querySelectorAll(".step").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    audioPrefs[k] = Math.min(EXTRA_MAX_SECS, Math.max(0, audioPrefs[k] + +b.dataset.d));
    store.set("vk.audio", audioPrefs);
    $(`#val-${k}`).textContent = audioPrefs[k];
  }));
  app.querySelectorAll("[data-award]").forEach((c) => c.addEventListener("change", () => { g.awards[+c.dataset.award].given = c.checked; saveProfileSoon(); render(); }));
  app.querySelectorAll("[data-prof]").forEach((b) => b.addEventListener("click", () => switchProfile(b.dataset.prof)));
  $("#add-prof").addEventListener("submit", (e) => { e.preventDefault(); const n = $("#prof-name").value.trim(); if (n) switchProfile(addProfile(n).id); });
  $("#del-prof")?.addEventListener("click", async () => {
    if (await ask({ title: `למחוק את ${esc(prof.name)}?`, text: "הנקודות, השלבים וההתקדמות של הפרופיל יימחקו לתמיד.", ok: "מחיקה" }) === null) return;
    family.profiles = family.profiles.filter((p) => p.id !== prof.id);
    delete pstates[prof.id];
    saveFamilySoon();
    be.deleteProfile(prof.id).catch(syncError);
    profileId = null; store.set("vk.profile", null);
    render();
  });
  $("#login-sp")?.addEventListener("click", () => sp.login());
  $("#logout-sp")?.addEventListener("click", () => { sp.logout(); render(); });
  $("#clear-custom")?.addEventListener("click", () => { family.customSongs = []; saveFamilySoon(); customHits = {}; render(); });
  $("#fam-name").addEventListener("change", (e) => { family.familyName = e.target.value.trim(); saveFamilySoon(); toast("נשמר ✓"); });
  $("#logout").addEventListener("click", async () => { flushSaves(); store.set("vk.profile", null); await be.signOut(); location.hash = "#/"; location.reload(); });
  be.adminExists().then((exists) => {
    if (!exists && $("#admin-claim")) {
      $("#admin-claim").innerHTML = `<button class="ghost" id="claim">🛡️ להיות המנהל של האפליקציה</button> <span class="muted">(רק החשבון הראשון שלוחץ יכול)</span>`;
      $("#claim").addEventListener("click", async () => {
        if (await be.claimAdmin()) { isAdmin = true; pendingCount = await be.pendingCount().catch(() => 0); toast("את/ה המנהל ✓"); render(); } else toast("כבר יש מנהל");
      });
    }
  }).catch(() => {});

  if (sp.isLoggedIn()) {
    sp.me().then((u) => { $("#me") && ($("#me").textContent = `מחובר ✓ ${u.display_name || ""}${u.product && u.product !== "premium" ? " (לא Premium: לא נוכל לנגן)" : ""}`); }).catch(playError);
    $("#pl-add").addEventListener("click", () => {
      const id = sp.playlistIdFrom($("#pl-link").value);
      if (!id) return toast("זה לא נראה כמו קישור לפלייליסט");
      importPlaylist(id, "פלייליסט");
    });
    sp.myPlaylists().then((pls) => {
      $("#my-pls").innerHTML = pls.map((p) => `<button class="pl" data-pl="${p.id}" data-name="${esc(p.name)}">${p.image ? `<img src="${esc(p.image)}" alt="">` : ""}<span>${esc(p.name)}</span></button>`).join("") || "אין פלייליסטים";
      app.querySelectorAll("[data-pl]").forEach((b) => b.addEventListener("click", () => importPlaylist(b.dataset.pl, b.dataset.name)));
    }).catch((e) => { $("#my-pls").textContent = "לא הצלחנו לטעון פלייליסטים: " + e.message; });
  }
}

let importing = false;
async function importPlaylist(id, name) {
  if (importing) return;
  importing = true;
  const status = $("#import-status");
  try {
    status.textContent = `טוען את "${name}"…`;
    const tracks = await sp.playlistTracks(id);
    const res = await importTracks(tracks, name, (done, added) => { status.textContent = `${done} שירים נבדקו, ${added} נוספו…`; });
    const added = Object.values(res).filter((x) => x === "added").length;
    status.textContent = `סיימנו! ${tracks.length} שירים נבדקו, ${added} שירים חדשים עם מילים מתוזמנות 🎉`;
  } catch (e) {
    status.textContent = "";
    if (e.status === 403 || e.status === 404) toast("ספוטיפיי לא מאפשר לקרוא את הפלייליסט הזה (פלייליסטים של ספוטיפיי עצמו חסומים לאפליקציות כאלה). נסו פלייליסט שאתם יצרתם.", 8000);
    else playError(e);
  } finally { importing = false; }
}

// ---------- router ----------
let renderToken = 0;
async function render() {
  const token = ++renderToken;
  finishListening();
  sp.stop();
  setPlaying(null);
  window.scrollTo(0, 0);
  if (!be.configured) { app.innerHTML = `<div class="empty">האפליקציה עוד לא מחוברת לשרת.</div>`; return; }
  if (!user) { loginView(localStorage.getItem("vk.everSignedIn") ? "in" : "up"); return; }
  if (!profileId) { pickProfileView(); return; }
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (parts[0] === "f" && parts[1]) {
      if (!(await openFolder(parts[1])) || token !== renderToken) return;
      if (parts[2] === "word") wordView(decodeURIComponent(parts[3] || ""));
      else if (parts[2] === "quiz") quizView();
      else if (parts[2] === "exam") examView();
      else folderHomeView();
    } else if (parts[0] === "new") await editorView();
    else if (parts[0] === "edit" && parts[1]) await editorView(parts[1]);
    else if (parts[0] === "catalog") await catalogView();
    else if (parts[0] === "admin") await adminView();
    else if (parts[0] === "settings") settingsView();
    else await shelfView();
  } catch (e) {
    console.error(e);
    app.innerHTML = `${header("#/")}<div class="empty">משהו השתבש 😕 ${esc(e.message)}</div>`;
  }
  $("#switch-profile")?.addEventListener("click", () => {
    if (family.profiles.length < 2) { location.hash = "#/settings"; return; }
    const i = family.profiles.findIndex((p) => p.id === profileId);
    switchProfile(family.profiles[(i + 1) % family.profiles.length].id);
  });
}

async function start() {
  const s = await be.session();
  user = s?.user || null;
  if (user) localStorage.setItem("vk.everSignedIn", "1");
  if (user) {
    app.innerHTML = `<p class="loading">טוען…</p>`;
    try { await loadFamilyData(); }
    catch (e) { app.innerHTML = `<div class="empty">לא הצלחנו לטעון את החשבון: ${esc(e.message)}</div>`; return; }
  }
  render();
}

addEventListener("hashchange", () => render());
try {
  const result = await sp.handleRedirect();
  if (result === "ok") location.hash = "#/settings";
  else if (result) toast("ההתחברות לספוטיפיי בוטלה");
} catch (e) { toast(esc(e.message)); }
sp.initPlayer();
be.onAuth((event) => {
  if (event === "PASSWORD_RECOVERY") newPasswordView();
  if (event === "SIGNED_OUT") { user = null; family = null; pstates = {}; render(); }
});
await start();
