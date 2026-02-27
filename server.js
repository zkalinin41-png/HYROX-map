const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─────────────────────────────────────────────
//  HTTP helpers
// ─────────────────────────────────────────────
const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

async function get(url, extra = {}) {
  return axios.get(url, {
    headers: { ...BASE_HEADERS, Referer: 'https://hyrox.com/' },
    timeout: 20_000,
    maxRedirects: 5,
    validateStatus: () => true,
    ...extra,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────
//  STEP 1 — Collect event page URLs from sitemap
// ─────────────────────────────────────────────
async function fetchEventUrls() {
  // 1a. Try the dedicated event sitemap
  const candidates = [
    'https://hyrox.com/event-sitemap.xml',
    'https://hyrox.com/sitemap_index.xml',
    'https://hyrox.com/sitemap.xml',
  ];

  let urls = [];

  for (const sitemapUrl of candidates) {
    try {
      console.log(`[SITEMAP] Trying ${sitemapUrl}`);
      const resp = await get(sitemapUrl);
      if (resp.status !== 200 || typeof resp.data !== 'string') continue;

      const $ = cheerio.load(resp.data, { xmlMode: true });

      // sitemap index → find nested sitemap urls that look like event sitemaps
      const isSitemapIndex = $('sitemapindex').length > 0;
      if (isSitemapIndex) {
        const nestedUrls = [];
        $('sitemap loc').each((_, el) => {
          const loc = $(el).text().trim();
          if (/event/i.test(loc)) nestedUrls.push(loc);
        });
        console.log(`[SITEMAP] Index found, event sitemaps: ${nestedUrls.join(', ')}`);

        for (const nestedUrl of nestedUrls) {
          const nested = await get(nestedUrl);
          if (nested.status === 200 && typeof nested.data === 'string') {
            const $n = cheerio.load(nested.data, { xmlMode: true });
            $n('url loc').each((_, el) => {
              const loc = $n(el).text().trim();
              if (loc) urls.push(loc);
            });
          }
        }
      } else {
        // direct sitemap
        $('url loc').each((_, el) => {
          const loc = $(el).text().trim();
          if (loc) urls.push(loc);
        });
      }

      if (urls.length > 0) {
        console.log(`[SITEMAP] Got ${urls.length} URLs from ${sitemapUrl}`);
        break;
      }
    } catch (e) {
      console.log(`[SITEMAP] Error at ${sitemapUrl}: ${e.message}`);
    }
  }

  // Filter: keep only URLs that look like event pages
  const eventUrls = urls.filter((u) =>
    /\/(event|race|rennen|veranstaltung)\//i.test(u)
  );

  console.log(`[SITEMAP] Event URLs found: ${eventUrls.length}`);
  return eventUrls.length > 0 ? eventUrls : urls; // fall back to all if filter is too strict
}

// ─────────────────────────────────────────────
//  STEP 2 — Extract event data from a single page
// ─────────────────────────────────────────────
async function scrapeEventPage(url) {
  try {
    await sleep(200); // be polite
    const resp = await get(url);
    if (resp.status !== 200 || typeof resp.data !== 'string') return null;

    const $ = cheerio.load(resp.data);
    let result = null;

    // ── 2a. Schema.org JSON-LD (most reliable) ──────────────────
    $('script[type="application/ld+json"]').each((_, el) => {
      if (result) return;
      try {
        const raw = $(el).html();
        const json = JSON.parse(raw);

        const isEvent = (obj) =>
          obj && /^(Event|SportsEvent|SocialEvent)$/i.test(obj['@type']);

        let schema = null;
        if (isEvent(json)) schema = json;
        else if (Array.isArray(json)) schema = json.find(isEvent);
        else if (json['@graph']) schema = json['@graph'].find(isEvent);

        if (!schema) return;

        const name = schema.name || '';
        const startDate = schema.startDate || schema.starttime || '';
        const endDate   = schema.endDate || '';

        let locationStr = '';
        let coordinates = null;

        const loc = schema.location;
        if (loc) {
          const parts = [
            loc.name,
            loc.address?.streetAddress,
            loc.address?.addressLocality,
            loc.address?.addressRegion,
            loc.address?.addressCountry,
          ].filter(Boolean);
          locationStr = parts.join(', ');

          // coordinates from geo schema
          const geo = loc.geo;
          if (geo && geo.latitude && geo.longitude) {
            coordinates = [parseFloat(geo.latitude), parseFloat(geo.longitude)];
          }
        }

        if (name) {
          result = {
            title: name,
            date: formatDateRange(startDate, endDate),
            location: locationStr,
            link: url,
            coordinates,
            source: 'json-ld',
          };
        }
      } catch { /* ignore malformed JSON-LD */ }
    });

    if (result) return result;

    // ── 2b. HTML fallback ─────────────────────────────────────
    const title    = $('h1').first().text().trim() || $('title').text().trim();
    const dateEl   = $('time, [class*="date"], [class*="Date"]').first();
    const date     = dateEl.attr('datetime') || dateEl.text().trim();
    const location = $('[class*="location"], [class*="venue"], [class*="city"]')
      .first().text().trim();

    if (title && title.length > 2) {
      return { title, date, location, link: url, coordinates: null, source: 'html-fallback' };
    }

    return null;
  } catch (e) {
    console.log(`[PAGE] Error scraping ${url}: ${e.message}`);
    return null;
  }
}

function formatDateRange(start, end) {
  if (!start) return '';
  try {
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    const s = new Date(start).toLocaleDateString('en-GB', opts);
    if (end && end !== start) {
      const e = new Date(end).toLocaleDateString('en-GB', opts);
      return `${s} – ${e}`;
    }
    return s;
  } catch {
    return start;
  }
}

// ─────────────────────────────────────────────
//  STEP 2b — Scrape "Find My Race" page directly
//            (backup if sitemap returns nothing useful)
// ─────────────────────────────────────────────
async function scrapeFindMyRacePage() {
  const urls = [
    'https://hyrox.com/find-my-race/',
    'https://hyrox.com/find-my-race/?switch_language=en',
  ];

  for (const url of urls) {
    try {
      const resp = await get(url);
      if (resp.status !== 200 || typeof resp.data !== 'string') continue;

      const $ = cheerio.load(resp.data);
      const events = [];

      // Try all common event card selectors
      const selectors = [
        '.event-card', '.race-card', '.race-item', '.race-list-item',
        '[class*="event-card"]', '[class*="race-card"]',
        '.w-grid-item.type-event', 'article[class*="event"]',
        '[data-event]', '[data-race]',
      ];

      for (const sel of selectors) {
        $(sel).each((_, el) => {
          const title    = $(el).find('h2, h3, h4, .title, [class*="title"]').first().text().trim();
          const dateEl   = $(el).find('time, [class*="date"], [class*="Date"]').first();
          const date     = dateEl.attr('datetime') || dateEl.text().trim();
          const location = $(el).find('[class*="location"], [class*="city"], [class*="venue"]').first().text().trim();
          const link     = $(el).find('a[href]').first().attr('href');

          if (title && title.length > 2) {
            events.push({
              title,
              date,
              location,
              link: link ? (link.startsWith('http') ? link : `https://hyrox.com${link}`) : url,
              coordinates: null,
            });
          }
        });
        if (events.length > 0) break;
      }

      // Also look for JSON-LD on the page
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          const list = Array.isArray(json) ? json : [json];
          list.forEach((item) => {
            if (/Event/i.test(item['@type']) && item.name) {
              events.push({
                title: item.name,
                date: formatDateRange(item.startDate, item.endDate),
                location: [
                  item.location?.name,
                  item.location?.address?.addressLocality,
                  item.location?.address?.addressCountry,
                ].filter(Boolean).join(', '),
                link: item.url || url,
                coordinates: item.location?.geo
                  ? [parseFloat(item.location.geo.latitude), parseFloat(item.location.geo.longitude)]
                  : null,
              });
            }
          });
        } catch { }
      });

      if (events.length > 0) {
        console.log(`[FMR] Found ${events.length} events via HTML scraping`);
        return events;
      }
    } catch (e) {
      console.log(`[FMR] Error: ${e.message}`);
    }
  }

  return [];
}

