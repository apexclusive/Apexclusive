const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async function handler(req, res) {
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

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Ongeldige URL' });
  }

  const allowed = [
    'mobile.de', 'www.mobile.de',
    'autoscout24.nl', 'autoscout24.de', 'autoscout24.be',
    'www.autoscout24.nl', 'www.autoscout24.de', 'www.autoscout24.be',
    'marktplaats.nl', 'www.marktplaats.nl',
    'autotrack.nl', 'www.autotrack.nl',
    'bas-world.com', 'www.bas-world.com'
  ];

  if (!allowed.some(function(d) {
    return parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d);
  })) {
    return res.status(403).json({ error: 'Platform niet ondersteund' });
  }

  try {
    var html;
    var images = [];

    if (parsedUrl.hostname.includes('marktplaats')) {
      /* stap 1: haal eerst de homepage op om cookies te krijgen */
      var cookieStr = '';
      try {
        var homeResp = await fetchRaw('https://www.marktplaats.nl/', {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'nl-NL,nl;q=0.9',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive'
        });
        /* cookies verzamelen */
        if (homeResp.headers && homeResp.headers['set-cookie']) {
          var cookies = homeResp.headers['set-cookie'];
          if (Array.isArray(cookies)) {
            cookieStr = cookies.map(function(c) { return c.split(';')[0]; }).join('; ');
          } else {
            cookieStr = String(cookies).split(';')[0];
          }
        }
      } catch(e) {
        cookieStr = '';
      }

      /* stap 2: haal de advertentie op met cookies */
      var adHeaders = {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.marktplaats.nl/',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
      };
      if (cookieStr) adHeaders['Cookie'] = cookieStr;

      var adResp = await fetchRaw(rawUrl, adHeaders);
      html = adResp.body;

      /* stap 3: extraheer afbeeldingen specifiek voor Marktplaats */
      images = extractMarktplaatsImages(html);

    } else {
      html = await fetchUrl(rawUrl);
      images = extractImages(html, parsedUrl.hostname);
    }

    return res.status(200).json({
      html: html.substring(0, 250000),
      images: images
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

/* ══════════════════════
   MARKTPLAATS IMAGE EXTRACTOR
══════════════════════ */
function extractMarktplaatsImages(html) {
  var images = [];
  var seen = {};

  /* Marktplaats slaat foto's op in JSON blokken in de HTML */
  var patterns = [
    /* nieuw formaat: extraExtraLargeUrl etc */
    /"extraExtraLargeUrl"\s*:\s*"([^"]+)"/gi,
    /"extraLargeUrl"\s*:\s*"([^"]+)"/gi,
    /"largeUrl"\s*:\s*"([^"]+)"/gi,
    /"mediumUrl"\s*:\s*"([^"]+)"/gi,
    /* oud formaat */
    /"imageUrl"\s*:\s*"([^"]+)"/gi,
    /"originalUrl"\s*:\s*"([^"]+)"/gi,
    /* CDN urls */
    /"(https?:\/\/images\.marktplaats\.com\/[^"]{10,300})"/gi,
    /"(https?:\/\/admarkt-cdn\.marktplaats\.com\/[^"]{10,300})"/gi,
    /"(https?:\/\/[^"]*ecg[^"]*\.(?:jpg|jpeg|png|webp)[^"]{0,100})"/gi,
    /* og image */
    /property="og:image"\s+content="([^"]+)"/gi,
    /content="([^"]+)"\s+property="og:image"/gi
  ];

  var skip = /logo|favicon|placeholder|banner|sprite|icon|avatar|hzcdn\.io/i;

  patterns.forEach(function(p) {
    var m, pp = new RegExp(p.source, p.flags);
    while ((m = pp.exec(html)) !== null) {
      var img = m[1];
      if (!img) continue;

      /* unescape */
      img = img
        .replace(/\\u002F/gi, '/')
        .replace(/\\u003A/gi, ':')
        .replace(/\\\//g, '/')
        .replace(/\"/g, '')
        .replace(/&/g, '&')
        .trim();

      if (!img.startsWith('http')) continue;
      if (skip.test(img)) continue;

      /* verwijder lage-res rules */
      img = img.replace(/[?&]rule=eps_\d+/g, '');
      img = img.replace(/[?&]rule=ecg_mp[^&]*/g, '');
      img = img.replace(/\?$/, '').replace(/\?&/, '?');

      var key = img.split('?')[0];
      if (seen[key]) continue;
      seen[key] = true;

      images.push(img);
      if (images.length >= 20) break;
    }
    if (images.length >= 20) return;
  });

  /* sorteer op kwaliteit */
  images.sort(function(a, b) {
    return mpScore(b) - mpScore(a);
  });

  return images.slice(0, 12);
}

function mpScore(img) {
  var s = 0;
  if (img.includes('extraExtraLarge') || img.includes('ExtraExtra')) s += 20;
  if (img.includes('extraLarge') || img.includes('ExtraLarge')) s += 15;
  if (img.includes('large') || img.includes('Large')) s += 10;
  if (img.includes('medium') || img.includes('Medium')) s += 5;
  if (img.includes('small') || img.includes('Small')) s -= 5;
  if (img.includes('eps_83')) s -= 20;
  if (img.includes('eps_48')) s -= 10;
  return s;
}

/* ══════════════════════
   FETCH RAW (met headers terug)
══════════════════════ */
function fetchRaw(url, headers, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve, reject) {
    if (redirects > 8) return reject(new Error('Te veel redirects'));

    var parsedUrl;
    try { parsedUrl = new URL(url); }
    catch(e) { return reject(new Error('Ongeldige URL')); }

    var lib = parsedUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: headers || {}
    };

    var request = lib.request(options, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        var nextUrl = response.headers.location;
        if (nextUrl.startsWith('/')) {
          nextUrl = parsedUrl.protocol + '//' + parsedUrl.hostname + nextUrl;
        }
        response.resume();
        return fetchRaw(nextUrl, headers, redirects + 1).then(resolve).catch(reject);
      }

      var chunks = [];
      response.on('data', function(c) { chunks.push(c); });
      response.on('end', function() {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(20000, function() {
      request.destroy();
      reject(new Error('Timeout'));
    });
    request.end();
  });
}

