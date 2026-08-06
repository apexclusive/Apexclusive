function extractImages(html){

const images = [];

const patterns = [

/"image"\s*:\s*"([^"]+)"/gi,

/"imageUrl"\s*:\s*"([^"]+)"/gi,

/"images"\s*:\s*\[\s*"([^"]+)"/gi,

/"https?:\\?\/\\?\/[^"\\]+\.(?:jpg|jpeg|png)[^"\\]*/gi,

/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/gi

];


patterns.forEach(pattern => {

let match;

while((match = pattern.exec(html)) !== null){

let img = match[1] || match[0];


// escaped URL herstellen
img = img.replace(/\\u002F/g,"/");
img = img.replace(/\\\//g,"/");


if(
img.startsWith("http") &&
!images.includes(img)
){

images.push(img);

}

}

});


return images.slice(0,10);

}

import https from "https";
import http from "http";

export default async function handler(req, res) {

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      error: "Geen URL opgegeven"
    });
  }

  try {

    const response = await fetch(url, {
      headers: {
        "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    const html = await response.text();

    const images = extractImages(html);

res.status(200).json({
  html: html,
  images: images
});

  } catch(e) {

    res.status(500).json({
      error: e.message
    });

  }
}
