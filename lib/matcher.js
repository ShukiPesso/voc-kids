// Shared by the build script (Node) and the web app (browser).
// Finds vocabulary words inside time-synced song lyrics.

const VOWELS = "aeiou";

function nounForms(w) {
  const out = [w];
  if (/[^aeiou]y$/.test(w)) out.push(w.slice(0, -1) + "ies");
  else if (/(s|x|z|ch|sh)$/.test(w)) out.push(w + "es");
  else out.push(w + "s");
  return out;
}

// Common irregular verbs: base -> other forms
const IRREGULAR = Object.fromEntries(`be was were been being am is are|become became|begin began begun|break broke broken|bring brought|build built|buy bought|catch caught|choose chose chosen|come came|cost|cut|do did done does|draw drew drawn|dream dreamt dreamed|drink drank drunk|drive drove driven|eat ate eaten|fall fell fallen|feed fed|feel felt|fight fought|find found|fly flew flown flies|forget forgot forgotten|forgive forgave forgiven|freeze froze frozen|get got gotten|give gave given|go went gone goes|grow grew grown|hang hung|have had has|hear heard|hide hid hidden|hit|hold held|hurt|keep kept|know knew known|lay laid|lead led|leave left|lend lent|let|lie lay lain|light lit|lose lost|make made|mean meant|meet met|pay paid|put|read|ride rode ridden|ring rang rung|rise rose risen|run ran|say said|see saw seen|seek sought|sell sold|send sent|set|shake shook shaken|shine shone|shoot shot|show showed shown|shut|sing sang sung|sink sank sunk|sit sat|sleep slept|speak spoke spoken|spend spent|stand stood|steal stole stolen|stick stuck|sting stung|strike struck|swear swore sworn|sweep swept|swim swam swum|swing swung|take took taken|teach taught|tear tore torn|tell told|think thought|throw threw thrown|understand understood|wake woke woken|wear wore worn|weep wept|win won|write wrote written`
  .split("|").map((g) => { const [b, ...rest] = g.split(" "); return [b, rest]; }));

