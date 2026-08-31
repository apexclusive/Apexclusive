/**
 * /api/fetch-ad — server-side ophalen van advertenties
 *
 * Beveiliging:
 *  - Alleen toegestane platform- en CDN-domeinen (allowlist) → geen open proxy
 *  - DNS-check: privé/gereserveerde IP-ranges worden geweigerd (anti-SSRF)
 *  - Rate limiting per IP (best-effort in-memory; zie opmerking onderaan)
 *  - Maximale response-grootte voor pagina's en afbeeldingen
 *  - Redirects worden per hop opnieuw gevalideerd
 */
const https = require('https');
const http = require('http');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

/* ── Configuratie ────────────────────────────────────────────────────────── */
const MAX_REDIRECTS   = 5;
const MAX_HTML_BYTES  = 3 * 1024 * 1024;  // 3 MB per advertentiepagina
const MAX_IMG_BYTES   = 10 * 1024 * 1024; // 10 MB per afbeelding
const FETCH_TIMEOUT   = 15000;
const IMG_TIMEOUT     = 10000;

// Advertentie-platforms (voor ?url=)
const AD_HOSTS = [
  'mobile.de',
  'marktplaats.nl',
  'autotrack.nl',
  'bas-world.com',
  'basworld.com',
];
const AD_HOST_RE = /(^|\.)autoscout24\.[a-z.]{2,8}$/; // autoscout24.nl/.de/.fr/...

// Afbeelding-CDN's van die platforms (extra toegestaan voor ?img=)
const IMG_HOSTS_EXTRA = [
  'mpimages.nl',      // Marktplaats (ecg-img.mpimages.nl)
  'hzcdn.com',
  'classistatic.de',  // mobile.de afbeeldingen (img.classistatic.de)
  'autoscout24.net',  // AutoScout24 afbeeldingen
];

function isAllowedHost(hostname, forImage) {
  const h = hostname.toLowerCase();
  const list = forImage ? AD_HOSTS.concat(IMG_HOSTS_EXTRA) : AD_HOSTS;
  if (list.some((d) => h === d || h.endsWith('.' + d))) return true;
  return AD_HOST_RE.test(h);
}

/* ── Privé-IP blokkade (anti-SSRF) ───────────────────────────────────────── */
function isPrivateIp(ip) {
  if (net.isIP(ip) === 0) return true; // ongeldig = weigeren
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) normaliseren
  let v4 = ip;
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) v4 = m[1];

  if (net.isIPv4(v4)) {
    const o = v4.split('.').map(Number);
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a === 169 && b === 254) return true;            // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;              // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;                          // multicast/reserved
    return false;
  }
  // IPv6
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;               // loopback/unspecified
  if (/^f[cd]/.test(v6)) return true;                          // fc00::/7 uniek-lokaal
  if (/^fe[89ab]/.test(v6)) return true;                       // fe80::/10 link-local
  if (/^ff/.test(v6)) return true;                             // multicast
  return false;
}

function resolveAndCheck(hostname) {
  return new Promise((resolve, reject) => {
    // IP-letterlijk? Direct controleren
    if (net.isIP(hostname)) {
      return isPrivateIp(hostname)
        ? reject(new Error('Doeladres niet toegestaan'))
        : resolve();
    }
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        return reject(new Error('Hostnaam niet resolveerbaar'));
      }
      if (addresses.some((a) => isPrivateIp(a.address))) {
        return reject(new Error('Doeladres niet toegestaan'));
      }
      resolve();
    });
  });
}

/* ── Rate limiting (best-effort, in-memory) ────────────────────────────────
   Op serverless wordt dit per instantie bijgehouden — het vangt normaal
   misbruik af maar is geen harde garantie. Voor een harde limiet: koppel
   een centrale store (bijv. Upstash Redis / Vercel KV). */
const RL_WINDOW_MS   = 60 * 1000;
const RL_MAX_AD      = 12; // advertentie-ophaalverzoeken per minuut per IP
const RL_MAX_IMG     = 60; // afbeelding-proxyverzoeken per minuut per IP
const rlBuckets = new Map();

