'use strict';

/* ---------- Settings ---------- */

const SEARCH_RADII_M = [2500, 10000, 40000]; // widen until something turns up
const RESEARCH_AFTER_M = 250;                // look again after walking this far
const RESEARCH_COOLDOWN_MS = 30000;          // ...but never more often than this
const ARRIVED_WITHIN_M = 25;
const OVERPASS_TIMEOUT_MS = 40000;
const RETRY_AFTER_MS = 45000;
const QUICK_TERMS = ['chicken', 'kfc', 'hähnchen', 'frango', 'pollo'];
const CACHE_KEY = 'frango-target-v1';
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// A place counts as a chicken restaurant when chicken is the first cuisine it
// lists, or when its name says so.
const CUISINE_RE = /chicken|wings|frango|pollo/i;
const NAME_ANYWHERE_RE = /chicken|frango|h(ä|ae)hnchen|hendl|g(ü|ue)ggeli|wienerwald|popeyes|wingstop|chick-fil-a|bojangles|bonchon|kyochon|zaxby|kentucky fried/i;
const NAME_WORD_RE = /(^|[^\p{L}])(pollos?|poulets?|kfc|nando'?s|raising cane'?s)($|[^\p{L}])/iu;
// Looser server-side filter; the client re-checks with the rules above.
const SERVER_NAME_RE = 'chicken|frango|pollo|hähnchen|haehnchen|hendl|poulet|güggeli|gueggeli|wienerwald|popeyes|wingstop|chick-fil-a|bojangles|bonchon|kyochon|zaxby|kentucky fried|kfc|nando|raising cane';

/* ---------- State ---------- */

const arrowEl = document.getElementById('arrow');
const statusEl = document.getElementById('status');

let position = null;       // { lat, lon }
let target = null;         // { lat, lon }
let searchOrigin = null;   // where the last search was made from
let searching = false;
let lastSearchAt = 0;
let failures = 0;
let searchFailed = false;
let heading = null;        // degrees clockwise from north, null until a compass reading
let gotAbsolute = false;
let started = false;
let shownAngle = 0;        // what the arrow is currently drawn at (unbounded)
let lastFrame = 0;
let wakeLock = null;

/* ---------- Geometry ---------- */

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function bearingDeg(from, to) {
  const dLon = rad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
    Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/* ---------- UI ---------- */

function setState(state, message) {
  document.body.dataset.state = state;
  statusEl.textContent = message || '';
}

function refresh() {
  if (!started) return setState('idle', 'Tap to start');
  if (!position) return; // keep whatever the location step last said
  if (!target) {
    if (searching) return setState('searching', 'Sniffing out chicken…');
    if (searchFailed) return setState('error', 'Search failed · tap to retry');
    return setState('empty', 'No chicken nearby');
  }
  if (distanceM(position, target) <= ARRIVED_WITHIN_M) return setState('arrived', '');
  setState('ready', heading === null ? 'No compass · top is north' : '');
}

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (document.body.dataset.state === 'ready') {
    const goal = bearingDeg(position, target) - (heading || 0);
    // Turn the short way round, easing in.
    const diff = ((goal - shownAngle) % 360 + 540) % 360 - 180;
    shownAngle += diff * Math.min(1, dt * 10);
  } else {
    shownAngle += dt * 60; // idle spin while there is nowhere to point
  }

  arrowEl.style.transform = `rotate(${shownAngle.toFixed(2)}deg)`;
  requestAnimationFrame(frame);
}

/* ---------- Compass ---------- */

function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

function onOrientation(e) {
  let h = null;

  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading; // iOS
  } else if (e.alpha !== null && (e.absolute || e.type === 'deviceorientationabsolute')) {
    gotAbsolute = true;
    // Where the phone "faces": the top edge when it lies flat, the back when
    // it is held upright. Adding both stays stable at every tilt in between.
    const z = rad(e.alpha), x = rad(e.beta || 0), y = rad(e.gamma || 0);
    const cX = Math.cos(x), sX = Math.sin(x);
    const cY = Math.cos(y), sY = Math.sin(y);
    const cZ = Math.cos(z), sZ = Math.sin(z);
    const east = -cX * sZ + (-cZ * sY - sZ * sX * cY);
    const north = cX * cZ + (-sZ * sY + cZ * sX * cY);
    if (Math.hypot(east, north) > 0.05) h = deg(Math.atan2(east, north));
  } else if (gotAbsolute) {
    return; // ignore the relative stream once the absolute one is flowing
  }

  if (h === null) return;
  const first = heading === null;
  heading = (h + screenAngle() + 360) % 360;
  if (first) refresh();
}

async function startCompass() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return;
  if (typeof DOE.requestPermission === 'function') {
    try {
      if ((await DOE.requestPermission()) !== 'granted') return;
    } catch {
      return;
    }
  }
  window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
}

/* ---------- Finding chicken ---------- */

function isChickenPlace(tags = {}) {
  const firstCuisine = (tags.cuisine || '').split(';')[0];
  if (CUISINE_RE.test(firstCuisine)) return true;
  const names = [tags.name, tags.brand, tags['name:en']].filter(Boolean).join(' | ');
  return NAME_ANYWHERE_RE.test(names) || NAME_WORD_RE.test(names);
}

// Public Overpass servers vary a lot in speed, so ask them all and take the
// first good answer.
async function overpass(query) {
  const controllers = [];
  const attempts = OVERPASS_ENDPOINTS.map((url) => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
    return fetch(url, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        // A server that ran out of time still answers 200, with a remark.
        if (data.remark && !(data.elements || []).length) throw new Error(data.remark);
        return data;
      })
      .finally(() => clearTimeout(timer));
  });
  try {
    return await Promise.any(attempts);
  } finally {
    controllers.forEach((c) => c.abort());
  }
}

