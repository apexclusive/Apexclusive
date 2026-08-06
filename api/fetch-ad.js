function extractImages(html){

const images = [];

const patterns = [
/"image"\s*:\s*"([^"]+)"/gi,
/"imageUrl"\s*:\s*"([^"]+)"/gi,
/"originalUrl"\s*:\s*"([^"]+)"/gi,
/"fullImageUrl"\s*:\s*"([^"]+)"/gi,
/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/gi
];


patterns.forEach(pattern => {

let match;

while((match = pattern.exec(html)) !== null){

let img = match[1];

if(!img) continue;

img = img
.replace(/\\u002F/g,"/")
.replace(/\\/g,"");


if(
!img.includes("logo") &&
!img.includes("dealer") &&
!img.includes("placeholder")
){

if(!images.includes(img)){
images.push(img);
}

}

}

});

return images.slice(0,10);

}



export default async function handler(req,res){

const {url} = req.query;


if(!url){
return res.status(400).json({
error:"Geen URL opgegeven"
});
}


try {


const response = await fetch(url,{
headers:{
"User-Agent":
"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
}
});


const html = await response.text();


const images = extractImages(html);


return res.status(200).json({
html:html,
images:images
});


}catch(e){

console.error(e);

return res.status(500).json({
error:e.message
});

}

}
