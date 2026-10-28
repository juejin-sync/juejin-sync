// 小红书发布页驱动：填充标题/正文、逐张注入图片、点击存草稿，并等待页面回传笔记标识。
// 选择器与按钮文案集中在此处，平台改版时只需修正一份常量。
import {detectNoteStateFromText,parseXiaohongshuUser} from './targets/xiaohongshu-capture';

const RESPONSE_EVENT='article-ferry:xhs-response';
const RESPONSE_ATTRIBUTE='data-article-ferry-xhs';
const USER_INFO_ENDPOINTS=['https://creator.xiaohongshu.com/api/galaxy/user/info','https://creator.xiaohongshu.com/api/galaxy/user/self_info'];
const DRAFT_MANAGER_URL='https://creator.xiaohongshu.com/new/note-manager?tab=draft';

const TITLE_SELECTORS=[
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  'input[placeholder*="填写标题"]',
  '.title-input input',
  '.publish-title input'
];
const EDITOR_SELECTORS=[
  '[contenteditable="true"]',
  '.ql-editor',
  '.editor-content [contenteditable="true"]',
  '.publish-content [contenteditable="true"]'
];
const SAVE_BUTTON_TEXTS=['存草稿','保存草稿'];
const FILE_INPUT_SELECTOR='input[type="file"]';

type BridgeSession={accountId:string;account?:string};
type BridgeSaveResult={ok:boolean;noteId?:string;message?:string};

let lastUser:BridgeSession|undefined;
let lastSave:BridgeSaveResult|undefined;
let lastState:{state:string}|undefined;
const waiters:Record<string,Array<(value:unknown)=>void>>={};

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

function emit(kind:string,value:unknown){
  const pending=waiters[kind];
  if(!pending)return;
  waiters[kind]=[];
  pending.forEach(resolve=>resolve(value));
}

function waitFor<T>(kind:string,timeoutMs:number):Promise<T|undefined>{
  return new Promise<T|undefined>(resolve=>{
    let settled=false;
    const finish=(value:T|undefined)=>{
      if(settled)return;
      settled=true;
      resolve(value);
    };
    const timer=setTimeout(()=>finish(undefined),timeoutMs);
    (waiters[kind]||=[]).push(value=>{
      clearTimeout(timer);
      finish(value as T);
    });
  });
}

/** 主世界通过 documentElement 属性共享响应数据；事件仅作唤醒信号。 */
function onPageResponse(){
  const raw=document.documentElement.getAttribute(RESPONSE_ATTRIBUTE);
  if(!raw)return;
  document.documentElement.removeAttribute(RESPONSE_ATTRIBUTE);
  try{
    const payload=JSON.parse(raw) as {kind?:string;accountId?:string;account?:string;ok?:boolean;noteId?:string;message?:string;state?:string};
    if(payload.kind==='user'&&payload.accountId){
      lastUser={accountId:payload.accountId,account:payload.account};
      emit('user',lastUser);
    }else if(payload.kind==='note-save'){
      lastSave={ok:payload.ok===true,noteId:payload.noteId,message:payload.message};
      emit('note-save',lastSave);
    }else if(payload.kind==='note-state'&&payload.state){
      lastState={state:payload.state};
      emit('note-state',lastState);
    }
  }catch{
    // 页面数据异常时静默忽略，由上层超时兜底。
  }
}

if(typeof document!=='undefined')document.addEventListener(RESPONSE_EVENT,onPageResponse);

function findFirst<T extends Element>(selectors:string[]):T|undefined{
  for(const selector of selectors){
    const element=document.querySelector<T>(selector);
    if(element)return element;
  }
  return undefined;
}

async function waitForElement<T extends Element>(selectors:string[],timeoutMs:number):Promise<T|undefined>{
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    const element=findFirst<T>(selectors);
    if(element)return element;
    await sleep(200);
  }
  return undefined;
}

