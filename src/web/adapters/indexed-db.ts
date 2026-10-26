import type { PersistedApplicationState } from '../../contracts';
import { emptyApplicationState, migrateApplicationState, validateApplicationState } from '../../core';

const DATABASE_NAME = 'erp-local-application';
const DATABASE_VERSION = 1;
const STORE_NAME = 'application-state';
const STATE_KEY = 'current';

export class LocalStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LocalStorageError';
  }
}

function requestResult<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new LocalStorageError(message, { cause: request.error }));
  });
}
function transactionComplete(transaction: IDBTransaction, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new LocalStorageError(message, { cause: transaction.error }));
    transaction.onabort = () => reject(new LocalStorageError(message, { cause: transaction.error }));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new LocalStorageError('IndexedDB is unavailable in this browser context. Export files remain available.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new LocalStorageError('ERP local storage could not be opened.', { cause: request.error }));
    request.onblocked = () => reject(new LocalStorageError('ERP local storage upgrade is blocked by another open application tab.'));
  });
}

export async function loadApplicationState(): Promise<PersistedApplicationState> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(STATE_KEY), 'ERP local state could not be read.') as unknown;
    if (!value) return emptyApplicationState();
    let migrated: PersistedApplicationState;
    try { migrated = await migrateApplicationState(value); }
    catch (error) { throw new LocalStorageError(error instanceof Error ? error.message : 'ERP local state could not be migrated.', { cause: error }); }
    if (!await validateApplicationState(migrated)) throw new LocalStorageError('ERP local state failed structural or Case-integrity validation. Export or clear the incompatible local state.');
    return migrated;
  } finally {
    database.close();
  }
}

export async function saveApplicationState(state: PersistedApplicationState): Promise<void> {
  if (state.schemaVersion !== '2.0') throw new LocalStorageError('ERP refused to save an unsupported application-state schema.');
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' });
    transaction.objectStore(STORE_NAME).put(structuredClone(state), STATE_KEY);
    await transactionComplete(transaction, 'ERP local state could not be committed. The previous committed state remains authoritative.');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new LocalStorageError('Browser storage quota was exceeded. Export a backup and delete unneeded local workspaces.', { cause: error });
    }
    throw error;
  } finally {
    database.close();
  }
}

export async function clearApplicationStorage(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' });
    transaction.objectStore(STORE_NAME).clear();
    await transactionComplete(transaction, 'ERP local storage could not be cleared.');
  } finally {
    database.close();
  }
}
