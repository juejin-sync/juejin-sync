// 小红书主世界入口：图文事务只读观测，长文独立导入新草稿；不执行发布。
import './xiaohongshu-article-page';
import {normalizeXiaohongshuText,parseXiaohongshuLocalDraft} from './targets/xiaohongshu-capture';

const COMMAND_EVENT='article-ferry:xhs-command';
const COMMAND_ATTRIBUTE='data-article-ferry-xhs-command';
const ACK_ATTRIBUTE='data-article-ferry-xhs-ack';
const RESPONSE_EVENT='article-ferry:xhs-response';
const RESPONSE_ATTRIBUTE='data-article-ferry-xhs';
type ExpectedSave={format?:'article'|'image';requestId:string;accountId:string;title:string;body:string;imageCount:number};
let expected:ExpectedSave|undefined;
let expiry:ReturnType<typeof setTimeout>|undefined;

function report(requestId:string,result:{ok:boolean;draftId?:string;accountId?:string;message?:string}){
  if(expected?.requestId!==requestId)return;
  expected=undefined;
  clearTimeout(expiry);
  const root=document.documentElement;
  root.setAttribute(RESPONSE_ATTRIBUTE,JSON.stringify({requestId,...result}));
  document.dispatchEvent(new Event(RESPONSE_EVENT));
  root.removeAttribute(RESPONSE_ATTRIBUTE);
}

/** 命令只授权一次保存结果的观测；未匹配标题、正文、账号和完整图片的自动保存不会被确认。 */
function armSave(){
  const root=document.documentElement;
  const raw=root.getAttribute(COMMAND_ATTRIBUTE);
  root.removeAttribute(COMMAND_ATTRIBUTE);
  if(!raw)return;
  try{
    const command=JSON.parse(raw);
    if(command.cancel){if(expected?.requestId===command.requestId){expected=undefined;clearTimeout(expiry);}return;}
    if(typeof command.requestId!=='string'||typeof command.accountId!=='string'||typeof command.title!=='string'||typeof command.body!=='string'||!Number.isInteger(command.imageCount)||command.imageCount<(command.format==='article'?0:1))return;
    expected=command;
    clearTimeout(expiry);
    expiry=setTimeout(()=>{expected=undefined;},45000);
    root.setAttribute(ACK_ATTRIBUTE,command.requestId);
  }catch{/* 异常命令不影响页面。 */}
}

function observeLocalDrafts(){
  if('__articleFerryXhsHooked' in window)return;
  Object.defineProperty(window,'__articleFerryXhsHooked',{value:true});
  document.addEventListener(COMMAND_EVENT,armSave);
  const originalPut=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){
    const request=key===undefined?originalPut.call(this,value):originalPut.call(this,value,key);
    try{
      const operation=expected;
      const draft=operation&&this.name===(operation.format==='article'?'article-draft':'image-draft')?parseXiaohongshuLocalDraft(value,operation.format):undefined;
      if(!operation||!draft||draft.accountId!==operation.accountId||!draft.imagesComplete||draft.imageCount!==operation.imageCount||
        normalizeXiaohongshuText(draft.title)!==normalizeXiaohongshuText(operation.title)||normalizeXiaohongshuText(draft.body)!==normalizeXiaohongshuText(operation.body))return request;
      // request success 仍可能被后续写入回滚，只有整个事务 complete 才能确认保存。
      this.transaction.addEventListener('complete',()=>report(operation.requestId,{ok:true,draftId:draft.draftId,accountId:draft.accountId}),{once:true});
      this.transaction.addEventListener('abort',()=>report(operation.requestId,{ok:false,message:'小红书本地草稿事务已回滚，请检查草稿箱'}),{once:true});
    }catch{/* 观测失败不得改变页面原有的写入结果。 */}
    return request;
  };
}

observeLocalDrafts();
