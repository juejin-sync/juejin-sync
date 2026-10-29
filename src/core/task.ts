// 同步任务的纯逻辑辅助函数：兼容旧记录并识别需要恢复的中断状态。
import type {SyncTask,XiaohongshuFormat} from '../types';

export function articleIdentityKeys(article:SyncTask['article']){
  return[...new Set([article.id,article.sourceDraftId].filter((value):value is string=>!!value))];
}

/** 平台绑定的稳定账号标识；CSDN 不区分账号，返回 undefined。 */
export function taskAccountId(task:SyncTask){
  return task.platform==='wechat'?task.wechatAccountId:task.platform==='cnblogs'?task.cnblogsAccountId:task.platform==='zhihu'?task.zhihuAccountId:task.platform==='xiaohongshu'?task.xiaohongshuAccountId:undefined;
}

export function findMatchingTask(tasks:SyncTask[],article:SyncTask['article'],platform:SyncTask['platform']='csdn',accountId?:string,format?:XiaohongshuFormat){
  const identities=new Set(articleIdentityKeys(article));
  return tasks.find(task=>articleIdentityKeys(task.article).some(identity=>identities.has(identity))&&task.platform===platform&&(platform==='csdn'||taskAccountId(task)===accountId)&&(platform!=='xiaohongshu'||(task.xiaohongshuFormat||'image')===(format||'image')));
}

export function targetArticleId(task:SyncTask){return task.platform==='wechat'?task.wechatAppMsgId:task.platform==='cnblogs'?task.cnblogsPostId:task.platform==='zhihu'?task.zhihuArticleId:task.platform==='xiaohongshu'?undefined:task.csdnArticleId;}

export function extractCsdnArticleId(draftUrl?:string){
  if(!draftUrl)return undefined;
  try{return new URL(draftUrl).searchParams.get('articleId')||undefined;}catch{return undefined;}
}

export function extractZhihuArticleId(draftUrl?:string){
  if(!draftUrl)return undefined;
  try{const match=draftUrl.match(/\/p\/(\d+)/);return match?match[1]:undefined;}catch{return undefined;}
}

export function isInterruptedTask(task:SyncTask){
  return['queued','checking-login','transforming'].includes(task.status)||(task.status==='writing'&&!!targetArticleId(task));
}

/** 新建草稿写入中断后无法判断目标平台是否成功，自动重试可能产生重复草稿。 */
export function isUncertainCreateTask(task:SyncTask){
  return task.status==='writing'&&!targetArticleId(task);
}

export function isActiveTask(task:SyncTask){return['queued','checking-login','transforming','writing'].includes(task.status);}
export function isRetryableTask(task:SyncTask){return['failed','needs-user'].includes(task.status)&&task.diagnostic?.category!=='interrupted';}
export function canDeleteTask(task:SyncTask){return!isActiveTask(task);}
