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

  if (req.query.img) {
    return proxyImage(req.query.img, res);
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
    /* ── Marktplaats: gebruik de publieke API ── */
    if (parsedUrl.hostname.includes('marktplaats')) {
      return await handleMarktplaats(rawUrl, parsedUrl, res);
    }

    const html = await fetchUrl(rawUrl);
    const images = extractImages(html, parsedUrl.hostname);
    return res.status(200).json({
      html: html.substring(0, 250000),
      images: images
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

/* ══════════════════════
   MARKTPLAATS API
══════════════════════ */
async function handleMarktplaats(rawUrl, parsedUrl, res) {
  /* haal advertentie ID uit URL */
  /* formaten:
     /v/auto-s/m1234567890-titel
     /a/auto-s/ad1234567890.html
     /m1234567890
  */
  var adId = null;
  var match;

  match = rawUrl.match(/[\/\-]([am](\d{9,12}))/);
  if (match) adId = match[2];

  if (!adId) {
    match = rawUrl.match(/\/(\d{9,12})[\/\-]/);
    if (match) adId = match[1];
  }

  if (!adId) {
    match = rawUrl.match(/(\d{9,12})/);
    if (match) adId = match[1];
  }

  if (!adId) {
    /* geen ID gevonden, probeer gewone HTML fetch */
    const html = await fetchUrl(rawUrl);
    const images = extractImages(html, 'marktplaats.nl');
    return res.status(200).json({
      html: html.substring(0, 250000),
      images: images
    });
  }

  /* Marktplaats publieke API */
  try {
    const apiUrl = 'https://www.marktplaats.nl/v/api/listing/' + adId;
    const apiData = await fetchJson(apiUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'nl-NL,nl;q=0.9',
      'Referer': 'https://www.marktplaats.nl/',
      'Origin': 'https://www.marktplaats.nl',
      'x-mp-xsrf-token': 'nocheck',
      'Cache-Control': 'no-cache'
    });

    var images = [];
    var title = '';
    var price = '';
    var km = '';
    var year = '';
    var fuel = '';
    var power = '';
    var color = '';

    if (apiData) {
      title = apiData.title || apiData.description || '';

      /* prijs */
      if (apiData.priceInfo) {
        price = apiData.priceInfo.priceCents
          ? String(apiData.priceInfo.priceCents)
          : apiData.priceInfo.price || '';
      }

      /* afbeeldingen uit API */
      if (apiData.pictures && Array.isArray(apiData.pictures)) {
        apiData.pictures.forEach(function(pic) {
          var url = pic.extraExtraLargeUrl ||
                    pic.extraLargeUrl ||
                    pic.largeUrl ||
                    pic.mediumUrl ||
                    pic.smallUrl ||
                    pic.url ||
                    '';
          if (url && url.startsWith('http')) {
            images.push(url);
          }
        });
      }

      /* kenmerken */
      if (apiData.attributes && Array.isArray(apiData.attributes)) {
        apiData.attributes.forEach(function(attr) {
          var k = (attr.key || '').toLowerCase();
          var v = attr.value || '';
          if (k === 'mileage' || k === 'kilometres') km = v;
          if (k === 'constructionyear' || k === 'year') year = v;
          if (k === 'fueltype' || k === 'fuel') fuel = v;
          if (k === 'enginepower' || k === 'power') power = v;
          if (k === 'colour' || k === 'color') color = v;
        });
      }
    }

    /* bouw nep-HTML voor de bestaande parsers */
    var fakeHtml = '<html><head>' +
      '<title>' + title + '</title>' +
      '<meta property="og:title" content="' + title + '"/>' +
      '</head><body>' +
      '<h1>' + title + '</h1>' +
      (price ? '<span class="price">' + price + '</span>' : '') +
      (km    ? '<span class="km">' + km + ' km</span>' : '') +
      (year  ? '<span class="year">' + year + '</span>' : '') +
      (fuel  ? '<span class="fuel">' + fuel + '</span>' : '') +
      (power ? '<span class="power">' + power + ' pk</span>' : '') +
      (color ? '<span class="color">' + color + '</span>' : '') +
      '</body></html>';

    return res.status(200).json({
      html: fakeHtml,
      images: images
    });

  } catch (e) {
    /* API mislukt, val terug op HTML */
    const html = await fetchUrl(rawUrl);
    const images = extractImages(html, 'marktplaats.nl');
    return res.status(200).json({
      html: html.substring(0, 250000),
      images: images
    });
  }
}

/* ══════════════════════
   FETCH JSON
══════════════════════ */
function fetchJson(url, headers) {
  return new Promise(function(resolve, reject) {
    var parsedUrl;
    try { parsedUrl = new URL(url); } catch(e) { return reject(e); }

    var lib = parsedUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: headers || {}
    };

    var request = lib.request(options, function(response) {
      var chunks = [];
      response.on('data', function(c) { chunks.push(c); });
      response.on('end', function() {
        try {
          var body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch(e) {
          resolve(null);
        }
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(15000, function() {
      request.destroy();
      reject(new Error('Timeout'));
    });
    request.end();
  });
}

/* ══════════════════════
   IMAGE PROXY
══════════════════════ */
function proxyImage(imgUrl, res) {
  return new Promise(function(resolve) {
    var decoded;
    try { decoded = decodeURIComponent(imgUrl); } catch(e) {
      res.status(400).end('Bad URL'); return resolve();
    }

    var parsedImg;
    try { parsedImg = new URL(decoded); } catch(e) {
      res.status(400).end('Bad URL'); return resolve();
    }

    var imgAllowed = [
      'marktplaats.com', 'images.marktplaats.com',
      'admarkt-cdn.marktplaats.com', 'ecg-img.com',
      'mobile.de', 'img.classistatic.de', 'i.ebayimg.com',
      'autoscout24.net', 'prod.pictures.autoscout24.net',
      'autotrack.nl', 'bas-world.com',
      'cloudfront.net', 'cloudinary.com'
    ];

    var ok = imgAllowed.some(function(d) {
      return parsedImg.hostname === d ||
             parsedImg.hostname.endsWith('.' + d) ||
             decoded.includes(d);
    });

    if (!ok) {
      res.status(403).end('Domain not allowed: ' + parsedImg.hostname);
      return resolve();
    }

    var lib = parsedImg.protocol === 'https:' ? https : http;
    var options = {
      hostname: parsedImg.hostname,
      path: parsedImg.pathname + parsedImg.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Referer': 'https://www.marktplaats.nl/',
        'Origin': 'https://www.marktplaats.nl',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    };

    var request = lib.request(options, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return proxyImage(encodeURIComponent(response.headers.location), res).then(resolve);
      }
      if (response.statusCode !== 200) {
        res.status(response.statusCode).end('Image fetch failed: ' + response.statusCode);
        return resolve();
      }
      var ct = response.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      response.pipe(res);
      response.on('end', resolve);
      response.on('error', function() { resolve(); });
    });

    request.on('error', function(e) {
      res.status(500).end('Proxy error: ' + e.message);
      resolve();
    });
    request.setTimeout(15000, function() {
      request.destroy();
      res.status(504).end('Timeout');
      resolve();
    });
    request.end();
  });
}

/* ══════════════════════
   FETCH HTML
══════════════════════ */
function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function(resolve, reject) {
    if (redirects > 8) return reject(new Error('Te veel redirects'));

    var parsedUrl;
    try { parsedUrl = new URL(url); } catch(e) { return reject(new Error('Ongeldige URL')); }

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
   EXTRACT IMAGES
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
    /<img[^>]+src="(https?:\/\/[^"]{10,300})"/gi
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
      img = img.replace(/\\u002F/gi,'/').replace(/\\u003A/gi,':').replace(/\\\//g,'/').replace(/\\"/g,'').replace(/&amp;/g,'&').trim();
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
    img = img.replace(/\/[sml]_/,'/xl_').replace(/\/thumb\//,'/big/').replace(/\/small\//,'/large/').replace(/\/medium\//,'/large/');
  } else if (hostname.includes('autoscout24') || img.includes('autoscout24')) {
    img = img.replace(/\/thumbs?\//,'/images/').replace(/\/small\//,'/large/');
  }
  return img;
}

function resScore(img) {
  var score = 0;
  if (img.includes('1600') || img.includes('xl') || img.includes('large') || img.includes('ExtraExtra')) score += 10;
  if (img.includes('800') || img.includes('medium')) score += 5;
  if (img.includes('jpg') || img.includes('jpeg')) score += 2;
  if (img.includes('webp')) score += 1;
  return score;
}
