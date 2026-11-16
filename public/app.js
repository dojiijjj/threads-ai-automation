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
 const shots=$("productShots");shots.replaceChildren();
 (data.images||[]).slice(0,5).forEach((url,i)=>{
  const img=document.createElement("img");img.src=url;img.alt=(data.title||"상품")+" 이미지 "+(i+1);img.loading="lazy";shots.appendChild(img);
 });
 $("productNotice").textContent=data.images?.length
  ?"상품 페이지에서 대표 이미지 "+data.images.length+"개를 확인했어. 글 생성 단계에서는 관련 공개 이미지를 별도로 검색해."
  :"페이지에서 대표 이미지를 찾지 못했어. 글 생성 단계에서 관련 사진을 별도로 검색할게.";
 $("productPanel").classList.remove("hidden");
}
function renderKeywords(items){
 const box=$("keywords");
 box.textContent="핵심 키워드 "+(items||[]).join(" · ");
}
function renderImages(){
 const box=$("images");box.replaceChildren();
 if(!foundImages.length){
  const p=document.createElement("p");p.className="muted";p.textContent="사용 가능한 공개 라이선스 사진을 찾지 못했습니다.";box.appendChild(p);return;
 }
 foundImages.forEach((im,i)=>{
  const card=document.createElement("div");card.className="imageCard";
  const img=document.createElement("img");img.src=im.thumbUrl;img.alt=(resultData.imageAlts||[])[i]||im.title;img.loading="lazy";card.appendChild(img);
  const meta=document.createElement("div");meta.className="meta";
  const name=document.createElement("div");name.className="name";name.textContent=(i+1)+". "+(im.title||"관련 이미지");
  meta.appendChild(name);card.appendChild(meta);box.appendChild(card);
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
function bodyHtml(includeTitle=true){
 if(!resultData)return "";
 const blocks=String($("body").value||"").trim().split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
 let html=includeTitle?"<h1>"+escapeHtml($("title").value)+"</h1>":"";
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
 $("articlePreview").innerHTML=bodyHtml(true);
}
async function copyRichHtml(){
 const html="<article>"+bodyHtml(true)+"</article>";
 if(navigator.clipboard&&window.ClipboardItem){
  const item=new ClipboardItem({
   "text/html":new Blob([html],{type:"text/html"}),
   "text/plain":new Blob([$("title").value+"\n\n"+$("body").value],{type:"text/plain"})
  });
  await navigator.clipboard.write([item]);
 }else{
  await navigator.clipboard.writeText($("title").value+"\n\n"+$("body").value);
 }
}
$("fetchProduct").onclick=async()=>{
 const url=$("url").value.trim();
 if(!url){msg("상품 링크를 입력해 주세요.");$("url").focus();return;}
 const button=$("fetchProduct");button.disabled=true;
 $("productPanel").classList.add("hidden");
 $("result").classList.add("hidden");
 productInfo=null;resultData=null;foundImages=[];
 msg("상품 페이지에서 정보만 먼저 가져오는 중...");
 try{
  const data=await api("/api/preview?url="+encodeURIComponent(url));
  productInfo=data;renderProduct(data);
  msg("상품 정보를 가져왔어. 내용을 확인한 뒤 아래 글 생성 버튼을 눌러줘.");
 }catch(e){msg("상품 정보 수집 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("generate").onclick=async()=>{
 if(!productInfo){msg("먼저 상품 정보를 가져와 주세요.");return;}
 const button=$("generate");button.disabled=true;
 $("result").classList.add("hidden");resultData=null;foundImages=[];
 msg("블로그 글을 작성하고 관련 사진을 동시에 찾는 중...");
 const title=productInfo.title||"product";
 const terms=title.split(/\s+/).filter(x=>x.length>1).slice(0,3);
 const queries=[
  title,
  terms.join(" ")+" product",
  (productInfo.brand?productInfo.brand+" ":"")+title,
  (terms[0]||title)+" product design",
  (terms[0]||title)+" product detail"
 ].slice(0,5);
 try{
  const generationPromise=api("/api/generate",{method:"POST",body:JSON.stringify({url:productInfo.url})});
  const imagePromise=api("/api/images",{method:"POST",body:JSON.stringify({queries})}).catch(e=>({images:[],error:e.message}));
  const [generated,photoResult]=await Promise.all([generationPromise,imagePromise]);
  resultData=generated;foundImages=photoResult.images||[];
  $("title").value=generated.title||"";
  $("body").value=generated.body||"";
  renderKeywords(generated.keywords||[]);
  $("result").classList.remove("hidden");
  renderImages();renderPreview();
  const count=(generated.body.match(/#[^\s#]+/g)||[]).length;
  if(foundImages.length===5)msg("완료. 상품 소개 글과 사진 5장, 해시태그 "+count+"개를 준비했어.");
  else msg("완료. 사진 "+foundImages.length+"장과 해시태그 "+count+"개를 준비했어.");
 }catch(e){msg("글 생성 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("body").addEventListener("input",renderPreview);
$("title").addEventListener("input",renderPreview);
$("copyHtml").onclick=async()=>{
 if(!resultData||!$("body").value.trim()){msg("먼저 글을 생성해 주세요.");return;}
 try{await copyRichHtml();msg("제목과 사진을 포함한 글 전체를 복사했어.");}
 catch(e){msg("복사에 실패했어. 브라우저의 클립보드 권한을 확인해 줘.");}
};
$("copyText").onclick=async()=>{
 if(!resultData||!$("body").value.trim()){msg("먼저 글을 생성해 주세요.");return;}
 try{await navigator.clipboard.writeText($("title").value+"\n\n"+$("body").value);msg("제목과 본문을 복사했어.");}
 catch(e){msg("복사를 지원하지 않는 브라우저야.");}
};
$("toTistory").onclick=async()=>{
 if(!resultData||!$("body").value.trim()){msg("먼저 글을 생성해 주세요.");return;}
 const tab=window.open("https://www.tistory.com/manage/newpost","_blank");
 try{
  await copyRichHtml();
  msg("글 전체를 서식과 사진 포함해 복사했고 티스토리 글쓰기 화면을 열었어. 티스토리 본문에 붙여넣고 제목 칸을 확인한 뒤 게시해 줘.");
  if(!tab)msg("팝업이 차단됐어. 티스토리 글쓰기 주소를 새 탭에서 직접 열고 복사한 글을 붙여넣어 줘.");
 }catch(e){
  msg("티스토리 화면은 열었지만 클립보드 복사에 실패했어. 위의 글 전체 복사 버튼을 먼저 눌러 줘.");
 }
};
api("/api/status").then(d=>$("status").textContent=d.aiConfigured?"AI 연결됨":"API 키 설정 필요").catch(()=>$("status").textContent="연결 오류");
})();