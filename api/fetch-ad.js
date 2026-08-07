const https = require('https');
const http = require('http');
const { URL } = require('url');

// ── Helpers ────────────────────────────────────────────────────────────────

function fetchUrl(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Te veel redirects'));

    let parsed;
    try { parsed = new URL(rawUrl); }
    catch (e) { return reject(new Error('Ongeldige URL')); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 18000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;' +
          'q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity', // geen gzip om Buffer-gedoe te vermijden
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
    };

    const req = lib.request(options, (res) => {
      // Volg redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers['location'];
        if (!loc) return reject(new Error('Redirect zonder Location header'));
        const next = loc.startsWith('http') ? loc : `${parsed.origin}${loc}`;
        return resolve(fetchUrl(next, redirects + 1));
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Proxy een afbeelding door (voor Marktplaats / CORS-beschermde CDN's)
async function proxyImage(imgUrl, res) {
  let parsed;
  try { parsed = new URL(imgUrl); }
  catch { res.status(400).json({ error: 'Ongeldige afbeeldings-URL' }); return; }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    timeout: 12000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'nl-NL,nl;q=0.9',
      'Referer': 'https://www.marktplaats.nl/',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    },
  };

  return new Promise((resolve) => {
    const req = lib.request(options, (imgRes) => {
      if ([301, 302, 303, 307, 308].includes(imgRes.statusCode)) {
        const loc = imgRes.headers['location'];
        if (loc) {
          const next = loc.startsWith('http') ? loc : `${parsed.origin}${loc}`;
          return resolve(proxyImage(next, res));
        }
      }

      const ct = imgRes.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      imgRes.pipe(res);
      imgRes.on('end', resolve);
    });

    req.on('timeout', () => { req.destroy(); res.status(504).end(); resolve(); });
    req.on('error', () => { res.status(502).end(); resolve(); });
    req.end();
  });
}

// ── Afbeeldingen extraheren uit HTML ───────────────────────────────────────

function extractImages(html, platform) {
  const seen = new Set();
  const images = [];

  const skip =
    /(logo|dealer|avatar|icon|placeholder|banner|sprite|pixel|tracking|favicon|hzcdn\.com\/simages)/i;

  function add(img) {
    if (!img || skip.test(img)) return;
    img = img
      .replace(/\\u002F/gi, '/')
      .replace(/\\u003A/gi, ':')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/&amp;/g, '&')
      .trim();

    if (!img.startsWith('http')) return;

    // Marktplaats: strip lage-resolutie regels, vraag grote versie op
    if (platform === 'marktplaats') {
      img = img
        .replace(/\?.*$/, '')          // verwijder alle query params
        .replace(/\/\d+\//, '/1200/'); // probeer grote versie
    }

    if (seen.has(img)) return;
    seen.add(img);
    images.push(img);
  }

  if (platform === 'autoscout') {
    // AutoScout24 laadt foto's via Next.js JSON blob
    const nextData = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextData) {
      try {
        const json = JSON.parse(nextData[1]);
        const str = JSON.stringify(json);
        const matches = str.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]*(?:jpg|jpeg|png|webp)[^"]*)"/gi);
        for (const m of matches) add(m[1]);
        // AutoScout gebruikt ook "previewImageUrl" / "imageUrl"
        const m2 = str.matchAll(/"(?:imageUrl|previewImageUrl|vehicleImageUrl)"\s*:\s*"(https?:\/\/[^"]+)"/gi);
        for (const m of m2) add(m[1]);
      } catch (_) {}
    }
  }

  if (platform === 'marktplaats') {
    // Marktplaats: afbeeldingen staan in __REDUX_STATE__ of window.__config__
    const reduxMatch = html.match(/window\.__REDUX_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/i)
      || html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/i);
    if (reduxMatch) {
      try {
        const json = JSON.parse(reduxMatch[1]);
        const str = JSON.stringify(json);
        const matches = str.matchAll(/"(?:extraExtraLargeUrl|extraLargeUrl|largeUrl|imageUrl)"\s*:\s*"(https?:\/\/[^"]+)"/gi);
        for (const m of matches) add(m[1]);
      } catch (_) {}
    }
    // Fallback: zoek ook in JSON-LD
    const jsonLd = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of jsonLd) {
      try {
        const str = block.replace(/<\/?script[^>]*>/gi, '');
        const json = JSON.parse(str);
        const images2 = [].concat(json.image || json.photo || []);
        images2.forEach((u) => typeof u === 'string' && add(u));
      } catch (_) {}
    }
  }

  // Universele fallback-patronen
  const patterns = [
    /"extraExtraLargeUrl"\s*:\s*"([^"]+)"/gi,
    /"extraLargeUrl"\s*:\s*"([^"]+)"/gi,
    /"largeUrl"\s*:\s*"([^"]+)"/gi,
    /"imageUrl"\s*:\s*"([^"]+)"/gi,
    /"fullImageUrl"\s*:\s*"([^"]+)"/gi,
    /"hdUrl"\s*:\s*"([^"]+)"/gi,
    /"srcUrl"\s*:\s*"([^"]+)"/gi,
    /"bigUrl"\s*:\s*"([^"]+)"/gi,
    /property="og:image"\s+content="([^"]+)"/gi,
    /content="([^"]+)"\s+property="og:image"/gi,
    /<meta[^>]+name="twitter:image[^"]*"[^>]+content="([^"]+)"/gi,
  ];

  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags);
    let m;
    while ((m = re.exec(html)) !== null) add(m[1]);
  }

  return images.slice(0, 16);
}

// ── Extra data uit AutoScout24 __NEXT_DATA__ ───────────────────────────────

function parseNextData(html) {
  const match = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
}

function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  for (const val of Object.values(obj)) {
    const found = deepFind(val, keys);
    if (found !== null) return found;
  }
  return null;
}

// ── Hoofd handler ──────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, img } = req.query;

  // ── Afbeelding proxy ──
  if (img) {
    return proxyImage(decodeURIComponent(img), res);
  }

  // ── Advertentie ophalen ──
  if (!url) return res.status(400).json({ error: 'url parameter ontbreekt' });

  const decoded = decodeURIComponent(url);

  let platform = 'unknown';
  if (decoded.includes('mobile.de')) platform = 'mobile';
  else if (decoded.includes('autoscout24')) platform = 'autoscout';
  else if (decoded.includes('marktplaats.nl')) platform = 'marktplaats';
  else if (decoded.includes('autotrack.nl')) platform = 'autotrack';
  else if (decoded.includes('bas-world')) platform = 'bas';

  try {
    const html = await fetchUrl(decoded);

    // Extraheer afbeeldingen server-side (betrouwbaarder)
    const images = extractImages(html, platform);

    // Stuur voor AutoScout ook de __NEXT_DATA__ mee zodat de frontend
    // meer data kan parsen
    const nextData = platform === 'autoscout' ? parseNextData(html) : null;

    return res.status(200).json({
      html,
      images,
      platform,
      nextData: nextData || undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
