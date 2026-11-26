// Spotify: login (PKCE, no server needed), track lookup, and snippet playback.
const AUTH = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const SCOPES = "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-top-read";
const LS = { clientId: "vk.spotify.clientId", token: "vk.spotify.token", verifier: "vk.spotify.verifier", tracks: "vk.spotify.tracks" };

export const redirectUri = () => location.origin + location.pathname;
export const getClientId = () => localStorage.getItem(LS.clientId) || "";
export const setClientId = (id) => localStorage.setItem(LS.clientId, id.trim());

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem(LS.verifier, verifier);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: getClientId(), response_type: "code", redirect_uri: redirectUri(),
    scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge,
  });
  location.href = `${AUTH}/authorize?${q}`;
}

export function logout() {
  localStorage.removeItem(LS.token);
}

function saveToken(t) {
  const prev = JSON.parse(localStorage.getItem(LS.token) || "{}");
  localStorage.setItem(LS.token, JSON.stringify({
    access: t.access_token, refresh: t.refresh_token || prev.refresh, expires: Date.now() + (t.expires_in - 60) * 1000,
  }));
}

async function tokenRequest(params) {
  const res = await fetch(`${AUTH}/api/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: getClientId(), ...params }),
  });
  if (!res.ok) throw new Error("Spotify login failed: " + (await res.text()));
  saveToken(await res.json());
}

// Call once on page load: finishes the login redirect if there is one.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (q.get("error")) { history.replaceState(null, "", redirectUri() + location.hash); return q.get("error"); }
  if (!q.get("code")) return null;
  await tokenRequest({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirectUri(), code_verifier: localStorage.getItem(LS.verifier) });
  history.replaceState(null, "", redirectUri() + location.hash);
  return "ok";
}

export const isLoggedIn = () => !!localStorage.getItem(LS.token);

async function accessToken() {
  const t = JSON.parse(localStorage.getItem(LS.token) || "null");
  if (!t) throw new Error("not logged in");
  if (Date.now() < t.expires) return t.access;
  await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
  return JSON.parse(localStorage.getItem(LS.token)).access;
}

export async function api(path, opts = {}) {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    ...opts, headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 204 || res.status === 202) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `Spotify ${res.status}`);
    err.status = res.status; err.reason = body?.error?.reason;
    throw err;
  }
  return body;
}

export const me = () => api("/me");

// ---------- track lookup (cached) ----------
const trackCache = JSON.parse(localStorage.getItem(LS.tracks) || "{}");
const simplify = (s) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]| - .*$/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function toTrack(t) {
  return { uri: t.uri, id: t.id, name: t.name, album: t.album.name, artist: t.artists.map((a) => a.name).join(", "), image: t.album.images.at(-1)?.url || t.album.images[0]?.url, explicit: t.explicit, durationMs: t.duration_ms };
}

export async function findTrack(song) {
  const key = `${song.artist}|${song.title}`;
  if (song.uri) return song;
  if (trackCache[key] !== undefined) return trackCache[key];
  const queries = [`track:${song.title} artist:${song.artist}`, `${song.title} ${song.artist}`];
  let best = null;
  for (const q of queries) {
    const r = await api(`/search?${new URLSearchParams({ q, type: "track", limit: "10" })}`);
    const items = (r?.tracks?.items || []).filter(Boolean);
    const want = simplify(song.title);
    const scored = items.map((t) => {
      let s = 0;
      const n = simplify(t.name);
      if (n === want) s += 10; else if (n.includes(want) || want.includes(n)) s += 5;
      if (t.artists.some((a) => simplify(a.name).includes(simplify(song.artist).split(" ")[0]))) s += 4;
      if (song.duration) s -= Math.min(8, Math.abs(t.duration_ms / 1000 - song.duration) / 1.5); // same recording as the timed lyrics
      if (t.explicit) s -= 3;
      if (/live|karaoke|instrumental|remix/i.test(t.name)) s -= 4;
      return { t, s };
    }).sort((a, b) => b.s - a.s);
    if (scored.length && scored[0].s >= 6) { best = toTrack(scored[0].t); break; }
  }
  trackCache[key] = best;
  localStorage.setItem(LS.tracks, JSON.stringify(trackCache));
  return best;
}

// ---------- playback ----------
let sdkPlayer = null;
let sdkDeviceId = null;
let sdkFailed = false;
let stopTimer = null;
let currentDevice = null;

export function initPlayer() {
  if (sdkPlayer || sdkFailed || !isLoggedIn()) return;
  window.onSpotifyWebPlaybackSDKReady = () => {
    sdkPlayer = new Spotify.Player({ name: "Voc Kids 🎵", volume: 0.8, getOAuthToken: (cb) => accessToken().then(cb) });
    sdkPlayer.addListener("ready", ({ device_id }) => { sdkDeviceId = device_id; });
    sdkPlayer.addListener("not_ready", () => { sdkDeviceId = null; });
    for (const ev of ["initialization_error", "authentication_error", "account_error"]) {
      sdkPlayer.addListener(ev, ({ message }) => { console.warn("Spotify SDK", ev, message); sdkFailed = true; sdkDeviceId = null; });
    }
    sdkPlayer.connect();
  };
  const s = document.createElement("script");
  s.src = "https://sdk.scdn.co/spotify-player.js";
  document.head.appendChild(s);
}

async function pickDevice() {
  if (sdkDeviceId) return sdkDeviceId;
  const { devices = [] } = (await api("/me/player/devices")) || {};
  const d = devices.find((x) => x.is_active) || devices.find((x) => !x.is_restricted);
  if (!d) {
    const err = new Error("no-device");
    err.code = "no-device";
    throw err;
  }
  return d.id;
}

export async function stop() {
  clearTimeout(stopTimer);
  stopTimer = null;
  if (currentDevice) await api(`/me/player/pause?device_id=${currentDevice}`, { method: "PUT" }).catch(() => {});
}

// Plays [startMs, endMs] of a track. onEnd is called when the snippet finishes.
export async function playSnippet(uri, startMs, endMs, onEnd) {
  clearTimeout(stopTimer);
  sdkPlayer?.activateElement?.(); // needed for autoplay rules in some browsers (must be inside a click)
  currentDevice = await pickDevice();
  const t0 = performance.now();
  await api(`/me/player/play?device_id=${currentDevice}`, { method: "PUT", body: JSON.stringify({ uris: [uri], position_ms: startMs }) });
  let length = endMs - startMs;
  if (currentDevice === sdkDeviceId && sdkPlayer) {
    // wait until the local player really started, then time the stop from its actual position
    for (let i = 0; i < 20; i++) {
      const st = await sdkPlayer.getCurrentState();
      if (st && !st.paused && st.position >= startMs - 500) { length = endMs - st.position; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
  } else {
    length += Math.min(800, performance.now() - t0);
  }
  stopTimer = setTimeout(async () => { await stop(); onEnd?.(); }, Math.max(1500, length));
}

export const usingBrowserPlayer = () => !!sdkDeviceId;

// ---------- playlists ----------
export function playlistIdFrom(text) {
  const m = text.match(/playlist[/:]([A-Za-z0-9]{10,})/);
  return m ? m[1] : /^[A-Za-z0-9]{22}$/.test(text.trim()) ? text.trim() : null;
}

export async function myPlaylists() {
  const r = await api("/me/playlists?limit=50");
  return (r?.items || []).filter(Boolean).map((p) => ({ id: p.id, name: p.name, image: p.images?.[0]?.url, count: p.items?.total ?? p.tracks?.total }));
}

export async function playlistTracks(id, max = 150) {
  let url = `/playlists/${id}/items?limit=50`;
  try { await api(url.replace("limit=50", "limit=1")); } catch { url = `/playlists/${id}/tracks?limit=50`; }
  const out = [];
  while (url && out.length < max) {
    const r = await api(url);
    for (const it of r?.items || []) {
      const t = it.item || it.track;
      if (t && t.type === "track" && t.uri && !t.is_local) out.push(toTrack(t));
    }
    url = r?.next;
  }
  return out.slice(0, max);
}

// ---------- search ----------
export async function searchTracks(q, max = 10) {
  const out = [];
  for (let offset = 0; offset < max; offset += 10) {
    const r = await api(`/search?${new URLSearchParams({ q, type: "track", limit: "10", offset: String(offset) })}`);
    const items = (r?.tracks?.items || []).filter(Boolean);
    out.push(...items.map(toTrack));
    if (items.length < 10) break;
  }
  return out;
}

export async function topTracks() {
  const out = [];
  for (const range of ["short_term", "medium_term", "long_term"]) {
    const r = await api(`/me/top/tracks?limit=50&time_range=${range}`);
    for (const t of r?.items || []) if (!out.some((x) => x.uri === t.uri)) out.push(toTrack(t));
  }
  return out;
}