/** 只按文案匹配存草稿按钮；即使页面同时存在「发布」，也不会被点击。 */
function findSaveButton(){
  const candidates=[...document.querySelectorAll<HTMLElement>('button,[role="button"],a,.btn')];
  return candidates.find(button=>{
    const text=(button.textContent||'').replace(/\s+/g,'');
    return SAVE_BUTTON_TEXTS.some(target=>text===target||text.includes(target));
  });
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
 * 返回是否写入后仍为空，供调用方判定页面是否已就绪。
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
  if(written.length>=Math.min(text.length,10))return true;
  editor.textContent=text;
  try{editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}catch{editor.dispatchEvent(new Event('input',{bubbles:true}));}
  return (editor.innerText||editor.textContent||'').trim().length>0;
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

async function getSession(){
  if(lastUser)return{ok:true,loggedIn:true,account:lastUser.account,accountId:lastUser.accountId};
  const fromPage=await waitFor<BridgeSession>('user',3000);
  if(fromPage)return{ok:true,loggedIn:true,account:fromPage.account,accountId:fromPage.accountId};
  for(const endpoint of USER_INFO_ENDPOINTS){
    try{
      const response=await fetch(endpoint,{credentials:'include',signal:AbortSignal.timeout(7000)});
      if(response.status===401||response.status===403)return{ok:true,loggedIn:false};
      if(!response.ok)continue;
      const contentType=response.headers.get('content-type')||'';
      if(!/json/i.test(contentType))return{ok:true,loggedIn:false};
      const user=parseXiaohongshuUser(await response.json());
      if(user){
        lastUser=user;
        return{ok:true,loggedIn:true,account:user.account,accountId:user.accountId};
      }
    }catch{
      // 尝试下一个探针。
    }
  }
  return{ok:false,loggedIn:false,message:'无法检测小红书登录状态，请确认已登录创作服务平台'};
}

async function waitEditor(timeoutMs=20000){
  const editor=await waitForElement<HTMLElement>(EDITOR_SELECTORS,timeoutMs);
  if(!editor)return{ok:false,message:'小红书发布页加载超时，请检查网络或重新登录'};
  const titleInput=await waitForElement<HTMLInputElement|HTMLTextAreaElement>(TITLE_SELECTORS,5000);
  if(!titleInput)return{ok:false,message:'未找到小红书标题输入框，页面可能已改版'};
  return{ok:true};
}

async function fillText(payload:{title?:string;body?:string}|undefined){
  const title=String(payload?.title||'');
  const body=String(payload?.body||'');
  if(!title.trim()||!body.trim())return{ok:false,message:'小红书标题或正文为空，已阻止写入'};
  const titleInput=await waitForElement<HTMLInputElement|HTMLTextAreaElement>(TITLE_SELECTORS,15000);
  const editor=await waitForElement<HTMLElement>(EDITOR_SELECTORS,15000);
  if(!titleInput||!editor)return{ok:false,message:'未找到小红书标题或正文编辑器，页面可能已改版'};
  setInputValue(titleInput,title);
  const accepted=insertEditorText(editor,body);
  await sleep(400);
  if(!titleInput.value?.trim())return{ok:false,message:'小红书标题输入框未接受输入，请刷新发布页后重试'};
  if(!accepted)return{ok:false,message:'小红书正文编辑器未接受输入，页面可能已改版'};
  return{ok:true,titleLength:titleInput.value.length,bodyLength:(editor.innerText||editor.textContent||'').trim().length};
}

async function uploadImage(payload:{base64?:string;mime?:string;name?:string}|undefined){
  const input=await waitForElement<HTMLInputElement>(['input[type="file"]'],10000)??document.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR);
  if(!input)return{ok:false,message:'未找到小红书图片上传入口，页面可能已改版'};
  const base64=String(payload?.base64||'');
  if(!base64)return{ok:false,message:'图片内容为空'};
  let file:File;
  try{
    file=dataUrlToFile(base64,String(payload?.mime||'image/png'),String(payload?.name||'image.png'));
  }catch{
    return{ok:false,message:'图片解码失败'};
  }
  if(!file.size)return{ok:false,message:'图片内容为空'};
  injectFile(input,file);
  await sleep(1200);
  return{ok:true};
}

async function saveNote(){
  const button=findSaveButton();
  if(!button)return{ok:false,message:'未找到「存草稿」按钮，请确认已进入小红书图文发布页'};
  // 先挂等待再点击：保存响应可能在 click 同步链路里就被页面脚本回传。
  const pending=waitFor<BridgeSaveResult>('note-save',45000);
  lastSave=undefined;
  button.click();
  const result=await pending;
  if(!result)return{ok:false,uncertain:true,message:'等待小红书保存结果超时，请先检查草稿箱，不要直接重复同步'};
  if(!result.ok)return{ok:false,message:result.message||'小红书保存失败'};
  return{ok:true,noteId:result.noteId,draftUrl:location.href||DRAFT_MANAGER_URL};
}

async function checkNote(){
  if(lastState?.state)return{ok:true,state:lastState.state};
  const text=document.body?.innerText||'';
  return{ok:true,state:detectNoteStateFromText(text)};
}

function handleAction(action:string,payload:any){
  switch(action){
    case 'PING':return Promise.resolve({ok:true});
    case 'GET_SESSION':return getSession();
    case 'WAIT_EDITOR':return waitEditor(Number(payload?.timeoutMs)||20000);
    case 'FILL_TEXT':return fillText(payload);
    case 'UPLOAD_IMAGE':return uploadImage(payload);
    case 'SAVE_NOTE':return saveNote();
    case 'CHECK_NOTE':return checkNote();
    default:return Promise.resolve({ok:false,message:`未知动作: ${action}`});
  }
}

chrome.runtime.onMessage.addListener((message:any,_sender:chrome.runtime.MessageSender,sendResponse:(response:any)=>void)=>{
  if(message?.target!=='xiaohongshu-bridge')return;
  handleAction(String(message.action||''),message.payload)
    .then(sendResponse)
    .catch(error=>sendResponse({ok:false,message:(error as Error)?.message||String(error)}));
  return true;
});
