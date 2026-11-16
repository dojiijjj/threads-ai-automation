(()=>{
"use strict";
const $=id=>document.getElementById(id);
let productInfo=null,articleInfo=null,resultData=null,foundImages=[],currentShareUrl="",contentMode="product";
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
 $("productPanel").classList.remove("hidden");
}
function isPlainHeading(value){
 const text=String(value||"").trim();
 return text.length>2&&text.length<=48&&!/[.!?。！？]$/.test(text)&&!/^https?:\/\//i.test(text);
}
function splitSentences(value){
 const text=String(value||"").replace(/\s+/g," ").trim();
 if(!text)return [];
 const output=[];
 let start=0;
 const punctuation=/[.!?。！？]+[”’"'」』】)]*/gu;
 let match;
 while((match=punctuation.exec(text))){
  const before=text.slice(start,match.index);
  if(!/[가-힣]$/u.test(before))continue;
  const marks=match[0].replace(/[”’"'」』】)]*$/u,"");
  if(marks==="."&&/\d$/u.test(before))continue;
  let next=punctuation.lastIndex;
  while(next<text.length&&/\s/u.test(text[next]))next++;
  if(next>=text.length)break;
  if(!/[가-힣0-9“"'‘(]/u.test(text[next]))continue;
  output.push(text.slice(start,punctuation.lastIndex).trim());
  start=next;
  punctuation.lastIndex=next;
 }
 const tail=text.slice(start).trim();
 if(tail)output.push(tail);
 return output.length?output:[text];
}
function makeImageFigure(url){
 const figure=document.createElement("figure");
 figure.className="articleImage";
 const img=document.createElement("img");
 img.src=url;img.alt=contentMode==="article"?"기사 사진":"상품 대표 이미지";img.loading="lazy";
 img.onerror=()=>figure.remove();
 figure.appendChild(img);
 return figure;
}
const SHARE_DISCLOSURE="이 포스팅은 토스쇼핑 쉐어링크 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";
function addShareDisclosure(editor){
 const p=document.createElement("p");
 p.className="affiliateDisclosure";
 p.append(document.createTextNode(SHARE_DISCLOSURE+" "));
 const link=document.createElement("a");
 link.href=currentShareUrl;
 link.textContent=currentShareUrl;
 link.target="_blank";
 link.rel="noopener noreferrer";
 p.appendChild(link);
 editor.appendChild(p);
}
function renderArticle(){
 const editor=$("articleEditor");
 editor.replaceChildren();
 if(!resultData)return;
 if(contentMode==="product")addShareDisclosure(editor);
 const blocks=String(resultData.body||"").trim().split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
 const hashtagBlock=blocks.length&&blocks[blocks.length-1].startsWith("#")?blocks.pop():"";
 let photoIndex=0;
 const displayBlocks=[];
 blocks.forEach(block=>{
  const normalized=block.split(/\n+/).map(x=>x.trim()).filter(Boolean).join(" ");
  if(!normalized)return;
  if(isPlainHeading(normalized)){displayBlocks.push({text:normalized,heading:true});return;}
  splitSentences(normalized).forEach(sentence=>displayBlocks.push({text:sentence,heading:false}));
 });
 displayBlocks.forEach((block,index)=>{
  const el=document.createElement(block.heading?"h2":"p");
  el.textContent=block.text;
  editor.appendChild(el);
  const target=foundImages.length?Math.max(1,Math.round(displayBlocks.length*(photoIndex+1)/(foundImages.length+1))):Infinity;
  if(photoIndex<foundImages.length&&index+1>=target){
   editor.appendChild(makeImageFigure(foundImages[photoIndex]));
   photoIndex++;
  }
 });
 while(photoIndex<foundImages.length){
  editor.appendChild(makeImageFigure(foundImages[photoIndex]));
  photoIndex++;
 }
 if(contentMode==="product")addShareDisclosure(editor);
 if(contentMode==="article"&&articleInfo){
  const source=document.createElement("p");
  source.className="articleSource";
  const label=document.createElement("span");label.textContent="원문 기사: ";
  const link=document.createElement("a");link.href=articleInfo.url;link.textContent=articleInfo.title||articleInfo.publisher||articleInfo.url;
  link.target="_blank";link.rel="noopener noreferrer";
  source.append(label,link);editor.appendChild(source);
 }
 if(hashtagBlock){
  const tags=document.createElement("p");tags.className="hashtags";tags.textContent=hashtagBlock;
  editor.appendChild(tags);
 }
}
function articleText(){return $("articleEditor").innerText||$("articleEditor").textContent||"";}
function articleHtml(){return $("articleEditor").innerHTML;}
function tistoryHtml(){
 return '<div class="product-article">'+articleHtml()+"</div>";
}
async function copyRichHtml(){
 // Copy literal HTML source: mobile clipboard can drop the text/html clipboard format.
 await navigator.clipboard.writeText(tistoryHtml());
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
 productInfo=null;resultData=null;foundImages=[];currentShareUrl="";
 msg("상품페이지에서 실제 대표 이미지를 확인하는 중...");
 try{
  const data=await api("/api/preview?url="+encodeURIComponent(url));
  articleInfo=null;contentMode="product";
  $("articlePanel").classList.add("hidden");
  productInfo=data;currentShareUrl=data.url||url;renderProduct(data);
  msg("상품 정보를 가져왔어. 아래 버튼을 눌러 글을 생성해 줘.");
 }catch(e){msg("상품 정보 수집 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("fetchArticle").onclick=async()=>{
 const url=$("articleUrl").value.trim();
 if(!url){msg("기사 링크를 입력해 줘.");$("articleUrl").focus();return;}
 const button=$("fetchArticle");button.disabled=true;
 $("productPanel").classList.add("hidden");$("articlePanel").classList.add("hidden");$("result").classList.add("hidden");
 productInfo=null;articleInfo=null;resultData=null;foundImages=[];currentShareUrl="";contentMode="article";
 msg("기사 제목과 본문을 가져오는 중...");
 try{
  const imagesAuthorized=$("articleImagesAuthorized").checked;
  const data=await api("/api/article-preview?url="+encodeURIComponent(url)+"&imagesAuthorized="+(imagesAuthorized?"1":"0"));
  articleInfo=data;
  const box=$("articleInfo");box.replaceChildren();
  addInfoRow(box,"기사 제목",data.title);
  addInfoRow(box,"언론사",data.publisher);
  addInfoRow(box,"기자",data.author);
  addInfoRow(box,"게시일",data.published);
  addInfoRow(box,"기사 사진",(data.images||[]).length+"장");
  $("articlePanel").classList.remove("hidden");
  msg("기사 정보를 가져왔어. 아래 버튼을 눌러 새 글을 생성해 줘.");
 }catch(e){msg("기사 정보 수집 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("generate").onclick=async()=>{
 if(!productInfo){msg("먼저 상품 정보를 가져와 줘.");return;}
 const button=$("generate");button.disabled=true;
 $("result").classList.add("hidden");resultData=null;foundImages=[];
 msg("상품 정보와 대표 이미지를 이용해 글을 작성 중...");
 try{
  contentMode="product";
  resultData=await api("/api/generate",{method:"POST",body:JSON.stringify({url:productInfo.url})});
  foundImages=(productInfo.images||[]).slice(0,8).map(url=>new URL(url,location.origin).toString());
  $("title").value=resultData.title||"";
  renderArticle();
  $("result").classList.remove("hidden");
  const count=(resultData.body.match(/#[^\s#]+/g)||[]).length;
  msg("완료. 검증된 대표 이미지 "+foundImages.length+"장과 해시태그 "+count+"개를 본문 한 칸에 넣었어.");
 }catch(e){msg("글 생성 실패: "+e.message);}
 finally{button.disabled=false;}
};
$("generateArticle").onclick=async()=>{
 if(!articleInfo){msg("먼저 기사 정보를 가져와 줘.");return;}
 const button=$("generateArticle");button.disabled=true;
 $("result").classList.add("hidden");resultData=null;foundImages=[];contentMode="article";currentShareUrl="";
 msg("기사 내용을 바탕으로 새 블로그 글을 작성 중...");
 try{
  resultData=await api("/api/generate-article",{method:"POST",body:JSON.stringify({url:articleInfo.url})});
  foundImages=(articleInfo.images||[]).slice(0,20).map(url=>new URL(url,location.origin).toString());
  $("title").value=resultData.title||"";
  renderArticle();
  $("result").classList.remove("hidden");
  msg("완료. 기사 내용과 사용 권한을 확인한 사진 "+foundImages.length+"장을 본문에 넣었어.");
 }catch(e){msg("기사 글 생성 실패: "+e.message);}
 finally{button.disabled=false;}
};

$("copyHtml").onclick=async()=>{
 if(!resultData||!articleText().trim()){msg("먼저 글을 생성해 줘.");return;}
 try{await copyRichHtml();msg("사진 주소가 포함된 HTML 코드를 복사했어. 티스토리 편집기에서 HTML 모드로 전환한 뒤 붙여넣어 줘.");}
 catch(e){msg("복사에 실패했어. 브라우저의 클립보드 권한을 확인해 줘.");}
};
$("copyText").onclick=async()=>{
 if(!$("title").value.trim()){msg("복사할 제목이 없어.");return;}
 try{await navigator.clipboard.writeText($("title").value);msg("제목을 복사했어.");}
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
  if(tab)msg("HTML 코드를 복사했어. 티스토리에서 기본모드를 HTML로 바꾸고 붙여넣은 다음, 기본모드로 돌아오면 사진이 보여. 제목 칸은 위 제목을 입력해 줘.");
  else msg("HTML 코드는 복사했어. 저장된 내 블로그 주소의 /manage/newpost/ 화면을 직접 열고 HTML 모드에 붙여넣어 줘.");
 }catch(e){msg("티스토리 글쓰기 화면은 열었지만 자동 복사에 실패했어. 글 전체 복사 버튼을 눌러서 붙여넣어 줘.");}
};
api("/api/status").then(d=>$("status").textContent=d.aiConfigured?"AI 연결됨":"API 키 설정 필요").catch(()=>$("status").textContent="연결 오류");
})();