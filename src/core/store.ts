// 任务与远端草稿映射存储；小红书本地草稿只保留任务结果，不建立覆盖映射。
import type {CnblogsDraftMapping,CsdnDraftMapping,ExtensionSettings,PlatformId,SyncTask,WechatDraftMapping,ZhihuDraftMapping} from '../types';
import {defaultSettings,normalizeSettings} from './settings';
import {articleIdentityKeys,isActiveTask,taskAccountId} from './task';
import {Semaphore} from './async';
const KEY='syncTasks';
const SETTINGS_KEY='settings';
const CSDN_MAPPING_PREFIX='csdnDraftMapping:';
const WECHAT_MAPPING_PREFIX='wechatDraftMapping:';
const CNBLOGS_MAPPING_PREFIX='cnblogsDraftMapping:';
const ZHIHU_MAPPING_PREFIX='zhihuDraftMapping:';
const XIAOHONGSHU_MAPPING_PREFIX='xiaohongshuDraftMapping:';
/** 读-改-写互斥锁：序列化对 syncTasks 键的存取，防止 Semaphore(2) 并发下交错覆盖。 */
const storageMutex=new Semaphore(1);

/** 持久化前剔除文章正文：任务历史仅保留元信息，防止 storage.local 冲破配额；重试时经掘金双路径回填。 */
export function toStorageTask(task:SyncTask):SyncTask{
  return task.article?.markdown?{...task,article:{...task.article,markdown:''}}:task;
}

/** 升级迁移：清理历史记录中已存在的全量 Markdown 正文。 */
export async function migrateStoredTasks():Promise<boolean>{
  const raw=((await chrome.storage.local.get(KEY))[KEY]||[]) as SyncTask[];
  if(!raw.some(task=>task.article?.markdown))return false;
  await saveTasks(raw);
  return true;
}

/** 同一平台的同一篇文章只展示和保留最近一次同步状态。 */
export function uniqueTasks(tasks:SyncTask[]){
  const identities=new Set<string>();
  return[...tasks]
    .sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))
    .filter(task=>{
      const accountId=taskAccountId(task);
      const identity=`${task.platform}:${accountId||'legacy'}:${task.article.id}`;
      if(identities.has(identity))return false;
      identities.add(identity);
      return true;
    });
}

