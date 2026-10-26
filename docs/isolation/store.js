const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("permission-isolation-probe", 1);
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
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? request.error);
  });
}

export const load = (key) => transact("state", "readonly", (store) => store.get(key));
export const save = (key, value) => transact("state", "readwrite", (store) => store.put(value, key));
export const readEvents = () => transact("events", "readonly", (store) => store.getAll());
export const record = (event) => transact("events", "readwrite", (store) => store.add({ at: new Date().toISOString(), ...event }));
