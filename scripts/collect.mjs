/**
 * collect.mjs — pulls meeting data from AA SA, NA SA, and CA SA public sites,
 * normalises it into public/data/meetings.json.
 *
 * Sources:
 *  - AA:  TSML plugin JSON cache, filename discovered from the meetings page HTML
 *  - NA:  same TSML plugin on 4 regional WP sub-sites (wc, jhb, kzn, pta)
 *  - CA:  static Elementor accordion pages, parsed with cheerio; coordinates
 *         resolved from Google Maps links (redirect) with Nominatim fallback,
 *         cached in scripts/geocache.json so geocoding is effectively one-time
 *
 * Run: node scripts/collect.mjs
 * Exit code 1 on any hard failure (count below tolerance, source unreachable)
 * so the GitHub Action fails loudly and keeps the last committed data.
 */

import { load } from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'meetings.json');
const GEOCACHE_PATH = join(__dirname, 'geocache.json');
const STATE_PATH = join(__dirname, 'state.json');

// Browser-like headers: aasouthafrica.org.za sits behind Cloudflare and 403s
// bare fetches.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-ZA,en;q=0.9',
};

const MIN_COUNTS = { AA: 300, NA: 200, CA: 25 };

const TYPE_LABELS = {
  O: 'Open', C: 'Closed', W: 'Women', M: 'Men', B: 'Big Book', BB: 'Big Book',
  ST: 'Step', S: 'Step', SP: 'Speaker', D: 'Discussion', LIT: 'Literature',
  Y: 'Young People', X: 'Wheelchair Access', T: 'Tradition', MED: 'Meditation',
  AF: 'Afrikaans', EN: 'English',
};

// TSML uses 0=Sunday..6=Saturday; we keep that convention.
const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, opts = {}) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow', ...opts });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res;
}

