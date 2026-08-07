const https = require('https');
const http = require('http');
const { URL } = require('url');

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');


module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');


  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }


  /*
  ==================================================
  IMAGE PROXY
  ==================================================
  */

  if (req.query.img) {
    return proxyImage(req.query.img, res);
  }


  const rawUrl = req.query.url;


  if (!rawUrl) {
    return res.status(400).json({
      error: 'Geen URL opgegeven'
    });
  }


  let parsedUrl;

  try {

    parsedUrl = new URL(rawUrl);

  } catch (e) {

    return res.status(400).json({
      error: 'Ongeldige URL'
    });

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
    'www.bas-world.com'

  ];



  if (!allowed.some(function(domain){

    return parsedUrl.hostname === domain ||
      parsedUrl.hostname.endsWith('.' + domain);

  })) {


    return res.status(403).json({

      error:'Platform niet ondersteund'

    });

  }



  try {


    const result = await scrapePage(rawUrl);



    return res.status(200).json({

      html: result.html.substring(0,300000),

      images: result.images,

      title: result.title || '',

      price: result.price || '',

      details: result.details || {}

    });



  } catch(error){


    return res.status(500).json({

      error:error.message

    });


  }

};





/*
==================================================
PUPPETEER SCRAPER
==================================================
*/


async function scrapePage(url){


let browser;


try {


browser = await puppeteer.launch({

args: chromium.args,

defaultViewport: chromium.defaultViewport,

executablePath: await chromium.executablePath(),

headless: chromium.headless

});



const page = await browser.newPage();



await page.setUserAgent(
'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
);



await page.setExtraHTTPHeaders({

'Accept-Language':'nl-NL,nl;q=0.9,en;q=0.8'

});



await page.goto(url,{

waitUntil:'networkidle2',

timeout:45000

});



await page.waitForTimeout(3000);



const data = await page.evaluate(()=>{


const html=document.documentElement.innerHTML;



const images=[];


document.querySelectorAll('img').forEach(img=>{


let src =
img.currentSrc ||
img.src ||
img.getAttribute('data-src');


if(src && src.startsWith('http')){

images.push(src);

}


});



document.querySelectorAll('meta').forEach(meta=>{


if(meta.property==='og:image' && meta.content){

images.push(meta.content);

}


});




let title='';

let price='';



const titleSelectors=[

'h1',

'[data-testid*="title"]',

'[class*="title"]'

];



for(const s of titleSelectors){

const el=document.querySelector(s);

if(el){

title=el.innerText.trim();

break;

}

}




const text=document.body.innerText || '';



const priceMatch=text.match(
/€\s?[\d\.\,]+/
);


if(priceMatch){

price=priceMatch[0];

}



return {

html,

images,

title,

price,

text

};


});



return {

html:data.html,

images:cleanImages(data.images),

title:data.title,

price:data.price,

details:extractDetails(data.text)

};



}

finally{


if(browser){

await browser.close();

}


}



}

/*
==================================================
DETAIL EXTRACTOR
==================================================
*/

function extractDetails(text){

  const details = {};


  if(!text){
    return details;
  }


  const km = text.match(
    /([\d\.]+)\s?km/i
  );


  if(km){

    details.kilometers = km[1]
      .replace(/\./g,'');

  }



  const year = text.match(
    /\b(19|20)\d{2}\b/
  );


  if(year){

    details.year = year[0];

  }



  const power = text.match(
    /(\d+)\s?(pk|pk\.)/i
  );


  if(power){

    details.power = power[1] + ' pk';

  }



  const fuel = text.match(
    /(benzine|diesel|hybride|elektrisch)/i
  );


  if(fuel){

    details.fuel = fuel[0];

  }



  const gearbox = text.match(
    /(automaat|handgeschakeld|automatisch)/i
  );


  if(gearbox){

    details.gearbox = gearbox[0];

  }



  return details;

}





/*
==================================================
IMAGE CLEANER
==================================================
*/


function cleanImages(images){


const result=[];

const seen={};



const blacklist = /logo|icon|avatar|sprite|placeholder|banner|tracking|favicon/i;



for(let img of images){


if(!img){
continue;
}



img = img
.replace(/\\u002F/g,'/')
.replace(/\\u003A/g,':')
.replace(/\\/g,'');



if(!img.startsWith('http')){
continue;
}



if(blacklist.test(img)){
continue;
}



img = upgradeImage(img);



const key=img.split('?')[0];



if(seen[key]){
continue;
}



seen[key]=true;


result.push(img);



if(result.length>=20){
break;
}


}



return result.slice(0,12);


}





/*
==================================================
IMAGE QUALITY UPGRADE
==================================================
*/


function upgradeImage(img){


/*
 MOBILE.DE
*/


if(
img.includes('mobile.de') ||
img.includes('classistatic')
){


img = img

.replace('/s_','/xl_')

.replace('/m_','/xl_')

.replace('/l_','/xl_')

.replace('/small/','/large/')

.replace('/thumb/','/big/');


}



/*
 AUTOSCOUT24
*/


if(
img.includes('autoscout24')
){


img = img

.replace('/thumb/','/large/')

.replace('/small/','/large/');

}



/*
 MARKTPLAATS
*/


if(
img.includes('marktplaats')
){


img = img

.replace(/rule=eps_\d+/,'rule=ecg_mp');

}



return img;


}






