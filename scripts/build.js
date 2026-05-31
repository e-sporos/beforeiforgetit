cconst notionPkg = require("@notionhq/client");
const Client = notionPkg.Client || (notionPkg.default && notionPkg.default.Client);
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ── TAG COLOURS (must match your blog CSS) ──────────────────────────────────
const TAG_COLORS = {
  film:    { bg: '#E8442A', text: '#fff' },
  people:  { bg: '#2A9E6A', text: '#fff' },
  culture: { bg: '#7C4DE8', text: '#fff' },
  history: { bg: '#D4B800', text: '#0D0D08' },
  books:   { bg: '#E8762A', text: '#fff' },
  music:   { bg: '#2A7CE8', text: '#fff' },
};

// ── PLACEHOLDER SVG BACKGROUNDS PER TAG ────────────────────────────────────
const TILE_SVGS = {
  film: `<svg viewBox="0 0 700 420" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g" cx="60%" cy="40%"><stop offset="0%" stop-color="#C4A060"/><stop offset="100%" stop-color="#3A2808"/></radialGradient></defs><rect width="700" height="420" fill="url(#g)"/><circle cx="420" cy="160" r="180" fill="#E8C070" opacity="0.12"/><rect x="60" y="140" width="180" height="120" rx="8" fill="#2A1C08" opacity="0.5"/></svg>`,
  people: `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g" cx="30%" cy="60%"><stop offset="0%" stop-color="#7AADAA"/><stop offset="100%" stop-color="#0A2825"/></radialGradient></defs><rect width="400" height="300" fill="url(#g)"/><rect x="120" y="50" width="160" height="110" rx="6" fill="#1A4845" opacity="0.6"/></svg>`,
  culture: `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g" cx="70%" cy="30%"><stop offset="0%" stop-color="#9A70C8"/><stop offset="100%" stop-color="#180A28"/></radialGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="200" cy="150" r="80" fill="#7040A0" opacity="0.25"/><circle cx="200" cy="150" r="45" fill="#C090E0" opacity="0.3"/></svg>`,
  history: `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="g" cx="50%" cy="50%"><stop offset="0%" stop-color="#C89030"/><stop offset="100%" stop-color="#281800"/></radialGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="200" cy="150" r="100" fill="#D4A030" opacity="0.1"/><circle cx="200" cy="150" r="55" fill="#D4A030" opacity="0.12"/></svg>`,
  books: `<svg viewBox="0 0 340 420" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1A3860"/><stop offset="100%" stop-color="#0A1828"/></linearGradient></defs><rect width="340" height="420" fill="url(#g)"/><rect x="80" y="60" width="180" height="240" rx="6" fill="#1E4070" opacity="0.6"/></svg>`,
  music: `<svg viewBox="0 0 340 420" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#0A2840"/><stop offset="100%" stop-color="#1A5080"/></linearGradient></defs><rect width="340" height="420" fill="url(#g)"/><rect x="60" y="100" width="4" height="180" rx="2" fill="#3A90D0" opacity="0.4"/><rect x="100" y="60" width="4" height="260" rx="2" fill="#3A90D0" opacity="0.45"/><rect x="140" y="90" width="4" height="200" rx="2" fill="#3A90D0" opacity="0.4"/><rect x="180" y="120" width="4" height="140" rx="2" fill="#3A90D0" opacity="0.3"/></svg>`,
};

const HERO_SVGS = {
  film: `<defs><radialGradient id="hg" cx="60%" cy="40%"><stop offset="0%" stop-color="#C4A060"/><stop offset="100%" stop-color="#3A2808"/></radialGradient></defs><rect width="640" height="300" fill="url(#hg)"/><circle cx="480" cy="120" r="160" fill="#E8C070" opacity="0.1"/><rect x="60" y="80" width="220" height="140" rx="8" fill="#2A1C08" opacity="0.5"/>`,
  people: `<defs><radialGradient id="hg" cx="30%" cy="60%"><stop offset="0%" stop-color="#7AADAA"/><stop offset="100%" stop-color="#0A2825"/></radialGradient></defs><rect width="640" height="300" fill="url(#hg)"/><rect x="180" y="60" width="280" height="180" rx="8" fill="#1A4845" opacity="0.55"/>`,
  culture: `<defs><radialGradient id="hg" cx="70%" cy="30%"><stop offset="0%" stop-color="#9A70C8"/><stop offset="100%" stop-color="#180A28"/></radialGradient></defs><rect width="640" height="300" fill="url(#hg)"/><circle cx="320" cy="150" r="100" fill="#7040A0" opacity="0.2"/><circle cx="320" cy="150" r="50" fill="#C090E0" opacity="0.3"/>`,
  history: `<defs><radialGradient id="hg" cx="50%" cy="50%"><stop offset="0%" stop-color="#C89030"/><stop offset="100%" stop-color="#281800"/></radialGradient></defs><rect width="640" height="300" fill="url(#hg)"/><circle cx="320" cy="150" r="120" fill="#D4A030" opacity="0.08"/><circle cx="320" cy="150" r="60" fill="#D4A030" opacity="0.1"/>`,
  books: `<defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1A3860"/><stop offset="100%" stop-color="#0A1828"/></linearGradient></defs><rect width="640" height="300" fill="url(#hg)"/><rect x="160" y="40" width="320" height="200" rx="8" fill="#1E4070" opacity="0.55"/>`,
  music: `<defs><linearGradient id="hg" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#0A2840"/><stop offset="100%" stop-color="#1A5080"/></linearGradient></defs><rect width="640" height="300" fill="url(#hg)"/><rect x="80" y="60" width="6" height="180" rx="3" fill="#3A90D0" opacity="0.4"/><rect x="130" y="40" width="6" height="220" rx="3" fill="#3A90D0" opacity="0.5"/><rect x="180" y="70" width="6" height="160" rx="3" fill="#3A90D0" opacity="0.4"/><rect x="230" y="30" width="6" height="240" rx="3" fill="#3A90D0" opacity="0.45"/>`,
};

