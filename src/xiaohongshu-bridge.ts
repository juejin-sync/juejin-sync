// 小红书隔离世界驱动：分别写入长文与精简图文，只点击“暂存离开”并确认本地事务完成。
import {normalizeXiaohongshuText,parseXiaohongshuUser} from './targets/xiaohongshu-capture';

const RESPONSE_EVENT='article-ferry:xhs-response';
const RESPONSE_ATTRIBUTE='data-article-ferry-xhs';
const COMMAND_EVENT='article-ferry:xhs-command';
const COMMAND_ATTRIBUTE='data-article-ferry-xhs-command';
const ACK_ATTRIBUTE='data-article-ferry-xhs-ack';
const USER_INFO_ENDPOINT='https://creator.xiaohongshu.com/api/galaxy/user/info';
const TITLE_SELECTORS=['input[placeholder*="标题"]','textarea[placeholder*="标题"]'];
const EDITOR_SELECTORS=['.ProseMirror[contenteditable="true"]'];
// 首图入口与编辑区追加入口不同；只选 multiple，避免误改封面或替换单图。
const FILE_INPUT_SELECTORS=['.img-list input[type="file"][multiple]','input.upload-input[type="file"][multiple][accept*=".jpg"]'];
const IMAGE_SELECTOR='.img-preview-area .img-container';
function findFileInput(){
  for(const selector of FILE_INPUT_SELECTORS){
    const input=document.querySelector<HTMLInputElement>(selector);
    if(input)return input;
  }
}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

function isVisible(element:Element){
  const rect=element.getBoundingClientRect();
  const style=getComputedStyle(element);
  return rect.width>0&&rect.height>0&&rect.right>0&&rect.bottom>0&&style.visibility!=='hidden'&&style.display!=='none'&&style.opacity!=='0'&&!element.closest('[aria-hidden="true"]');
}

function findFirst<T extends Element>(selectors:string[]):T|undefined{
  for(const selector of selectors){
    const element=[...document.querySelectorAll<T>(selector)].find(isVisible);
    if(element)return element;
  }
}

async function waitForElement<T extends Element>(selectors:string[],timeoutMs:number):Promise<T|undefined>{
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){
    const element=findFirst<T>(selectors);
    if(element)return element;
    await sleep(200);
  }
}

/** 精确匹配真实页面的保存文案，不匹配“发布”或包含额外动作的按钮。 */
function findSaveButton(){
  const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>isVisible(button)&&!button.disabled&&(button.textContent||'').replace(/\s+/g,'')==='暂存离开');
  if(button)return button;
  // 新版底部按钮位于 closed Shadow DOM；通过组件已公开的 save 事件保存，不访问内部节点。
  const isReady=(host:HTMLElement)=>{
    const disabled=host.getAttribute('save-disabled');
    return isVisible(host)&&host.getAttribute('is-save-draft')!=='false'&&
      (disabled===null||disabled==='false')&&
      (host.getAttribute('save-text')??'暂存离开').replace(/\s+/g,'')==='暂存离开';
  };
  const host=[...document.querySelectorAll<HTMLElement>('xhs-publish-btn')].find(isReady);
  if(host)return{click:()=>{
    if(!isReady(host))throw new Error('暂存控件当前不可用');
    host.dispatchEvent(new CustomEvent('save',{bubbles:true,composed:true}));
  }};
}

async function prepareImageNote(){
  const end=Date.now()+20000;
  while(Date.now()<end){
    if(findFileInput())return{ok:true};
    const tab=[...document.querySelectorAll<HTMLElement>('.creator-tab')].find(element=>isVisible(element)&&(element.textContent||'').trim()==='上传图文');
    if(tab)tab.click();
    await sleep(300);
  }
  return{ok:false,message:'未找到小红书图文上传入口，页面可能已改版'};
}

function setInputValue(input:HTMLInputElement|HTMLTextAreaElement,value:string){
  const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  const descriptor=Object.getOwnPropertyDescriptor(prototype,'value');
  try{
    descriptor?.set?.call(input,value);
  }catch{
    input.value=value;
  }
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
}

/**
 * 富文本编辑器优先用 execCommand 模拟真实输入；框架未接管时退回 textContent + input 事件。
 * 核对编辑器是否接受完整正文，避免只写入 DOM 就报告完成。
 */
