const express=require("express");
const dns=require("dns").promises;
const net=require("net");
const path=require("path");
const app=express();
app.use(express.json({limit:"14mb"}));
app.use(express.static(path.join(__dirname,"public")));
const PORT=process.env.PORT||3000;
const MODELS=["gemini-3.8-flash","gemini-3.6-flash","gemini-3.5-flash-lite"];
const productCache=new Map();
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
  productCache.set(url,{product,createdAt:Date.now()});
  res.json({ok:true,...product,images:product.images.slice(0,5)});
 }catch(e){res.status(422).json({error:e.message||"상품 정보를 읽지 못했습니다."});}
});
function stripMeta(value){return decode(String(value||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ")).slice(0,350);}
function licenseAllowed(value){const s=String(value||"").trim().toUpperCase();return s==="CC0"||s.includes("PUBLIC DOMAIN");}
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
 if(!queries.length)return res.status(400).json({error:"이미지 검색어가 없습니다."});
 try{
  const batches=await Promise.all(queries.map(q=>searchCommons(q).catch(e=>{console.warn("Commons search:",q,e.message);return [];})));
  const seen=new Set(),images=[];
  for(let i=0;i<batches.length;i++)for(const item of batches[i]){
   const key=item.id||item.originalUrl;if(seen.has(key))continue;seen.add(key);
   images.push({...item,query:queries[i],kind:"commons"});
   if(images.length>=5)break;
  }
  res.json({images:images.slice(0,5),searched:queries});
 }catch(e){res.status(502).json({error:e.message||"관련 이미지를 찾지 못했습니다."});}
});
function cleanBlogText(value){
 return String(value||"").replace(/\r/g,"")
  .replace(/^\s{0,3}#{1,6}\s*/gm,"")
  .replace(/^[ \t]*[-*+][ \t]+/gm,"")
  .replace(/^[ \t]*\d+[.)][ \t]+/gm,"")
  .replace(/^[ \t]*>+[ \t]?/gm,"")
  .replace(/\*\*(.*?)\*\*/g,"$1")
  .replace(/__(.*?)__/g,"$1")
  .replace(/\[([^\]]+)\]\([^)]+\)/g,"$1")
  .replace(/[#*_[\]~|{}<>]/g,"")
  .replace(/\x60/g,"")
  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu,"")
  .replace(/\n{3,}/g,"\n\n")
  .trim();
}
app.post("/api/generate",async(req,res)=>{
 if(!process.env.GEMINI_API_KEY)return res.status(503).json({error:"Railway 환경변수 GEMINI_API_KEY가 필요합니다."});
 let url="";
 try{url=urlOf(req.body.url);}catch(e){return res.status(400).json({error:e.message});}
 try{
  const cached=productCache.get(url);
  if(!cached||Date.now()-cached.createdAt>30*60*1000)return res.status(409).json({error:"상품 정보가 만료됐습니다. 링크로 상품 정보를 먼저 불러와 주세요."});
  const product=cached.product;
  if(!product.title&&!product.description&&!product.pageText)return res.status(422).json({error:"상품 페이지에서 정보를 읽지 못했습니다. 주소가 실제 상품 상세페이지인지 확인해 주세요."});
  const prompt=[
  "역할: 당신은 10년 경력의 전문 블로거이자 검색엔진 최적화 컨설턴트입니다. 구글 검색 의도를 정확히 파악하고 독자의 체류 시간을 높이는 정보성 상품 포스팅을 작성합니다.",
  "임무: 제공된 상품 상세페이지의 실제 정보를 분석하여 해당 상품을 검색하는 사람이 궁금해할 내용을 충분히 설명하는 한국어 블로그 글을 작성합니다.",
  "상품명: "+product.title,
  "브랜드: "+(product.brand||"상품 페이지에서 확인되지 않음"),
  "페이지 설명: "+(product.description||"상세 설명이 제공되지 않음"),
  "가격: "+([product.price,product.currency].filter(Boolean).join(" ")||"페이지에서 확인되지 않음"),
  "판매 상태: "+(product.availability||"페이지에서 확인되지 않음"),
  "제품 코드: "+(product.sku||"확인되지 않음"),
  "확인된 주요 특징: "+(product.features.join("; ")||"구조화된 상세 특징 없음"),
  "상품 페이지에서 추출한 추가 내용: "+product.pageText,
  "원본 상품 URL: "+url,
  "작성 분량: 공백 포함 약 4000자에서 5000자 사이. 제목은 분량에서 제외하고 본문만 기준으로 합니다. 상품의 특징, 사용 환경, 선택 기준, 구매 전 확인 사항을 실제 정보에 기반해 충분히 설명합니다.",
  "핵심 키워드: 상품명과 제품 카테고리에서 검색 가능성이 높은 메인 키워드 1개와 서브 키워드 2개를 도출합니다. 메인 키워드는 제목 앞부분과 도입부 첫 2~3문장 안에 자연스럽게 배치하고 본문 전체에서 3~5회 사용합니다. 서브 키워드는 문맥에 맞게 사용합니다.",
  "제목: 메인 키워드를 최대한 앞쪽에 배치합니다. 검색자가 얻을 정보를 분명히 보여주고 자연스러운 관심을 유도합니다. 과장 표현은 금지합니다.",
  "도입부: 독자가 상품을 찾게 된 고민이나 상황을 짚어 공감대를 형성합니다. 첫 2~3문장에 메인 키워드를 자연스럽게 포함합니다.",
  "본문 구조: 기호 없이 짧고 명확한 소제목을 여러 개 배치합니다. 제품 개요, 핵심 특징, 각 특징이 실제로 의미하는 점, 적합한 사용자, 비슷한 제품을 비교할 때 확인할 기준, 구매 전 체크할 점 순으로 자연스럽게 전개합니다. 소제목 아래에는 구체적인 설명과 실용적인 정보를 담습니다.",
  "활용 팁과 비교 분석: 단순한 특징 나열에 그치지 말고 독자가 선택할 때 확인할 조건, 사용 환경에 따른 차이, 구매 전에 비교할 항목을 구체적으로 제안합니다. 실제 확인되지 않은 경쟁 제품의 성능이나 수치와 비교하지 마세요.",
  "결론: 핵심 내용을 정확히 세 문장으로 정리한 뒤, 독자가 자신의 조건을 댓글이나 생각으로 나눌 수 있도록 자연스럽게 마무리합니다.",
  "문체: 친근하고 공감 가는 자연스러운 존댓말을 사용합니다. 전문가처럼 정확하되 딱딱하지 않게 씁니다. 어색한 문어체와 AI 특유의 정형화된 말투는 피합니다.",
  "금지 표현: '요약하자면', '또한', '그리고', '따라서'를 습관적으로 반복하지 않습니다. '~합니다만', '~할 수 있습니다' 같은 뻔한 문장 틀을 반복하지 않습니다. '~이다', '~한다' 문어체를 반복하지 않습니다.",
  "사실성: 실제 사용 경험이 제공되지 않았습니다. 직접 구매했다, 사용해 봤다, 만족했다, 가족이 써 봤다는 경험담을 절대 꾸며내지 마세요. 확인되지 않은 가격, 할인, 사양, 기능, 효능, 소재, 구성, 배송, 재고, 평점, 인증, 내구성을 만들지 마세요. 정보가 부족한 항목은 확인되지 않았다고 말하거나 구매 전 상세페이지에서 확인할 항목으로 안내합니다.",
  "문자 형식: 본문과 제목은 일반 텍스트만 사용합니다. 해시태그, 샵 기호, 별표, 밑줄, 백틱, 대괄호, 중괄호, 인용 블록, 마크다운 문법, HTML 태그, 이모지, 장식용 구분선, 특수 기호를 넣지 마세요. 번호 목록이나 불릿 목록 대신 자연스러운 문단과 소제목으로 작성합니다. 소제목은 기호 없이 문장만 단독 줄에 적습니다.",
  "사진: 본문 중간에 사진 자리표시자나 출처, 저작자, 라이선스, URL을 쓰지 마세요. 사진 배치는 프로그램이 본문 문단 사이에 자동으로 넣습니다. 사진 캡션도 본문에 생성하지 마세요.",
  "이미지 검색: 관련 사진을 자동으로 찾기 위한 서로 다른 영어 검색어 5개를 생성합니다. 제품 카테고리, 구조, 관련 사용 환경, 디테일을 보여주는 사진을 고릅니다. 사진 검색어는 상품과 직접 관련되게 구체적으로 작성합니다. 각 사진에 대한 대체 텍스트와 짧은 설명도 별도 JSON 필드로 작성합니다.",
  "해시태그: 상품명, 브랜드, 제품 종류, 구매 의도와 관련된 실제 검색어를 바탕으로 서로 겹치지 않는 해시태그 20개를 만듭니다. 너무 넓은 단어와 무관한 유행어는 제외합니다. 각 태그는 #을 포함하지 않은 단어 또는 짧은 구로 JSON 배열에 담습니다. 게시글 맨 마지막에 해시태그 20개를 한 줄로 붙입니다. 이 해시태그 줄 외에는 # 기호를 절대 사용하지 않습니다.",
  "출력: 유효한 JSON 객체 하나만 출력합니다. 키는 keywords(메인 키워드 1개와 서브 키워드 2개, 문자열 배열 3개), title(문자열), body(문자열), hashtags(문자열 20개 배열), imageQueries(영어 검색어 5개 배열), imageAlts(문자열 5개 배열), imageCaptions(문자열 5개 배열), imagePlacements(문자열 5개 배열)입니다. JSON 외 설명이나 마크다운 코드블록은 출력하지 않습니다."
 ].join("\n");
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
  let lastError="응답 없음";
  try{
   for(const model of MODELS){
    for(let attempt=0;attempt<2;attempt++){
     try{
      const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.65,maxOutputTokens:6500,responseMimeType:"application/json"}}),signal:controller.signal});
      const data=await response.json().catch(()=>({}));
      if(response.ok){
       const raw=data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim()||"";
       const result=JSON.parse(raw);
       if(!result.title||!result.body)throw new Error("AI 결과에 제목 또는 본문이 없습니다.");
      result.title=cleanBlogText(result.title);
      result.body=cleanBlogText(result.body);
       const arr=(v,n)=>Array.isArray(v)?v.map(x=>String(x||"").trim()).filter(Boolean).slice(0,n):[];
       result.keywords=arr(result.keywords,3).map(cleanBlogText);
       const makeTag=value=>cleanBlogText(value).replace(/\s+/g,"").replace(/[^\p{L}\p{N}]/gu,"");
       const tags=[],addTag=value=>{const t=makeTag(value);if(t&&!tags.includes(t)&&tags.length<20)tags.push(t);};
       arr(result.hashtags,30).forEach(addTag);
       [product.title,product.brand,product.title+"추천",product.title+"정보",product.title+"가격",product.title+"특징",product.title+"비교",product.title+"구매",product.title+"선택",product.title+"제품"].forEach(addTag);
       ["제품정보","상품정보","구매가이드","제품비교","상품추천","제품특징","구매팁","제품선택","상품리뷰","제품분석"].forEach(addTag);
       while(tags.length<20)addTag(product.title+"정보"+(tags.length+1));
       result.hashtags=tags.slice(0,20);
       result.body=result.body.replace(/\s*#[^\s#]+/g,"").trim()+"\n\n"+result.hashtags.map(t=>"#"+t).join(" ");
       result.imageQueries=arr(result.imageQueries,5);
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
