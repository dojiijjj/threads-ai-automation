(()=>{
"use strict";
const $=id=>document.getElementById(id);
let productUrl="",resultData=null,foundImages=[];
function msg(t){$("message").textContent=t;}
async function api(url,opt={}){
 const r=await fetch(url,{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(d.error||"요청 실패 ("+r.status+")");
 return d;
}
function safeText(v){return String(v??"");}
function escapeHtml(v){return safeText(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
function cleanKeywordList(){return $("keywords").value.split(/[,\n]/).map(x=>x.trim()).filter(Boolean).slice(0,3);}
function toDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error("사진을 읽지 못했습니다."));reader.readAsDataURL(blob);});}
async function compressPhoto(file){
 if(!/^image\/(jpeg|png|webp)$/i.test(file.type))throw new Error("JPG, PNG, WEBP 사진만 첨부할 수 있습니다.");
 if(typeof createImageBitmap!=="function")return toDataUrl(file);
 const bitmap=await createImageBitmap(file);
 const scale=Math.min(1,1280/Math.max(bitmap.width,bitmap.height));
 const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
 const ctx=canvas.getContext("2d");ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.78));
 if(!blob)throw new Error("사진 압축에 실패했습니다.");
 return toDataUrl(blob);
}
$("photos").addEventListener("change",()=>{
 const files=Array.from($("photos").files||[]).slice(0,5);
 $("photoNames").textContent=files.length?files.map(f=>f.name).join(" · ")+" ("+files.length+"장 선택됨)":"선택한 사진이 없습니다.";
});
$("fetch").onclick=async()=>{
 const url=$("url").value.trim();if(!url){msg("먼저 참고 URL을 입력해 주세요.");return;}
 const b=$("fetch");b.disabled=true;msg("페이지 정보를 읽는 중...");
 try{
  const d=await api("/api/preview?url="+encodeURIComponent(url));
  productUrl=d.url||url;
  if(d.title&&!$("product").value.trim())$("product").value=d.title;
  if(d.description)$("description").value=d.description;
  $("productPreview").classList.remove("hidden");
  $("productInfo").textContent=(d.title||"페이지 제목 없음")+"\n"+(d.description||"설명 정보를 찾지 못했습니다.");
  if(d.image){$("productImage").src=d.image;$("productImage").classList.remove("hidden");}else $("productImage").classList.add("hidden");
  msg("참고 정보를 가져왔습니다. 내용을 확인하고 부족한 정보는 직접 보충해 주세요.");
 }catch(e){msg("URL 정보 가져오기 실패: "+e.message);}finally{b.disabled=false;}
};
function renderKeywords(keywords){
 const box=$("keywordsOut");box.replaceChildren();
 (keywords||[]).slice(0,3).forEach(k=>{const s=document.createElement("span");s.className="chip";s.textContent=k;box.appendChild(s);});
 if(!keywords?.length)box.textContent="추천 키워드가 없습니다.";
}
function renderTags(tags){
 const box=$("tags");box.replaceChildren();
 (tags||[]).slice(0,20).forEach(t=>{const s=document.createElement("span");s.className="tag";s.textContent="#"+String(t).replace(/^#+/,"");box.appendChild(s);});
 if(!tags?.length)box.textContent="추천 태그가 없습니다.";
}
function renderImages(){
 const box=$("images");box.replaceChildren();
 if(!foundImages.length){const p=document.createElement("p");p.className="muted";p.textContent="사용 가능한 라이선스가 확인된 관련 사진을 찾지 못했습니다. 검색어를 바꾸거나 직접 촬영한 사진을 사용해 주세요.";box.appendChild(p);return;}
 foundImages.forEach((im,i)=>{
  const card=document.createElement("div");card.className="imageCard";
  const image=document.createElement("img");image.src=im.thumbUrl;image.alt=(resultData?.imageAlts||[])[i]||im.title;image.loading="lazy";card.appendChild(image);
  const meta=document.createElement("div");meta.className="meta";
  const name=document.createElement("div");name.className="name";name.textContent=(i+1)+". "+im.title;meta.appendChild(name);
  const detail=document.createElement("div");detail.className="detail";
  const placement=(resultData?.imagePlacements||[])[i]||"본문 중간";
  detail.textContent="삽입 위치: "+placement+"\n작가: "+(im.artist||"정보 없음")+"\n라이선스: "+im.license;
  meta.appendChild(detail);
  const link=document.createElement("a");link.href=im.sourceUrl;link.target="_blank";link.rel="noopener noreferrer";link.textContent="원본·라이선스 확인";meta.appendChild(link);
  card.appendChild(meta);box.appendChild(card);
 });
}
function addImageMarkers(body,count){
 let text=String(body||"").trim();
 const paras=text.split(/\n\s*\n/).filter(Boolean);
 for(let i=1;i<=count;i++){
  const marker="[[IMAGE_"+i+"]]";
  if(text.includes(marker))continue;
  const idx=Math.min(paras.length,Math.max(1,Math.round(i*paras.length/(count+1))));
  paras.splice(idx+(i-1),0,marker);
  text=paras.join("\n\n");
 }
 return text;
}
function imageFigure(im,i){
 const alt=(resultData?.imageAlts||[])[i]||im.title;
 const caption=(resultData?.imageCaptions||[])[i]||alt;
 const artist=im.artist||"저작자 정보 없음",license=im.license||"라이선스 정보 확인";
 const source=im.sourceUrl||"https://commons.wikimedia.org/";
 const licenseLink=im.licenseUrl?'<a href="'+escapeHtml(im.licenseUrl)+'">라이선스</a>':"";
 return '<figure><a href="'+escapeHtml(source)+'"><img src="'+escapeHtml(im.thumbUrl)+'" alt="'+escapeHtml(alt)+'" loading="lazy" style="width:100%;height:auto;display:block"></a><figcaption>'+escapeHtml(caption)+'<br>사진: '+escapeHtml(artist)+' · '+escapeHtml(license)+' · <a href="'+escapeHtml(source)+'">원본 출처</a> '+licenseLink+'</figcaption></figure>';
}
function bodyToHtml(){
 if(!resultData)return "";
 const body=addImageMarkers($("body").value,foundImages.length);
 const chunks=body.split(/(\[\[IMAGE_[1-5]\]\])/g);
 let html="";
 chunks.forEach(chunk=>{
  const m=chunk.match(/^\[\[IMAGE_([1-5])\]\]$/);
  if(m){const i=Number(m[1])-1;if(foundImages[i])html+=imageFigure(foundImages[i],i);return;}
  const text=chunk.trim();if(!text)return;
  text.split(/\n\s*\n/).forEach(block=>{
   const b=block.trim();if(!b)return;
   const heading=b.match(/^#{1,3}\s+(.+)$/);
   if(heading)html+="<h2>"+escapeHtml(heading[1])+"</h2>";
   else html+="<p>"+escapeHtml(b).replace(/\n/g,"<br>")+"</p>";
  });
 });
 return html;
}
function renderArticlePreview(){
 const html=bodyToHtml();
 $("articlePreview").innerHTML=html||"본문을 작성해 주세요.";
}
function plainTextWithSources(){
 let text=$("body").value.trim();
 foundImages.forEach((im,i)=>{
  const tag="[[IMAGE_"+(i+1)+"]]";
  text=text.replace(tag,"[사진 "+(i+1)+": "+((resultData?.imageCaptions||[])[i]||im.title)+" / "+im.artist+" / "+im.license+" / "+im.sourceUrl+"]");
 });
 return text;
}
$("generate").onclick=async()=>{
 const topic=$("topic").value.trim(),product=$("product").value.trim(),brand=$("brand").value.trim(),draft=$("draft").value.trim();
 if(!topic&&!product&&!brand&&!draft){msg("글 주제, 제품명 또는 초안을 입력해 주세요.");return;}
 const files=Array.from($("photos").files||[]).slice(0,5);
 const button=$("generate");button.disabled=true;foundImages=[];resultData=null;
 $("images").textContent="글 생성 후 관련 사진을 검색합니다...";
 $("articlePreview").textContent="본문 생성 중...";
 msg("첨부 사진을 분석하고 SEO 블로그 글을 생성하는 중...");
 try{
  const photoParts=[];
  for(const f of files)photoParts.push({name:f.name,data:await compressPhoto(f)});
  const generated=await api("/api/generate",{method:"POST",body:JSON.stringify({
   channel:$("channel").value,topic,keywords:cleanKeywordList(),brand,product,
   perspective:$("perspective").value,style:$("style").value,draft,
   extra:$("extra").value,photos:photoParts,url:productUrl||$("url").value.trim()
  })});
  resultData=generated;
  $("postTitle").value=generated.title||"";
  $("body").value=generated.body||"";
  renderKeywords(generated.keywords);renderTags(generated.tags);
  msg("본문 생성 완료. 주제에 맞는 공개 라이선스 사진 5장을 찾는 중...");
  try{
   const photos=await api("/api/images",{method:"POST",body:JSON.stringify({queries:generated.imageQueries||[]})});
   foundImages=photos.images||[];
  }catch(e){foundImages=[];msg("본문은 생성했지만 사진 검색에 실패했습니다: "+e.message);}
  renderImages();renderArticlePreview();
  if(foundImages.length===5)msg("완료: SEO 글, 키워드 3개, 태그 20개, 관련 사진 5장을 준비했습니다.");
  else msg("글 생성 완료. 관련 사진은 "+foundImages.length+"장 확보했습니다. 라이선스가 확인되는 사진만 표시했습니다.");
 }catch(e){msg("글 생성 실패: "+e.message);$("articlePreview").textContent="글 생성 결과가 없습니다.";}
 finally{button.disabled=false;}
};
$("body").addEventListener("input",renderArticlePreview);
$("postTitle").addEventListener("input",renderArticlePreview);
$("copyTitle").onclick=async()=>{if(!$("postTitle").value.trim()){msg("복사할 제목이 없습니다.");return;}try{await navigator.clipboard.writeText($("postTitle").value.trim());msg("제목을 복사했습니다.");}catch(e){msg("제목 복사를 지원하지 않습니다. 직접 복사해 주세요.");}};
$("copyTags").onclick=async()=>{const tags=(resultData?.tags||[]).slice(0,20).map(t=>"#"+t.replace(/^#+/,"")).join(" ");if(!tags){msg("복사할 태그가 없습니다.");return;}try{await navigator.clipboard.writeText(tags);msg("태그 20개를 복사했습니다.");}catch(e){msg("태그 복사를 지원하지 않습니다.");}};
$("copyHtml").onclick=async()=>{
 if(!$("body").value.trim()){msg("먼저 글을 생성해 주세요.");return;}
 const html=bodyToHtml();
 const full="<article>"+html+"</article>";
 try{
  if(navigator.clipboard&&window.ClipboardItem){
   const item=new ClipboardItem({"text/html":new Blob([full],{type:"text/html"}),"text/plain":new Blob([$("postTitle").value+"\n\n"+plainTextWithSources()],{type:"text/plain"})});
   await navigator.clipboard.write([item]);
  }else await navigator.clipboard.writeText(full);
  msg("이미지 포함 HTML을 복사했습니다. 티스토리 편집기를 HTML 모드로 바꾼 뒤 붙여넣으세요.");
 }catch(e){msg("HTML 자동 복사가 제한되었습니다. 본문 미리보기 대신 HTML 모드 붙여넣기 기능을 지원하는 브라우저에서 다시 시도해 주세요.");}
};
$("openTistory").onclick=()=>{if(!$("body").value.trim()){msg("먼저 글을 생성해 주세요.");return;}window.open("https://www.tistory.com/manage/newpost?type=post","_blank","noopener");};
api("/api/status").then(d=>$("status").textContent=d.aiConfigured?"AI 연결됨":"GEMINI_API_KEY 확인 필요").catch(()=>$("status").textContent="서버 연결 오류");
})();