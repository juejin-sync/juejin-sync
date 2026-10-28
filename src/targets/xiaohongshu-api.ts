// 小红书图文笔记适配器：页面驱动式草稿写入，复用浏览器登录态，全链路不点击发布。
import type {Article,TaskProgress} from '../types';
import type {AdapterResult} from './adapter';
import {SyncError} from '../core/diagnostic';
import {renderAllMermaidBlocks} from '../core/mermaid-render';
import {downloadImageBlob,imageExtension} from './csdn-api';
import {compileXiaohongshuNote} from './xiaohongshu-content';
import {parseXiaohongshuUser} from './xiaohongshu-capture';

export const XHS_PUBLISH_URL='https://creator.xiaohongshu.com/publish/publish';
export const XHS_DRAFT_MANAGER_URL='https://creator.xiaohongshu.com/new/note-manager?tab=draft';
const USER_INFO_ENDPOINTS=['https://creator.xiaohongshu.com/api/galaxy/user/info','https://creator.xiaohongshu.com/api/galaxy/user/self_info'];
const MAX_IMAGE_BYTES=8*1024*1024;
const TAB_TIMEOUT_MS=12000;

export type XiaohongshuAuth={ok:boolean;loggedIn:boolean;account?:string;accountId?:string;message?:string};
export type XiaohongshuNoteState='draft'|'published'|'missing'|'unauthorized'|'unknown';

export interface XiaohongshuSaveOptions{
  noteId?:string;
  expectedAccountId?:string;
  appendSourceLink?:boolean;
  syncCover?:boolean;
  onPreparing?:()=>void|Promise<void>;
  onProgress?:(progress:TaskProgress)=>void|Promise<void>;
  onSaving?:()=>void|Promise<void>;
  onDraftCreated?:(noteId:string,draftUrl:string)=>void|Promise<void>;
}

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** 草案编辑页地址：平台改版时只需修正这一处与 capture 端点表。 */
function noteEditorUrl(noteId:string){return `${XHS_PUBLISH_URL}?noteId=${encodeURIComponent(noteId)}`;}

async function sendBridgeMessage<T=any>(tabId:number,action:string,payload?:unknown):Promise<T>{
  try{
    return await chrome.tabs.sendMessage(tabId,{target:'xiaohongshu-bridge',action,payload}) as T;
  }catch(error){
    throw new SyncError(`与小红书页面通信失败：${(error as Error).message}`,'interrupted','draft');
  }
}

async function pingXiaohongshuTab(tabId:number){
  try{
    const result=await chrome.tabs.sendMessage(tabId,{target:'xiaohongshu-bridge',action:'PING'});
    return result?.ok===true;
  }catch{
    return false;
  }
}

/** 查询或创建可用发布页标签页；只有自己创建的标签页才会在结束后关闭。 */
export async function acquireXiaohongshuTab(targetUrl:string,matchNeedle:string){
  const existingTabs=await chrome.tabs.query({url:'*://creator.xiaohongshu.com/*'});
  for(const tab of existingTabs){
    if(tab.id&&tab.url&&tab.url.includes(matchNeedle)&&await pingXiaohongshuTab(tab.id))return{tabId:tab.id,createdByUs:false};
  }
  const createdTab=await chrome.tabs.create({url:targetUrl,active:false});
  if(!createdTab.id)throw new SyncError('无法创建小红书发布页标签页','platform-change','authentication');
  const tabId=createdTab.id;
  const attempts=Math.ceil(TAB_TIMEOUT_MS/500);
  for(let attempt=0;attempt<attempts;attempt++){
    await sleep(500);
    if(await pingXiaohongshuTab(tabId))return{tabId,createdByUs:true};
  }
  await chrome.tabs.remove(tabId).catch(()=>{});
  throw new SyncError('小红书发布页加载超时，请检查网络或重新登录','network','authentication');
}

export async function releaseXiaohongshuTab(session:{tabId:number;createdByUs:boolean}){
  if(session.createdByUs&&session.tabId)await chrome.tabs.remove(session.tabId).catch(()=>{});
}

