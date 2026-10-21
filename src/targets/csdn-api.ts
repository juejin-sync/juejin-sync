// CSDN 草稿 API 适配器：清洗 Markdown、转存图片，并直接保存到草稿箱。
import {marked} from 'marked';
import type {Article,ExtensionSettings,ImageFailurePolicy,TaskErrorCategory,TaskProgress} from '../types';
import {mapConcurrent,retry,sleep} from '../core/async';
import {SyncError} from '../core/diagnostic';
import {resolveCsdnCategories} from '../core/settings';
import type {AdapterResult} from './adapter';

const API='https://bizapi.csdn.net/blog-console-api/v3/mdeditor/saveArticle';
// CSDN Web 编辑器公开下发的客户端签名参数，不属于用户账号凭据，也无法在浏览器扩展中保密。
const CSDN_WEB_API_KEY='203803574';
const CSDN_WEB_SIGNING_KEY='9znpamsyl2c7cdrr9sas0le9vbc3r6ba';

/** 按 CSDN Markdown 编辑器的标题规则在发起网络请求前拦截无效内容。 */
export function validateCsdnArticle(article:Article){
  const title=article.title.trim();
  if(title.length<5)throw new SyncError('CSDN 标题至少需要 5 个字符，请修改掘金标题后重新同步','content','validation');
  if(title.length>100)throw new SyncError('CSDN 标题最多允许 100 个字符，请缩短掘金标题后重新同步','content','validation');
  if(article.markdown.trim().length<20)throw new SyncError('文章正文不完整，暂无法同步到 CSDN','content','validation');
}

/** HTTP 状态码到错误类别的映射；未覆盖的状态码交由调用方给定兜底类别。 */
function statusErrorCategory(status:number):TaskErrorCategory|undefined{
  if(status===401)return'login';
  if(status===429)return'rate-limit';
  if(status>=500)return'network';
  return undefined;
}

type UploadSignature={filePath:string;host:string;accessId:string;policy:string;signature:string;callbackUrl:string;callbackBody:string;callbackBodyType:string;customParam:{rtype:string;filePath:string;isAudit:number;'x-image-app':string;type:string;'x-image-suffix':string;username:string}};

function nonce(){return crypto.randomUUID();}