function loadJsonFile(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

const state = loadJsonFile(STATE_PATH, { tsmlCache: {} });
const geocache = loadJsonFile(GEOCACHE_PATH, {});

/* ---------------- TSML (AA + NA) ---------------- */

async function discoverTsmlCache(pageUrl, baseUrl, stateKey) {
  try {
    const html = await (await get(pageUrl)).text();
    const m = html.match(/tsml-cache-[a-z0-9]+\.json/);
    if (m) {
      const url = `${baseUrl}/wp-content/${m[0]}`;
      state.tsmlCache[stateKey] = url;
      return url;
    }
    throw new Error(`no tsml-cache filename in ${pageUrl}`);
  } catch (err) {
    // Cloudflare may block the HTML page; the last known cache URL usually
    // still serves (filename only rotates when the source data changes).
    const last = state.tsmlCache[stateKey];
    if (last) {
      console.warn(`  discovery failed (${err.message}); trying last known cache URL`);
      return last;
    }
    throw err;
  }
}

function normaliseTsml(raw, fellowship, idPrefix) {
  return raw
    .filter((m) => m.latitude && m.longitude)
    .filter((m) => (m.attendance_option ?? 'in_person') !== 'online')
    .map((m) => ({
      id: `${idPrefix}-${m.id}`,
      fellowship,
      name: (m.name ?? '').trim(),
      day: typeof m.day === 'string' ? parseInt(m.day, 10) : m.day,
      time: m.time || null,
      endTime: m.end_time || null,
      address: m.formatted_address ?? '',
      region: m.region ?? '',
      lat: Number(m.latitude),
      lng: Number(m.longitude),
      types: (m.types ?? []).map((t) => TYPE_LABELS[t] ?? t),
      notes: m.notes || null,
      online: false,
      conferenceUrl: m.conference_url || null,
      sourceUrl: m.url ?? null,
    }))
    .filter((m) => Number.isInteger(m.day) && m.day >= 0 && m.day <= 6 && m.time);
}

async function collectAA() {
  console.log('AA: discovering TSML cache…');
  const cacheUrl = await discoverTsmlCache(
    'https://aasouthafrica.org.za/meetings-list/',
    'https://aasouthafrica.org.za',
    'aa'
  );
  const raw = await (await get(cacheUrl)).json();
  const meetings = normaliseTsml(raw, 'AA', 'aa');
  console.log(`AA: ${raw.length} raw, ${meetings.length} in-person with coords`);
  return meetings;
}

const NA_REGIONS = [
  { key: 'wc', page: 'https://na.org.za/wc/in-person-meetings/' },
  { key: 'jhb', page: 'https://na.org.za/jhb/na-meetings/' },
  { key: 'kzn', page: 'https://na.org.za/kzn/meetings/' },
  { key: 'pta', page: 'https://na.org.za/pta/na-meetings/' },
];

async function collectNA() {
  const all = [];
  for (const { key, page } of NA_REGIONS) {
    console.log(`NA/${key}: discovering TSML cache…`);
    const cacheUrl = await discoverTsmlCache(page, `https://na.org.za/${key}`, `na-${key}`);
    const raw = await (await get(cacheUrl)).json();
    const meetings = normaliseTsml(raw, 'NA', `na-${key}`);
    console.log(`NA/${key}: ${raw.length} raw, ${meetings.length} in-person with coords`);
    all.push(...meetings);
  }
  return all;
}

/* ---------------- CA (static HTML + geocoding) ---------------- */

const CA_PAGES = [
  { url: 'https://ca.org.za/casa/meetings-westerncape/', region: 'Western Cape' },
  { url: 'https://ca.org.za/casa/meetings-johannesburg/', region: 'Johannesburg' },
  { url: 'https://ca.org.za/casa/meetings-pretoria/', region: 'Pretoria' },
  { url: 'https://ca.org.za/casa/meetings-greater-sa/', region: 'Greater SA' },
];

function parseCaPage(html, region, pageUrl) {
  const $ = load(html);
  const meetings = [];

  $('.elementor-tab-content').each((_, panel) => {
    const $panel = $(panel);
    // Day name lives in the sibling toggle title within the same accordion item.
    const title = $panel
      .closest('.elementor-toggle-item, .elementor-accordion-item')
      .find('.elementor-toggle-title, .elementor-tab-title')
      .first()
      .text()
      .trim()
      .toLowerCase();
    const day = DAY_INDEX[title];
    if (day === undefined) return;

    $panel.find('p').each((_, p) => {
      const $p = $(p);
      const mapsHref = $p.find('a[href*="goo.gl"], a[href*="maps.app"], a[href*="google.com/maps"]').attr('href') ?? null;
      // Split the paragraph on <br> boundaries.
      const lines = $p
        .html()
        .split(/<br\s*\/?>/i)
        .map((frag) => load(`<x>${frag}</x>`)('x').text().trim())
        .filter(Boolean)
        .filter((l) => !/^maps? link$/i.test(l));
      if (lines.length < 3) return;

      const timeIdx = lines.findIndex((l) => /\d{1,2}[:h]\d{2}/.test(l));
      if (timeIdx === -1) return;
      const timeMatch = lines[timeIdx].match(/(\d{1,2})[:h](\d{2})\s*(?:[–—-]\s*(\d{1,2})[:h](\d{2}))?/);
      const pad = (n) => String(n).padStart(2, '0');

      const name = lines.slice(0, timeIdx).join(' ').trim();
      const addressLines = lines.slice(timeIdx + 1);
      if (!name || addressLines.length === 0) return;

      meetings.push({
        fellowship: 'CA',
        name,
        day,
        time: `${pad(timeMatch[1])}:${timeMatch[2]}`,
        endTime: timeMatch[3] ? `${pad(timeMatch[3])}:${timeMatch[4]}` : null,
        address: `${addressLines.join(', ')}, South Africa`,
        region,
        mapsUrl: mapsHref,
        types: [],
        notes: null,
        online: false,
        conferenceUrl: null,
        sourceUrl: pageUrl,
      });
    });
  });

  return meetings;
}

/** Extract coordinates from an expanded Google Maps URL. */
function coordsFromMapsUrl(url) {
  // Prefer the place pin (!3d…!4d…) over the viewport (@lat,lng).
  let m = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  m = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  return null;
}

async function resolveMapsLink(shortUrl) {
  let url = shortUrl;
  for (let hop = 0; hop < 5; hop++) {
    // Deliberately NOT a browser UA: maps.app.goo.gl serves a JS app shell
    // (no Location header, no coords) to browsers, but a plain 302 to
    // simple clients.
    const res = await fetch(url, { headers: { 'User-Agent': 'curl/8.6.0' }, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (!loc) break;
    // Google consent interstitial keeps the real target in ?continue=
    const consent = loc.match(/[?&]continue=([^&]+)/);
    url = consent ? decodeURIComponent(consent[1]) : loc;
    const coords = coordsFromMapsUrl(url);
    if (coords) return coords;
  }
  return coordsFromMapsUrl(url);
}

async function nominatimQuery(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=za&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'meeting-finder-007/0.1 (recovery meeting finder, contact: deej@deejburke.co.za)' },
  });
  await sleep(1100); // Nominatim usage policy: max 1 req/sec
  if (!res.ok) return null;
  const results = await res.json();
  if (!results.length) return null;
  return { lat: Number(results[0].lat), lng: Number(results[0].lon) };
}

