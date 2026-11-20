import { RELEASE_TOKEN_KEY } from "./config.js";

// Older installations keep their Pages-era transactions; the release credential is shared across the migration.
const stateKey = (key) => key === RELEASE_TOKEN_KEY ? key : "internal:" + key;

const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("github-unpacked-self-update-lab", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("state");
    request.result.createObjectStore("events", { autoIncrement: true });
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});

async function transact(name, mode, action) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const request = action(transaction.objectStore(name));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onabort = () => reject(transaction.error ?? request?.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? request?.error);
  });
}

export const load = (key) => transact("state", "readonly", (store) => store.get(stateKey(key)));
export const saveAll = (values) => transact("state", "readwrite", (store) => {
  for (const [key, value] of Object.entries(values)) store.put(value, stateKey(key));
  return null;
});
export const save = (key, value) => saveAll({ [key]: value });
export const readEvents = () => transact("events", "readonly", (store) => store.getAll());
export const record = (event) => transact("events", "readwrite", (store) => {
  const entry = store.add({ at: new Date().toISOString(), ...event });
  entry.onsuccess = () => { if (entry.result > 100) store.delete(IDBKeyRange.upperBound(entry.result - 100)); };
  return entry;
});
