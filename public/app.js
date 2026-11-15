(()=>{
"use strict";
const $=id=>document.getElementById(id);
let resultData=null,foundImages=[];
function msg(t){$("message").textContent=t;}
async function api(url,opt={}){
 const r=await fetch(url,{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(d.error||"요청 실패 ("+r.status+")");
 return d;
}
function escapeHtml(v){
 return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function renderKeywords(items){
 const box=$("keywords");box.replaceChildren();
 (items||[]).slice(0,3).forEach(k=>{const el=document.createElement("span");el.className="chip";el.textContent=k;box.appendChild(el);});
}
function renderImages(){
 const box=$("images");box.replaceChildren();
 if(!foundImages.length){box.textContent="사용 조건이 확인된 관련 이미지를 찾지 못했습니다.";return;}
 foundImages.forEach((im,i)=>{
  const card=document.createElement("div");card.className="imageCard";
  const img=document.createElement("img");img.src=im.thumbUrl;img.alt=(resultData.imageAlts||[])[i]||im.title;img.loading="lazy";card.appendChild(img);
  const meta=document.createElement("div");meta.className="meta";
  const name=document.createElement("div");name.className="name";name.textContent=(i+1)+". "+(im.title||"관련 이미지");meta.appendChild(name);
  const detail=document.createElement("div");detail.className="detail";
  if(im.kind==="product"){
   detail.textContent="상품 상세페이지에서 수집한 대표 이미지\\n이미지 이용 조건은 판매처 정책을 확인해 주세요.";
  }else{
   detail.textContent="작가: "+(im.artist||"정보 없음")+"\\n라이선스: "+(im.license||"정보 없음");
  }
  meta.appendChild(detail);
  const link=document.createElement("a");link.href=im.sourceUrl;link.target="_blank";link.rel="noopener noreferrer";link.textContent=im.kind==="product"?"상품 원본 페이지":"원본·라이선스 확인";meta.appendChild(link);
  card.appendChild(meta);box.appendChild(card);
 });
}
function addMissingMarkers(body,count){
 let parts=String(body||"").trim().split(/\n\s*\n/).filter(Boolean);
 for(let i=1;i<=count;i++){
  const marker="[[IMAGE_"+i+"]]";
  if(parts.some(p=>p.trim()===marker))continue;
  const position=Math.min(parts.length,Math.max(1,Math.round(i*parts.length/(count+1))));
  parts.splice(position,0,marker);
 }
 return parts.join("\n\n");
}
function imageFigure(im,i){
 const alt=(resultData.imageAlts||[])[i]||im.title||"관련 이미지";
 const caption=(resultData.imageCaptions||[])[i]||alt;
 const source=im.sourceUrl||"https://commons.wikimedia.org/";
 let attribution="";
 if(im.kind==="product"){
  attribution="상품 이미지 출처: <a href=\""+escapeHtml(source)+"\">상품 상세페이지</a> · 판매처의 이미지 이용 조건을 확인해 주세요.";
 }else{
  const licenseLink=im.licenseUrl?" · <a href=\""+escapeHtml(im.licenseUrl)+"\">라이선스</a>":"";
  attribution="사진: "+escapeHtml(im.artist||"저작자 정보 없음")+" · "+escapeHtml(im.license||"라이선스 정보 확인")+" · <a href=\""+escapeHtml(source)+"\">원본 출처</a>"+licenseLink;
 }
 return "<figure><a href=\""+escapeHtml(source)+"\"><img src=\""+escapeHtml(im.originalUrl||im.thumbUrl)+"\" alt=\""+escapeHtml(alt)+"\" loading=\"lazy\" style=\"width:100%;height:auto;display:block\"></a><figcaption>"+escapeHtml(caption)+"<br>"+attribution+"</figcaption></figure>";
}
function bodyHtml(){
 if(!resultData)return "";
 const content=addMissingMarkers($("body").value,foundImages.length);
 const chunks=content.split(/(\[\[IMAGE_[1-5]\]\])/g);
 let html="";
 chunks.forEach(chunk=>{
  const m=chunk.match(/^\[\[IMAGE_([1-5])\]\]$/);
  if(m){const index=Number(m[1])-1;if(foundImages[index])html+=imageFigure(foundImages[index],index);return;}
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
function renderPreview(){
 if(!resultData)return;
 $("articlePreview").innerHTML="<h1>"+escapeHtml($("title").value)+"</h1>"+bodyHtml();
}
$("generate").onclick=async()=>{
 const url=$("url").value.trim();
 if(!url){msg("상품 링크를 입력해 주세요.");$("url").focus();return;}
 const button=$("generate");button.disabled=true;
 $("result").classList.add("hidden");resultData=null;foundImages=[];
 msg("상품 페이지 정보를 읽고 있습니다...");
 try{
  const generated=await api("/api/generate",{method:"POST",body:JSON.stringify({url})});
  resultData=generated;
  $("title").value=generated.title||"";
  $("body").value=generated.body||"";
  renderKeywords(generated.keywords||[]);
  msg("상품 정보 분석과 글 생성 완료. 관련 사진을 찾고 있습니다...");
  try{
   const photoResult=await api("/api/images",{method:"POST",body:JSON.stringify({
    queries:generated.imageQueries||[],
    productImages:generated.product?.images||[],
    productUrl:generated.product?.url||url
   })});
   foundImages=photoResult.images||[];
  }catch(e){foundImages=[];msg("본문은 생성했지만 사진 검색에 실패했습니다: "+e.message);}
  $("result").classList.remove("hidden");
  renderImages();renderPreview();
  if(foundImages.length===5)msg("완료: 구글 SEO 글과 관련 사진 5장을 준비했습니다.");
  else msg("글 생성 완료. 사용 가능한 사진은 "+foundImages.length+"장입니다.");
 }catch(e){msg("글 생성 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("body").addEventListener("input",renderPreview);
$("title").addEventListener("input",renderPreview);
$("copyHtml").onclick=async()=>{
 if(!resultData||!$("body").value.trim()){msg("먼저 상품 링크를 분석해 글을 생성해 주세요.");return;}
 const html="<article><h1>"+escapeHtml($("title").value)+"</h1>"+bodyHtml()+"</article>";
 try{
  if(navigator.clipboard&&window.ClipboardItem){
   const item=new ClipboardItem({"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([$("title").value+"\n\n"+$("body").value],{type:"text/plain"})});
   await navigator.clipboard.write([item]);
  }else{
   await navigator.clipboard.writeText(html);
  }
  msg("이미지가 포함된 글 전체를 복사했습니다.");
 }catch(e){msg("자동 복사가 제한됐습니다. 브라우저 권한을 확인해 주세요.");}
};
$("copyText").onclick=async()=>{
 if(!resultData||!$("body").value.trim()){msg("먼저 상품 링크를 분석해 글을 생성해 주세요.");return;}
 const text=$("title").value+"\n\n"+$("body").value+"\n\n"+foundImages.map((im,i)=>"사진 "+(i+1)+": "+(im.sourceUrl||"")).join("\n");
 try{await navigator.clipboard.writeText(text);msg("제목과 본문을 복사했습니다.");}
 catch(e){msg("복사를 지원하지 않는 브라우저입니다.");}
};
api("/api/status").then(d=>$("status").textContent=d.aiConfigured?"AI 연결됨":"API 키 설정 필요").catch(()=>$("status").textContent="연결 오류");
})();