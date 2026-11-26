import { buildMatcher, wordId, parseLRC, indexLyrics, pickLyrics, hitFromLyrics } from "../lib/matcher.js?v=1795730899";
import * as sp from "./spotify.js?v=1795730899";

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

// ---------- data ----------
const [wordsData, indexData] = await Promise.all([
  fetch("data/words.json?v=1795730899").then((r) => r.json()),
  fetch("data/index.json?v=1795730899").then((r) => r.json()),
]);
const list = wordsData.lists[0];
const WORDS = list.words.map((w) => ({ ...w, id: wordId(w) }));
const WORD_BY_ID = Object.fromEntries(WORDS.map((w) => [w.id, w]));
const MATCHERS = WORDS.map(buildMatcher);
const MATCHER_BY_ID = Object.fromEntries(MATCHERS.map((m) => [m.id, m]));

// The published index holds no lyric text, only where each word is.
// Lyric lines are loaded live from LRCLIB when they are shown.
const linesCache = new Map();
function songLines(song) {
  if (!linesCache.has(song.lrclib)) {
    linesCache.set(song.lrclib, fetch(`https://lrclib.net/api/get/${song.lrclib}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => parseLRC(j.syncedLyrics))
      .catch((e) => { linesCache.delete(song.lrclib); throw e; }));
  }
  return linesCache.get(song.lrclib);
}
const resolved = new Map();
// Fills in line / prev / next / ranges for a hit. Returns null if the lyrics can't be loaded.
async function resolveHit(h, wid) {
  if (h.line) return h;
  const key = `${wid}|${songKey(h.song)}`;
  if (!resolved.has(key)) {
    try {
      const full = hitFromLyrics(await songLines(h.song), MATCHER_BY_ID[wid], h.t);
      resolved.set(key, full);
    } catch { return null; }
  }
  const full = resolved.get(key);
  return full ? Object.assign(h, full) : null;
}

const store = {
  get: (k, d) => JSON.parse(localStorage.getItem(k) || "null") ?? d,
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// Extra seconds the user chose to hear before / after each snippet (per device).
let audioPrefs = store.get("vk.audio", { before: 0, after: 0 });

// Songs imported from Spotify (playlists, searches) live in localStorage.
let custom = store.get("vk.custom", { songs: [], hits: {}, seen: [] });
const allSongs = () => [...indexData.songs, ...custom.songs];
const songKey = (song) => `${song.artist}|${song.title}`.toLowerCase();

const seededRand = (seed) => { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296; };

// ---------- profiles, progress, song order, points ----------
let profiles = store.get("vk.profiles", []);
let profileId = store.get("vk.profile", profiles[0]?.id || null);
const pkey = (name) => `vk.${name}.${profileId || "default"}`;
let progress, order, game;
function loadProfileData() {
  progress = store.get(pkey("progress"), {});
  order = store.get(pkey("order"), {});
  game = store.get(pkey("game"), { points: 0, awards: [], listen: {} });
}
loadProfileData();
const saveProgress = () => store.set(pkey("progress"), progress);
const saveGame = () => store.set(pkey("game"), game);
const known = (id) => !!progress[id]?.known;
function setKnown(id, v) { progress[id] = { ...(progress[id] || {}), known: v }; saveProgress(); }
function recordAnswer(id, right) {
  const p = progress[id] || {};
  p.right = right ? (p.right || 0) + 1 : 0;
  if (p.right >= 2) p.known = true;
  if (!right) p.known = false;
  progress[id] = p; saveProgress();
}
const currentProfile = () => profiles.find((p) => p.id === profileId);

function hitsFor(id) {
  const songs = allSongs();
  const base = indexData.songs.length;
  const mine = (custom.hits[id] || []).map((h) => ({ ...h, song: songs[base + h.s], mine: true }));
  const rnd = seededRand(id);
  const rest = (indexData.hits[id] || []).map((h) => ({ ...h, song: songs[h.s], r: rnd() })).sort((a, b) => a.r - b.r);
  // songs from their own Spotify come first; avoid duplicates of the same song
  const seen = new Set(mine.map((h) => h.song.title.toLowerCase()));
  const all = [...mine, ...rest.filter((h) => !seen.has(h.song.title.toLowerCase()))];
  // then the order the child chose by dragging
  const mineOrder = order[id] || [];
  const pos = (h) => { const i = mineOrder.indexOf(songKey(h.song)); return i < 0 ? 1e6 : i; };
  return all.map((h, i) => ({ h, i })).sort((a, b) => pos(a.h) - pos(b.h) || a.i - b.i).map((x) => x.h);
}
function saveOrder(id, keys) { order[id] = keys; store.set(pkey("order"), order); }
function moveToTop(id, key) { saveOrder(id, [key, ...hitsFor(id).map((h) => songKey(h.song)).filter((k) => k !== key)]); }

// levels: level n needs LEVEL_FIRST + LEVEL_STEP*(n-1) points
const levelNeed = (lvl) => LEVEL_FIRST + LEVEL_STEP * (lvl - 1);
function levelInfo(total) {
  let lvl = 1, rem = total;
  while (rem >= levelNeed(lvl)) { rem -= levelNeed(lvl); lvl++; }
  return { lvl, into: rem, need: levelNeed(lvl) };
}

function addPoints(n, anchor, icon = "⭐") {
  if (n <= 0) return;
  const before = levelInfo(game.points).lvl;
  game.points += n;
  const after = levelInfo(game.points).lvl;
  for (let l = before + 1; l <= after; l++) if (!game.awards.some((a) => a.level === l)) game.awards.push({ level: l, date: new Date().toISOString().slice(0, 10), given: false });
  saveGame();
  floatPoints(`+${n} ${icon}`, anchor);
  updateScoreBar();
  if (after > before) setTimeout(() => levelUpModal(after), 700);
}

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = $("#app");
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanEn = (w) => w.en.replace(/ \(.*?\)/g, "").replace(/\.\.\.|[?.]/g, "").trim();
const EMPTY_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

function highlight(line, ranges, blank = false) {
  let out = "", pos = 0;
  for (const [a, b] of ranges) {
    out += esc(line.slice(pos, a));
    out += blank ? `<span class="blank">${"_".repeat(Math.max(4, b - a))}</span>` : `<mark>${esc(line.slice(a, b))}</mark>`;
    pos = b;
  }
  return out + esc(line.slice(pos));
}

function toast(msg, ms = 4000) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
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
let listening = null; // { key, t0, maxMs, btn }

function finishListening(reachedEnd = false) {
  if (!listening) return;
  const { key, t0, btn } = listening;
  listening = null;
  if (!reachedEnd && Date.now() - t0 < LISTEN_MIN_SECS * 1000) return;
  const day = new Date().toISOString().slice(0, 10);
  if (!game.listen[day]) game.listen = { [day]: {} }; // keep only today
  const count = game.listen[day][key] || 0;
  if (count >= LISTEN_REPEATS_PER_DAY) return;
  game.listen[day][key] = count + 1;
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
    listening = { key: `${wordKey}|${songKey(hit.song)}`, t0: Date.now(), btn };
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
    try {
      const t = song.image ? song : await sp.findTrack(song);
      if (t?.image) { img.src = t.image; img.classList.add("loaded"); }
    } catch (e) { if (e.status === 401) return; }
  }
}
const songIndex = (song) => allSongs().indexOf(song);

// ---------- import songs from Spotify (playlists, search, top tracks) ----------
async function lyricsForTrack(t) {
  const artist = t.artist.split(",")[0];
  const dur = Math.round(t.durationMs / 1000);
  let r = await fetch(`https://lrclib.net/api/get?${new URLSearchParams({ track_name: t.name, artist_name: artist, album_name: t.album || "", duration: String(dur) })}`);
  if (r.ok) { const j = await r.json(); if (j.syncedLyrics) return j.syncedLyrics; }
  r = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: t.name, artist_name: artist })}`);
  if (!r.ok) return null;
  return pickLyrics(await r.json(), t.name, artist, dur)?.syncedLyrics || null;
}

// Returns { [uri]: "added" | "nomatch" | "nolyrics" | "explicit" | "known" }
async function importTracks(tracks, label, onProgress, { force = false } = {}) {
  const result = {};
  const queue = tracks.filter((t) => {
    if (t.explicit) { result[t.uri] = "explicit"; return false; }
    if (custom.songs.some((s) => s.uri === t.uri)) { result[t.uri] = "known"; return false; }
    if (!force && custom.seen.includes(t.uri)) { result[t.uri] = "nomatch"; return false; }
    return true;
  });
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const lrc = await lyricsForTrack(t);
        if (!custom.seen.includes(t.uri)) custom.seen.push(t.uri);
        if (!lrc) result[t.uri] = "nolyrics";
        else {
          const found = indexLyrics(parseLRC(lrc), MATCHERS);
          if (Object.keys(found).length) {
            const s = custom.songs.length;
            custom.songs.push({ title: t.name, artist: t.artist, uri: t.uri, image: t.image, duration: t.durationMs / 1000, group: label });
            for (const [wid, hit] of Object.entries(found)) (custom.hits[wid] ||= []).push({ s, ...hit });
            result[t.uri] = "added";
          } else result[t.uri] = "nomatch";
        }
      } catch (e) { console.warn(e); result[t.uri] = "nolyrics"; }
      done++;
      onProgress?.(done, Object.values(result).filter((x) => x === "added").length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  store.set("vk.custom", custom);
  return result;
}
const songHasWord = (uri, id) => {
  const s = custom.songs.findIndex((x) => x.uri === uri);
  return s >= 0 && (custom.hits[id] || []).some((h) => h.s === s);
};

// ---------- views ----------
function scoreBar() {
  const { lvl, into, need } = levelInfo(game.points);
  return `<div id="score" class="score" title="${game.points} נקודות בסך הכל">
    <span class="lvl">שלב ${lvl}</span>
    <span class="bar"><span style="width:${(100 * into) / need}%"></span></span>
    <span class="pts">${into}/${need}</span></div>`;
}
function updateScoreBar() { const el = $("#score"); if (el) el.outerHTML = scoreBar(); }

function header(back) {
  const prof = currentProfile();
  return `
  <header class="top">
    ${back ? `<a class="back" href="#/">→</a>` : `<h1>🎵 מילים בשירים</h1>`}
    <div class="top-actions">
      ${scoreBar()}
      ${profiles.length ? `<button class="chip" id="switch-profile">${esc(prof?.emoji || "🙂")} ${esc(prof?.name || "")}</button>` : ""}
      <a class="gear ${sp.isLoggedIn() ? "" : "attention"}" href="#/settings" title="הגדרות" aria-label="הגדרות">⚙️</a>
    </div>
  </header>`;
}

function homeView() {
  const knownCount = WORDS.filter((w) => known(w.id)).length;
  app.innerHTML = `
    ${header()}
    <section class="hero">
      <div>
        <div class="list-title">${esc(list.title)}</div>
        <div class="progress"><div style="width:${(100 * knownCount) / WORDS.length}%"></div></div>
        <div class="muted">${knownCount} מתוך ${WORDS.length} מילים כבר יודעים</div>
      </div>
      <div class="hero-btns">
        <a class="big-btn" href="#/quiz">🎧 משחק שירים</a>
        <a class="big-btn" href="#/exam">📝 בחינה</a>
      </div>
    </section>
    ${Object.entries(wordsData.sections).map(([key, title]) => `
      <h2 class="section">${esc(title)}</h2>
      <div class="grid">
        ${WORDS.filter((w) => w.section === key).map((w) => {
          const n = hitsFor(w.id).length;
          return `<a class="tile ${known(w.id) ? "known" : ""} ${n ? "" : "nosong"}" href="#/word/${w.id}">
            <span class="en" dir="ltr">${esc(w.en)}</span>
            <span class="he">${esc(w.he)}</span>
            <span class="badge">${known(w.id) ? "✓" : n ? `🎵 ${n}` : "—"}</span>
          </a>`;
        }).join("")}
      </div>`).join("")}
    <p class="muted foot">המילים מהשירים מגיעות מ-LRCLIB. מילה בלי שיר? אפשר לחפש לה שיר בעמוד של המילה.</p>`;
}

function lyricHtml(h) {
  if (!h.line) return `<div class="main-line loading-line">♪ ♪ ♪</div>`;
  return `${h.prev ? `<div class="ctx">${esc(h.prev)}</div>` : ""}
        <div class="main-line">${highlight(h.line, h.ranges)}</div>
        ${h.next ? `<div class="ctx">${esc(h.next)}</div>` : ""}`;
}

// Loads the lyric lines of the cards inside root (hits: list of hits, keyed by song).
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
      <div class="song-meta">${esc(h.song.title)} · <span class="muted">${esc(h.song.artist)}</span>${h.mine ? ` <span class="mine">מהספוטיפיי שלך</span>` : ""}</div>
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
      // auto-scroll near the screen edges
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
  if (!w) { location.hash = "#/"; return; }
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
    ${header(true)}
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
  const countFor = () => (custom.hits[id] || []).length;

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
        const res = (await importTracks([t], "חיפוש", null, { force: true }))[t.uri];
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
      await importTracks(tracks, label, (done, added) => setStatus(`בדקנו ${done} מתוך ${tracks.length} שירים…`));
      const found = countFor() - before;
      setStatus(found ? `<b>מצאנו ${found} שירים חדשים עם המילה! 🎉</b> (ובדרך גם שירים למילים אחרות ברשימה)` : `בדקנו ${tracks.length} שירים, אבל המילה לא הופיעה באף אחד מהם 😕`);
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
  return `${prev ? `<a href="#/word/${prev.id}">→ ${esc(prev.en)}</a>` : "<span></span>"}${next ? `<a href="#/word/${next.id}">${esc(next.en)} ←</a>` : ""}`;
}

// ---------- song game ----------
const quiz = { score: 0, total: 0, streak: 0 };
function pickQuizWord() {
  const pool = WORDS.filter((w) => hitsFor(w.id).length);
  const weights = pool.map((w) => (known(w.id) ? 1 : 4));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((r -= weights[i]) < 0) return pool[i];
  return pool[0];
}

let quizToken = 0;
async function quizView() {
  const token = ++quizToken;
  app.innerHTML = `${header(true)}<p class="loading">♪ ♪ ♪</p>`;
  let w, hit;
  for (let tries = 0; tries < 6 && !hit; tries++) {
    w = pickQuizWord();
    const hits = hitsFor(w.id);
    // favour the songs the child put on top
    const pick = hits[Math.random() < 0.7 ? Math.floor(Math.random() * Math.min(3, hits.length)) : Math.floor(Math.random() * hits.length)];
    hit = await resolveHit(pick, w.id);
  }
  if (token !== quizToken || location.hash !== "#/quiz") return; // user moved on meanwhile
  if (!hit) { app.innerHTML = `${header(true)}<div class="empty">לא הצלחנו לטעון מילים של שירים. בדקו את החיבור לאינטרנט ונסו שוב.</div>`; return; }
  const mode = Math.random() < 0.5 ? "blank" : "meaning";
  const options = shuffle([w, ...shuffle(WORDS.filter((x) => x.id !== w.id && x.he !== w.he)).slice(0, 3)]);
  app.innerHTML = `
    ${header(true)}
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
  app.innerHTML = `
    ${header(true)}
    <section class="exam-start panel">
      <h2>📝 בחינה על המילים</h2>
      <p>כל תשובה נכונה שווה <b>${PTS_EXAM} נקודות</b>!</p>
      <p class="muted">יש שלושה סוגי שאלות: לתרגם לעברית, לבחור את המילה באנגלית, ולכתוב את המילה באנגלית (איות).</p>
      <label class="known-toggle"><input type="checkbox" id="with-spell" checked> כולל שאלות איות</label>
      <div class="exam-sizes">
        ${[10, 20, WORDS.length].map((n) => `<button class="big-btn small" data-n="${n}">${n === WORDS.length ? `כל המילים (${n})` : `${n} שאלות`}</button>`).join("")}
      </div>
    </section>`;
  app.querySelectorAll("[data-n]").forEach((b) => b.addEventListener("click", () => runExam(+b.dataset.n, $("#with-spell").checked)));
}