// ─────────────────────────────────────────────
//  CITY EXTRACTION — pull city name for geocoding
// ─────────────────────────────────────────────

/**
 * Extract a geocodable city string from an event.
 * Priority:
 *   1. event.location (already set from schema.org)
 *   2. URL slug  e.g. /event/hyrox-cape-town-2526/ → "cape town"
 *   3. Title before "| HYROX"  e.g. "BYD HYROX Brisbane | HYROX" → "Brisbane"
 */
function cityFromEvent(event) {
  if (event.location && event.location.trim()) return event.location.trim();

  // From URL slug
  if (event.link) {
    const m = event.link.match(/\/event\/([^/?#]+)/);
    if (m) {
      const city = cityFromSlug(m[1]);
      if (city) return city;
    }
  }

  // From title: "PUMA HYROX World Championships Stockholm | HYROX" → "Stockholm"
  // Sponsor is always before HYROX, city is always after → split on HYROX, take last segment
  const m = event.title.match(/^(.+?)\s*\|\s*hyrox\s*$/i);
  if (m) {
    const parts = m[1].split(/hyrox/i);
    const afterHyrox = parts[parts.length - 1]
      .replace(/\d{2}\/\d{2}/, '')   // strip season "25/26" (purely numeric)
      .replace(/\s*-\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (afterHyrox) return afterHyrox;
  }

  return event.title;
}

function cityFromSlug(slug) {
  let s = slug.toLowerCase();

  // Find 'hyrox' and take everything after it
  const hIdx = s.indexOf('hyrox');
  if (hIdx !== -1) {
    s = s.slice(hIdx + 5).replace(/^-/, ''); // skip past 'hyrox-'
  }

  // Strip known non-city qualifiers (order matters — longer first)
  const qualifiers = [
    'emea-regional-championships', 'emea-championships',
    'apac-championships', 'world-championships',
    'regional-championships', 'championships',
    'youngstars', 'grand-palais',
  ];
  for (const q of qualifiers) {
    if (s.startsWith(q)) {
      s = s.slice(q.length).replace(/^-/, '');
      break;
    }
  }

  // Strip trailing season/date: -25-26, -2026, -20260411, 2026 (no dash)
  s = s
    .replace(/-\d{2}-\d{2}$/, '')   // -25-26
    .replace(/-?\d{4,8}$/, '')       // -2026, 20260411
    .replace(/-\d{1,4}$/, '')        // -25, -26 (season year/short)
    .replace(/-$/, '');              // trailing dash

  // Convert hyphens to spaces
  return s.replace(/-/g, ' ').trim();
}

// ─────────────────────────────────────────────
//  GEOCODING — Nominatim with cache + rate limit
// ─────────────────────────────────────────────
const geocodeCache = new Map();
let lastGeoAt = 0;

async function geocode(text) {
  const q = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return null;
  if (geocodeCache.has(q)) return geocodeCache.get(q);

  const now = Date.now();
  const wait = 1100 - (now - lastGeoAt);
  if (wait > 0) await sleep(wait);
  lastGeoAt = Date.now();

  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 1 },
      headers: {
        'User-Agent': 'hyrox-map-app (learning project)',
        'Accept-Language': 'en',
      },
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (resp.status === 429) { geocodeCache.set(q, null); return null; }

    const coords =
      Array.isArray(resp.data) && resp.data.length > 0
        ? [parseFloat(resp.data[0].lat), parseFloat(resp.data[0].lon)]
        : null;

    geocodeCache.set(q, coords);
    return coords;
  } catch {
    geocodeCache.set(q, null);
    return null;
  }
}

// Drop words from the front one by one until Nominatim finds a city
async function geocodeProgressive(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const candidate = words.slice(i).join(' ');
    const coords = await geocode(candidate);
    if (coords) return coords;
  }
  return null;
}

// ─────────────────────────────────────────────
//  CONTINENT DETECTION — from lat/lng
// ─────────────────────────────────────────────
function detectContinent(coords) {
  if (!coords) return null;
  const [lat, lng] = coords;

  if (lat > 35 && lat < 72 && lng > -25 && lng < 45)   return 'europe';
  if (lat > 15 && lat < 72 && lng > -170 && lng < -50)  return 'americas';
  if (lat > -60 && lat < 15 && lng > -82  && lng < -34)  return 'americas';  // South America
  if (lat > 15 && lat < 42 && lng > 25   && lng < 65)   return 'middle east';
  if (lat > -10 && lat < 55 && lng > 60  && lng < 150)  return 'asia-pacific';
  if (lat > -50 && lat < -10 && lng > 110 && lng < 180) return 'asia-pacific'; // AU/NZ
  if (lat > -35 && lat < 38 && lng > -20 && lng < 55)   return 'africa';

  return 'other';
}

// ─────────────────────────────────────────────
//  MAIN PIPELINE
// ─────────────────────────────────────────────
let cachedEvents = null;
let cacheTime    = 0;
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour

async function loadEvents(force = false) {
  if (!force && cachedEvents && Date.now() - cacheTime < CACHE_TTL) {
    return cachedEvents;
  }

  console.log('\n[PIPELINE] Starting event scrape...');
  let events = [];

  // ── Phase 1: try sitemap → scrape individual event pages ──
  try {
    const eventUrls = await fetchEventUrls();

    if (eventUrls.length > 0) {
      console.log(`[PIPELINE] Scraping ${eventUrls.length} event pages (batch of 5)...`);

      for (let i = 0; i < eventUrls.length; i += 5) {
        const batch = eventUrls.slice(i, i + 5);
        const results = await Promise.all(batch.map(scrapeEventPage));
        results.forEach((r) => r && events.push(r));
        if (i + 5 < eventUrls.length) await sleep(500);
      }

      // deduplicate
      events = dedup(events);
      console.log(`[PIPELINE] Phase 1: ${events.length} events from sitemap`);
    }
  } catch (e) {
    console.error('[PIPELINE] Phase 1 error:', e.message);
  }

  // ── Phase 2: fallback — scrape Find My Race page ──
  if (events.length === 0) {
    console.log('[PIPELINE] Phase 2: scraping /find-my-race/ ...');
    try {
      events = await scrapeFindMyRacePage();
      events = dedup(events);
      console.log(`[PIPELINE] Phase 2: ${events.length} events`);
    } catch (e) {
      console.error('[PIPELINE] Phase 2 error:', e.message);
    }
  }

  // ── Phase 3: geocode events that lack coordinates ──
  const needGeo = events.filter((e) => !e.coordinates);
  if (needGeo.length > 0) {
    console.log(`[PIPELINE] Geocoding ${needGeo.length} events...`);
    for (const event of needGeo) {
      event.coordinates = await geocodeProgressive(cityFromEvent(event));
    }
  }

  // ── Phase 4: assign continent from coordinates ──
  for (const event of events) {
    event.continent = detectContinent(event.coordinates);
  }

  const withCoords = events.filter((e) => e.coordinates).length;
  console.log(`[PIPELINE] Done. ${events.length} events, ${withCoords} with coordinates.\n`);

  cachedEvents = events;
  cacheTime    = Date.now();
  return events;
}

function dedup(events) {
  const seen = new Map();
  for (const e of events) {
    const key = `${e.title}__${e.date}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return Array.from(seen.values());
}

// ─────────────────────────────────────────────
//  API
// ─────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const events = await loadEvents();
    res.json(events);
  } catch (e) {
    console.error('[API] Error:', e.message);
    res.status(500).json({ error: 'Failed to load events', message: e.message });
  }
});

// Force-refresh endpoint (useful for dev)
app.post('/api/events/refresh', async (_req, res) => {
  try {
    const events = await loadEvents(true);
    res.json({ refreshed: true, count: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n  HYROX Map Server`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api/events\n`);

  // Pre-fetch events in background so first API call is fast
  loadEvents().catch((e) => console.error('[PREFETCH] Error:', e.message));
});
