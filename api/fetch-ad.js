javascript
const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function handler(req, res) {

  /* ── CORS ── */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const rawUrl = req.query.url;

  if (!rawUrl) {
    return res.status(400).json({ error: 'Geen URL opgegeven' });
  }

  /* ── URL validatie ── */
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Ongeldige URL' });
  }

  const allowed = [
    'mobile.de',
    'www.mobile.de',
    'autoscout24.nl',
    'autoscout24.de',
    'autoscout24.be',
    'www.autoscout24.nl',
    'www.autoscout24.de',
    'www.autoscout24.be',
    'marktplaats.nl',
    'www.marktplaats.nl',
    'autotrack.nl',
    'www.autotrack.nl',
    'bas-world.com',
    'www.bas-world.com',
  ];

  if (!allowed.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d))) {
    return res.status(403).json({ error: 'Platform niet ondersteund' });
  }

  try {
    const html = await fetchUrl(rawUrl);

    /* ── images extraheren server-side ── */
    const images = extractImages(html, parsedUrl.hostname);

    return res.status(200).json({
      html: html.substring(0, 250000),
      images: images
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};


/* ══════════════════════════════════════════
   FETCH MET REDIRECT + BETERE HEADERS
══════════════════════════════════════════ */
function fetchUrl(url, redirects = 0) {
  return new Promise((resolve, reject) => {

    if (redirects > 8) {
      return reject(new Error('Te veel redirects'));
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error('Ongeldige redirect URL'));
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,' +
          'image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
        'Connection': 'keep-alive',
      }
    };

    const request = lib.request(options, (response) => {

      /* ── redirect afhandelen ── */
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        let nextUrl = response.headers.location;
        /* relatieve redirects oplossen */
        if (nextUrl.startsWith('/')) {
          nextUrl = parsedUrl.protocol + '//' + parsedUrl.hostname + nextUrl;
        }
        response.resume();
        return fetchUrl(nextUrl, redirects + 1).then(resolve).catch(reject);
      }

      /* ── response body lezen ── */
      const chunks = [];

      response.on('data', chunk => chunks.push(chunk));

      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('utf8'));
      });

      response.on('error', reject);
    });

    request.on('error', reject);

    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error('Timeout — pagina reageert niet'));
    });

    request.end();
  });
}


/* ══════════════════════════════════════════
   IMAGE EXTRACTOR — server-side, hoge res
══════════════════════════════════════════ */
function extractImages(html, hostname) {
  const images = [];
  const seen = new Set();

  /* blokkeer logo's, iconen, tracking pixels */
  const skipPattern =
    /logo|dealer|avatar|icon|placeholder|banner|sprite|pixel|tracking|badge|flag|brand|watermark/i;

  /* minimum breedte in URL detecteren */
  const tooSmall = /[_\-/](\d{1,2}|[0-9]{1,3})x[0-9]{1,3}[_\-.]/;

  /* ── platform-specifieke patronen ── */
  const patterns = [];

  /* generieke JSON-velden */
  patterns.push(
    /"(?:imageUrl|image|fullImageUrl|originalUrl|largeUrl|xlUrl|hdUrl|srcUrl|bigUrl)"\s*:\s*"(https?:\/\/[^"]{10,300})"/gi,
    /"src"\s*:\s*"(https?:\/\/[^"]*?\.(?:jpg|jpeg|png|webp)[^"]{0,200})"/gi,
    /"url"\s*:\s*"(https?:\/\/[^"]*?(?:vehicle|car|auto|fahrzeug|image|photo|foto|img)[^"]{0,200}\.(?:jpg|jpeg|png|webp)[^"]*)"/gi
  );

  /* Open Graph */
  patterns.push(
    /property="og:image(?::[^"]+)?"\s+content="(https?:\/\/[^"]{10,300})"/gi,
    /content="(https?:\/\/[^"]{10,300})"\s+property="og:image(?::[^"]+)?"/gi
  );

  /* Twitter card */
  patterns.push(
    /name="twitter:image(?::[^"]+)?"\s+content="(https?:\/\/[^"]{10,300})"/gi
  );

  /* srcset */
  patterns.push(
    /srcset="(https?:\/\/[^"\s,]{10,300})/gi
  );

  /* img src */
  patterns.push(
    /<img[^>]+src="(https?:\/\/[^"]{10,300})"/gi
  );

  /* Mobile.de specifiek */
  if (hostname.includes('mobile.de')) {
    patterns.push(
      /"url"\s*:\s*"(https?:\/\/i\.?mobilede[^"]+)"/gi,
      /img\.classistatic\.de\/[^"'\s]{5,200}/gi,
      /"mediaList"\s*:\s*\[[^\]]*?"url"\s*:\s*"([^"]+)"/gi
    );
  }

  /* AutoScout24 specifiek */
  if (hostname.includes('autoscout24')) {
    patterns.push(
      /"(https?:\/\/prod\.pictures\.autoscout24\.net[^"]{5,300})"/gi,
      /"(https?:\/\/[^"]*autoscout[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/gi
    );
  }

  /* Marktplaats specifiek */
  if (hostname.includes('marktplaats')) {
    patterns.push(
      /"(https?:\/\/images\.marktplaats\.com[^"]{5,300})"/gi,
      /"(https?:\/\/[^"]*marktplaats[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
      /images\.marktplaats\.com\/[^"'\s]{5,200}/gi
    );
  }

  /* ── doorzoek alle patronen ── */
  for (const pattern of patterns) {
    const p = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = p.exec(html)) !== null) {
      let img = match[1] || match[0];
      if (!img) continue;

      /* unescape */
      img = img
        .replace(/\\u002F/gi, '/')
        .replace(/\\u003A/gi, ':')
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '')
        .replace(/&amp;/g, '&')
        .trim();

      /* moet met http starten */
      if (!img.startsWith('http')) continue;

      /* skip kleine/logo afbeeldingen */
      if (skipPattern.test(img)) continue;
      if (tooSmall.test(img)) continue;

      /* ── hogere resolutie forceren ── */
      img = upgradeResolution(img, hostname);

      /* dedupliceer */
      const key = img.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);

      images.push(img);

      if (images.length >= 20) break;
    }
    if (images.length >= 20) break;
  }

  /* sorteer: grotere URL's (met hogere res params) eerst */
  images.sort((a, b) => {
    const scoreA = resScore(a);
    const scoreB = resScore(b);
    return scoreB - scoreA;
  });

  return images.slice(0, 12);
}