export async function allTasks(){return uniqueTasks(((await chrome.storage.local.get(KEY))[KEY]||[]) as SyncTask[]);}
export async function saveTasks(tasks:SyncTask[]){await chrome.storage.local.set({[KEY]:tasks.slice(0,200).map(toStorageTask)});}
function mappingPrefix(platform:PlatformId,accountId?:string){
  if(platform==='wechat')return WECHAT_MAPPING_PREFIX+(accountId?`${accountId}:`:'');
  if(platform==='cnblogs')return CNBLOGS_MAPPING_PREFIX+(accountId?`${accountId}:`:'');
  if(platform==='zhihu')return ZHIHU_MAPPING_PREFIX+(accountId?`${accountId}:`:'');
  if(platform==='xiaohongshu')return XIAOHONGSHU_MAPPING_PREFIX+(accountId?`${accountId}:`:'');
  return CSDN_MAPPING_PREFIX;
}
function draftMappingValue(articleId:string,targetId:string,draftUrl?:string,platform:PlatformId='csdn',accountId?:string){
  const prefix=mappingPrefix(platform,accountId);
  const data=platform==='wechat'
    ?{articleId,wechatAccountId:accountId,wechatAppMsgId:targetId,draftUrl,updatedAt:new Date().toISOString()}
    :platform==='cnblogs'
      ?{articleId,cnblogsAccountId:accountId,cnblogsPostId:targetId,draftUrl,updatedAt:new Date().toISOString()}
      :platform==='zhihu'
        ?{articleId,zhihuAccountId:accountId,zhihuArticleId:targetId,draftUrl,updatedAt:new Date().toISOString()}
        :{articleId,csdnArticleId:targetId,draftUrl,updatedAt:new Date().toISOString()};
  return{key:prefix+articleId,data};
}
export async function saveDraftMapping(articleId:string,targetId:string,draftUrl?:string,platform:PlatformId='csdn',accountId?:string){
  if(platform==='xiaohongshu')return;
  const mapping=draftMappingValue(articleId,targetId,draftUrl,platform,accountId);
  await chrome.storage.local.set({[mapping.key]:mapping.data});
}
export async function getDraftMapping(articleId:string,platform:PlatformId='csdn',accountId?:string){
  if(platform==='xiaohongshu')return undefined;
  const prefix=mappingPrefix(platform,accountId);
  return(await chrome.storage.local.get(prefix+articleId))[prefix+articleId] as (CsdnDraftMapping&WechatDraftMapping&CnblogsDraftMapping&ZhihuDraftMapping)|undefined;
}
export async function saveArticleDraftMapping(article:SyncTask['article'],targetId:string,draftUrl?:string,platform:PlatformId='csdn',accountId?:string){
  for(const identity of articleIdentityKeys(article))await saveDraftMapping(identity,targetId,draftUrl,platform,accountId);
}
export async function getArticleDraftMapping(article:SyncTask['article'],platform:PlatformId='csdn',accountId?:string){
  for(const identity of articleIdentityKeys(article)){
    const mapping=await getDraftMapping(identity,platform,accountId);
    if(mapping)return mapping;
  }
  return undefined;
}
export async function removeArticleDraftMapping(article:SyncTask['article'],platform:PlatformId='csdn',accountId?:string){
  for(const identity of articleIdentityKeys(article)){
    const prefix=mappingPrefix(platform,accountId);
    await chrome.storage.local.remove(prefix+identity);
  }
}
/** 把任务已获得的远端草稿标识回写为身份映射：删除任务记录时仍能识别已有草稿。 */
async function persistTaskMapping(task:SyncTask){
  if(task.platform==='csdn'&&task.csdnArticleId)await saveArticleDraftMapping(task.article,task.csdnArticleId,task.draftUrl,'csdn');
  else if(task.platform==='wechat'&&task.wechatAppMsgId)await saveArticleDraftMapping(task.article,task.wechatAppMsgId,task.draftUrl,'wechat',task.wechatAccountId);
  else if(task.platform==='cnblogs'&&task.cnblogsPostId)await saveArticleDraftMapping(task.article,task.cnblogsPostId,task.draftUrl,'cnblogs',task.cnblogsAccountId);
  else if(task.platform==='zhihu'&&task.zhihuArticleId)await saveArticleDraftMapping(task.article,task.zhihuArticleId,task.draftUrl,'zhihu',task.zhihuAccountId);
}
export async function preserveTaskMappings(tasks:SyncTask[]){
  for(const task of tasks)await persistTaskMapping(task);
}
export async function deleteTask(id:string,options?:{removeMapping?:boolean}){await storageMutex.run(async()=>{
  const tasks=await allTasks();
  const task=tasks.find(item=>item.id===id);
  if(task){
    if(options?.removeMapping){
      await removeArticleDraftMapping(task.article,task.platform,taskAccountId(task));
    }else{
      await persistTaskMapping(task);
    }
  }
  await saveTasks(tasks.filter(item=>item.id!==id));
});}
export async function putTask(task:SyncTask){await storageMutex.run(async()=>{const tasks=await allTasks();const i=tasks.findIndex(x=>x.id===task.id);if(i>=0)tasks[i]=task;else tasks.unshift(task);await saveTasks(tasks);});}
export async function patchTask(id:string,patch:Partial<SyncTask>){return storageMutex.run(async()=>{const tasks=await allTasks();const task=tasks.find(x=>x.id===id);if(!task)return;Object.assign(task,patch,{updatedAt:new Date().toISOString()});await saveTasks(tasks);return task;});}
/** 远端已返回草稿 ID 后，用一次 storage 写入同步保存任务结果和身份映射。 */
export async function finishSavedTask(id:string,targetId:string,draftUrl:string,patch:Partial<SyncTask>){await storageMutex.run(async()=>{
  const tasks=await allTasks();
  const task=tasks.find(item=>item.id===id);
  if(!task)throw new Error('任务记录已丢失，无法保存草稿结果');
  Object.assign(task,patch,{status:'saved',updatedAt:new Date().toISOString()});
  const values:Record<string,unknown>={[KEY]:tasks.slice(0,200).map(toStorageTask)};
  // 小红书仅记录本地保存凭证，不建立用于覆盖更新的文章映射。
  for(const identity of task.platform==='xiaohongshu'?[]:articleIdentityKeys(task.article)){
    const mapping=draftMappingValue(identity,targetId,draftUrl,task.platform,taskAccountId(task));
    values[mapping.key]=mapping.data;
  }
  await chrome.storage.local.set(values);
});}
export async function clearAllTasks(){await storageMutex.run(async()=>{const tasks=await allTasks();if(tasks.some(isActiveTask))throw new Error('仍有文章正在同步，请等待完成后再清空历史');await preserveTaskMappings(tasks);await saveTasks([]);});}
export async function getSettings(){return normalizeSettings({...defaultSettings,...((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]||{})});}
export async function saveSettings(settings:ExtensionSettings){await chrome.storage.local.set({[SETTINGS_KEY]:normalizeSettings(settings)});}
