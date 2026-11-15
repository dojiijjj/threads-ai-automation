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
app.get("/api/preview",async(req,res)=>{try{const u=urlOf(req.query.url),h=await fetchPage(u),tm=h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);const title=meta(h,"og:title")||meta(h,"twitter:title")||decode(tm?tm[1].replace(/<[^>]+>/g," "):"");const description=meta(h,"og:description")||meta(h,"description")||meta(h,"twitter:description");const imageRaw=meta(h,"og:image")||meta(h,"og:image:secure_url")||meta(h,"twitter:image");let image="";try{const x=new URL(imageRaw,u);if(["http:","https:"].includes(x.protocol))image=x.toString();}catch(_){}res.json({title:title.slice(0,300),description:description.slice(0,1500),image,url:u});}catch(e){res.status(422).json({error:e.message});}});

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
 if(!queries.length)return res.status(400).json({error:"이미지 검색어가 없습니다."});
 try{
  const batches=await Promise.all(queries.map(q=>searchCommons(q).catch(e=>{console.warn("Commons search:",q,e.message);return [];})));
  const seen=new Set(),images=[];
  for(let i=0;i<batches.length;i++)for(const item of batches[i]){
   const key=item.id||item.originalUrl;if(seen.has(key))continue;seen.add(key);
   images.push({...item,query:queries[i]});if(images.length>=5)break;
  }
  res.json({images:images.slice(0,5),searched:queries});
 }catch(e){res.status(502).json({error:e.message||"관련 이미지를 찾지 못했습니다."});}
});
app.post("/api/generate",async(req,res)=>{
 if(!process.env.GEMINI_API_KEY)return res.status(503).json({error:"Railway 환경변수 GEMINI_API_KEY가 필요합니다."});
 const channel=["naver","google"].includes(req.body.channel)?req.body.channel:"naver";
 const topic=clean(req.body.topic,300),brand=clean(req.body.brand,240),product=clean(req.body.product,240);
 const subject=[brand,product,topic].filter(Boolean).join(" ");
 const keywords=Array.isArray(req.body.keywords)?req.body.keywords.map(x=>clean(x,60)).filter(Boolean).slice(0,3):String(req.body.keywords||"").split(/[,\n]/).map(x=>clean(x,60)).filter(Boolean).slice(0,3);
 const perspective=["reviewer","supplier"].includes(req.body.perspective)?req.body.perspective:"reviewer";
 const style=["expert","influencer"].includes(req.body.style)?req.body.style:"expert";
 const draft=clean(req.body.draft,10000),extra=clean(req.body.extra,2000);
 if(!subject&&!draft)return res.status(400).json({error:"글 주제나 초안을 입력해 주세요."});
 const photos=Array.isArray(req.body.photos)?req.body.photos.slice(0,5):[];
 const prompt=[
  "역할: 너는 네이버 블로그 SEO 전문 작가이자 콘텐츠 마케팅 전문가다. 검색엔진만이 아니라 실제 독자가 읽었을 때 유용하고 신뢰할 수 있는 한국어 블로그 글을 쓴다.",
  "채널 최적화: "+(channel==="naver"?"네이버 블로그. 검색 의도에 맞춘 구체적인 정보, 자연스러운 제목과 소제목, 읽기 쉬운 문단을 우선한다.":"구글 검색 SEO. 검색 의도 충족, 명확한 H2/H3 구조, 충분한 맥락과 구체적인 설명, 자연스러운 관련 용어 사용을 우선한다."),
  "글 주제/제품: "+(subject||"초안 기반"),
  "핵심 키워드(사용자 입력): "+(keywords.join(", ")||"입력되지 않음. 주제에 맞게 3개 추천"),
  "작성자 관점: "+(perspective==="reviewer"?"리뷰어 관점":"공급자/브랜드 제공자 관점"),
  "문체: "+(style==="expert"?"전문가. 정확하고 신뢰도 높은 설명, 용어를 쉬운 말로 풀어 쓰기":"인플루언서. 친근하고 생동감 있는 표현, 독자와 대화하는 듯한 호흡"),
  "기존 초안(있으면 내용과 형식을 최대한 유지하면서 개선): "+(draft||"없음"),
  "추가 요청: "+(extra||"없음"),
  "첨부된 사진이 있다면 사진에서 실제로 확인할 수 있는 제품/장면만 묘사하고, 사진에 없는 정보나 사용 경험을 만들어내지 마.",
  "작성 원칙: 자연스럽고 사람다운 문장, 친절한 존댓말, 검색 의도에 직접 답변, 키워드는 문맥에 맞게 반복, 제목에 핵심 키워드 포함, 문단마다 적절한 소제목, 모바일에서 읽기 쉬운 문단 길이, 과장 광고와 키워드 남용 금지.",
  "핵심 키워드는 정확히 3개 제안. 사용자 키워드가 있으면 최대한 반영하되 주제와 맞지 않는 키워드는 억지로 넣지 말고 더 적합한 것으로 교체.",
  "본문 첫 문단에 핵심 키워드를 자연스럽게 포함. 소제목의 약 절반에 핵심 키워드 또는 연관 표현을 자연스럽게 포함. 문장마다 키워드를 반복하지 마.",
  "실제 경험이 제공되지 않았다면 사용·구매·체험했다고 쓰지 마. 리뷰어 관점일 때는 제공된 실제 경험만 1인칭으로 표현하고, 경험이 없으면 제품 정보 기반의 객관적 검토/소개로 작성. 공급자 관점에서도 인증·효능·수치·가격·배송 정보 등 미제공 사실을 만들지 마.",
  "기본 분량은 본문 약 1600자(공백 포함, 대략 1300~1900자). 초안 재작성 시 원문의 핵심 정보와 논리, 구성은 최대한 보존해.",
  "이미지 검색을 위한 짧은 영어 검색어 5개를 생성해. 서로 다른 장면과 주제를 찾도록 하고 제품/주제와 직접 관련되게 작성해. 생성한 5개 이미지에 대해 각각 대체 텍스트(alt), 짧은 캡션, 본문 내 권장 배치 위치를 생성해.",
  "본문에는 소제목과 자연스러운 문단을 구성하고, 이미지 5개를 넣을 위치를 본문 문단 사이에 [[IMAGE_1]]부터 [[IMAGE_5]]까지 각각 한 번씩 표시해. 이미지 표시는 문장 중간이 아닌 문단 사이 단독 줄에 둬.",
  "네이버 블로그 태그 20개를 제안해. # 없이 단어/짧은 구 형태로 배열해.",
  "결과는 아래 키를 갖는 유효한 JSON 객체만 출력해: keywords(문자열 3개 배열), title(문자열), body(문자열), tags(문자열 20개 배열), imageQueries(영어 검색어 5개 배열), imageAlts(문자열 5개 배열), imageCaptions(문자열 5개 배열), imagePlacements(문자열 5개 배열). 마크다운 코드블록이나 JSON 외 해설은 금지."
 ].join("\n");
 const parts=[{text:prompt}];
 for(const p of photos){if(p&&typeof p.data==="string"){const m=p.data.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);if(m&&m[2].length<1800000)parts.push({inlineData:{mimeType:m[1],data:m[2]}});}}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
 let lastError="응답 없음";
 try{
  for(const model of MODELS){
   for(let attempt=0;attempt<2;attempt++){
    try{
     const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{parts}],generationConfig:{temperature:0.7,maxOutputTokens:3500,responseMimeType:"application/json"}}),signal:controller.signal});
     const data=await response.json().catch(()=>({}));
     if(response.ok){
      const raw=data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim()||"";
      const result=JSON.parse(raw.replace(/^\s*\x60{3}json\s*|\s*\x60{3}$/g,""));
      if(!result.title||!result.body)throw new Error("AI 결과에 제목 또는 본문이 없습니다.");
      const arr=(v,n)=>Array.isArray(v)?v.map(x=>String(x||"").trim()).filter(Boolean).slice(0,n):[];
      result.keywords=arr(result.keywords,3);result.tags=arr(result.tags,20);
      result.imageQueries=arr(result.imageQueries,5);result.imageAlts=arr(result.imageAlts,5);result.imageCaptions=arr(result.imageCaptions,5);result.imagePlacements=arr(result.imagePlacements,5);
      while(result.keywords.length<3)result.keywords.push(subject||topic||"블로그 정보");
      while(result.tags.length<20)result.tags.push(result.keywords[result.tags.length%3]);
      while(result.imageQueries.length<5)result.imageQueries.push((subject||topic||"related subject")+" "+["details","use","features","lifestyle","close up"][result.imageQueries.length]);
      while(result.imageAlts.length<5)result.imageAlts.push(result.imageQueries[result.imageAlts.length]);
      while(result.imageCaptions.length<5)result.imageCaptions.push(result.imageAlts[result.imageCaptions.length]);
      while(result.imagePlacements.length<5)result.imagePlacements.push(["도입부 다음","첫 번째 특징 설명 뒤","두 번째 특징 설명 뒤","구매 전 확인 사항 근처","마무리 전"][result.imagePlacements.length]);
      return res.json({...result,model,channel});
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
});
app.get("/api/status",(req,res)=>res.json({ok:true,aiConfigured:Boolean(process.env.GEMINI_API_KEY),models:MODELS,mode:"SEO 블로그 작성"}));
app.listen(PORT,()=>console.log("Blog writer listening on "+PORT));