async function probeUserInfo(){
  for(const endpoint of USER_INFO_ENDPOINTS){
    try{
      const response=await fetch(endpoint,{credentials:'include',signal:AbortSignal.timeout(7000)});
      if(response.status===401||response.status===403)return{ok:true,loggedIn:false} as XiaohongshuAuth;
      if(!response.ok)continue;
      const contentType=response.headers.get('content-type')||'';
      // 未登录时通常返回登录页 HTML，而不是 JSON。
      if(!/json/i.test(contentType))return{ok:true,loggedIn:false} as XiaohongshuAuth;
      const user=parseXiaohongshuUser(await response.json());
      if(user)return{ok:true,loggedIn:true,account:user.account,accountId:user.accountId} as XiaohongshuAuth;
    }catch{
      // 尝试下一个探针或降级到已有标签页。
    }
  }
  return undefined;
}

/** 登录检测：优先后台探针（不打扰用户），失败后降级到已打开的小红书标签页。 */
export async function checkXiaohongshuAuth():Promise<XiaohongshuAuth>{
  const probed=await probeUserInfo();
  if(probed)return probed;
  try{
    const tabs=await chrome.tabs.query({url:'*://creator.xiaohongshu.com/*'});
    for(const tab of tabs){
      if(tab.id&&await pingXiaohongshuTab(tab.id)){
        const session=await sendBridgeMessage<XiaohongshuAuth>(tab.id,'GET_SESSION');
        if(session?.ok)return session;
      }
    }
  }catch{
    // 标签页不可用时保持未确认状态。
  }
  return{ok:false,loggedIn:false,message:'无法检测小红书登录状态，请打开小红书创作服务平台后重试'};
}

/** 读取远端笔记状态：明确已发布/已删除才允许上层决策，无法判断时返回 unknown。 */
export async function fetchXiaohongshuNoteState(noteId:string,expectedAccountId?:string):Promise<XiaohongshuNoteState>{
  let session:{tabId:number;createdByUs:boolean}|undefined;
  try{
    session=await acquireXiaohongshuTab(noteEditorUrl(noteId),`noteId=${noteId}`);
    const auth=await sendBridgeMessage<XiaohongshuAuth>(session.tabId,'GET_SESSION');
    if(!auth?.ok||!auth.loggedIn)return 'unauthorized';
    if(expectedAccountId&&auth.accountId&&auth.accountId!==expectedAccountId)return 'unauthorized';
    const result=await sendBridgeMessage<{ok:boolean;state?:string}>(session.tabId,'CHECK_NOTE',{noteId});
    const state=result?.state;
    return state==='draft'||state==='published'||state==='missing'?state:'unknown';
  }catch{
    return 'unknown';
  }finally{
    if(session)await releaseXiaohongshuTab(session);
  }
}

async function blobToBase64(blob:Blob){
  const buffer=new Uint8Array(await blob.arrayBuffer());
  let binary='';
  const chunkSize=0x8000;
  for(let offset=0;offset<buffer.length;offset+=chunkSize){
    binary+=String.fromCharCode(...buffer.subarray(offset,offset+chunkSize));
  }
  return btoa(binary);
}

/** 给失败任务补上“已保存但结果不确定”时的草稿入口，避免用户重复创建。 */
function attachDraftMeta(error:SyncError,meta:{articleId?:string;draftUrl?:string}){
  return Object.assign(error,meta);
}

