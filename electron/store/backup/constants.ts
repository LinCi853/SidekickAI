
export const BACKUP_FILES = [
  // ===== settings.db =====
  'settings.db',
  'settings.db-wal',
  'settings.db-shm',
  
  'chat.db',
  'chat.db-wal',
  'chat.db-shm',
  'whiteboard.db',
  'whiteboard.db-wal',
  'whiteboard.db-shm',
  'notes.db',
  'notes.db-wal',
  'notes.db-shm',
  'search-history.db',
  'search-history.db-wal',
  'search-history.db-shm',
  'browser-downloads.db',
  'browser-downloads.db-wal',
  'browser-downloads.db-shm',
  'bookmarks.db',
  'bookmarks.db-wal',
  'bookmarks.db-shm',
  'nav-history.db',
  'nav-history.db-wal',
  'nav-history.db-shm',
  'accumulated-links.db',
  'accumulated-links.db-wal',
  'accumulated-links.db-shm',
  
  'injection-history.json',
  
];


export const ASSET_DIRS = ['whiteboard-assets', 'notes-assets'];


export const PARTITION_COOKIE_FILES = [
  'Cookies', 'Cookies-wal', 'Cookies-shm', 'Cookies-journal',
  'Network/Cookies', 'Network/Cookies-wal', 'Network/Cookies-shm', 'Network/Cookies-journal',
];


export const PARTITION_COOKIE_DIRS = ['Local Storage'];

/** Persistent offline application storage must never be treated as disposable cache. */
export const PARTITION_INDEXEDDB_DIRS = ['IndexedDB', 'File System', 'blob_storage', 'WebStorage'];


export const PARTITION_CACHE_DIRS = [
  'Service Worker',
  'Cache',
  'Code Cache',
  'GPUCache',
];
