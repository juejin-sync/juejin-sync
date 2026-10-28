// 任务完成系统通知：仅长耗时任务触发，避免高频打扰；文案使用脱敏诊断信息。
import type {SyncTask} from '../types';
import {platformLabel} from './message';

export const NOTIFY_DURATION_MS=10000;
export const NOTIFY_IMAGE_COUNT=3;

export type TaskNotification={id:string;kind:'saved'|'failed';title:string;message:string;draftUrl?:string};

/** 判定任务是否值得系统通知：成功需长耗时（>= 10s 或图片 >= 3 张）；失败/需介入任务豁免门槛，避免用户切走后误以为同步成功。 */
export function buildTaskNotification(task:SyncTask,durationMs:number):TaskNotification|undefined{
  const needsUser=task.status==='failed'||task.status==='needs-user';
  const longRunning=durationMs>=NOTIFY_DURATION_MS||(task.stats?.imageTotal??0)>=NOTIFY_IMAGE_COUNT;
  if(!longRunning&&!needsUser)return undefined;
  const title=task.article.title;
  if(task.status==='saved'){
    const imageStats=task.stats?.imageTotal?`，转存图片 ${task.stats.imageSucceeded}/${task.stats.imageTotal}`:'';
    const destination=task.platform==='xiaohongshu'?'小红书本地草稿箱':task.platform==='csdn'?'CSDN 草稿箱':`${platformLabel(task.platform)}草稿箱`;
    return{id:task.id,kind:'saved',title:`文章已抵达 ${destination}`,message:`「${title}」保存成功${imageStats}`,draftUrl:task.draftUrl};
  }
  if(task.status==='failed'||task.status==='needs-user'){
    return{id:task.id,kind:'failed',title:'掘金同步助手需要处理',message:`「${title}」${task.diagnostic?.message||task.error||'同步失败，点击查看详情'}`};
  }
  return undefined;
}

/** 通过 Chrome 原生通知播报任务结果；扩展环境异常时静默降级。 */
export async function showTaskNotification(notification:TaskNotification){
  try{
    await chrome.notifications.create(notification.id,{
      type:'basic',
      iconUrl:chrome.runtime.getURL('logo-128.png'),
      title:notification.title,
      message:notification.message,
      priority:2
    });
  }catch{
    // 通知权限缺失或扩展上下文失效时静默忽略，不影响同步主流程。
  }
}
