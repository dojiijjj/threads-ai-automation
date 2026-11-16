(()=>{
"use strict";
const $=id=>document.getElementById(id);
let productInfo=null,resultData=null,foundImages=[];
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
function addInfoRow(parent,key,value){
 if(!value)return;
 const k=document.createElement("div");k.className="key";k.textContent=key;
 const v=document.createElement("div");v.className="value";v.textContent=value;
 parent.append(k,v);
}
function renderProduct(data){
 const box=$("productInfo");box.replaceChildren();
 addInfoRow(box,"상품명",data.title);
 addInfoRow(box,"브랜드",data.brand);
 addInfoRow(box,"가격",data.price?[data.price,data.currency].filter(Boolean).join(" "):"페이지에서 가격 정보 확인 안 됨");
 addInfoRow(box,"판매 상태",data.availability);
 addInfoRow(box,"상품 설명",data.description);
 addInfoRow(box,"주요 특징",(data.features||[]).join(" · "));
 addInfoRow(box,"상품 코드",data.sku);
 $("productNotice").textContent=data.images?.length
  ?"상품페이지에서 실제 이미지 파일 "+data.images.length+"장을 확인했어. 글 생성 후 본문 안에 함께 넣을게."
  :"사용 가능한 대표 이미지를 찾지 못했어. 깨진 이미지나 대체 이미지는 넣지 않을게.";
 $("productPanel").classList.remove("hidden");
}
function isPlainHeading(value){
 const text=String(value||"").trim();
 return text.length>2&&text.length<=48&&!/[.!?。！？]$/.test(text)&&!/^https?:\/\//i.test(text);
}
function makeImageFigure(url){
 const figure=document.createElement("figure");
 figure.className="articleImage";
 const img=document.createElement("img");
 img.src=url;img.alt="상품 대표 이미지";img.loading="lazy";
 img.onerror=()=>figure.remove();
 figure.appendChild(img);
 return figure;
}
function renderArticle(){
 const editor=$("articleEditor");
 editor.replaceChildren();
 if(!resultData)return;
 const blocks=String(resultData.body||"").trim().split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
 const hashtagBlock=blocks.length&&blocks[blocks.length-1].startsWith("#")?blocks.pop():"";
 let photoIndex=0;
 blocks.forEach((block,index)=>{
  const el=document.createElement(!block.includes("\n")&&isPlainHeading(block)?"h2":"p");
  el.textContent=block;
  editor.appendChild(el);
  const target=foundImages.length?Math.max(1,Math.round(blocks.length*(photoIndex+1)/(foundImages.length+1))):Infinity;
  if(photoIndex<foundImages.length&&index+1>=target){
   editor.appendChild(makeImageFigure(foundImages[photoIndex]));
   photoIndex++;
  }
 });
 while(photoIndex<foundImages.length){
  editor.appendChild(makeImageFigure(foundImages[photoIndex]));
  photoIndex++;
 }
 if(hashtagBlock){
  const tags=document.createElement("p");tags.className="hashtags";tags.textContent=hashtagBlock;
  editor.appendChild(tags);
 }
}
function articleText(){return $("articleEditor").innerText||$("articleEditor").textContent||"";}
function articleHtml(){return $("articleEditor").innerHTML;}
async function copyRichHtml(){
 const html="<article><h1>"+escapeHtml($("title").value)+"</h1>"+articleHtml()+"</article>";
 const plain=$("title").value+"\n\n"+articleText();
 if(navigator.clipboard&&window.ClipboardItem){
  const item=new ClipboardItem({
   "text/html":new Blob([html],{type:"text/html"}),
   "text/plain":new Blob([plain],{type:"text/plain"})
  });
  await navigator.clipboard.write([item]);
 }else await navigator.clipboard.writeText(plain);
}
function getTistoryPostUrl(){
 let base="";
 try{base=localStorage.getItem("tistoryBlogBase")||"";}catch(_){}
 if(!base){
  const entered=prompt("티스토리 블로그 주소를 한 번만 입력해 줘.\n예: https://myblog.tistory.com");
  if(!entered)return null;
  let raw=entered.trim();
  if(!/^https?:\/\//i.test(raw))raw="https://"+raw;
  let parsed;
  try{parsed=new URL(raw);}catch(_){throw Error("올바른 티스토리 블로그 주소가 아니야.");}
  if(parsed.protocol!=="https:"||!parsed.hostname||parsed.hostname==="tistory.com"||parsed.hostname==="www.tistory.com")
   throw Error("내 티스토리 블로그 주소를 입력해 줘. 예: https://myblog.tistory.com");
  base=parsed.origin;
  try{localStorage.setItem("tistoryBlogBase",base);}catch(_){}
 }
 return base.replace(/\/+$/,"")+"/manage/newpost/";
}
$("fetchProduct").onclick=async()=>{
 const url=$("url").value.trim();
 if(!url){msg("상품 링크를 입력해 줘.");$("url").focus();return;}
 const button=$("fetchProduct");button.disabled=true;
 $("productPanel").classList.add("hidden");$("result").classList.add("hidden");
 productInfo=null;resultData=null;foundImages=[];
 msg("상품페이지에서 실제 대표 이미지를 확인하는 중...");
 try{
  const data=await api("/api/preview?url="+encodeURIComponent(url));
  productInfo=data;renderProduct(data);
  msg("상품 정보를 가져왔어. 아래 버튼을 눌러 글을 생성해 줘.");
 }catch(e){msg("상품 정보 수집 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("generate").onclick=async()=>{
 if(!productInfo){msg("먼저 상품 정보를 가져와 줘.");return;}
 const button=$("generate");button.disabled=true;
 $("result").classList.add("hidden");resultData=null;foundImages=[];
 msg("상품 정보와 대표 이미지를 이용해 글을 작성 중...");
 try{
  resultData=await api("/api/generate",{method:"POST",body:JSON.stringify({url:productInfo.url})});
  foundImages=(productInfo.images||[]).slice(0,8);
  $("title").value=resultData.title||"";
  renderArticle();
  $("result").classList.remove("hidden");
  const count=(resultData.body.match(/#[^\s#]+/g)||[]).length;
  msg("완료. 검증된 대표 이미지 "+foundImages.length+"장과 해시태그 "+count+"개를 본문 한 칸에 넣었어.");
 }catch(e){msg("글 생성 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("copyHtml").onclick=async()=>{
 if(!resultData||!articleText().trim()){msg("먼저 글을 생성해 줘.");return;}
 try{await copyRichHtml();msg("제목과 본문, 사진을 한 번에 복사했어.");}
 catch(e){msg("복사에 실패했어. 브라우저의 클립보드 권한을 확인해 줘.");}
};
$("copyText").onclick=async()=>{
 if(!resultData||!articleText().trim()){msg("먼저 글을 생성해 줘.");return;}
 try{await navigator.clipboard.writeText($("title").value+"\n\n"+articleText());msg("제목과 본문 텍스트를 복사했어.");}
 catch(e){msg("복사를 지원하지 않는 브라우저야.");}
};
$("toTistory").onclick=async()=>{
 if(!resultData||!articleText().trim()){msg("먼저 글을 생성해 줘.");return;}
 let target;
 try{target=getTistoryPostUrl();}catch(e){msg(e.message);return;}
 if(!target){msg("티스토리 주소 입력을 취소했어.");return;}
 const tab=window.open(target,"_blank");
 try{
  await copyRichHtml();
  if(tab)msg("내 블로그의 글쓰기 화면을 열고 제목, 본문, 사진을 복사했어. 티스토리 본문에 붙여넣고 게시해 줘.");
  else msg("글은 복사했어. 팝업이 차단됐으니 저장된 내 블로그 주소의 /manage/newpost/ 화면을 열고 붙여넣어 줘.");
 }catch(e){msg("티스토리 글쓰기 화면은 열었지만 자동 복사에 실패했어. 글 전체 복사 버튼을 눌러서 붙여넣어 줘.");}
};
api("/api/status").then(d=>$("status").textContent=d.aiConfigured?"AI 연결됨":"API 키 설정 필요").catch(()=>$("status").textContent="연결 오류");
})();