function insertEditorText(editor:HTMLElement,text:string){
  editor.focus();
  try{
    const selection=window.getSelection();
    if(selection){
      const range=document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand('insertText',false,text);
  }catch{
    // 继续走兜底路径。
  }
  const written=(editor.innerText||editor.textContent||'').trim();
  if(normalizeXiaohongshuText(written)===normalizeXiaohongshuText(text))return true;
  editor.textContent=text;
  try{editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}catch{editor.dispatchEvent(new Event('input',{bubbles:true}));}
  return normalizeXiaohongshuText(editor.innerText||editor.textContent||'')===normalizeXiaohongshuText(text);
}

function dataUrlToFile(base64:string,mime:string,name:string){
  const binary=atob(base64);
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return new File([bytes],name,{type:mime||'image/png'});
}

function injectFile(input:HTMLInputElement,file:File){
  const transfer=new DataTransfer();
  transfer.items.add(file);
  try{
    input.files=transfer.files;
  }catch{
    try{Object.defineProperty(input,'files',{value:transfer.files,configurable:true});}catch{}
  }
  input.dispatchEvent(new Event('change',{bubbles:true}));
}

/** 每次重新读取用户接口，避免缓存账号掩盖页面中的账号切换。 */
async function getSession(){
  try{
    const response=await fetch(USER_INFO_ENDPOINT,{credentials:'include',signal:AbortSignal.timeout(7000)});
    if(response.status===401)return{ok:true,loggedIn:false};
    if(response.ok&&/json/i.test(response.headers.get('content-type')||'')){
      const user=parseXiaohongshuUser(await response.json());
      if(user)return{ok:true,loggedIn:true,...user};
    }
  }catch{/* 读取失败时返回未确认状态，禁止使用旧账号缓存。 */}
  return{ok:false,loggedIn:false,message:'无法确认小红书当前账号，请打开创作服务平台检查登录状态'};
}

async function waitEditor(timeoutMs=20000){
  const editor=await waitForElement<HTMLElement>(EDITOR_SELECTORS,timeoutMs);
  const titleInput=editor&&await waitForElement<HTMLInputElement|HTMLTextAreaElement>(TITLE_SELECTORS,5000);
  return titleInput?{ok:true}:{ok:false,message:'未找到小红书图文编辑器，请检查图片是否上传成功'};
}

async function fillText(payload:{title?:string;body?:string}){
  const title=String(payload?.title||'');
  const body=String(payload?.body||'');
  if(!title.trim()||!body.trim())return{ok:false,message:'小红书标题或正文为空，已阻止写入'};
  const titleInput=findFirst<HTMLInputElement|HTMLTextAreaElement>(TITLE_SELECTORS);
  const editor=findFirst<HTMLElement>(EDITOR_SELECTORS);
  if(!titleInput||!editor)return{ok:false,message:'未找到小红书标题或正文编辑器，页面可能已改版'};
  setInputValue(titleInput,title);
  if(!insertEditorText(editor,body))return{ok:false,message:'小红书编辑器未完整接受正文'};
  await sleep(400);
  return normalizeXiaohongshuText(titleInput.value)===normalizeXiaohongshuText(title)&&normalizeXiaohongshuText(editor.innerText||'')===normalizeXiaohongshuText(body)
    ?{ok:true}:{ok:false,message:'小红书编辑器内容与文章不一致，请检查本地草稿'};
}

async function uploadImage(payload:{base64:string;mime:string;name:string;imageCount:number}){
  const input=findFileInput();
  if(!input)return{ok:false,message:'未找到小红书图片上传入口，页面可能已改版'};
  const file=dataUrlToFile(payload.base64,payload.mime,payload.name);
  if(!file.size)return{ok:false,message:'图片内容为空'};
  injectFile(input,file);
  // 真实上传状态和图片数在图文编辑区确认；最终保存还会核对平台写入的完整 fileId 列表。
  const end=Date.now()+45000;
  while(Date.now()<end){
    const images=[...document.querySelectorAll(IMAGE_SELECTOR)];
    if(images.some(image=>image.querySelector('.mask.failed')))return{ok:false,message:'小红书图片上传失败，请检查保留的编辑页'};
    if(images.length===payload.imageCount&&images.every(image=>!image.querySelector('.mask.uploading,.processing-container'))&&findFirst(EDITOR_SELECTORS))return{ok:true};
    await sleep(300);
  }
  return{ok:false,message:'小红书图片上传超时，请检查保留的编辑页'};
}

const ARTICLE_EDITOR='.rich-editor-content .tiptap.ProseMirror[contenteditable="true"]';
/** 请求主世界服务，只返回图片地址或保存凭证，上传许可不跨世界传递。 */
function articlePageRequest(action:string,payload:unknown):Promise<any>{
  const requestId=crypto.randomUUID(),root=document.documentElement,attr='data-article-ferry-xhs-article';
  return new Promise(resolve=>{
    const finish=(result:any)=>{clearTimeout(timer);document.removeEventListener('article-ferry:xhs-article-response',listener);resolve(result);};
    const listener=()=>{try{const result=JSON.parse(root.getAttribute(attr)||'{}');if(result.requestId===requestId)finish(result);}catch{}};
    const timer=setTimeout(()=>finish({ok:false,message:'小红书长文服务超时，请核对草稿箱后再试'}),45000);
    document.addEventListener('article-ferry:xhs-article-response',listener);
    root.setAttribute(attr,JSON.stringify({requestId,action,payload}));document.dispatchEvent(new Event('article-ferry:xhs-article-request'));root.removeAttribute(attr);
  });
}
function importArticle(payload:any){
  const document=new DOMParser().parseFromString(payload.html,'text/html');
  function walk(node:Node):any[]{
    if(node.nodeType===3)return node.textContent?[{type:'text',text:node.textContent.replace(/\u00a0/g,' ')}]:[];
    if(node.nodeType!==1)return [];
    const element=node as Element,tag=element.tagName.toLowerCase();
    if(element.hasAttribute('data-xhs-image')){
      const image=payload.images[Number(element.getAttribute('data-xhs-image'))];
      return[{type:'image',attrs:{imgs:[{src:image.src,desc:'',percent:0,width:410,height:410*image.height/image.width}]}}];
    }
    if(tag==='br')return[{type:'hardBreak'}];
    const content=[...node.childNodes].flatMap(walk);
    const type:Record<string,string>={p:'paragraph',h1:'heading',h2:'heading',ul:'bulletList',ol:'orderedList',li:'listItem',blockquote:'blockquote'};
    if(!type[tag])throw new Error('长文包含未经校准的结构');
    return[{type:type[tag],...(tag==='h1'||tag==='h2'?{attrs:{level:Number(tag[1])}}:{}),...(content.length?{content}:{})}];
  }
  const richJson={type:'doc',content:[...document.body.childNodes].flatMap(walk)};
  return articlePageRequest('import',{...payload,richJson,imageCount:payload.images.length});
}
async function prepareArticle(){
  const end=Date.now()+20000;
  while(Date.now()<end){
    if(findFirst([ARTICLE_EDITOR])&&findFirst(['textarea[placeholder="输入标题"]']))return{ok:true};
    const create=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>isVisible(b)&&(b.textContent||'').trim()==='新的创作');
    if(create)create.click();
    else{
      const tab=[...document.querySelectorAll<HTMLElement>('.creator-tab')].find(e=>isVisible(e)&&(e.textContent||'').trim()==='写长文');
      if(tab)tab.click();
    }
    await sleep(300);
  }
  return{ok:false,message:'未找到小红书长文编辑器，页面可能已改版'};
}
/** 使用页面原生粘贴处理器，让编辑器自己更新 richJson；不直接写平台内部状态。 */
function pasteArticleHtml(editor:HTMLElement,html:string,replace:boolean){
  editor.focus();
  const range=document.createRange();range.selectNodeContents(editor);
  if(!replace)range.collapse(false);
  const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  const data=new DataTransfer();data.setData('text/html',html);
  editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
}
async function fillArticle(payload:{title?:string;html?:string},append=false){
  const editor=findFirst<HTMLElement>([ARTICLE_EDITOR]);
  const title=findFirst<HTMLTextAreaElement>(['textarea[placeholder="输入标题"]']);
  if(!editor||!title)return{ok:false,message:'长文编辑器未就绪'};
  if(!append){
    if(!payload.title?.trim()||payload.title.length>Number(title.maxLength))return{ok:false,message:'长文标题超出页面限制'};
    setInputValue(title,payload.title);
  }
  if(payload.html)pasteArticleHtml(editor,payload.html,!append);
  await sleep(400);
  return{ok:true};
}
async function uploadArticleImage(payload:{base64:string;mime:string;name:string;imageCount:number}){
  const editor=findFirst<HTMLElement>([ARTICLE_EDITOR]);
  if(!editor)return{ok:false,message:'长文编辑器未就绪'};
  editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);
  const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  const data=new DataTransfer();data.items.add(dataUrlToFile(payload.base64,payload.mime,payload.name));
  // ProseMirror 对无文本切片的粘贴会在 fallback 中再次调用 handlePaste，造成重复上传。
  // 空段落提供合法切片，使文件处理器只执行一次；不向正文添加占位文字。
  data.setData('text/html','<p></p>');
  editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  const end=Date.now()+45000;
  while(Date.now()<end){
    const images=[...editor.querySelectorAll<HTMLImageElement>('img:not([data-emoji-shortcode])')];
    if(images.length===payload.imageCount&&images.every(img=>/^https:\/\//.test(img.src)&&img.complete&&img.naturalWidth>0))return{ok:true};
    await sleep(300);
  }
  return{ok:false,message:'长文配图上传超时，请检查保留的编辑页'};
}
function checkArticle(payload:{title:string;body:string;imageCount:number}){
  const editor=findFirst<HTMLElement>([ARTICLE_EDITOR]);
  const title=findFirst<HTMLTextAreaElement>(['textarea[placeholder="输入标题"]']);
  const text=editor?[...editor.querySelectorAll<HTMLElement>('p,h1,h2')].map(e=>e.innerText||'').join('\n'):'';
  // 上限 span 使用 v-show 隐藏但仍有 textContent，不能凭 /10000 文本判定超限。
  if(document.querySelector('.rich-editor-container .char-count.danger-text'))return{ok:false,message:'长文超过页面字数限制，请精简后重试'};
  return title?.value===payload.title&&normalizeXiaohongshuText(text)===normalizeXiaohongshuText(payload.body)&&editor?.querySelectorAll('img:not([data-emoji-shortcode])').length===payload.imageCount
    ?{ok:true}:{ok:false,message:'长文内容或配图未完整进入编辑器，请检查草稿'};
}

/** 点击前武装只读事务观测，必须收到本次请求的保存凭证才报告成功。 */
async function saveNote(payload:{accountId:string;title:string;body:string;imageCount:number}){
  const end=Date.now()+10000;
  let button=findSaveButton();
  while(!button&&Date.now()<end){await sleep(200);button=findSaveButton();}
  if(!button)return{ok:false,message:'未找到可用的“暂存离开”按钮，请检查图片上传状态'};
  const requestId=crypto.randomUUID();
  const root=document.documentElement;
  return new Promise(resolve=>{
    let settled=false;
    const finish=(result:unknown)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      document.removeEventListener(RESPONSE_EVENT,onResponse);
      root.setAttribute(COMMAND_ATTRIBUTE,JSON.stringify({requestId,cancel:true}));
      document.dispatchEvent(new Event(COMMAND_EVENT));
      resolve(result);
    };
    const onResponse=()=>{
      const raw=root.getAttribute(RESPONSE_ATTRIBUTE);
      if(!raw)return;
      try{
        const result=JSON.parse(raw);
        if(result.requestId===requestId)finish(result);
      }catch{/* 不相关或异常响应由超时处理。 */}
    };
    const timer=setTimeout(()=>finish({ok:false,message:'等待小红书本地保存结果超时，请先检查当前浏览器的草稿箱'}),45000);
    document.addEventListener(RESPONSE_EVENT,onResponse);
    root.setAttribute(COMMAND_ATTRIBUTE,JSON.stringify({requestId,...payload}));
    document.dispatchEvent(new Event(COMMAND_EVENT));
    const armed=root.getAttribute(ACK_ATTRIBUTE)===requestId;
    root.removeAttribute(ACK_ATTRIBUTE);
    if(!armed){finish({ok:false,message:'本地草稿观测器未就绪，请刷新小红书发布页后重试'});return;}
    try{button.click();}catch{finish({ok:false,message:'无法点击小红书暂存按钮，请检查保留的编辑页'});}
  });
}

