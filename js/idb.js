// Tiny key-value store in IndexedDB. Used to cache song lyrics on this device only.
let dbp;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("voc-kids", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("kv", mode);
    const r = fn(t.objectStore("kv"));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}
export const idbGet = (key) => tx("readonly", (s) => s.get(key)).catch(() => undefined);
export const idbSet = (key, value) => tx("readwrite", (s) => s.put(value, key)).catch(() => {});