function rateLimitOk(key, max) {
  const now = Date.now();
  let b = rlBuckets.get(key);
  if (!b || now - b.start > RL_WINDOW_MS) {
    b = { start: now, count: 0 };
    rlBuckets.set(key, b);
  }
  b.count += 1;
  // Zaal geheugen op: oude buckets opruimen zodra de map groeit
  if (rlBuckets.size > 5000) {
    for (const [k, v] of rlBuckets) {
      if (now - v.start > RL_WINDOW_MS) rlBuckets.delete(k);
    }
  }
  return b.count <= max;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function fetchUrl(rawUrl, redirects = 0) {
  if (redirects > MAX_REDIRECTS) throw new Error('Te veel redirects');

  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { throw new Error('Ongeldige URL'); }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Alleen http(s) URLs zijn toegestaan');
  }
  if (parsed.username || parsed.password) throw new Error('Ongeldige URL');
  if (!isAllowedHost(parsed.hostname, false)) {
    throw new Error('Dit platform wordt niet ondersteund');
  }
  await resolveAndCheck(parsed.hostname);

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    timeout: FETCH_TIMEOUT,
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

  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      // Volg redirects (elke hop wordt opnieuw gevalideerd via recursie)
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers['location'];
        res.resume(); // body doorspoelen
        if (!loc) return reject(new Error('Redirect zonder Location header'));
        const next = loc.startsWith('http')
          ? loc
          : `${parsed.protocol}//${parsed.host}${loc}`;
        return resolve(fetchUrl(next, redirects + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_HTML_BYTES) {
          req.destroy();
          return reject(new Error('Pagina te groot om te verwerken'));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Proxy een afbeelding door (CORS-beschermde CDN's van de platforms)
async function proxyImage(imgUrl, res, redirects = 0) {
  if (redirects > MAX_REDIRECTS) { res.status(508).end(); return; }

  let parsed;
  try { parsed = new URL(imgUrl); } catch { res.status(400).json({ error: 'Ongeldige afbeeldings-URL' }); return; }

  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    res.status(400).json({ error: 'Ongeldige afbeeldings-URL' });
    return;
  }
  if (!isAllowedHost(parsed.hostname, true)) {
    res.status(403).json({ error: 'Afbeeldingsbron niet toegestaan' });
    return;
  }
  try { await resolveAndCheck(parsed.hostname); }
  catch (e) { res.status(403).json({ error: e.message }); return; }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    timeout: IMG_TIMEOUT,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'nl-NL,nl;q=0.9',
      'Referer': `${parsed.protocol}//${parsed.host}/`,
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    },
  };

  return new Promise((resolve) => {
    const req = lib.request(options, (imgRes) => {
      if ([301, 302, 303, 307, 308].includes(imgRes.statusCode)) {
        const loc = imgRes.headers['location'];
        imgRes.resume();
        if (loc) {
          const next = loc.startsWith('http')
            ? loc
            : `${parsed.protocol}//${parsed.host}${loc}`;
          return resolve(proxyImage(next, res, redirects + 1));
        }
      }

      if (imgRes.statusCode !== 200) {
        imgRes.resume();
        res.status(502).end();
        return resolve();
      }

      // Alleen echte afbeeldingen doorlaten
      const ct = (imgRes.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('image/')) {
        imgRes.resume();
        res.status(415).json({ error: 'Bron is geen afbeelding' });
        return resolve();
      }

      // Groottecap afdwingen
      const declared = parseInt(imgRes.headers['content-length'] || '0', 10);
      if (declared > MAX_IMG_BYTES) {
        imgRes.resume();
        res.status(413).json({ error: 'Afbeelding te groot' });
        return resolve();
      }

      let size = 0;
      imgRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_IMG_BYTES) {
          req.destroy();
          if (!res.headersSent) res.status(413).end(); else res.end();
        }
      });

      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      imgRes.pipe(res);
      imgRes.on('end', resolve);
    });

    req.on('timeout', () => { req.destroy(); res.status(504).end(); resolve(); });
    req.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); resolve(); });
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

// ── Hoofd handler ──────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Methode niet toegestaan' });

  const { url, img } = req.query;
  const ip = clientIp(req);

  // ── Afbeelding proxy ──
  if (img) {
    if (!rateLimitOk(`img:${ip}`, RL_MAX_IMG)) {
      return res.status(429).json({ error: 'Te veel verzoeken — probeer het straks opnieuw' });
    }
    return proxyImage(decodeURIComponent(img), res);
  }

  // ── Advertentie ophalen ──
  if (!url) return res.status(400).json({ error: 'url parameter ontbreekt' });
  if (!rateLimitOk(`ad:${ip}`, RL_MAX_AD)) {
    return res.status(429).json({ error: 'Te veel verzoeken — probeer het straks opnieuw' });
  }

  const decoded = decodeURIComponent(url);

  let platform = 'unknown';
  if (/mobile\.de/i.test(decoded)) platform = 'mobile';
  else if (/autoscout24/i.test(decoded)) platform = 'autoscout';
  else if (/marktplaats\.nl/i.test(decoded)) platform = 'marktplaats';
  else if (/autotrack\.nl/i.test(decoded)) platform = 'autotrack';
  else if (/bas-world|basworld/i.test(decoded)) platform = 'bas';

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
