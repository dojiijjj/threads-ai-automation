const express=require("express");
const dns=require("dns").promises;
const net=require("net");
const path=require("path");
const app=express();
app.use(express.json({limit:"14mb"}));
app.use(express.static(path.join(__dirname,"public")));
const PORT=process.env.PORT||3000;
const MODELS=["gemini-3.8-flash","gemini-3.6-flash","gemini-3.5-flash-lite"];
const clean=(v,n=3000)=>String(v||"").trim().slice(0,n);
function urlOf(v){const m=String(v||"").match(/https?:\/\/[^\s<>"']+/i);if(!m)throw new Error("상품 URL을 입력해 주세요.");const u=new URL(m[0].replace(/[.,!?;:，。！？；：)\]}》〉」』】]+$/u,""));if(!["http:","https:"].includes(u.protocol)||u.username||u.password)throw new Error("올바른 상품 URL이 아닙니다.");return u.toString();}
function privateIp(a){if(net.isIPv4(a)){const p=a.split(".").map(Number);return p[0]===0||p[0]===10||p[0]===127||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||p[0]>=224;}if(net.isIPv6(a)){const x=a.toLowerCase();return x==="::"||x==="::1"||x.startsWith("fc")||x.startsWith("fd")||x.startsWith("fe8")||x.startsWith("fe9")||x.startsWith("fea")||x.startsWith("feb");}return true;}
async function checkHost(u){const h=new URL(u).hostname.toLowerCase();if(h==="localhost"||h.endsWith(".local")||h.endsWith(".localhost"))throw new Error("내부 주소는 사용할 수 없습니다.");if(net.isIP(h)){if(privateIp(h))throw new Error("내부 네트워크 주소는 사용할 수 없습니다.");return;}const rows=await dns.lookup(h,{all:true});if(!rows.length||rows.some(x=>privateIp(x.address)))throw new Error("안전하지 않은 주소입니다.");}
async function fetchPage(raw,depth=0){const u=urlOf(raw);await checkHost(u);const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);try{const r=await fetch(u,{redirect:"manual",signal:c.signal,headers:{"User-Agent":"Mozilla/5.0","Accept":"text/html"}});if([301,302,303,307,308].includes(r.status)){if(depth>=3)throw new Error("링크 이동이 너무 많습니다.");const loc=r.headers.get("location");if(!loc)throw new Error("이동 주소를 확인할 수 없습니다.");return fetchPage(new URL(loc,u).toString(),depth+1);}if(!r.ok)throw new Error("상품 페이지를 열지 못했습니다. HTTP "+r.status);const type=r.headers.get("content-type")||"";if(!/text\/html|application\/xhtml\+xml/i.test(type))throw new Error("상품 정보를 읽을 수 없는 페이지입니다.");const reader=r.body.getReader();let bytes=0,parts=[];while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1200000){await reader.cancel();break;}parts.push(Buffer.from(value));}return Buffer.concat(parts).toString("utf8");}catch(e){if(e.name==="AbortError")throw new Error("상품 페이지 응답 시간이 초과됐습니다.");throw e;}finally{clearTimeout(t);}}
function decode(s){return String(s||"").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/\s+/g," ").trim();}
function meta(html,key){for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){const a={};tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g,(_,k,z,d,s,b)=>(a[k.toLowerCase()]=d??s??b,z));if((a.property||"").toLowerCase()===key||(a.name||"").toLowerCase()===key)return decode(a.content);}return "";}
function findProductNode(value){
 if(!value)return null;
 if(Array.isArray(value)){for(const item of value){const found=findProductNode(item);if(found)return found;}return null;}
 if(typeof value!=="object")return null;
 const type=value["@type"];
 if((Array.isArray(type)?type:[type]).some(x=>String(x||"").toLowerCase()==="product"))return value;
 if(value["@graph"]){const found=findProductNode(value["@graph"]);if(found)return found;}
 for(const key of Object.keys(value)){if(key==="offers"||key==="brand")continue;const found=findProductNode(value[key]);if(found)return found;}
 return null;
}
function productImageList(html,baseUrl,productNode){
 const raw=[];
 const add=(value)=>{for(const item of (Array.isArray(value)?value:[value])){if(typeof item!=="string")continue;try{const u=new URL(item,baseUrl);if(u.protocol==="https:"&&!u.username&&!u.password&&!/sprite|logo|icon|pixel|blank|placeholder/i.test(u.pathname))raw.push(u.toString());}catch(_){}}};
 add(meta(html,"og:image"));add(meta(html,"og:image:secure_url"));add(meta(html,"twitter:image"));
 if(productNode)add(productNode.image);
 const tags=html.match(/<img\b[^>]*>/gi)||[];
 for(const tag of tags.slice(0,90)){
  const attrs={};tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g,(_,k,z,d,s,v)=>(attrs[k.toLowerCase()]=d??s??v,z));
  add(attrs["data-src"]||attrs["data-original"]||attrs.src||attrs["data-lazy-src"]);
 }
 return [...new Set(raw)].slice(0,8);
}
function extractProductInfo(html,baseUrl){
 const titleTag=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
 const title=meta(html,"og:title")||meta(html,"twitter:title")||decode(titleTag?titleTag[1].replace(/<[^>]+>/g," "):"");
 const description=meta(html,"og:description")||meta(html,"description")||meta(html,"twitter:description")||"";
 let productNode=null;
 for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const parsed=JSON.parse(match[1].trim());productNode=findProductNode(parsed);if(productNode)break;}catch(_){}
 }
 const name=clean(productNode?.name||title,300);
 const brandValue=productNode?.brand;
 const brand=clean(typeof brandValue==="string"?brandValue:brandValue?.name||meta(html,"product:brand")||meta(html,"brand"),160);
 const offer=Array.isArray(productNode?.offers)?productNode.offers[0]:(productNode?.offers||{});
 const price=clean(offer.price||offer.lowPrice||meta(html,"product:price:amount")||"",60);
 const currency=clean(offer.priceCurrency||meta(html,"product:price:currency")||"",8);
 const availability=clean(String(offer.availability||"").split("/").pop()||"",60);
 const sku=clean(productNode?.sku||productNode?.mpn||"",80);
 const features=[];
 if(Array.isArray(productNode?.additionalProperty)){
  for(const p of productNode.additionalProperty.slice(0,18)){const n=clean(p.name,80),v=clean(p.value,180);if(n&&v)features.push(n+": "+v);}
 }
 const pageText=decode(html
  .replace(/<!--[\s\S]*?-->/g," ")
  .replace(/<(script|style|svg|noscript|header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
  .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi,"\n")
  .replace(/<[^>]+>/g," ")
 ).slice(0,9000);
 const images=productImageList(html,baseUrl,productNode);
 return {url:baseUrl,title:name||title,description:clean(description,1800),brand,price,currency,availability,sku,features,images,pageText};
}
app.get("/api/preview",async(req,res)=>{
 try{
  const url=urlOf(req.query.url),html=await fetchPage(url),product=extractProductInfo(html,url);
  res.json({ok:true,...product,images:product.images.slice(0,5)});
 }catch(e){res.status(422).json({error:e.message||"상품 정보를 읽지 못했습니다."});}
});
function stripMeta(value){return decode(String(value||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ")).slice(0,350);}
function licenseAllowed(value){const s=String(value||"").trim().toUpperCase();return s==="CC0"||s.includes("PUBLIC DOMAIN")||/^CC BY(?:-SA)?(?:\s|$)/.test(s);}
async function searchCommons(query){
 const params=new URLSearchParams({action:"query",format:"json",formatversion:"2",generator:"search",gsrsearch:query,gsrnamespace:"6",gsrlimit:"18",prop:"imageinfo",iiprop:"url|extmetadata",iiurlwidth:"1100"});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),14000);
 try{
  const response=await fetch("https://commons.wikimedia.org/w/api.php?"+params.toString(),{signal:controller.signal,headers:{"User-Agent":"BlogContentAssistant/1.0 (image search)","Accept":"application/json"}});
  if(!response.ok)throw new Error("Wikimedia Commons 응답 오류 "+response.status);
  const data=await response.json();
  const pages=Array.isArray(data.query?.pages)?data.query.pages:[];
  return pages.map(page=>{
   const info=page.imageinfo?.[0]||{},ext=info.extmetadata||{};
   const license=stripMeta(ext.LicenseShortName?.value||ext.UsageTerms?.value||"");
   if(!licenseAllowed(license)||!info.thumburl&&!info.url)return null;
   const sourceUrl=info.descriptionurl||("https://commons.wikimedia.org/wiki/"+encodeURIComponent(String(page.title||"").replace(/ /g,"_")));
   const thumbUrl=info.thumburl||info.url;
   if(!/^https:\/\/upload\.wikimedia\.org\//i.test(thumbUrl))return null;
   return {id:page.pageid||page.title,title:String(page.title||"").replace(/^File:/,"").replace(/_/g," "),thumbUrl,originalUrl:info.url||thumbUrl,sourceUrl,artist:stripMeta(ext.Artist?.value||ext.Credit?.value||"저작자 정보 없음"),license,licenseUrl:ext.LicenseUrl?.value||"",description:stripMeta(ext.ImageDescription?.value||"")};
  }).filter(Boolean);
 }finally{clearTimeout(timer);}
}
app.post("/api/images",async(req,res)=>{
 const queries=Array.isArray(req.body.queries)?req.body.queries.map(x=>clean(x,100)).filter(Boolean).slice(0,5):[];
 const productUrl=clean(req.body.productUrl,2000);
 const productImages=Array.isArray(req.body.productImages)?req.body.productImages.slice(0,3):[];
 if(!queries.length&&!productImages.length)return res.status(400).json({error:"이미지 검색어가 없습니다."});
 try{
  const images=[],seen=new Set();
  for(const p of productImages){
   try{
    const u=new URL(p.url);
    if(u.protocol!=="https:"||u.username||u.password||seen.has(u.href))continue;
    seen.add(u.href);
    images.push({id:"product-"+images.length,title:clean(p.title||"상품 대표 이미지",180),thumbUrl:u.href,originalUrl:u.href,sourceUrl:productUrl||u.origin,artist:"상품 판매 페이지",license:"판매처 이미지 이용 조건 확인 필요",licenseUrl:"",description:"상품 페이지에서 가져온 대표 이미지",kind:"product"});
   }catch(_){}
  }
  const batches=await Promise.all(queries.map(q=>searchCommons(q).catch(e=>{console.warn("Commons search:",q,e.message);return [];})));
  for(let i=0;i<batches.length;i++)for(const item of batches[i]){
   const key=item.id||item.originalUrl;if(seen.has(key))continue;seen.add(key);
   images.push({...item,query:queries[i],kind:"commons"});if(images.length>=5)break;
  }
  res.json({images:images.slice(0,5),searched:queries});
 }catch(e){res.status(502).json({error:e.message||"관련 이미지를 찾지 못했습니다."});}
});
app.post("/api/generate",async(req,res)=>{
 if(!process.env.GEMINI_API_KEY)return res.status(503).json({error:"Railway 환경변수 GEMINI_API_KEY가 필요합니다."});
 let url="";
 try{url=urlOf(req.body.url);}catch(e){return res.status(400).json({error:e.message});}
 try{
  const html=await fetchPage(url);
  const product=extractProductInfo(html,url);
  if(!product.title&&!product.description&&!product.pageText)return res.status(422).json({error:"상품 페이지에서 정보를 읽지 못했습니다. 주소가 실제 상품 상세페이지인지 확인해 주세요."});
  const prompt=[
   "너는 Google 검색 SEO를 전문으로 하는 한국어 제품 블로그 작가다.",
   "사용자가 제공한 상품 URL에서 실제로 읽어온 정보만 근거로 자연스럽고 신뢰도 높은 상품 소개 포스팅을 작성한다.",
   "상품명: "+product.title,
   "브랜드: "+product.brand,
   "판매 페이지 설명: "+product.description,
   "가격: "+[product.price,product.currency].filter(Boolean).join(" ")+" (페이지에 있을 때만)",
   "판매 상태: "+product.availability,
   "상품 코드: "+product.sku,
   "구조화된 상품 특징: "+product.features.join("; "),
   "페이지에서 추출한 추가 정보: "+product.pageText,
   "원본 상품 URL: "+url,
   "작성 원칙: 친절한 존댓말, 실제 사람이 읽기 좋은 흐름, 검색 의도에 맞는 충분한 정보, 과도한 광고 문구와 키워드 반복 금지.",
   "기본 분량은 공백 포함 약 1600자(1300~1900자). 검색자가 이 제품을 이해하고 구매 전 확인할 사항까지 판단할 수 있게 써.",
   "제목은 상품명과 가장 중요한 검색 키워드를 포함하되 과장하거나 클릭베이트로 쓰지 마.",
   "핵심 키워드 3개를 추천하고 제목과 첫 문단, 적절한 소제목에 자연스럽게 녹여. 키워드 밀도를 위해 부자연스럽게 반복하지 마.",
   "본문 구성: 자연스러운 도입, 제품 개요, 확인된 주요 특징과 사용 환경, 장점, 구매 전 확인할 점, 간결한 마무리. 필요한 만큼 소제목을 사용해.",
   "실제 사용 경험이나 사용자가 제공한 후기가 없다. 직접 사용해봤다, 구매했다, 만족했다, 몇 주 써봤다, 가족이 좋아했다 등의 체험담을 절대 꾸며내지 마. 리뷰어처럼 친근하게 설명하되 객관적인 제품 소개/분석으로 작성해.",
   "가격, 사양, 재료, 사이즈, 기능, 성능, 배송, 평점, 할인율, 효능 등은 페이지에서 확인한 내용만 써. 확인 안 된 정보는 만들어내지 말고, 필요하면 구매 전 상세페이지에서 확인하라고 안내해.",
   "페이지 정보가 빈약하면 일반적인 장점을 사실처럼 단정하지 말고, 확인 가능한 정보와 구매 전 체크리스트 중심으로 작성해.",
   "본문에 이미지 배치 위치를 [[IMAGE_1]]부터 [[IMAGE_5]]까지 각각 한 번씩 문단 사이에 단독 줄로 표시해.",
   "상품 사진 1~2장은 상품 상세 페이지에서 추출한 이미지를 우선 사용한다. 나머지 관련 사진 검색어는 짧은 영어 검색어로 총 5개 제안해. 중복되지 않고 제품 카테고리 및 맥락에 맞는 장면을 찾아.",
   "각 이미지에 대해 자연스러운 alt 텍스트, 캡션, 본문 내 권장 배치 위치를 제안해.",
   "결과는 유효한 JSON 객체만 출력: keywords(문자열 3개 배열), title(문자열), body(문자열), imageQueries(영어 검색어 5개 배열), imageAlts(문자열 5개 배열), imageCaptions(문자열 5개 배열), imagePlacements(문자열 5개 배열). JSON 외 다른 설명, 마크다운 코드블록은 금지."
  ].join("\n");
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
  let lastError="응답 없음";
  try{
   for(const model of MODELS){
    for(let attempt=0;attempt<2;attempt++){
     try{
      const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:3800,responseMimeType:"application/json"}}),signal:controller.signal});
      const data=await response.json().catch(()=>({}));
      if(response.ok){
       const raw=data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim()||"";
       const result=JSON.parse(raw);
       if(!result.title||!result.body)throw new Error("AI 결과에 제목 또는 본문이 없습니다.");
       const arr=(v,n)=>Array.isArray(v)?v.map(x=>String(x||"").trim()).filter(Boolean).slice(0,n):[];
       result.keywords=arr(result.keywords,3);result.imageQueries=arr(result.imageQueries,5);
       result.imageAlts=arr(result.imageAlts,5);result.imageCaptions=arr(result.imageCaptions,5);result.imagePlacements=arr(result.imagePlacements,5);
       while(result.keywords.length<3)result.keywords.push(product.title);
       while(result.imageQueries.length<5)result.imageQueries.push(product.title+" product detail");
       while(result.imageAlts.length<5)result.imageAlts.push(result.imageQueries[result.imageAlts.length]);
       while(result.imageCaptions.length<5)result.imageCaptions.push(result.imageAlts[result.imageCaptions.length]);
       while(result.imagePlacements.length<5)result.imagePlacements.push(["도입부 다음","제품 개요 뒤","주요 특징 설명 뒤","구매 전 확인 사항 근처","마무리 전"][result.imagePlacements.length]);
       return res.json({...result,product:{title:product.title,brand:product.brand,price:product.price,currency:product.currency,description:product.description,url,images:product.images.slice(0,3)},model});
      }
      const message=data.error?.message||("Gemini 오류 "+response.status);lastError=model+" / "+response.status+" / "+message;
      if([400,401,403].includes(response.status))return res.status(response.status).json({error:lastError});
      if(![404,429,500,502,503,504].includes(response.status))return res.status(502).json({error:lastError});
      if(attempt===0)await new Promise(resolve=>setTimeout(resolve,1200));else break;
     }catch(e){if(e.name==="AbortError")throw e;lastError=e.message||String(e);if(attempt===0)await new Promise(resolve=>setTimeout(resolve,1000));else break;}
    }
   }
   return res.status(503).json({error:"기본 모델과 대체 모델이 모두 응답하지 않습니다. 잠시 후 다시 시도해 주세요. 마지막 오류: "+lastError});
  }catch(e){return res.status(502).json({error:e.name==="AbortError"?"글 생성 시간이 초과됐습니다. 다시 시도해 주세요.":e.message});}
  finally{clearTimeout(timer);}
 }catch(e){return res.status(422).json({error:"상품 링크에서 정보를 가져오지 못했습니다: "+e.message});}
});
app.get("/api/status",(req,res)=>res.json({ok:true,aiConfigured:Boolean(process.env.GEMINI_API_KEY),models:MODELS,mode:"SEO 블로그 작성"}));
app.listen(PORT,()=>console.log("Blog writer listening on "+PORT));