export async function saveXiaohongshuDraft(article:Article,options:XiaohongshuSaveOptions={}):Promise<AdapterResult>{
  const warnings:string[]=[];
  let note;
  try{
    const mermaidImages=await renderAllMermaidBlocks(article.markdown);
    note=compileXiaohongshuNote(article,{
      appendSourceLink:options.appendSourceLink,
      syncCover:options.syncCover,
      mermaidImages
    });
  }catch(error){
    if(error instanceof SyncError)throw error;
    throw new SyncError(`小红书内容编译失败：${(error as Error).message}`,'content','content');
  }
  warnings.push(...note.warnings);

  const session=await acquireXiaohongshuTab(options.noteId?noteEditorUrl(options.noteId):XHS_PUBLISH_URL,options.noteId?`noteId=${options.noteId}`:'/publish/publish');
  try{
    const auth=await sendBridgeMessage<XiaohongshuAuth>(session.tabId,'GET_SESSION');
    if(!auth?.ok)throw new SyncError('无法检测小红书登录状态，请确认已登录创作服务平台','platform-change','authentication');
    if(!auth.loggedIn)throw new SyncError('请先登录小红书创作服务平台','login','authentication');
    if(!auth.accountId)throw new SyncError('无法确认小红书账号身份，已阻止写入草稿','blocked','authentication');
    if(options.expectedAccountId&&auth.accountId!==options.expectedAccountId)throw new SyncError('当前小红书账号与任务创建时不一致，已阻止覆盖草稿','blocked','authentication');

    await options.onPreparing?.();
    const ready=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'WAIT_EDITOR',{timeoutMs:20000});
    if(!ready?.ok)throw new SyncError(ready?.message||'小红书发布页加载超时，请检查网络或重新登录','network','content');

    const filled=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'FILL_TEXT',{title:note.title,body:note.body});
    if(!filled?.ok)throw new SyncError(filled?.message||'小红书编辑器填充失败，页面可能已改版','platform-change','content');

    let uploaded=0;
    for(let index=0;index<note.images.length;index++){
      const src=note.images[index];
      await options.onProgress?.({current:index,total:note.images.length,message:`正在上传小红书图片 ${index+1}/${note.images.length}`});
      const blob=await downloadImageBlob(src).catch(error=>{
        throw new SyncError(`小红书图片下载失败：${(error as Error).message}`,'content','images');
      });
      if(blob.size>MAX_IMAGE_BYTES)throw new SyncError(`小红书图片超过 8MB，已停止保存：${src}`,'content','images');
      const base64=await blobToBase64(blob);
      const result=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'UPLOAD_IMAGE',{
        base64,
        mime:blob.type||'image/png',
        name:`xiaohongshu-${index+1}.${imageExtension(src,blob)}`
      });
      if(!result?.ok)throw new SyncError(result?.message||'小红书图片注入失败，页面可能已改版','content','images');
      uploaded++;
    }

    // 图片上传期间可能切换账号；写入前再次核验，避免把内容存进他人账号。
    const reAuth=await sendBridgeMessage<XiaohongshuAuth>(session.tabId,'GET_SESSION');
    if(!reAuth?.ok||reAuth.accountId!==auth.accountId)throw new SyncError('小红书登录账号在同步过程中发生变更，已阻断写入','blocked','authentication');

    await options.onSaving?.();
    const saved=await sendBridgeMessage<{ok:boolean;noteId?:string;draftUrl?:string;message?:string}>(session.tabId,'SAVE_NOTE');
    if(!saved?.ok){
      throw attachDraftMeta(new SyncError(saved?.message||'无法确认小红书草稿是否已保存，请先检查草稿箱，不要直接重复同步','interrupted','draft'),{draftUrl:XHS_DRAFT_MANAGER_URL});
    }
    if(!saved.noteId){
      throw attachDraftMeta(new SyncError('小红书草稿已保存，但未捕获笔记标识，请先检查草稿箱确认结果','interrupted','draft'),{draftUrl:saved.draftUrl||XHS_DRAFT_MANAGER_URL});
    }
    const draftUrl=saved.draftUrl||XHS_DRAFT_MANAGER_URL;
    await options.onDraftCreated?.(saved.noteId,draftUrl);
    return{
      draftUrl,
      articleId:saved.noteId,
      warnings,
      stats:{imageTotal:note.images.length,imageSucceeded:uploaded,imageFailed:note.images.length-uploaded}
    };
  }finally{
    await releaseXiaohongshuTab(session);
  }
}