async function hmacSha256(message:string){
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(CSDN_WEB_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function signedHeaders(path:string,method:'GET'|'POST'){
  const requestNonce=nonce();
  const signText=method==='GET'
    ?`GET\n*/*\n\n\n\nx-ca-key:${CSDN_WEB_API_KEY}\nx-ca-nonce:${requestNonce}\n${path}`
    :`POST\n*/*\n\napplication/json\n\nx-ca-key:${CSDN_WEB_API_KEY}\nx-ca-nonce:${requestNonce}\n${path}`;
  const headers:Record<string,string>={accept:'*/*','x-ca-key':CSDN_WEB_API_KEY,'x-ca-nonce':requestNonce,'x-ca-signature':await hmacSha256(signText),'x-ca-signature-headers':'x-ca-key,x-ca-nonce'};
  if(method==='POST')headers['content-type']='application/json';
  return headers;
}

/** 通过 CSDN 编辑器使用的签名接口确认登录状态。 */
export async function checkCsdnAuth(){
  const path='/blog-console-api/v3/editor/getBaseInfo';
  try{
    const response=await fetch(`https://bizapi.csdn.net${path}`,{method:'GET',credentials:'include',headers:await signedHeaders(path,'GET'),signal:AbortSignal.timeout(6000)});
    if(response.status===401)return{ok:true,loggedIn:false};
    if(!response.ok){
      const detail=response.headers.get('x-ca-error-message')||await response.text().catch(()=>'');
      return{ok:false,loggedIn:false,message:`CSDN 接口鉴权异常 (${response.status})${detail?`：${detail.slice(0,120)}`:''}`};
    }
    const result=await response.json() as {code?:number;data?:{name?:string;nickname?:string}};
    const loggedIn=result.code===200&&!!result.data?.name;
    return{ok:true,loggedIn,account:loggedIn?(result.data?.nickname||result.data?.name):undefined};
  }catch(error){
    return{ok:false,loggedIn:false,message:(error as Error).message||'CSDN 登录状态检测失败'};
  }
}

export type CsdnArticleState='draft'|'published'|'missing'|'unauthorized'|'unknown';

/**
 * 拉取当前登录用户的 CSDN 分类专栏列表。
 * 实证来源：编辑器 getBaseInfo 接口的 data.categorys 为字符串数组（编辑器 tag-selection 组件直接按 string 消费）。
 */
export async function fetchCsdnCategories():Promise<{ok:boolean;categories:string[];message?:string}>{
  const path='/blog-console-api/v3/editor/getBaseInfo';
  try{
    const response=await fetch(`https://bizapi.csdn.net${path}`,{method:'GET',credentials:'include',headers:await signedHeaders(path,'GET'),signal:AbortSignal.timeout(6000)});
    if(response.status===401)return{ok:false,categories:[],message:'请先登录 CSDN'};
    if(!response.ok)return{ok:false,categories:[],message:`CSDN 接口异常 (${response.status})`};
    const result=await response.json() as {code?:number;data?:{categorys?:unknown;categories?:unknown}};
    if(result.code!==200)return{ok:false,categories:[],message:'CSDN 返回错误码 '+result.code};
    // CSDN 编辑器实测下发拼写错误的 categorys；做 categories 兼容防守，防平台某天修正拼写后失效。
    const raw=result.data?.categorys??result.data?.categories;
    const categories=(Array.isArray(raw)?raw:[])
      .filter((item):item is string=>typeof item==='string'&&item.trim().length>0)
      .map(item=>item.trim());
    return{ok:true,categories};
  }catch(error){
    return{ok:false,categories:[],message:(error as Error).message||'CSDN 分类列表拉取失败'};
  }
}

/**
 * 写入前查询 CSDN 文章当前状态：编辑器加载接口按 pubStatus / status 区分草稿与已发布。
 * 只有明确返回草稿或“文章不存在”才继续写入；其他无法确认的状态由后台暂停更新。
 */
export async function fetchCsdnArticleState(articleId:string):Promise<CsdnArticleState>{
  const path=`/blog-console-api/v3/editor/getArticle?id=${encodeURIComponent(articleId)}`;
  try{
    const response=await fetch(`https://bizapi.csdn.net${path}`,{method:'GET',credentials:'include',headers:await signedHeaders(path,'GET'),signal:AbortSignal.timeout(8000)});
    if(response.status===401)return'unauthorized';
    if(!response.ok){
      const detail=await response.text().catch(()=>'');
      return detail.includes('该文章不存在')?'missing':'unknown';
    }
    const result=await response.json() as {code?:number;msg?:string;message?:string;data?:{status?:number;pubStatus?:string}};
    if(result.code!==200||!result.data)return [result.msg,result.message].some(message=>message?.includes('该文章不存在'))?'missing':'unknown';
    if(typeof result.data.pubStatus==='string'&&result.data.pubStatus)return result.data.pubStatus==='draft'?'draft':'published';
    if(typeof result.data.status==='number')return result.data.status===2?'draft':'published';
    return'unknown';
  }catch{
    return'unknown';
  }
}

const CONTAINER_KINDS:Record<string,{emoji:string;label:string}>={
  tips:{emoji:'💡',label:'提示'},
  info:{emoji:'ℹ️',label:'说明'},
  note:{emoji:'📝',label:'笔记'},
  warning:{emoji:'⚠️',label:'注意'},
  danger:{emoji:'🚨',label:'警告'},
  success:{emoji:'✅',label:'成功'}
};

/** 掘金 ::: 容器语法转译为通用 Markdown 引用块，避免 CSDN 编辑器出现字面量乱码；代码围栏内的 ::: 保持原样。 */
export function sanitizeJuejinContainers(markdown:string):string{
  const lines=markdown.split('\n');
  const output:string[]=[];
  let inFence=false;
  let fenceMarker='';
  let container:{header:string;body:string[]}|null=null;
  const flushContainer=()=>{
    if(!container)return;
    output.push(container.header);
    output.push(...(container.body.length?container.body:['>']));
    container=null;
  };
  for(const line of lines){
    if(container){
      if(/^ {0,3}:::[ \t]*$/.test(line)){flushContainer();continue;}
      container.body.push(line.trim()?`> ${line}`:'>');
      continue;
    }
    const fence=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(fence){
      if(!inFence){inFence=true;fenceMarker=fence[1][0];}
      else if(fence[1][0]===fenceMarker){inFence=false;fenceMarker='';}
      output.push(line);
      continue;
    }
    if(!inFence){
      const open=line.match(/^ {0,3}:::[ \t]*([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)?[ \t]*(.*)$/);
      if(open&&open[1]){
        const meta=CONTAINER_KINDS[open[1].toLowerCase()]||{emoji:'ℹ️',label:open[1]};
        container={header:`> ${meta.emoji} ${meta.label}：${open[2].trim()}`,body:[]};
        continue;
      }
    }
    output.push(line);
  }
  flushContainer();
  return output.join('\n');
}

/** 统计正文中将被转译的掘金 ::: 容器数量（代码围栏内不计），供同步预演报告展示。 */
export function countJuejinContainers(markdown:string):number{
  let inFence=false;
  let fenceMarker='';
  let count=0;
  for(const line of markdown.split('\n')){
    const fence=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(fence){
      if(!inFence){inFence=true;fenceMarker=fence[1][0];}
      else if(fence[1][0]===fenceMarker){inFence=false;fenceMarker='';}
      continue;
    }
    if(!inFence&&/^ {0,3}:::[ \t]*[A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*[ \t]*(.*)$/.test(line))count++;
  }
  return count;
}

/** 统计 Markdown 代码围栏数量，供同步预演报告展示。 */
export function countCodeFences(markdown:string):number{
  let count=0;
  let inFence=false;
  let fenceMarker='';
  for(const line of markdown.split('\n')){
    const fence=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(!fence)continue;
    if(!inFence){inFence=true;fenceMarker=fence[1][0];count++;}
    else if(fence[1][0]===fenceMarker){inFence=false;fenceMarker='';}
  }
  return count;
}

/** 从 Markdown 提取纯文本摘要：剥离代码块、图片、链接、HTML 与行内标记后截取前 N 字。 */
export function extractSummary(markdown:string,limit=100):string{
  const text=markdown
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/~~~[\s\S]*?~~~/g,' ')
    .replace(/`([^`]*)`/g,'$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/<[^>]+>/g,' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s?/gm,' ')
    .replace(/^\s{0,3}\|.*\|\s*$/gm,' ')
    .replace(/[*_~]{1,3}/g,'')
    .replace(/\s+/g,' ')
    .trim();
  return text.length<=limit?text:text.slice(0,limit);
}

/** 构建正文末尾的首发声明块；无来源链接时返回空串（不注入）。 */
export function buildSourceAttribution(article:Article):string{
  const url=article.sourceUrl?.trim();
  if(!url)return'';
  const title=article.title?.trim();
  return`\n\n---\n\n> 本文首发于掘金${title?`：[${title}](${url})`:`：${url}`}`;
}

/** 判断图片是否为掘金私有存储或带有数字签名的外链。 */
export function isJuejinPrivateImage(src:string):boolean{
  try{
    const url=new URL(src.replace(/&amp;/g,'&'));
    return url.hostname.endsWith('-private.juejin.cn')||
      url.searchParams.has('x-orig-sign')||
      url.searchParams.has('x-orig-authkey')||
      url.searchParams.has('policy');
  }catch{
    return false;
  }
}

/** 剔除掘金图片 CDN 的 OSS 裁剪/水印参数（~tplv- 模板段与 x-oss-process 查询）；私有签名链接保持原样以防破坏签名。 */
export function stripJuejinImageParams(src:string):string{
  try{
    const url=new URL(src.replace(/&amp;/g,'&'));
    if(!/(^|\.)((juejin\.cn)|(byteimg\.com)|(bytecdn\.cn))$/i.test(url.hostname))return src;
    if(isJuejinPrivateImage(src))return src;
    let changed=false;
    const tplvIndex=url.pathname.indexOf('~tplv-');
    if(tplvIndex>0){
      url.pathname=url.pathname.slice(0,tplvIndex);
      changed=true;
    }
    if(url.searchParams.has('x-oss-process')){
      url.searchParams.delete('x-oss-process');
      changed=true;
    }
    return changed?url.toString():src;
  }catch{
    return src;
  }
}

/** 去掉掘金导出主题元数据，统一为 CSDN 支持的 Markdown 围栏，转译掘金特有容器语法。 */
export function normalizeMarkdown(source:string){
  let markdown=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const frontmatter=markdown.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if(frontmatter&&/^(?:theme|highlight)\s*:/m.test(frontmatter[1]))markdown=markdown.slice(frontmatter[0].length);
  markdown=markdown.replace(/^(?:(?:theme|highlight)\s*:[^\n]*\n){1,2}(?:\n)?/,'');
  markdown=markdown.replace(/^(\s*)~~~([^\n]*)$/gm,'$1```$2');
  markdown=sanitizeJuejinContainers(markdown);
  return markdown.trim();
}

export function imageExtension(src:string,blob:Blob){
  if(!src.startsWith('data:')){
    const pathExtension=src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1]?.toLowerCase();
    if(pathExtension&&['jpg','jpeg','png','gif','webp'].includes(pathExtension))return pathExtension;
  }
  const mimeExtension:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'};
  return mimeExtension[blob.type.toLowerCase()]||'jpg';
}

export function dataUrlToBlob(dataUrl:string):Blob{
  const commaIndex=dataUrl.indexOf(',');
  if(commaIndex===-1)throw new SyncError('无效的 Data URL 图片数据','content','images');
  const meta=dataUrl.slice(0,commaIndex);
  const rawData=dataUrl.slice(commaIndex+1);
  const mime=meta.match(/data:([^;]+)/)?.[1]||'image/png';
  const isBase64=meta.includes(';base64');
  if(isBase64){
    const binStr=atob(rawData);
    const len=binStr.length;
    const bytes=new Uint8Array(len);
    for(let i=0;i<len;i++)bytes[i]=binStr.charCodeAt(i);
    return new Blob([bytes],{type:mime});
  }else{
    const decoded=decodeURIComponent(rawData);
    return new Blob([decoded],{type:mime});
  }
}

/** 尝试通过已打开的掘金页面标签（Content Script）在第一方登录态上下文中代为下载图片。 */
async function downloadImageViaPage(src:string):Promise<Blob|null>{
  if(typeof chrome==='undefined'||!chrome.tabs?.query||!chrome.tabs?.sendMessage)return null;
  try{
    const tabs=await chrome.tabs.query({url:['https://juejin.cn/*','https://*.juejin.cn/*']});
    const sorted=[...tabs].sort((a,b)=>{
      const aEditor=a.url?.includes('/editor/')?1:0;
      const bEditor=b.url?.includes('/editor/')?1:0;
      if(aEditor!==bEditor)return bEditor-aEditor;
      return(b.active?1:0)-(a.active?1:0);
    });
    for(const tab of sorted){
      if(!tab.id)continue;
      try{
        const response=await chrome.tabs.sendMessage(tab.id,{type:'DOWNLOAD_IMAGE_VIA_PAGE',url:src}) as {ok?:boolean;dataUrl?:string}|undefined;
        if(response?.ok&&typeof response.dataUrl==='string'){
          const fetched=await fetch(response.dataUrl);
          const blob=await fetched.blob();
          if(blob.type.startsWith('image/'))return blob;
        }
      }catch{}
    }
  }catch{}
  return null;
}

export async function downloadImageBlob(src:string):Promise<Blob>{
  if(src.startsWith('data:'))return dataUrlToBlob(src);
  const targetUrl=src.replace(/&amp;/g,'&');
  const isPrivate=isJuejinPrivateImage(targetUrl);
  // 掘金私有 CDN 的签名链接仍需当前登录会话；其他外链图片不携带站点凭据。
  const credentials:RequestCredentials=isPrivate?'include':'omit';
  // 无水印直链优先（剔除 ~tplv- 模板与 x-oss-process 参数）；私有签名链接保持原样以防破坏签名。
  const direct=stripJuejinImageParams(targetUrl);
  const attempts=direct!==targetUrl?[direct,targetUrl]:[targetUrl];
  let lastError:unknown;
  for(const url of attempts){
    try{
      const imageResponse=await fetch(url,{credentials});
      if(!imageResponse.ok){
        lastError=new SyncError(`图片下载失败 (${imageResponse.status})：${src}`,statusErrorCategory(imageResponse.status)??'content','images');
        continue;
      }
      const imageBlob=await imageResponse.blob();
      if(!imageBlob.type.startsWith('image/'))throw new SyncError(`图片地址返回了非图片内容：${src}`,'content','images');
      return imageBlob;
    }catch(error){
      lastError=error;
    }
  }

  // 掘金私有图床若受限于 Service Worker 跨站凭据隔离（如 403），尝试通过打开的掘金页面 Tab 代为下载（同站第一方上下文）。
  if(isPrivate){
    const pageBlob=await downloadImageViaPage(targetUrl);
    if(pageBlob)return pageBlob;
  }

  throw lastError instanceof Error?lastError:new SyncError(`图片下载失败：${src}`,'network','images');
}

async function uploadImageToCsdn(src:string){
  const imageBlob=await downloadImageBlob(src);
  const extension=imageExtension(src,imageBlob);
  const signaturePath='/resource-api/v1/image/direct/upload/signature';
  const signatureResponse=await fetch(`https://bizapi.csdn.net${signaturePath}`,{method:'POST',credentials:'include',headers:await signedHeaders(signaturePath,'POST'),body:JSON.stringify({imageTemplate:'',appName:'direct_blog_markdown',imageSuffix:extension})});
  if(!signatureResponse.ok)throw new SyncError(`获取 CSDN 图片上传凭证失败 (${signatureResponse.status})`,statusErrorCategory(signatureResponse.status)??'platform-change','images');
  const signatureResult=await signatureResponse.json() as {code?:number;msg?:string;message?:string;data?:UploadSignature};
  if(signatureResult.code!==200||!signatureResult.data)throw new SyncError(signatureResult.msg||signatureResult.message||'获取 CSDN 图片上传凭证失败','platform-change','images');

  const upload=signatureResult.data;
  const custom=upload.customParam;
  const form=new FormData();
  form.append('key',upload.filePath);
  form.append('policy',upload.policy);
  form.append('signature',upload.signature);
  form.append('callbackBody',upload.callbackBody);
  form.append('callbackBodyType',upload.callbackBodyType);
  form.append('callbackUrl',upload.callbackUrl);
  form.append('AccessKeyId',upload.accessId);
  form.append('x:rtype',custom.rtype);
  form.append('x:filePath',custom.filePath);
  form.append('x:isAudit',String(custom.isAudit));
  form.append('x:x-image-app',custom['x-image-app']);
  form.append('x:type',custom.type);
  form.append('x:x-image-suffix',custom['x-image-suffix']);
  form.append('x:username',custom.username);
  form.append('file',imageBlob,`image.${extension}`);
  const uploadResponse=await fetch(upload.host,{method:'POST',body:form});
  if(!uploadResponse.ok)throw new SyncError(`上传图片到 CSDN 失败 (${uploadResponse.status})`,statusErrorCategory(uploadResponse.status)??'network','images');
  const uploadResult=await uploadResponse.json() as {code?:number;msg?:string;message?:string;data?:{imageUrl?:string}};
  if(uploadResult.code!==200||!uploadResult.data?.imageUrl)throw new SyncError(uploadResult.msg||uploadResult.message||'上传图片到 CSDN 失败','platform-change','images');
  return uploadResult.data.imageUrl;
}

type ImageReference={src:string;start:number;end:number};

/** 仅定位实际图片标签的地址，代码围栏、缩进代码、行内代码与 HTML code/pre 内的示例不参与转存。 */
function imageReferences(markdown:string):ImageReference[]{
  const hidden=markdown.split('');
  const mask=(start:number,end:number)=>{for(let i=start;i<end;i++)if(hidden[i]!=='\n')hidden[i]=' ';};
  let fence:{marker:string;length:number}|undefined;
  let listContentIndent:number|undefined;
  let offset=0;
  for(const line of markdown.match(/[^\n]*(?:\n|$)/g)||[]){
    if(!line)continue;
    const listItem=line.match(/^( *)(?:[-*+]|\d+[.)]) +/);
    if(listItem)listContentIndent=listItem[0].length;
    else if(line.trim()&&listContentIndent!==undefined&&line.match(/^ */)![0].length<listContentIndent)listContentIndent=undefined;
    const marker=line.match(/^ {0,7}(?:>\s*)*(`{3,}|~{3,})/);
    if(fence){
      mask(offset,offset+line.length);
      if(marker&&marker[1][0]===fence.marker&&marker[1].length>=fence.length&&/^\s*$/.test(line.slice(marker[0].length)))fence=undefined;
    }else if(marker){
      fence={marker:marker[1][0],length:marker[1].length};
      mask(offset,offset+line.length);
    }else if(/^(?: {4,}|\t)/.test(line)&&!(listContentIndent!==undefined&&line.match(/^ */)![0].length<listContentIndent+4))mask(offset,offset+line.length);
    offset+=line.length;
  }
  for(const match of markdown.matchAll(/<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)>/gi))mask(match.index!,match.index!+match[0].length);
  // 只有存在闭合反引号时才视为代码跨度；未闭合的反引号仍是普通文本。
  for(let i=0;i<hidden.length;){
    if(hidden[i]!== '`'){i++;continue;}
    let length=1;while(hidden[i+length]==='`')length++;
    let close=-1;
    for(let j=i+length;j<hidden.length;j++){
      if(hidden[j]!=='`')continue;
      let closeLength=1;while(hidden[j+closeLength]==='`')closeLength++;
      if(closeLength===length){close=j;break;}
      j+=closeLength-1;
    }
    if(close<0){i+=length;continue;}
    mask(i,close+length);
    i=close+length;
  }
  const visible=hidden.join('');
  const references:ImageReference[]=[];
  const markdownImage=/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
  const htmlImage=/<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  for(const match of visible.matchAll(markdownImage)){
    let slashCount=0;for(let i=match.index!-1;i>=0&&visible[i]==='\\';i--)slashCount++;
    if(slashCount%2)continue;
    const src=match[1]||match[2];
    const start=match.index!+match[0].lastIndexOf(src);
    references.push({src,start,end:start+src.length});
  }
  for(const match of visible.matchAll(htmlImage)){
    let slashCount=0;for(let i=match.index!-1;i>=0&&visible[i]==='\\';i--)slashCount++;
    if(slashCount%2)continue;
    const src=match[1];
    const start=match.index!+match[0].lastIndexOf(src);
    references.push({src,start,end:start+src.length});
  }
  return references.sort((a,b)=>a.start-b.start);
}

export function collectExternalImages(markdown:string){
  const urls=new Set(imageReferences(markdown).map(item=>item.src));
  return[...urls].filter(src=>{
    try{
      const url=new URL(src);
      return /^https?:$/.test(url.protocol)&&!/(?:^|\.)csdn\.net$|(?:^|\.)csdnimg\.cn$/i.test(url.hostname);
    }catch{return false;}
  });
}

/** CSDN 无法稳定读取掘金 CDN，保存前将正文和封面图片转存到 CSDN。 */
type SaveDraftOptions={articleId?:string;categories?:string[];syncCover?:boolean;autoSummary?:boolean;appendSourceLink?:boolean;imageFailurePolicy?:ImageFailurePolicy;_rateLimitRetried?:boolean;rateLimitDelayMs?:number;onPreparing?:()=>void|Promise<void>;onProgress?:(progress:TaskProgress)=>void|Promise<void>;onSaving?:()=>void|Promise<void>;onDowngradeToCreate?:()=>void|Promise<void>};
type ImageTransfer={src:string;target?:string;error?:string;errorCategory?:TaskErrorCategory};

export function summarizeImageTransfers(transfers:ImageTransfer[]){
  return{imageTotal:transfers.length,imageSucceeded:transfers.filter(item=>item.target).length,imageFailed:transfers.filter(item=>item.error).length};
}

export function enforceImageFailurePolicy(transfers:ImageTransfer[],policy:ImageFailurePolicy='continue'){
  const failed=transfers.filter(item=>item.error);
  if(policy==='abort'&&failed.length)throw new SyncError(`有 ${failed.length} 张图片转存失败，已按设置终止同步：${failed[0].error}`,failed[0].errorCategory??'content','images');
}

export function applyImageTransfers(markdown:string,cover:string|undefined,transfers:ImageTransfer[]){
  const replacements=new Map(transfers.filter(item=>item.target).map(item=>[item.src,item.target!]));
  const references=imageReferences(markdown);
  const bodyImages=new Set(references.map(reference=>reference.src));
  for(const reference of references.reverse()){
    const target=replacements.get(reference.src);
    if(target)markdown=markdown.slice(0,reference.start)+target+markdown.slice(reference.end);
  }
  const warnings=transfers.filter(item=>item.error).map(item=>{
    const location=cover===item.src&&!bodyImages.has(item.src)?'封面':'正文图片';
    const action=location==='封面'?'已忽略':'已保留原链接';
    return`${location}转存失败，${action}：${item.src}（${item.error}）`;
  });
  return{markdown,cover:cover?replacements.get(cover):undefined,warnings};
}

async function prepareArticle(article:Article,options:SaveDraftOptions){
  let markdown=normalizeMarkdown(article.markdown);
  // 摘要基于注入首发声明之前的正文提取，避免声明文案混入摘要。
  const summary=article.summary?.trim()||extractSummary(markdown);
  if(options.appendSourceLink!==false)markdown+=buildSourceAttribution(article);
  const images=collectExternalImages(markdown);
  const cover=options.syncCover===false?undefined:article.cover;
  if(cover&&!images.includes(cover))images.push(cover);
  let completed=0;
  if(images.length)await options.onProgress?.({current:0,total:images.length,message:`准备转存 ${images.length} 张图片`});
  const transfers=await mapConcurrent(images,3,async src=>{
    let result:ImageTransfer;
    try{result={src,target:await retry(()=>uploadImageToCsdn(src))};}
    catch(error){
      result={src,error:(error as Error).message,errorCategory:error instanceof SyncError?error.category:undefined};
    }
    finally{
      completed++;
      await options.onProgress?.({current:completed,total:images.length,message:`正在转存图片 ${completed}/${images.length}`});
    }
    return result;
  });
  enforceImageFailurePolicy(transfers,options.imageFailurePolicy);
  const transferred=applyImageTransfers(markdown,cover,transfers);
  const html=marked.parse(transferred.markdown,{async:false,gfm:true,breaks:false}) as string;
  return{...transferred,html,summary,stats:summarizeImageTransfers(transfers)};
}

export function buildSaveArticleBody(article:Article,prepared:{markdown:string;html:string;cover?:string;summary?:string},articleId?:string,categories:string[]=[],autoSummary=true){
  // CSDN 编辑器摘要字段为大写 Description；原创文章的 original_link 语义为「转载原文」，保持留空以符合平台规则。
  return{title:article.title,markdowncontent:prepared.markdown+'\n',content:prepared.html+'\n',Description:autoSummary?prepared.summary||'':'',readType:'public',level:0,tags:article.tags?.join(',')||'',status:2,categories:[...new Set(categories.map(item=>item.trim()).filter(Boolean))].join(','),type:'original',original_link:'',authorized_status:false,not_auto_saved:'1',source:'pc_mdeditor',cover_images:prepared.cover?[prepared.cover]:[],cover_type:prepared.cover?1:0,is_new:articleId?0:1,...(articleId?{id:articleId}:{}),vote_id:0,resource_id:'',pubStatus:'draft',creation_statement:0,creator_activity_id:''};
}

type PreparedArticle=Awaited<ReturnType<typeof prepareArticle>>;

/** 调用 CSDN 保存草稿 API；400 降级新建时复用已转存的 prepared 结果，避免重复下载与上传图片。 */
export async function saveDraftViaApi(article:Article,options:SaveDraftOptions={},prepared?:PreparedArticle):Promise<AdapterResult>{
  validateCsdnArticle(article);
  const auth=await checkCsdnAuth();
  if(!auth.ok)throw new SyncError(auth.message||'CSDN 登录状态检测失败','platform-change','authentication');
  if(!auth.loggedIn)throw new SyncError('请先登录 CSDN','login','authentication');
  await options.onPreparing?.();
  const preparedResult=prepared??await prepareArticle(article,options);
  const body=buildSaveArticleBody(article,preparedResult,options.articleId,options.categories,options.autoSummary!==false);
  await options.onSaving?.();
  let response:Response;
  try{
    response=await fetch(API,{method:'POST',credentials:'include',signal:AbortSignal.timeout(30000),headers:await signedHeaders('/blog-console-api/v3/mdeditor/saveArticle','POST'),body:JSON.stringify(body)});
  }catch{
    // 请求可能已经到达 CSDN；不能把没有收到响应等同于“没有创建草稿”。
    throw new SyncError('无法确认 CSDN 草稿是否已保存，请先检查草稿箱，再决定是否重试','interrupted','draft');
  }
  if(!response.ok){
    const text=await response.text().catch(()=>'');
    // 更新模式下 CSDN 返回 400「该文章不存在」（草稿已被用户在 CSDN 删除等）：自动降级为新建草稿，避免任务因旧 articleId 永久卡死。
    if(response.status===400&&options.articleId&&text.includes('该文章不存在')){
      await options.onDowngradeToCreate?.();
      return saveDraftViaApi(article,{...options,articleId:undefined},preparedResult);
    }
    // 频控识别：CSDN 响应 400 且文本包含「文章频繁发布」或「频繁」或「稍后再试」
    if(response.status===400&&(text.includes('频繁')||text.includes('稍后再试'))){
      if(!options._rateLimitRetried){
        const delay=options.rateLimitDelayMs??4000;
        if(delay>0)await sleep(delay);
        return saveDraftViaApi(article,{...options,_rateLimitRetried:true},preparedResult);
      }
      throw new SyncError('CSDN 发文过于频繁，已被平台临时限流，请稍后再试','rate-limit','draft');
    }
    throw new SyncError('CSDN API 请求失败 ('+response.status+')'+(text?': '+text.slice(0,120):''),statusErrorCategory(response.status)??'platform-change','draft');
  }
  let result:{code?:number;msg?:string;message?:string;data?:{id?:string;article_id?:string;url?:string}};
  try{result=await response.json();if(!result||typeof result!=='object')throw new Error('invalid response');}
  catch{throw new SyncError('CSDN 已响应保存请求，但结果无法解析，请先检查草稿箱','interrupted','draft');}
  if(result.code!==200&&result.code!==0){
    const msg=result.msg||result.message||'';
    if(msg.includes('频繁')||msg.includes('稍后再试')){
      if(!options._rateLimitRetried){
        const delay=options.rateLimitDelayMs??4000;
        if(delay>0)await sleep(delay);
        return saveDraftViaApi(article,{...options,_rateLimitRetried:true},preparedResult);
      }
      throw new SyncError('CSDN 发文过于频繁，已被平台临时限流，请稍后再试','rate-limit','draft');
    }
    if(typeof result.code!=='number')throw new SyncError('CSDN 保存响应缺少结果码，请先检查草稿箱确认结果','interrupted','draft');
    throw new SyncError(msg||'CSDN 返回错误码 '+result.code,'platform-change','draft');
  }
  const articleId=result.data?.id||result.data?.article_id;
  const draftUrl=result.data?.url||(articleId?'https://editor.csdn.net/md/?articleId='+articleId:'');
  if(!draftUrl||!articleId)throw new SyncError('CSDN 保存响应缺少草稿标识，请先检查草稿箱确认结果','interrupted','draft');
  return{draftUrl,articleId:String(articleId),warnings:preparedResult.warnings,stats:preparedResult.stats};
}

/** 同步预演报告：执行除图片转存与草稿写入外的全部分析，供用户在确认前评估风险。issues 为风险/警告，notices 为功能告知。 */
export type DryRunReport={
  titleLength:number;
  contentLength:number;
  summaryPreview:string;
  categories:string[];
  imageCount:number;
  images:string[];
  containerCount:number;
  codeFenceCount:number;
  issues:string[];
  notices:string[];
};

export function buildDryRunReport(article:Article,settings:ExtensionSettings):DryRunReport{
  const markdown=normalizeMarkdown(article.markdown);
  // 容器计数基于转译前的原始正文：normalizeMarkdown 已把 ::: 容器转译为引用块，事后统计恒为 0。
  const rawMarkdown=article.markdown.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const issues:string[]=[];
  const title=article.title.trim();
  if(title.length<5)issues.push(`标题 ${title.length} 字，少于 CSDN 要求的 5 字下限`);
  if(title.length>100)issues.push(`标题 ${title.length} 字，超过 CSDN 的 100 字上限`);
  if(markdown.length<20)issues.push('正文内容过短，不满足同步要求');
  const images=collectExternalImages(markdown);
  if(images.length>50)issues.push(`外链图片多达 ${images.length} 张，转存耗时较长`);
  const categories=resolveCsdnCategories(article.tags,settings);
  if(!categories.length)issues.push('未命中任何 CSDN 分类（可在偏好设置中配置默认分类或标签映射）');
  // 首发声明注入是默认功能告知而非风险，单独走 notices，避免风险清单常黄。
  const notices:string[]=[];
  const attribution=buildSourceAttribution(article);
  if(attribution&&settings.appendSourceLink!==false)notices.push(`将在正文末尾注入首发声明（掘金原文：${article.sourceUrl}）`);
  return{
    titleLength:title.length,
    contentLength:markdown.length,
    summaryPreview:settings.autoSummary===false?'':(article.summary?.trim()||extractSummary(markdown)),
    categories,
    imageCount:images.length,
    images:images.slice(0,20),
    containerCount:countJuejinContainers(rawMarkdown),
    codeFenceCount:countCodeFences(markdown),
    issues,
    notices
  };
}
