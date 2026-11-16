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
 if(!foundImages.length){box.textContent="사용 조건이 확인된 공개 이미지를 찾지 못했습니다.";return;}
 foundImages.forEach((im,i)=>{
  const card=document.createElement("div");card.className="imageCard";
  const img=document.createElement("img");img.src=im.thumbUrl;img.alt=(resultData.imageAlts||[])[i]||im.title;img.loading="lazy";card.appendChild(img);
  const meta=document.createElement("div");meta.className="meta";
  const name=document.createElement("div");name.className="name";name.textContent=(i+1)+". "+(im.title||"관련 이미지");meta.appendChild(name);
  card.appendChild(meta);box.appendChild(card);
 });
}
function imageFigure(im,i){
 const alt=(resultData.imageAlts||[])[i]||im.title||"관련 이미지";
 return "<figure><img src=\""+escapeHtml(im.originalUrl||im.thumbUrl)+"\" alt=\""+escapeHtml(alt)+"\" loading=\"lazy\" style=\"width:100%;height:auto;display:block\"></figure>";
}
function isPlainHeading(value){
 const text=String(value||"").trim();
 return text.length>2&&text.length<=48&&!/[.!?。！？]$/.test(text)&&!/^https?:\/\//i.test(text);
}
function bodyHtml(){
 if(!resultData)return "";
 const blocks=String($("body").value||"").trim().split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
 let html="<h1>"+escapeHtml($("title").value)+"</h1>";
 let photoIndex=0;
 blocks.forEach((block,index)=>{
  const safe=escapeHtml(block).replace(/\n/g,"<br>");
  if(!block.includes("\n")&&isPlainHeading(block))html+="<h2>"+safe+"</h2>";
  else html+="<p>"+safe+"</p>";
  const target=Math.max(1,Math.round(blocks.length*(photoIndex+1)/(foundImages.length+1)));
  if(photoIndex<foundImages.length&&index+1>=target){
   html+=imageFigure(foundImages[photoIndex],photoIndex);
   photoIndex++;
  }
 });
 while(photoIndex<foundImages.length){html+=imageFigure(foundImages[photoIndex],photoIndex);photoIndex++;}
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
 const text=$("title").value+"\n\n"+$("body").value;
 try{await navigator.clipboard.writeText(text);msg("제목과 본문을 복사했습니다.");}
 catch(e){msg("복사를 지원하지 않는 브라우저입니다.");}
};
api("/api/status").then(d=>$("status").textContent=d.aiConfigured?"AI 연결됨":"API 키 설정 필요").catch(()=>$("status").textContent="연결 오류");
})();