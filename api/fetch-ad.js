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
    if (parsedUrl.hostname.includes('marktplaats')) {
      return await handleMarktplaats(rawUrl, res);
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

/* ══════════════════════════════════════
   MARKTPLAATS — via mobiele API
══════════════════════════════════════ */
async function handleMarktplaats(rawUrl, res) {

  /* ID extraheren */
  var adId = null;
  var match;
  match = rawUrl.match(/\/[ma](\d{8,12})/i);
  if (match) adId = match[1];
  if (!adId) {
    match = rawUrl.match(/(\d{8,12})/);
    if (match) adId = match[1];
  }
  if (!adId) {
    return res.status(400).json({ error: 'Geen advertentie ID gevonden in de URL.' });
  }

  /* Mobiele API — werkt zonder authenticatie */
  var endpoints = [
    {
      url: 'https://www.marktplaats.nl/api/v2/listings/' + adId,
      headers: {
        'User-Agent': 'Marktplaats/11.12.0 (Android 12; Mobile)',
        'Accept': 'application/json',
        'Accept-Language': 'nl-NL',
        'x-mp-xsrf-token': 'nocheck',
        'Referer': 'https://www.marktplaats.nl/'
      }
    },
    {
      url: 'https://www.marktplaats.nl/api/v4/advertisements/' + adId + '?attributeGroup=mp-auto-characteristics',
      headers: {
        'User-Agent': 'Marktplaats/11.12.0 (Android 12; Mobile)',
        'Accept': 'application/json',
        'Accept-Language': 'nl-NL',
        'x-mp-xsrf-token': 'nocheck',
        'Referer': 'https://www.marktplaats.nl/'
      }
    },
    {
      url: 'https://api.marktplaats.nl/v1/listings/' + adId,
      headers: {
        'User-Agent': 'Marktplaats/11.12.0 (Android 12; Mobile)',
        'Accept': 'application/json',
        'Accept-Language': 'nl-NL'
      }
    },
    {
      url: 'https://www.marktplaats.nl/lrp/api/advertisement/' + adId,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Referer': 'https://www.marktplaats.nl/',
        'x-mp-xsrf-token': 'nocheck'
      }
    }
  ];

  var apiData = null;
  var lastResponse = null;

  for (var i = 0; i < endpoints.length; i++) {
    try {
      var result = await fetchRaw(endpoints[i].url, endpoints[i].headers);
      lastResponse = result.body.substring(0, 500);
      if (result.status === 200) {
        try {
          apiData = JSON.parse(result.body);
          if (apiData && (apiData.title || apiData.description ||
              apiData.listing || apiData.advertisement || apiData.ad)) {
            break;
          }
        } catch(e) {
          apiData = null;
        }
      }
    } catch(e) {
      continue;
    }
  }

  /* unwrap geneste structuren */
  if (apiData) {
    apiData = apiData.listing || apiData.advertisement ||
              apiData.ad || apiData.data || apiData;
  }

  /* als alles mislukt, stuur nuttige foutmelding */
  if (!apiData || (!apiData.title && !apiData.description)) {
    return res.status(200).json({
      html: '<html><body><h1>Marktplaats advertentie</h1></body></html>',
      images: [],
      error: 'Marktplaats blokkeert automatische toegang tot advertenties. ' +
             'Probeer een link van Mobile.de of AutoScout24.',
      _debug: { adId: adId, lastResponse: lastResponse }
    });
  }

  /* verwerk data */
  var images = [];
  var title  = apiData.title || apiData.description || '';
  var price  = '';
  var km     = '';
  var year   = '';
  var fuel   = '';
  var power  = '';
  var color  = '';

  /* afbeeldingen */
  var pics = apiData.pictures || apiData.images ||
             apiData.photos   || apiData.media  || [];
  if (Array.isArray(pics)) {
    pics.forEach(function(pic) {
      var u = '';
      if (typeof pic === 'string') {
        u = pic;
      } else {
        u = pic.extraExtraLargeUrl || pic.extraLargeUrl ||
            pic.largeUrl || pic.mediumUrl ||
            pic.url || pic.imageUrl || pic.src || '';
      }
      if (u && u.startsWith('http') && !u.includes('logo') && !u.includes('placeholder')) {
        images.push(u);
      }
    });
  }

  /* prijs */
  var pi = apiData.priceInfo || apiData.price || apiData.pricing || {};
  if (typeof pi === 'number') {
    price = String(pi);
  } else if (pi.priceCents) {
    price = String(Math.round(pi.priceCents / 100));
  } else if (pi.price || pi.amount || pi.value) {
    price = String(pi.price || pi.amount || pi.value);
  }

  /* kenmerken */
  var allAttrs = []
    .concat(apiData.attributes || [])
    .concat(apiData.vipAttributes || [])
    .concat(apiData.characteristics || [])
    .concat(apiData.properties || [])
    .concat(apiData.traits || []);

  allAttrs.forEach(function(a) {
    var k = String(a.key || a.attributeId || a.name || a.trait || '').toLowerCase();
    var v = String(a.value || a.valueId || a.label || a.traitValue || '');
    if (/mileage|km|kilomet/.test(k))       km    = v;
    if (/year|bouwjaar|constructi/.test(k)) year  = v;
    if (/fuel|brandstof/.test(k))           fuel  = v;
    if (/power|vermogen|engine/.test(k))    power = v;
    if (/colou?r|kleur/.test(k))            color = v;
  });

  /* bouw HTML */
  var fakeHtml = '<html><head>'
    + '<title>' + esc(title) + '</title>'
    + '</head><body>'
    + '<h1>' + esc(title) + '</h1>'
    + (price ? '<div class="priceCents">' + (parseInt(price) * 100) + '</div>' : '')
    + (km    ? '<div class="mileage">' + km + ' km</div>' : '')
    + (year  ? '<div class="constructionYear">' + year + '</div>' : '')
    + (fuel  ? '<div class="fuelType">' + fuel + '</div>' : '')
    + (power ? '<div class="power">' + power + ' pk</div>' : '')
    + (color ? '<div class="color">' + color + '</div>' : '')
    + '</body></html>';

  return res.status(200).json({
    html: fakeHtml,
    images: images
  });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════
   FETCH RAW (status + body)
══════════════════════ */
function fetchRaw(url, headers) {
  return new Promise(function(resolve, reject) {
    var parsedUrl;
    try { parsedUrl = new URL(url); }
    catch(e) { return reject(e); }

    var lib = parsedUrl.protocol === 'https:' ? https : http;
    var options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: headers || {}
    };

    var request = lib.request(options, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return fetchRaw(response.headers.location, headers).then(resolve).catch(reject);
      }
      var chunks = [];
      response.on('data', function(c) { chunks.push(c); });
      response.on('end', function() {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(12000, function() {
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
    try { decoded = decodeURIComponent(imgUrl); }
    catch(e) { res.status(400).end('Bad URL'); return resolve(); }

    var parsedImg;
    try { parsedImg = new URL(decoded); }
    catch(e) { res.status(400).end('Bad URL'); return resolve(); }

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
        'Referer': 'https://www.marktplaats.nl/',
        'Origin': 'https://www.marktplaats.nl',
        'Cache-Control': 'no-cache'
      }
    };

    var request = lib.request(options, function(response) {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return proxyImage(encodeURIComponent(response.headers.location), res).then(resolve);
      }
      if (response.statusCode !== 200) {
        res.status(response.statusCode).end('Image failed: ' + response.statusCode);
        return resolve();
      }
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      response.pipe(res);
      response.on('end', resolve);
      response.on('error', function() { resolve(); });
    });

    request.on('error', function(e) {
      res.status(500).end('Error: ' + e.message);
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
      img = img.replace(/\\u002F/gi,'/').replace(/\\u003A/gi,':')
               .replace(/\\\//g,'/').replace(/\\"/g,'')
               .replace(/&amp;/g,'&').trim();
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
    img = img.replace(/\/[sml]_/,'/xl_').replace(/\/thumb\//,'/big/')
             .replace(/\/small\//,'/large/').replace(/\/medium\//,'/large/');
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
