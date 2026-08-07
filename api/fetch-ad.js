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

  /* ── IMAGE PROXY mode ── */
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

  if (!allowed.some(d => parsedUrl.hostname === d || parsedUrl.hostname.endsWith('.' + d))) {
    return res.status(403).json({ error: 'Platform niet ondersteund' });
  }

  try {
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
   IMAGE PROXY
══════════════════════ */
function proxyImage(imgUrl, res) {
  return new Promise(function(resolve) {
    var decoded;
    try {
      decoded = decodeURIComponent(imgUrl);
    } catch(e) {
      res.status(400).end('Bad image URL');
      return resolve();
    }

    var parsedImg;
    try {
      parsedImg = new URL(decoded);
    } catch(e) {
      res.status(400).end('Bad image URL');
      return resolve();
    }

    /* alleen bekende image domeinen toestaan */
    var imgAllowed = [
      'marktplaats.com', 'images.marktplaats.com',
      'mobile.de', 'img.classistatic.de', 'i.ebayimg.com',
      'autoscout24.net', 'prod.pictures.autoscout24.net',
      'autotrack.nl', 'bas-world.com',
      'imgur.com', 'cloudfront.net', 'cloudinary.com'
    ];

    var ok = imgAllowed.some(function(d) {
      return parsedImg.hostname === d || parsedImg.hostname.endsWith('.' + d);
    });

    if (!ok) {
      res.status(403).end('Domain not allowed');
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
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    };

    var request = lib.request(options, function(response) {

      /* redirect volgen */
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return proxyImage(encodeURIComponent(response.headers.location), res).then(resolve);
      }

      if (response.statusCode !== 200) {
        res.status(response.statusCode).end('Image fetch failed');
        return resolve();
      }

      /* headers doorzetten */
      var ct = response.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');

      response.pipe(res);
      response.on('end', resolve);
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
    if (redirects > 8) {
      return reject(new Error('Te veel redirects'));
    }

    var parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return reject(new Error('Ongeldige URL'));
    }

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
      response.on('end', function() {
        var buffer = Buffer.concat(chunks);
        resolve(buffer.toString('utf8'));
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
   EXTRACT IMAGES
══════════════════════ */
function extractImages(html, hostname) {
  var images = [];
  var seen = {};

  var skipPattern = /logo|dealer|avatar|icon|placeholder|banner|sprite|pixel|tracking|badge|flag|brand|watermark/i;
  var tooSmall = /[_\-\/]\d{1,3}x\d{1,3}[_\-.]/;

  var patterns = [
    /"(?:imageUrl|image|fullImageUrl|originalUrl|largeUrl|xlUrl|hdUrl|srcUrl|bigUrl)"\s*:\s*"(https?:\/\/[^"]{10,300})"/gi,
    /"src"\s*:\s*"(https?:\/\/[^"]*?\.(?:jpg|jpeg|png|webp)[^"]{0,200})"/gi,
    /property="og:image[^"]*"\s+content="(https?:\/\/[^"]{10,300})"/gi,
    /content="(https?:\/\/[^"]{10,300})"\s+property="og:image[^"]*"/gi,
    /name="twitter:image[^"]*"\s+content="(https?:\/\/[^"]{10,300})"/gi,
    /<img[^>]+src="(https?:\/\/[^"]{10,300})"/gi
  ];

  if (hostname.includes('autoscout24')) {
    patterns.push(/"(https?:\/\/prod\.pictures\.autoscout24\.net[^"]{5,300})"/gi);
  }
  if (hostname.includes('marktplaats')) {
    patterns.push(/"(https?:\/\/images\.marktplaats\.com[^"]{5,300})"/gi);
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

      img = img
        .replace(/\\u002F/gi, '/')
        .replace(/\\u003A/gi, ':')
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '')
        .replace(/&amp;/g, '&')
        .trim();

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

  images.sort(function(a, b) {
    return resScore(b) - resScore(a);
  });

  return images.slice(0, 12);
}

function upgradeResolution(img, hostname) {
  if (hostname.includes('mobile.de') || img.includes('mobilede') || img.includes('classistatic')) {
    img = img
      .replace(/\/[sml]_/, '/xl_')
      .replace(/\/thumb\//, '/big/')
      .replace(/\/small\//, '/large/')
      .replace(/\/medium\//, '/large/');
  } else if (hostname.includes('autoscout24') || img.includes('autoscout24')) {
    img = img
      .replace(/\/thumbs?\//, '/images/')
      .replace(/\/small\//, '/large/');
  } else if (hostname.includes('marktplaats') || img.includes('marktplaats')) {
    img = img.replace(/\$_\d+\.(JPG|jpg|jpeg)/i, '$_86.JPG');
    if (!img.includes('$_86') && img.includes('marktplaats')) {
      img = img.replace(/\.(jpg|jpeg|png|webp)(\?.*)?$/i, '$_86.JPG');
    }
  }
  return img;
}

function resScore(img) {
  var score = 0;
  if (img.includes('1600') || img.includes('xl') || img.includes('large') || img.includes('$_86')) score += 10;
  if (img.includes('800') || img.includes('medium')) score += 5;
  if (img.includes('jpg') || img.includes('jpeg')) score += 2;
  if (img.includes('webp')) score += 1;
  return score;
}
