CREATE TABLE IF NOT EXISTS friends (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  isbn TEXT,
  description TEXT,
  pageCount INTEGER,
  tags TEXT,          -- JSON array, e.g. ["fantasy","favorite"]
  coverUrl TEXT,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',  -- available | requested | borrowed
  requestedBy TEXT,
  borrowedBy TEXT,
  addedAt INTEGER NOT NULL
);
