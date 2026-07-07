// Cloudflare Worker — REST API for "the shelf" book-lending app, backed by D1.
//
// Routes:
//   GET    /api/state             -> { friends: string[], books: Book[] }
//   POST   /api/friends           { name }              -> add a friend
//   DELETE /api/friends/:name                           -> remove a friend
//   POST   /api/books             { ...book fields }    -> add a book
//   PATCH  /api/books/:id         { ...changed fields }  -> update a book
//   DELETE /api/books/:id                                -> remove a book
//
// Bind a D1 database to this Worker as `DB` (Settings -> Bindings -> D1 database).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function rowToBook(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author || '',
    isbn: row.isbn || '',
    description: row.description || '',
    pageCount: row.pageCount ?? null,
    tags: row.tags ? JSON.parse(row.tags) : [],
    coverUrl: row.coverUrl || null,
    owner: row.owner,
    status: row.status,
    requestedBy: row.requestedBy || null,
    borrowedBy: row.borrowedBy || null,
    addedAt: row.addedAt,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ["api", "books", ":id"]

    try {
      if (parts[0] !== 'api') return json({ error: 'not found' }, 404);

      // GET /api/state
      if (parts[1] === 'state' && request.method === 'GET') {
        const friendsRes = await env.DB.prepare('SELECT name FROM friends ORDER BY name').all();
        const booksRes = await env.DB.prepare('SELECT * FROM books ORDER BY addedAt DESC').all();
        return json({
          friends: friendsRes.results.map(r => r.name),
          books: booksRes.results.map(rowToBook),
        });
      }

      // POST /api/friends
      if (parts[1] === 'friends' && request.method === 'POST') {
        const body = await request.json();
        const name = (body.name || '').trim();
        if (!name) return json({ error: 'name is required' }, 400);
        await env.DB.prepare('INSERT OR IGNORE INTO friends (name) VALUES (?)').bind(name).run();
        return json({ ok: true });
      }

      // DELETE /api/friends/:name
      if (parts[1] === 'friends' && parts[2] && request.method === 'DELETE') {
        const name = decodeURIComponent(parts[2]);
        const inUse = await env.DB.prepare(
          'SELECT 1 FROM books WHERE owner = ?1 OR requestedBy = ?1 OR borrowedBy = ?1 LIMIT 1'
        ).bind(name).first();
        if (inUse) return json({ error: 'friend owns, borrowed, or requested a book' }, 409);
        await env.DB.prepare('DELETE FROM friends WHERE name = ?').bind(name).run();
        return json({ ok: true });
      }

      // POST /api/books
      if (parts[1] === 'books' && request.method === 'POST' && !parts[2]) {
        const b = await request.json();
        if (!b.id || !b.title || !b.owner) return json({ error: 'id, title, and owner are required' }, 400);
        await env.DB.prepare(
          `INSERT INTO books (id, title, author, isbn, description, pageCount, tags, coverUrl, owner, status, requestedBy, borrowedBy, addedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          b.id, b.title, b.author || '', b.isbn || '', b.description || '',
          b.pageCount ?? null, JSON.stringify(b.tags || []), b.coverUrl || null,
          b.owner, b.status || 'available', b.requestedBy || null, b.borrowedBy || null,
          b.addedAt || Date.now()
        ).run();
        return json({ ok: true });
      }

      // PATCH /api/books/:id
      if (parts[1] === 'books' && parts[2] && request.method === 'PATCH') {
        const id = parts[2];
        const b = await request.json();
        const fields = ['status', 'requestedBy', 'borrowedBy', 'title', 'author', 'description', 'pageCount', 'coverUrl'];
        const sets = [];
        const values = [];
        for (const f of fields) {
          if (f in b) { sets.push(`${f} = ?`); values.push(b[f]); }
        }
        if ('tags' in b) { sets.push('tags = ?'); values.push(JSON.stringify(b.tags)); }
        if (sets.length === 0) return json({ error: 'no fields to update' }, 400);
        values.push(id);
        await env.DB.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
        return json({ ok: true });
      }

      // DELETE /api/books/:id
      if (parts[1] === 'books' && parts[2] && request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM books WHERE id = ?').bind(parts[2]).run();
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