/*
==================================================
FALLBACK HTML FETCH
==================================================
*/


function fetchUrl(url, redirects){


redirects = redirects || 0;



return new Promise((resolve,reject)=>{


if(redirects > 8){

return reject(
new Error('Te veel redirects')
);

}



let parsed;


try{

parsed=new URL(url);

}

catch(e){

return reject(
new Error('Ongeldige URL')
);

}




const lib =
parsed.protocol==='https:' ? https : http;




const request=lib.request({

hostname:parsed.hostname,

path:
parsed.pathname+
parsed.search,

method:'GET',

headers:{

'User-Agent':
'Mozilla/5.0 Chrome/124 Safari/537.36',

'Accept':
'text/html,*/*',

'Accept-Language':
'nl-NL,nl;q=0.9',

'Accept-Encoding':
'identity'

}


},response=>{


if(
response.statusCode>=300 &&
response.statusCode<400 &&
response.headers.location
){


let next=response.headers.location;


if(next.startsWith('/')){

next=
parsed.protocol+
'//'+
parsed.hostname+
next;

}



response.resume();



return fetchUrl(next,redirects+1)
.then(resolve)
.catch(reject);


}



let chunks=[];


response.on('data',c=>chunks.push(c));


response.on('end',()=>{


resolve(
Buffer.concat(chunks).toString('utf8')
);


});


});



request.on('error',reject);



request.setTimeout(20000,()=>{


request.destroy();


reject(
new Error('Timeout')
);


});



request.end();



});


}

/*
==================================================
IMAGE PROXY
==================================================
*/


function proxyImage(imgUrl,res){


return new Promise(function(resolve){


let decoded;


try{

decoded=decodeURIComponent(imgUrl);

}

catch(e){

res.status(400).end('Bad image URL');

return resolve();

}



decoded = decoded
.replace(/[?&]rule=eps_\d+/g,'')
.replace(/[?&]rule=ecg_mp[^&]*/g,'')
.replace(/\?$/,'');



let parsed;


try{

parsed=new URL(decoded);

}

catch(e){

res.status(400).end('Bad URL');

return resolve();

}




const allowed=[

'marktplaats.com',

'images.marktplaats.com',

'admarkt-cdn.marktplaats.com',

'autoscout24.net',

'prod.pictures.autoscout24.net',

'cloudfront.net',

'cloudinary.com',

'img.classistatic.de',

'media.classistatic.de',

'i.ebayimg.com'

];



const ok=allowed.some(domain=>{

return parsed.hostname===domain ||
parsed.hostname.endsWith('.'+domain);

});



if(!ok){

res.status(403).end(
'Image domain not allowed'
);

return resolve();

}



const lib =
parsed.protocol==='https:' ? https : http;



const request=lib.request({

hostname:parsed.hostname,

path:
parsed.pathname+
parsed.search,

method:'GET',


headers:{


'User-Agent':
'Mozilla/5.0 Chrome/124 Safari/537.36',


'Accept':
'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',


'Referer':
'https://www.marktplaats.nl/',


'Accept-Language':
'nl-NL,nl;q=0.9'


}



},response=>{


/*
 redirects volgen
*/


if(
response.statusCode>=300 &&
response.statusCode<400 &&
response.headers.location
){


response.resume();


return proxyImage(
encodeURIComponent(response.headers.location),
res
)
.then(resolve);


}




if(response.statusCode!==200){


res
.status(response.statusCode)
.end(
'Image failed'
);


return resolve();

}




res.setHeader(

'Content-Type',

response.headers['content-type']
||
'image/jpeg'

);



res.setHeader(

'Cache-Control',

'public,max-age=86400'

);



res.setHeader(

'Access-Control-Allow-Origin',

'*'

);



response.pipe(res);



response.on(
'end',
resolve
);



response.on(
'error',
resolve
);



});



request.on('error',function(err){


res.status(500).end(
err.message
);


resolve();


});



request.setTimeout(
15000,
function(){

request.destroy();

res.status(504).end(
'Image timeout'
);

resolve();


}
);



request.end();



});


}





/*
==================================================
MARKTPLAATS EXTRA JSON EXTRACTOR
==================================================
*/


function extractMarktplaatsData(html){


const result={

images:[],
price:null,
title:null

};



if(!html){
return result;
}



/*
 NEXT DATA JSON
*/


const next =
html.match(
/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s
);



if(next){


try{


const json=
JSON.parse(next[1]);



const str=
JSON.stringify(json);



result.images =
[
...str.matchAll(
/https?:\/\/[^"\\]+?\.(?:jpg|jpeg|png|webp)[^"\\]*/gi
)

]
.map(x=>x[0]);



const price =
str.match(
/"price(?:Cents)?":\s*"?(\d+)/i
);



if(price){

result.price =
parseInt(price[1]);

if(result.price>100000){

result.price =
Math.round(
result.price/100
);

}

}



}

catch(e){}



}




/*
 OG IMAGE FALLBACK
*/


const og =
html.matchAll(
/property="og:image"\s+content="([^"]+)"/gi
);



for(const x of og){

result.images.push(x[1]);

}



return result;


}


}