// ── TILE SIZE CLASSES (cycles through for variety) ──────────────────────────
const TILE_CLASSES = ['t1', 't2', 't3', 't4', 't5', 't6'];

// ── FETCH POSTS FROM NOTION ─────────────────────────────────────────────────
async function fetchPosts() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: 'Published',
      checkbox: { equals: true },
    },
    sorts: [{ property: 'Date', direction: 'descending' }],
  });

  return response.results.map(page => {
    const props = page.properties;
    const title    = props.Name?.title?.[0]?.plain_text || props.Title?.title?.[0]?.plain_text || 'Untitled';
    const tag      = (props.Tag?.select?.name || 'film').toLowerCase();
    const date     = props.Date?.date?.start ? new Date(props.Date.date.start).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '';
    const excerpt  = props.Excerpt?.rich_text?.[0]?.plain_text || '';
    const readTime = props.ReadTime?.rich_text?.[0]?.plain_text || '';
    const cover    = page.cover?.external?.url || page.cover?.file?.url || null;
    return { title, tag, date, excerpt, readTime, cover };
  });
}

// ── BUILD A SINGLE TILE ─────────────────────────────────────────────────────
function buildTile(post, index) {
  const tileClass = TILE_CLASSES[index % TILE_CLASSES.length];
  const tag       = post.tag in TAG_COLORS ? post.tag : 'film';
  const tc        = TAG_COLORS[tag];
  const minH      = tileClass === 't1' ? '420px' : tileClass === 't2' || tileClass === 't3' ? '195px' : '230px';

  const imgContent = post.cover
    ? `<img src="${post.cover}" style="width:100%;height:100%;object-fit:cover;display:block;min-height:${minH};transition:transform 0.5s ease;" alt="${post.title}"/>`
    : `<svg viewBox="0 0 700 420" preserveAspectRatio="xMidYMid slice" style="min-height:${minH}">${(TILE_SVGS[tag] || TILE_SVGS.film).replace(/<svg[^>]*>/, '')}</svg>`;

  const escapedTitle    = post.title.replace(/'/g, "\\'");
  const escapedExcerpt  = post.excerpt.replace(/'/g, "\\'");

  return `
      <div class="tile ${tileClass}" data-tag="${tag}" onclick="openPost('${tag}','${escapedTitle}','${post.date}','${post.readTime}','${escapedExcerpt}'${post.cover ? `,'${post.cover}'` : ''})">
        <div class="tile-img-wrap" style="min-height:${minH}">
          ${imgContent}
        </div>
        <div class="tile-overlay">
          <span class="tile-tag tag-${tag}" style="background:${tc.bg};color:${tc.text}">${tag}</span>
          <h2 class="tile-title">${post.title}</h2>
          <div class="tile-extra">
            <p class="tile-excerpt">${post.excerpt}</p>
            <span class="tile-date">${post.date}${post.readTime ? ' · ' + post.readTime : ''}</span>
          </div>
        </div>
      </div>`;
}

// ── READ THE TEMPLATE index.html ────────────────────────────────────────────
function buildHTML(posts) {
  const templatePath = path.join(__dirname, '..', 'index.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  // Build tiles HTML
  const tilesHTML = posts.length > 0
    ? posts.map((post, i) => buildTile(post, i)).join('\n')
    : `<div class="empty-state show">no published posts yet — write something in Notion!</div>`;

  // Build hero SVGs object for JS
  const heroSvgsJS = Object.entries(HERO_SVGS)
    .map(([k, v]) => `  ${k}: \`${v}\``)
    .join(',\n');

  // Replace the mosaic content between markers
  html = html.replace(
    /(<div class="mosaic" id="mosaic">)([\s\S]*?)(<\/div>\s*<!-- end mosaic -->)/,
    `$1\n${tilesHTML}\n      <div class="empty-state" id="empty-state"></div>\n    $3`
  );

  // Replace HERO_SVGS in the script
  html = html.replace(
    /const HERO_SVGS = \{[\s\S]*?\};/,
    `const HERO_SVGS = {\n${heroSvgsJS}\n};`
  );

  return html;
}

// ── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching posts from Notion...');
  const posts = await fetchPosts();
  console.log(`Found ${posts.length} published post(s)`);

  const html = buildHTML(posts);
  const outputPath = path.join(__dirname, '..', 'index.html');
  fs.writeFileSync(outputPath, html);
  console.log('index.html updated successfully!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