function runExam(count, withSpell) {
  // words not known yet come first
  const qs = shuffle([...WORDS]).sort((a, b) => known(a.id) - known(b.id)).slice(0, count);
  shuffle(qs);
  const questions = qs.map((w) => {
    const types = ["en2he", "he2en"];
    if (withSpell && /^[a-z]+$/i.test(w.en)) types.push("spell");
    return { w, type: types[Math.floor(Math.random() * types.length)] };
  });
  const state = { i: 0, correct: 0, earned: 0, mistakes: [] };

  const show = () => {
    const { w, type } = questions[state.i];
    const others = shuffle(WORDS.filter((x) => x.id !== w.id && x.he !== w.he && cleanEn(x) !== cleanEn(w))).slice(0, 3);
    const options = shuffle([w, ...others]);
    app.innerHTML = `
      ${header(true)}
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
      if (right) {
        state.correct++;
        const pts = PTS_EXAM;
        state.earned += pts;
        addPoints(pts, anchor);
      } else state.mistakes.push(w);
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
      ${header(true)}
      <section class="quiz exam-results">
        <div class="grade">${grade}</div>
        <div class="fb good">${msg}</div>
        <p>${state.correct} תשובות נכונות מתוך ${questions.length} · הרווחת <b>${state.earned} נקודות</b> ⭐</p>
        ${state.mistakes.length ? `
          <h3>מילים לחזור עליהן:</h3>
          <div class="grid">${state.mistakes.map((w) => `<a class="tile" href="#/word/${w.id}"><span class="en" dir="ltr">${esc(w.en)}</span><span class="he">${esc(w.he)}</span></a>`).join("")}</div>` : ""}
        <div class="row center"><a class="big-btn small" href="#/exam">בחינה חדשה</a><a class="ghost" href="#/">לרשימת המילים</a></div>
      </section>`;
  };

  show();
}

