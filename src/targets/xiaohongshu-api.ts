// 小红书图文笔记适配器：页面驱动式草稿写入，复用浏览器登录态，全链路不点击发布。
import type {Article,TaskProgress} from '../types';
import type {AdapterResult} from './adapter';
import {SyncError} from '../core/diagnostic';
import {renderAllMermaidBlocks} from '../core/mermaid-render';
import {downloadImageBlob,imageExtension} from './csdn-api';
import {compileXiaohongshuNote} from './xiaohongshu-content';
import {parseXiaohongshuUser} from './xiaohongshu-capture';

export const XHS_PUBLISH_URL='https://creator.xiaohongshu.com/publish/publish';
export const XHS_DRAFT_MANAGER_URL=XHS_PUBLISH_URL;
const USER_INFO_ENDPOINT='https://creator.xiaohongshu.com/api/galaxy/user/info';
const MAX_IMAGE_BYTES=32*1024*1024;
const TAB_TIMEOUT_MS=12000;

export type XiaohongshuAuth={ok:boolean;loggedIn:boolean;account?:string;accountId?:string;message?:string};

export interface XiaohongshuSaveOptions{
  expectedAccountId?:string;
  appendSourceLink?:boolean;
  syncCover?:boolean;
  onPreparing?:()=>void|Promise<void>;
  onProgress?:(progress:TaskProgress)=>void|Promise<void>;
  onSaving?:()=>void|Promise<void>;
}

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

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

/** 每次新建独立标签页，避免覆盖用户正在编辑或已有的本地草稿。 */
export async function acquireXiaohongshuTab(){
  const createdTab=await chrome.tabs.create({url:XHS_PUBLISH_URL,active:false});
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
  try{
    const response=await fetch(USER_INFO_ENDPOINT,{credentials:'include',signal:AbortSignal.timeout(7000)});
    if(response.status===401||response.status===403)return{ok:true,loggedIn:false} as XiaohongshuAuth;
    if(!response.ok)return undefined;
    // 未登录时通常返回登录页 HTML，而不是 JSON。
    if(!/json/i.test(response.headers.get('content-type')||''))return{ok:true,loggedIn:false} as XiaohongshuAuth;
    const user=parseXiaohongshuUser(await response.json());
    if(user)return{ok:true,loggedIn:true,...user} as XiaohongshuAuth;
  }catch{
    // 后台探针不可用时，降级到已有标签页同源读取。
  }
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

  warnings.push('草稿仅保存在当前浏览器本地；清除浏览器数据会删除草稿，重复同步会新建草稿。');
  const session=await acquireXiaohongshuTab();
  let pageTouched=false;
  let savedSuccessfully=false;
  try{
    const auth=await sendBridgeMessage<XiaohongshuAuth>(session.tabId,'GET_SESSION');
    if(!auth?.ok)throw new SyncError('无法检测小红书登录状态，请确认已登录创作服务平台','platform-change','authentication');
    if(!auth.loggedIn)throw new SyncError('请先登录小红书创作服务平台','login','authentication');
    if(!auth.accountId)throw new SyncError('无法确认小红书账号身份，已阻止写入草稿','blocked','authentication');
    if(options.expectedAccountId&&auth.accountId!==options.expectedAccountId)throw new SyncError('当前小红书账号与任务创建时不一致，已阻止写入草稿','blocked','authentication');
    await options.onPreparing?.();
    const prepared=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'PREPARE_IMAGE_NOTE');
    if(!prepared?.ok)throw new SyncError(prepared?.message||'无法进入小红书图文上传页','platform-change','content');

    let uploaded=0;
    for(let index=0;index<note.images.length;index++){
      const src=note.images[index];
      const blob=await downloadImageBlob(src).catch(error=>{
        throw new SyncError(`小红书图片下载失败：${(error as Error).message}`,'content','images');
      });
      if(blob.size>MAX_IMAGE_BYTES)throw new SyncError('小红书图片超过 32MB，已停止保存','content','images');
      if(!['image/jpeg','image/png','image/webp'].includes(blob.type))throw new SyncError('小红书图片仅支持 JPG、PNG、WebP，请转换图片格式后重试','content','images');
      const base64=await blobToBase64(blob);
      // 图片进入页面后平台可能自动保存；从此刻开始中断不得自动重试。
      if(!pageTouched){await options.onSaving?.();pageTouched=true;}
      await options.onProgress?.({current:index,total:note.images.length,message:`正在上传小红书图片 ${index+1}/${note.images.length}`});
      const result=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'UPLOAD_IMAGE',{
        base64,mime:blob.type,name:`xiaohongshu-${index+1}.${imageExtension(src,blob)}`,imageCount:index+1
      });
      if(!result?.ok)throw new SyncError(result?.message||'小红书图片上传未完成','content','images');
      uploaded++;
    }
    const ready=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'WAIT_EDITOR',{timeoutMs:20000});
    if(!ready?.ok)throw new SyncError(ready?.message||'小红书编辑器加载超时','platform-change','content');
    const filled=await sendBridgeMessage<{ok:boolean;message?:string}>(session.tabId,'FILL_TEXT',{title:note.title,body:note.body});
    if(!filled?.ok)throw new SyncError(filled?.message||'小红书编辑器填充失败','platform-change','content');
    const reAuth=await sendBridgeMessage<XiaohongshuAuth>(session.tabId,'GET_SESSION');
    if(!reAuth?.ok||!reAuth.loggedIn||reAuth.accountId!==auth.accountId)throw new SyncError('小红书登录账号在同步过程中发生变更，已阻断写入','blocked','authentication');
    const saved=await sendBridgeMessage<{ok:boolean;draftId?:string;accountId?:string;message?:string}>(session.tabId,'SAVE_NOTE',{
      accountId:auth.accountId,title:note.title,body:note.body,imageCount:note.images.length
    });
    if(!saved?.ok||!saved.draftId||saved.accountId!==auth.accountId)throw new SyncError(saved?.message||'无法确认小红书本地草稿是否完整保存','interrupted','draft');
    savedSuccessfully=true;
    return{draftUrl:XHS_DRAFT_MANAGER_URL,articleId:saved.draftId,warnings,stats:{imageTotal:note.images.length,imageSucceeded:uploaded,imageFailed:0}};
  }catch(error){
    if(pageTouched){
      const message=error instanceof Error?error.message:String(error);
      throw attachDraftMeta(new SyncError(`${message}。页面可能已自动保存部分内容，请先检查当前浏览器的小红书草稿箱，确认后再重试。`,'interrupted','draft'),{draftUrl:XHS_DRAFT_MANAGER_URL});
    }
    throw error;
  }finally{
    // 失败时保留已写入的页面，供用户核对或继续编辑，避免丢失部分草稿。
    if(savedSuccessfully||!pageTouched)await releaseXiaohongshuTab(session);
  }
}
