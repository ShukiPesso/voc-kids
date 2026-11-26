// Supabase project the app talks to. Both keys are public by design (browser apps);
// what each family can read or change is enforced by row-level security in the database.
const PROD = {
  url: "https://cpvlhtipmkncbgibdvbs.supabase.co",
  anonKey: "sb_publishable_cjD37yeOVuiMf8GlymMu7g_HlXAB4Xf",
};

// Local development stack (`supabase start`). Turn on with: localStorage.setItem("vk.dev", "1")
const LOCAL = {
  url: "http://127.0.0.1:54321",
  anonKey: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
};

export const SUPABASE = localStorage.getItem("vk.dev") === "1" ? LOCAL : PROD;