function verbForms(w) {
  const out = new Set([...nounForms(w), ...(IRREGULAR[w] || [])]);
  let stem = w;
  if (w.endsWith("e")) {
    stem = w.slice(0, -1);
    out.add(w + "d");
  } else if (/[^aeiou]y$/.test(w)) {
    out.add(w.slice(0, -1) + "ied");
    out.add(w + "ing");
    return [...out];
  } else {
    out.add(w + "ed");
  }
  const stems = [stem];
  const n = w.length;
  // consonant-vowel-consonant ending: travel -> travelled / travelling
  if (n >= 3 && !VOWELS.includes(w[n - 1]) && VOWELS.includes(w[n - 2]) && !VOWELS.includes(w[n - 3]) && !"wxy".includes(w[n - 1])) {
    stems.push(w + w[n - 1]);
    out.add(w + w[n - 1] + "ed");
  }
  for (const s of stems) {
    out.add(s + "ing");
    out.add(s + "in'"); // sung forms: lovin', drivin'
    out.add(s + "in");
  }
  return [...out];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function wordId(word) {
  return word.en.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
}

// "What about ...?" -> "what about", "interested (in)" -> "interested in"
export function baseForm(en) {
  return en.toLowerCase().replace(/[()]/g, "").replace(/\.\.\.|…|[?!.]/g, "").replace(/\s+/g, " ").trim();
}

// Every plain lowercase spelling that counts as this word (null for legacy regex words).
export function formsFor(word) {
  if (word.match) return null;
  const base = baseForm(word.en);
  let forms;
  if (base.includes(" ")) {
    // phrase: inflect its first word ("shake hands" -> "shaking hands"); also the phrase without (optional) words
    const [first, ...rest] = base.split(" ");
    forms = verbForms(first).map((f) => [f, ...rest].join(" "));
    const noOptional = baseForm(word.en.replace(/\(.*?\)/g, ""));
    if (noOptional && noOptional !== base) forms.push(noOptional);
  } else {
    switch (word.pos) {
      case "noun": forms = nounForms(base); break;
      case "verb":
      case "nounverb": forms = verbForms(base); break;
      default: forms = [base];
    }
  }
  forms = [...new Set([...forms, ...(word.forms || []), ...(word.extra || [])].map((x) => normalize(x.toLowerCase())).filter(Boolean))];
  // longest first so "loving" wins over "lovin"
  forms.sort((a, b) => b.length - a.length);
  return forms;
}

export function patternsFor(word) {
  return word.match || formsFor(word).map(escapeRe);
}

// ---------- hashed word index (lets the app skip songs that can't contain a word, without storing lyrics) ----------
export function tokens(text) {
  return (normalize(text.toLowerCase()).match(/[a-z0-9']+/g) || []).map((t) => t.replace(/^'+|'+$/g, "")).filter(Boolean);
}
export function tokenHash(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function buildMatcher(word) {
  const src = `(?<!\\p{L})(?:${patternsFor(word).join("|")})(?!\\p{L})`;
  return { id: wordId(word), re: new RegExp(src, "giu") };
}

export function normalize(text) {
  return text.replace(/[‘’ʼ`´]/g, "'").replace(/\s+/g, " ").trim();
}

// "[01:23.45] text" -> [{t: ms, text}]
export function parseLRC(lrc) {
  const lines = [];
  for (const raw of (lrc || "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = normalize(raw.replace(/\[[^\]]*\]/g, ""));
    for (const m of stamps) lines.push({ t: Math.round((+m[1] * 60 + +m[2]) * 1000), text });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

// Snippet window around line i: a little pre-roll, until just after the line ends.
export function snippetWindow(lines, i) {
  const t = lines[i].t;
  let end = (lines[i + 1] ? lines[i + 1].t : t + 4000) + 600;
  let start = Math.max(0, t - 700);
  if (end - start < 3500) end = start + 3500;
  if (end - start > 12000) end = start + 12000;
  return { start, end };
}

function neighbour(lines, i, dir) {
  for (let j = i + dir; j >= 0 && j < lines.length; j += dir) if (lines[j].text) return lines[j].text;
  return "";
}

// Returns { [wordId]: hit } with the first occurrence of each word in the song.
export function indexLyrics(lines, matchers) {
  const hits = {};
  lines.forEach((line, i) => {
    if (!line.text) return;
    for (const m of matchers) {
      if (hits[m.id]) continue;
      m.re.lastIndex = 0;
      const ranges = [];
      for (const r of line.text.matchAll(m.re)) ranges.push([r.index, r.index + r[0].length]);
      if (!ranges.length) continue;
      hits[m.id] = {
        t: line.t,
        line: line.text,
        prev: neighbour(lines, i, -1),
        next: neighbour(lines, i, 1),
        ranges,
        ...snippetWindow(lines, i),
      };
    }
  });
  return hits;
}

const simplify = (s) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]|- .*$/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Pick the best LRCLIB search result for a title/artist (must have synced lyrics).
export function pickLyrics(results, title, artist, durationSec) {
  const want = simplify(title);
  const wantArtist = simplify(artist);
  const scored = results
    .filter((r) => r.syncedLyrics && !r.instrumental)
    .map((r) => {
      let score = 0;
      const t = simplify(r.trackName || "");
      if (t === want) score += 10;
      else if (t.includes(want) || want.includes(t)) score += 5;
      if (simplify(r.artistName || "").includes(wantArtist.split(" ")[0])) score += 4;
      if (durationSec && r.duration) score -= Math.min(6, Math.abs(r.duration - durationSec) / 2);
      if (/live|karaoke|instrumental|remix|acoustic/i.test(`${r.trackName} ${r.albumName}`)) score -= 3;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.length && scored[0].score >= 5 ? scored[0].r : null;
}

// Rebuild a full hit (line text, context, highlight ranges) from live lyrics.
// Finds the line by its timestamp; falls back to the first line containing the word.
export function hitFromLyrics(lines, matcher, t) {
  const has = (i) => { matcher.re.lastIndex = 0; return lines[i]?.text && matcher.re.test(lines[i].text); };
  let i = lines.findIndex((l) => Math.abs(l.t - t) < 50);
  if (i < 0 || !has(i)) i = lines.findIndex((_, k) => has(k));
  if (i < 0) return null;
  matcher.re.lastIndex = 0;
  const ranges = [...lines[i].text.matchAll(matcher.re)].map((r) => [r.index, r.index + r[0].length]);
  return { t: lines[i].t, line: lines[i].text, prev: neighbour(lines, i, -1), next: neighbour(lines, i, 1), ranges, ...snippetWindow(lines, i) };
}
