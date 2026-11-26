// Supabase: family login, synced family data, word libraries, publishing and admin.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { SUPABASE } from "./config.js?v=1795733384";

export const configured = !!(SUPABASE.url && SUPABASE.anonKey);
export const sb = configured ? createClient(SUPABASE.url, SUPABASE.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit", storageKey: "vk.auth" },
}) : null;

const redirectTo = () => location.origin + location.pathname;
const check = ({ data, error }) => { if (error) throw error; return data; };

// ---------- auth ----------
export async function session() { return configured ? (await sb.auth.getSession()).data.session : null; }
export const onAuth = (cb) => sb?.auth.onAuthStateChange((event, s) => cb(event, s));
export const signIn = (email, password) => sb.auth.signInWithPassword({ email, password }).then(check);
export const signUp = (email, password) => sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } }).then(check);
export const signOut = () => sb.auth.signOut();
export const resetPassword = (email) => sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() }).then(check);
export const setPassword = (password) => sb.auth.updateUser({ password }).then(check);

// ---------- family data ----------
export async function loadFamily() {
  const fam = check(await sb.from("family_state").select("data, updated_at").maybeSingle());
  const profs = check(await sb.from("profile_state").select("profile_id, data, updated_at"));
  return { family: fam?.data ?? null, profiles: Object.fromEntries(profs.map((p) => [p.profile_id, p.data])) };
}
export async function saveFamily(data) {
  check(await sb.from("family_state").upsert({ user_id: (await session()).user.id, data, updated_at: new Date().toISOString() }));
}
export async function saveProfile(profileId, data) {
  check(await sb.from("profile_state").upsert({ user_id: (await session()).user.id, profile_id: profileId, data, updated_at: new Date().toISOString() }));
}
export async function deleteProfile(profileId) {
  check(await sb.from("profile_state").delete().eq("profile_id", profileId));
}

// ---------- libraries ----------
const LIST_COLS = "id, owner, author_name, title, description, visibility, request_note, review_note, requested_at, reviewed_at, updated_at";
export async function myLibraries() {
  const uid = (await session()).user.id;
  return check(await sb.from("libraries").select(LIST_COLS + ", content").eq("owner", uid).order("created_at"));
}
export async function publicLibraries() {
  return check(await sb.from("libraries").select(LIST_COLS + ", content").eq("visibility", "public").order("reviewed_at", { ascending: false }));
}
export async function getLibrary(id) {
  return check(await sb.from("libraries").select("*").eq("id", id).maybeSingle());
}
export async function getLibraries(ids) {
  if (!ids.length) return [];
  return check(await sb.from("libraries").select(LIST_COLS + ", content").in("id", ids));
}
export async function createLibrary(lib) {
  return check(await sb.from("libraries").insert(lib).select("id").single()).id;
}
export async function updateLibrary(id, patch) {
  check(await sb.from("libraries").update(patch).eq("id", id));
}
export async function deleteLibrary(id) {
  check(await sb.from("libraries").delete().eq("id", id));
}

// ---------- admin ----------
export async function isAdmin() { return check(await sb.rpc("is_admin")); }
export async function adminExists() { return check(await sb.rpc("admin_exists")); }
export async function claimAdmin() { return check(await sb.rpc("claim_admin")); }
export async function pendingLibraries() {
  return check(await sb.from("libraries").select(LIST_COLS + ", content").eq("visibility", "pending").order("requested_at"));
}
export async function pendingCount() {
  const { count, error } = await sb.from("libraries").select("id", { count: "exact", head: true }).eq("visibility", "pending");
  if (error) throw error;
  return count ?? 0;
}

// ---------- page scan (Claude, via the scan-words function) ----------
export async function scanPages(files) {
  const { data, error } = await sb.functions.invoke("scan-words", { body: { files } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data;
}