/* ── Resolutie upgraden per platform ── */
function upgradeResolution(img, hostname) {

  /* Mobile.de */
  if (hostname.includes('mobile.de') || img.includes('mobilede') || img.includes('classistatic')) {
    img = img
      .replace(/\/[sml]_/, '/xl_')
      .replace(/\/thumb\//, '/big/')
      .replace(/\/small\//, '/large/')
      .replace(/\/medium\//, '/large/')
      .replace(/[?&]w=\d+/, '?w=1600')
      .replace(/[?&]h=\d+/, '&h=1200')
      .replace(/width=\d+/, 'width=1600')
      .replace(/height=\d+/, 'height=1200')
      .replace(/_\d{3,4}x\d{3,4}\./, '_1600x1200.');
  }

  /* AutoScout24 */
  else if (hostname.includes('autoscout24') || img.includes('autoscout24')) {
    img = img
      .replace(/\/\d+\/\d+\//, '/1600/1200/')
      .replace(/[?&]width=\d+/, '?width=1600')
      .replace(/[?&]height=\d+/, '&height=1200')
      .replace(/_\d{3,4}x\d{3,4}/, '_1600x1200')
      .replace(/\/thumbs?\//, '/images/')
      .replace(/\/small\//, '/large/');
  }

  /* Marktplaats */
  else if (hostname.includes('marktplaats') || img.includes('marktplaats')) {
    /* Marktplaats gebruikt $_{size} suffix */
    img = img
      .replace(/\$_\d+\.JPG/i, '$_86.JPG')   /* $_86 = grootste maat */
      .replace(/\$_\d+\.jpg/i, '$_86.JPG')
      .replace(/\/thumb\//, '/image/')
      .replace(/[?&]rule=ecg_mp[^&]+/g, '')
      .replace(/[?&]w=\d+/, '?w=1600')
      .replace(/[?&]h=\d+/, '&h=1200');
    /* voeg hoge-res rule toe */
    if (!img.includes('$_86') && img.includes('marktplaats')) {
      img = img.replace(/(\.(jpg|jpeg|png|webp))(\?.*)?$/i, '$_86.JPG');
    }
  }

  /* Generiek */
  else {
    img = img
      .replace(/[?&]w=\d+/, '?w=1600')
      .replace(/[?&]h=\d+/, '&h=1200')
      .replace(/width=\d+/g, 'width=1600')
      .replace(/height=\d+/g, 'height=1200')
      .replace(/\/\d{2,4}x\d{2,4}\//, '/1600x1200/')
      .replace(/_\d{2,4}x\d{2,4}\./, '_1600x1200.');
  }

  return img;
}


/* ── Score hogere resolutie ── */
function resScore(img) {
  let score = 0;
  if (img.includes('1600') || img.includes('xl') || img.includes('large') || img.includes('$_86')) score += 10;
  if (img.includes('800') || img.includes('medium')) score += 5;
  if (img.includes('jpg') || img.includes('jpeg')) score += 2;
  if (img.includes('webp')) score += 1;
  return score;
}
