// 小红书发布页主世界桥接：只读观测页面自身的用户与笔记响应，把稳定标识回传给隔离世界。
import {matchXiaohongshuEndpoint,parseXiaohongshuNoteSave,parseXiaohongshuNoteState,parseXiaohongshuUser} from './targets/xiaohongshu-capture';

const RESPONSE_EVENT='article-ferry:xhs-response';
const RESPONSE_ATTRIBUTE='data-article-ferry-xhs';

type BridgeReport=
  |{kind:'user';accountId:string;account?:string}
  |{kind:'note-save';ok:boolean;noteId?:string;message?:string}
  |{kind:'note-state';state:string};

/** 属性是主世界与隔离世界唯一共享的数据通道；事件只负责通知，不携带对象（跨世界不可序列化）。 */
function report(payload:BridgeReport){
  document.documentElement.setAttribute(RESPONSE_ATTRIBUTE,JSON.stringify(payload));
  document.dispatchEvent(new Event(RESPONSE_EVENT));
  document.documentElement.removeAttribute(RESPONSE_ATTRIBUTE);
}

function handleResponse(url:string,text:string){
  if(!/xiaohongshu\.com|xhscdn\.com/i.test(url)||!text)return;
  let payload:unknown;
  try{payload=JSON.parse(text);}catch{return;}
  try{
    if(matchXiaohongshuEndpoint(url,'user')){
      const user=parseXiaohongshuUser(payload);
      if(user)report({kind:'user',accountId:user.accountId,account:user.account});
      return;
    }
    if(matchXiaohongshuEndpoint(url,'save')){
      const result=parseXiaohongshuNoteSave(payload);
      report({kind:'note-save',ok:result.ok,noteId:result.noteId,message:result.message});
      return;
    }
    if(matchXiaohongshuEndpoint(url,'note')){
      report({kind:'note-state',state:parseXiaohongshuNoteState(payload)});
    }
  }catch{
    // 观测失败不得影响页面自身请求。
  }
}

/** 只观测、不改写请求与响应；发布与保存均由页面自身完成签名。 */
function observeResponses(){
  if('__articleFerryXhsHooked' in window)return;
  Object.defineProperty(window,'__articleFerryXhsHooked',{value:true,enumerable:false});

  const originalFetch=window.fetch.bind(window);
  window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=input instanceof Request?input.url:String(input);
    const response=await originalFetch(input,init);
    if(/xiaohongshu\.com|xhscdn\.com/i.test(url)){
      try{handleResponse(url,await response.clone().text());}catch{}
    }
    return response;
  };

  type XhsXhr=XMLHttpRequest&{__ferryXhsUrl?:string};
  const originalOpen=XMLHttpRequest.prototype.open;
  const originalSend=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(this:XhsXhr,method:string,url:string|URL,...rest:unknown[]){
    this.__ferryXhsUrl=String(url);
    return originalOpen.apply(this,[method,url,...rest] as Parameters<typeof originalOpen>);
  };
  XMLHttpRequest.prototype.send=function(this:XhsXhr,...args:unknown[]){
    const url=this.__ferryXhsUrl||'';
    this.addEventListener('loadend',()=>{
      try{
        const text=typeof this.response==='string'?this.response:JSON.stringify(this.response);
        handleResponse(url,text||'');
      }catch{}
    },{once:true});
    return originalSend.apply(this,args as Parameters<typeof originalSend>);
  };
}

observeResponses();