// A quick, rougher answer from the Photon geocoder (name matches only), so
// the arrow has something to point at while the thorough search runs.
async function quickGuess(from) {
  const base = 'https://photon.komoot.io/api/?limit=15&zoom=14&location_bias_scale=0.1' +
    '&osm_tag=amenity:fast_food&osm_tag=amenity:restaurant' +
    `&lat=${from.lat.toFixed(5)}&lon=${from.lon.toFixed(5)}&q=`;
  const answers = await Promise.allSettled(QUICK_TERMS.map(async (term) => {
    const res = await fetch(base + encodeURIComponent(term));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return (await res.json()).features || [];
  }));

  const maxD = SEARCH_RADII_M[SEARCH_RADII_M.length - 1];
  let best = null;
  for (const answer of answers) {
    for (const f of answer.value || []) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (lat == null || !isChickenPlace({ name: f.properties?.name })) continue;
      const d = distanceM(from, { lat, lon });
      if (d <= maxD && (!best || d < best.d)) best = { lat, lon, d };
    }
  }
  return best && { lat: best.lat, lon: best.lon };
}

async function findNearest(from) {
  for (const radius of SEARCH_RADII_M) {
    const around = `(around:${radius},${from.lat.toFixed(5)},${from.lon.toFixed(5)})`;
    const kind = '["amenity"~"^(restaurant|fast_food)$"]';
    const data = await overpass(
      `[out:json][timeout:18];(` +
      `nwr${kind}["cuisine"~"chicken|wings|frango|pollo",i]${around};` +
      `nwr${kind}["name"~"${SERVER_NAME_RE}",i]${around};` +
      `);out center tags;`
    );

    let best = null;
    for (const el of data.elements || []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null || !isChickenPlace(el.tags)) continue;
      const d = distanceM(from, { lat, lon });
      if (!best || d < best.d) best = { lat, lon, d };
    }
    if (best) return { lat: best.lat, lon: best.lon };
  }
  return null;
}

function readCache(from) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c && Date.now() - c.at < CACHE_MAX_AGE_MS && distanceM(from, c.origin) < RESEARCH_AFTER_M) return c;
  } catch {}
  return null;
}

function writeCache(origin, found) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), origin, target: found }));
  } catch {}
}

async function search() {
  if (searching || !position) return;
  const from = position;

  const cached = readCache(from);
  if (cached) {
    target = cached.target;
    searchOrigin = cached.origin;
    searchFailed = false;
    lastSearchAt = Date.now();
    return refresh();
  }

  searching = true;
  searchFailed = false;
  lastSearchAt = Date.now();
  refresh();

  let guess = null;
  quickGuess(from)
    .then((g) => {
      guess = g;
      if (g && searching && !target) {
        target = g;
        refresh();
      }
    })
    .catch(() => {});

  try {
    const found = await findNearest(from);
    if (found) {
      target = found;
      writeCache(from, found);
    } else if (target !== guess) {
      target = null; // nothing here any more; a quick guess may stand
    }
    failures = 0;
  } catch {
    searchFailed = true; // keep pointing at whatever we had
    // The public servers have slow spells: try again shortly, a few times.
    if (++failures <= 3) setTimeout(() => { if (searchFailed) search(); }, RETRY_AFTER_MS);
  } finally {
    searchOrigin = from;
    searching = false;
    refresh();
  }
}

/* ---------- Location ---------- */

function onPosition(lat, lon) {
  position = { lat, lon };
  const moved = searchOrigin && distanceM(position, searchOrigin) > RESEARCH_AFTER_M;
  const cooledDown = Date.now() - lastSearchAt > RESEARCH_COOLDOWN_MS;
  if (!lastSearchAt || (moved && cooledDown)) search();
  refresh();
}

function startLocation() {
  // ?lat=..&lon=.. stands in for GPS, for trying the app on a desktop.
  const params = new URLSearchParams(location.search);
  if (params.has('lat') && params.has('lon')) {
    return onPosition(parseFloat(params.get('lat')), parseFloat(params.get('lon')));
  }

  if (!navigator.geolocation) return setState('error', 'No location on this device');
  setState('locating', 'Finding you…');
  navigator.geolocation.watchPosition(
    (p) => onPosition(p.coords.latitude, p.coords.longitude),
    (err) => {
      if (position) return; // a later hiccup; keep going with the last fix
      setState('error', err.code === err.PERMISSION_DENIED ? 'Location access needed' : 'Can’t find you · tap to retry');
      started = false;
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

/* ---------- Start-up ---------- */

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}
}

async function start() {
  if (started) {
    // A tap on a running app retries a failed or empty search.
    if (position && !target && !searching) {
      searchOrigin = null;
      failures = 0;
      search();
    }
    return;
  }
  started = true;
  await startCompass(); // must come first: iOS only grants this inside the tap
  startLocation();
  keepAwake();
}

document.addEventListener('click', start);
document.addEventListener('visibilitychange', () => {
  if (started && document.visibilityState === 'visible') keepAwake();
});

// iOS needs a tap before it hands out compass readings; everywhere else the
// app can start by itself.
const needsTap = window.DeviceOrientationEvent &&
  typeof window.DeviceOrientationEvent.requestPermission === 'function';
if (needsTap) refresh();
else start();

requestAnimationFrame((t) => {
  lastFrame = t;
  requestAnimationFrame(frame);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