/* ══════════════════════
   FETCH HTML (niet-Marktplaats)
══════════════════════ */
function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve, reject) {
    if (redirects > 8) return reject(new Error('Te veel redirects'));

    var parsedUrl;
    try { parsedUrl = new URL(url); }
    catch(e) { return reject(new Error('Ongeldige URL')); }

    var lib = parsedUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    };

    var request = lib.request(options, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        var nextUrl = response.headers.location;
        if (nextUrl.startsWith('/')) {
          nextUrl = parsedUrl.protocol + '//' + parsedUrl.hostname + nextUrl;
        }
        response.resume();
        return fetchUrl(nextUrl, redirects + 1).then(resolve).catch(reject);
      }

      var chunks = [];
      response.on('data', function(chunk) { chunks.push(chunk); });
      response.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(20000, function() {
      request.destroy();
      reject(new Error('Timeout'));
    });
    request.end();
  });
}

/* ══════════════════════
   EXTRACT IMAGES (niet-Marktplaats)
══════════════════════ */
function extractImages(html, hostname) {
  var images = [];
  var seen = {};
  var skipPattern = /logo|dealer|avatar|icon|placeholder|banner|sprite|pixel|tracking|badge|flag|brand|watermark/i;
  var tooSmall = /[_\-\/]\d{1,3}x\d{1,3}[_\-.]/;

  var patterns = [
    /"(?:imageUrl|image|fullImageUrl|originalUrl|largeUrl|xlUrl|hdUrl|srcUrl|bigUrl|extraExtraLargeUrl|extraLargeUrl)"\s*:\s*"(https?:\/\/[^"]{10,300})"/gi,
    /"src"\s*:\s*"(https?:\/\/[^"]*?\.(?:jpg|jpeg|png|webp)[^"]{0,200})"/gi,
    /property="og:image[^"]*"\s+content="(https?:\/\/[^"]{10,300})"/gi,
    /content="(https?:\/\/[^"]{10,300})"\s+property="og:image[^"]*"/gi,
    /name="twitter:image[^"]*"\s+content="(https?:\/\/[^"]{10,300})"/gi,
    /]+src="(https?:\/\/[^"]{10,300})"/gi
  ];

  if (hostname.includes('autoscout24')) {
    patterns.push(/"(https?:\/\/prod\.pictures\.autoscout24\.net[^"]{5,300})"/gi);
  }
  if (hostname.includes('mobile.de')) {
    patterns.push(/"url"\s*:\s*"(https?:\/\/[^"]*(?:mobile|classistatic)[^"]{5,300})"/gi);
  }

  for (var i = 0; i < patterns.length; i++) {
    var p = new RegExp(patterns[i].source, patterns[i].flags);
    var match;
    while ((match = p.exec(html)) !== null) {
      var img = match[1];
      if (!img) continue;
      img = img.replace(/\\u002F/gi, '/').replace(/\\u003A/gi, ':')
               .replace(/\\\//g, '/').replace(/\"/g, '')
               .replace(/&/g, '&').trim();
      if (!img.startsWith('http')) continue;
      if (skipPattern.test(img)) continue;
      if (tooSmall.test(img)) continue;
      img = upgradeResolution(img, hostname);
      var key = img.split('?')[0];
      if (seen[key]) continue;
      seen[key] = true;
      images.push(img);
      if (images.length >= 20) break;
    }
    if (images.length >= 20) break;
  }

  images.sort(function(a, b) { return resScore(b) - resScore(a); });
  return images.slice(0, 12);
}

function upgradeResolution(img, hostname) {
  if (hostname.includes('mobile.de') || img.includes('mobilede') || img.includes('classistatic')) {
    img = img.replace(/\/[sml]_/, '/xl_').replace(/\/thumb\//, '/big/')
             .replace(/\/small\//, '/large/').replace(/\/medium\//, '/large/');
  } else if (hostname.includes('autoscout24') || img.includes('autoscout24')) {
    img = img.replace(/\/thumbs?\//, '/images/').replace(/\/small\//, '/large/');
  }
  return img;
}

function resScore(img) {
  var score = 0;
  if (img.includes('1600') || img.includes('xl') || img.includes('large')) score += 10;
  if (img.includes('800') || img.includes('medium')) score += 5;
  if (img.includes('jpg') || img.includes('jpeg')) score += 2;
  if (img.includes('webp')) score += 1;
  return score;
}