// ---------- settings ----------
function settingsView() {
  const cid = sp.getClientId();
  const { lvl } = levelInfo(game.points);
  app.innerHTML = `
    ${header(true)}
    <h1 class="page-title">⚙️ הגדרות</h1>
    <nav class="settings-nav">
      ${[["set-profiles", "👧 מי לומדת"], ["set-spotify", `🎧 ספוטיפיי${sp.isLoggedIn() ? "" : " ⚠️"}`], ["set-audio", "🔊 אורך הקטע"], ["set-songs", "📀 השירים שלנו"], ["set-points", "🏆 נקודות ומתנות"], ["set-backup", "💾 גיבוי"]]
        .map(([id, label]) => `<button class="chip" data-goto="${id}">${label}</button>`).join("")}
    </nav>
    <section class="panel" id="set-profiles">
      <h2>👧 מי לומדת?</h2>
      <p class="muted">לכל אחת נקודות, שלבים, סדר שירים והתקדמות משלה.</p>
      <div class="row wrap">${profiles.map((p) => `<button class="chip ${p.id === profileId ? "ok" : ""}" data-prof="${p.id}">${esc(p.emoji)} ${esc(p.name)}</button>`).join("")}</div>
      <div class="row"><input id="prof-name" placeholder="שם"><button id="prof-add" class="big-btn small">הוספה</button></div>
    </section>

    <section class="panel" id="set-spotify">
      <h2>🎧 ספוטיפיי</h2>
      ${!cid ? `
        <p>חד-פעמי, להורה: צריך ליצור "אפליקציה" בחשבון המפתחים של ספוטיפיי (חינם, 2 דקות):</p>
        <ol class="steps">
          <li>היכנסו ל-<a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> עם חשבון הספוטיפיי שלכם ולחצו <b>Create app</b>.</li>
          <li>שם: מה שתרצו. ב-<b>Redirect URI</b> הדביקו בדיוק: <code dir="ltr">${esc(sp.redirectUri())}</code></li>
          <li>סמנו <b>Web API</b> ו-<b>Web Playback SDK</b>, ושמרו.</li>
          <li>ב-<b>User Management</b> הוסיפו את כתובות האימייל של חשבונות הספוטיפיי של הבנות.</li>
          <li>העתיקו את ה-<b>Client ID</b> והדביקו כאן:</li>
        </ol>
        <div class="row"><input id="cid" dir="ltr" placeholder="Client ID"><button id="save-cid" class="big-btn small">שמירה</button></div>
      ` : sp.isLoggedIn() ? `
        <p id="me">מחובר ✓</p>
        <div class="row"><button id="logout" class="ghost">התנתקות</button><button id="reset-cid" class="ghost">החלפת Client ID</button></div>
      ` : `
        <p>לחצו כדי להתחבר עם חשבון הספוטיפיי של מי שמשתמש עכשיו.</p>
        <div class="row"><button id="login" class="big-btn small">התחברות לספוטיפיי</button><button id="reset-cid" class="ghost">החלפת Client ID</button></div>
      `}
      <p class="muted">בדפדפן במחשב השיר מתנגן ישר מהדף. בטלפון השיר מתנגן באפליקציית ספוטיפיי, אז היא צריכה להיות פתוחה.</p>
    </section>

    <section class="panel" id="set-audio">
      <h2>🔊 אורך הקטע</h2>
      <p class="muted">רוצים לשמוע יותר מהשיר? מוסיפים שניות לפני הקטע ואחריו.</p>
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
      <p>נחפש את המילים גם בשירים מהפלייליסטים שלכם. שירים מהספוטיפיי שלכם יופיעו ראשונים.</p>
      ${sp.isLoggedIn() ? `
        <div class="row"><input id="pl-link" dir="ltr" placeholder="https://open.spotify.com/playlist/..."><button id="pl-add" class="big-btn small">הוספה</button></div>
        <div id="my-pls" class="pls muted">טוען פלייליסטים…</div>
        <div id="import-status"></div>` : `<p class="muted">קודם מתחברים לספוטיפיי.</p>`}
      <p class="muted">${custom.songs.length} שירים מהספוטיפיי שלכם עם מילים מהרשימה. ${custom.songs.length ? `<button id="clear-custom" class="link">מחיקה</button>` : ""}</p>
    </section>

    <section class="panel" id="set-points">
      <h2>🏆 נקודות ומתנות${currentProfile() ? ` · ${esc(currentProfile().name)}` : ""}</h2>
      <p>שלב <b>${lvl}</b> · <b>${game.points}</b> נקודות בסך הכל.</p>
      <p class="muted">איך מרוויחים נקודות: נקודה על כל השמעה של שיר (אותו קטע נותן נקודה עד ${LISTEN_REPEATS_PER_DAY} פעמים ביום), ${PTS_EXAM} נקודות על כל תשובה נכונה בבחינה, ו-${PTS_GAME} על תשובה נכונה במשחק השירים. שלב 1 דורש ${LEVEL_FIRST} נקודות, וכל שלב אחריו דורש ${LEVEL_STEP} נקודות יותר מהקודם.</p>
      ${game.awards.length ? `
        <h3>🎁 מתנות (להורים)</h3>
        <div class="awards">${game.awards.map((a, i) => `
          <label class="award ${a.given ? "given" : ""}"><input type="checkbox" data-award="${i}" ${a.given ? "checked" : ""}> שלב ${a.level} · ${esc(a.date)} · ${a.given ? "המתנה ניתנה ✓" : "מחכה למתנה 🎁"}</label>`).join("")}
        </div>` : `<p class="muted">עוד לא עברו שלב. בהצלחה! 🍀</p>`}
    </section>

    <section class="panel" id="set-backup">
      <h2>💾 גיבוי והעברה בין מכשירים</h2>
      <p class="muted">כל הנתונים (פרופילים, נקודות, שלבים, סדר שירים ושירים שנוספו) נשמרים רק בדפדפן הזה. כדי להעביר אותם למכשיר אחר: מורידים כאן קובץ גיבוי, ופותחים אותו בעמוד הזה במכשיר השני.</p>
      <div class="row wrap"><button id="backup-dl" class="big-btn small">הורדת גיבוי</button><label class="ghost">טעינת גיבוי<input type="file" id="backup-ul" accept=".json,application/json" hidden></label></div>
    </section>`;

  app.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => document.getElementById(b.dataset.goto).scrollIntoView({ behavior: "smooth" })));
  app.querySelectorAll(".step").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    audioPrefs[k] = Math.min(EXTRA_MAX_SECS, Math.max(0, audioPrefs[k] + +b.dataset.d));
    store.set("vk.audio", audioPrefs);
    $(`#val-${k}`).textContent = audioPrefs[k];
  }));
  app.querySelectorAll("[data-award]").forEach((c) => c.addEventListener("change", () => { game.awards[+c.dataset.award].given = c.checked; saveGame(); render(); }));
  $("#save-cid")?.addEventListener("click", () => { const v = $("#cid").value.trim(); if (v) { sp.setClientId(v); render(); } });
  $("#reset-cid")?.addEventListener("click", () => { sp.logout(); localStorage.removeItem("vk.spotify.clientId"); render(); });
  $("#login")?.addEventListener("click", () => sp.login());
  $("#logout")?.addEventListener("click", () => { sp.logout(); render(); });
  $("#clear-custom")?.addEventListener("click", () => { custom = { songs: [], hits: {}, seen: [] }; store.set("vk.custom", custom); render(); });
  $("#prof-add").addEventListener("click", () => {
    const name = $("#prof-name").value.trim();
    if (!name) return;
    const emojis = ["🦄", "🐬", "🌈", "🦊", "🐼", "🌻"];
    const p = { id: Date.now().toString(36), name, emoji: emojis[profiles.length % emojis.length] };
    // the first profile inherits whatever was earned before profiles existed
    if (!profiles.length) for (const k of ["progress", "order", "game"]) { const v = localStorage.getItem(`vk.${k}.default`); if (v) localStorage.setItem(`vk.${k}.${p.id}`, v); }
    profiles.push(p); store.set("vk.profiles", profiles); switchProfile(p.id);
  });
  app.querySelectorAll("[data-prof]").forEach((b) => b.addEventListener("click", () => switchProfile(b.dataset.prof)));
  $("#backup-dl").addEventListener("click", () => {
    const data = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith("vk.") && !/^vk\.spotify\.(token|verifier)$/.test(k)) data[k] = localStorage.getItem(k);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: "voc-kids", savedAt: new Date().toISOString(), data })], { type: "application/json" }));
    a.download = `voc-kids-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#backup-ul").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { app: tag, data } = JSON.parse(await file.text());
      if (tag !== "voc-kids" || !data) throw new Error("bad file");
      if (!confirm("לטעון את הגיבוי? הנתונים שבדפדפן הזה יוחלפו בנתונים מהקובץ.")) return;
      for (const [k, v] of Object.entries(data)) if (k.startsWith("vk.") && !/^vk\.spotify\.(token|verifier)$/.test(k)) localStorage.setItem(k, v);
      location.reload();
    } catch { toast("זה לא נראה כמו קובץ גיבוי של האפליקציה"); }
  });

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

function switchProfile(id) {
  profileId = id; store.set("vk.profile", id);
  loadProfileData();
  render();
}

let importing = false;
async function importPlaylist(id, name) {
  if (importing) return;
  importing = true;
  const status = $("#import-status");
  try {
    status.textContent = `טוען את "${name}"…`;
    const tracks = await sp.playlistTracks(id);
    const res = await importTracks(tracks, name, (done, added) => { status.textContent = `${done} שירים נבדקו, ${added} עם מילים מהרשימה…`; });
    const added = Object.values(res).filter((x) => x === "added").length;
    status.textContent = `סיימנו! ${tracks.length} שירים נבדקו, ${added} שירים חדשים עם מילים מהרשימה 🎉`;
  } catch (e) {
    status.textContent = "";
    if (e.status === 403 || e.status === 404) toast("ספוטיפיי לא מאפשר לקרוא את הפלייליסט הזה (פלייליסטים של ספוטיפיי עצמו חסומים לאפליקציות כאלה). נסו פלייליסט שאתם יצרתם.", 8000);
    else playError(e);
  } finally { importing = false; }
}

// ---------- router ----------
function render() {
  finishListening();
  sp.stop();
  setPlaying(null);
  const [, route, arg] = location.hash.split("/");
  if (route === "word") wordView(decodeURIComponent(arg));
  else if (route === "quiz") quizView();
  else if (route === "exam") examView();
  else if (route === "settings") settingsView();
  else homeView();
  $("#switch-profile")?.addEventListener("click", () => {
    if (profiles.length < 2) { location.hash = "#/settings"; return; }
    const i = profiles.findIndex((p) => p.id === profileId);
    switchProfile(profiles[(i + 1) % profiles.length].id);
  });
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);
try {
  const result = await sp.handleRedirect();
  if (result === "ok") location.hash = "#/settings";
  else if (result) toast("ההתחברות לספוטיפיי בוטלה");
} catch (e) { toast(esc(e.message)); }
sp.initPlayer();
render();
