// Tiny IndexedDB key-value store for settings. No localStorage.
const STORE = 'kv'

let dbp: Promise<IDBDatabase> | null = null

function open(name: string): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbp = null
      reject(req.error ?? new Error('idb open'))
    }
  })
  return dbp
}

export async function load<T>(name: string, key: string): Promise<T | undefined> {
  try {
    const db = await open(name)
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      r.onsuccess = () => resolve(r.result as T | undefined)
      r.onerror = () => reject(r.error)
    })
  } catch {
    return undefined
  }
}

export async function save(name: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await open(name)
    await new Promise<void>((resolve, reject) => {
      const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
      r.onsuccess = () => resolve()
      r.onerror = () => reject(r.error)
    })
  } catch {
    /* settings are a nicety; never block the app */
  }
}

/** Best-effort. A denial must not block the app. */
export async function askPersist(): Promise<void> {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist()
    }
  } catch {
    /* ignore */
  }
}
