const https = require('https');
const http = require('http');

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin','*');

  const url = req.query.url;

  if(!url){
    return res.status(400).json({
      error:'Geen URL opgegeven'
    });
  }


  try{

    const html = await fetchUrl(url);

    res.status(200).json({
      html: html.substring(0,200000)
    });

  }catch(e){

    res.status(500).json({
      error:e.message
    });

  }

};



function fetchUrl(url, redirects=0){

return new Promise((resolve,reject)=>{


if(redirects>5){
return reject(new Error("Te veel redirects"));
}


const lib=url.startsWith("https") ? https : http;


const request=lib.get(url,{

headers:{

'User-Agent':
'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',

'Accept':
'text/html',

'Accept-Language':
'nl-NL,nl;q=0.9,en;q=0.8'

}

},response=>{


if(
response.statusCode>=300 &&
response.statusCode<400 &&
response.headers.location
){

return fetchUrl(
response.headers.location,
redirects+1
)
.then(resolve)
.catch(reject);

}



let data="";


response.on(
'data',
chunk=>data+=chunk
);


response.on(
'end',
()=>resolve(data)
);


});


request.on(
'error',
reject
);


request.setTimeout(
15000,
()=>{
request.destroy();
reject(new Error("Timeout"));
}
);


});

}