async function handleAction(action:string,payload:any){
  switch(action){
    case 'PING':return{ok:true};
    case 'GET_SESSION':return getSession();
    case 'UPLOAD_ARTICLE_FILE':return articlePageRequest('upload',payload);
    case 'IMPORT_ARTICLE':return importArticle(payload);
    case 'PREPARE_ARTICLE':return prepareArticle();
    case 'FILL_ARTICLE':return fillArticle(payload);
    case 'APPEND_ARTICLE_HTML':return fillArticle(payload,true);
    case 'UPLOAD_ARTICLE_IMAGE':return uploadArticleImage(payload);
    case 'CHECK_ARTICLE':return checkArticle(payload);
    case 'PREPARE_IMAGE_NOTE':return prepareImageNote();
    case 'WAIT_EDITOR':return waitEditor(Number(payload?.timeoutMs)||20000);
    case 'FILL_TEXT':return fillText(payload);
    case 'UPLOAD_IMAGE':return uploadImage(payload);
    case 'SAVE_NOTE':return saveNote(payload);
    default:return{ok:false,message:`未知动作: ${action}`};
  }
}

chrome.runtime.onMessage.addListener((message:any,_sender:chrome.runtime.MessageSender,sendResponse:(response:any)=>void)=>{
  if(message?.target!=='xiaohongshu-bridge')return;
  handleAction(String(message.action||''),message.payload).then(sendResponse).catch(error=>sendResponse({ok:false,message:(error as Error)?.message||String(error)}));
  return true;
});