async function geocodeNominatim(address) {
  // Ladder: full address, then progressively coarser (drop venue/street
  // segments). A suburb-level pin beats no pin — navigation uses the
  // Directions link, which carries the full address text.
  const segments = address.split(',').map((s) => s.trim()).filter(Boolean);
  const variants = [address];
  for (let drop = 1; drop <= segments.length - 2; drop++) {
    variants.push(segments.slice(drop).join(', '));
  }
  for (const q of variants) {
    const coords = await nominatimQuery(q);
    if (coords) return coords;
  }
  return null;
}

async function collectCA() {
  const all = [];
  for (const { url, region } of CA_PAGES) {
    console.log(`CA/${region}: fetching…`);
    const html = await (await get(url)).text();
    const meetings = parseCaPage(html, region, url);
    console.log(`CA/${region}: ${meetings.length} meetings parsed`);
    all.push(...meetings);
  }

  // Resolve coordinates, cache-first.
  let idx = 0;
  for (const m of all) {
    m.id = `ca-${idx++}`;
    const cacheKey = m.mapsUrl || m.address;
    if (geocache[cacheKey]) {
      Object.assign(m, geocache[cacheKey]);
    } else {
      let coords = null;
      if (m.mapsUrl) {
        try {
          coords = await resolveMapsLink(m.mapsUrl);
        } catch {
          coords = null;
        }
      }
      if (!coords) coords = await geocodeNominatim(m.address);
      if (coords) {
        geocache[cacheKey] = coords;
        Object.assign(m, coords);
        console.log(`  geocoded: ${m.name} -> ${coords.lat},${coords.lng}`);
      } else {
        console.warn(`  NO COORDS: ${m.name} | ${m.address}`);
      }
    }
    delete m.mapsUrl;
  }

  return all.filter((m) => m.lat && m.lng);
}

/* ---------------- main ---------------- */

const errors = [];
const results = { AA: [], NA: [], CA: [] };

for (const [key, fn] of [['AA', collectAA], ['NA', collectNA], ['CA', collectCA]]) {
  try {
    results[key] = await fn();
    if (results[key].length < MIN_COUNTS[key]) {
      errors.push(`${key}: only ${results[key].length} meetings (expected >= ${MIN_COUNTS[key]})`);
    }
  } catch (err) {
    errors.push(`${key}: ${err.message}`);
  }
}

if (errors.length) {
  console.error('\nCOLLECTION FAILED:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  console.error('Existing meetings.json left untouched.');
  process.exit(1);
}

const meetings = [...results.AA, ...results.NA, ...results.CA];
const out = {
  updated: new Date().toISOString(),
  counts: { AA: results.AA.length, NA: results.NA.length, CA: results.CA.length, total: meetings.length },
  meetings,
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
writeFileSync(GEOCACHE_PATH, JSON.stringify(geocache, null, 1));
writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
console.log(`\nWrote ${meetings.length} meetings (AA ${results.AA.length}, NA ${results.NA.length}, CA ${results.CA.length}) to public/data/meetings.json`);
