// 轻量远程健康检查：定期读取仓库发布的状态 JSON，提前预警平台接口变动；任何异常静默降级，绝不阻断同步。
export const HEALTH_CHECK_ALARM='health-check';
export const HEALTH_URL='https://raw.githubusercontent.com/juejin-sync/juejin-sync/master/health.json';
export const STATUS_PAGE_URL='https://juejin-sync.github.io/juejin-sync/status.html';

export type PlatformHealth='ok'|'degraded'|'broken'|'unknown';
export type HealthStatus={csdn:PlatformHealth;juejin:PlatformHealth;wechat?:PlatformHealth;cnblogs?:PlatformHealth;zhihu?:PlatformHealth;xiaohongshu?:PlatformHealth;message:string;sourceUrl:string;updatedAt:string;checkedAt:string};

/** 解析远程健康 JSON；结构异常或字段缺失时按 unknown 降级，不抛错。 */
export function parseHealthPayload(value:unknown):HealthStatus{
  const input=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const level=(raw:unknown):PlatformHealth=>raw==='ok'||raw==='degraded'||raw==='broken'?raw:'unknown';
  return{
    csdn:level(input.csdn),
    juejin:level(input.juejin),
    wechat:level(input.wechat),
    cnblogs:level(input.cnblogs),
    zhihu:level(input.zhihu),
    xiaohongshu:level(input.xiaohongshu),
    message:typeof input.message==='string'?input.message.slice(0,200):'',
    sourceUrl:STATUS_PAGE_URL,
    updatedAt:typeof input.updatedAt==='string'?input.updatedAt:'',
    checkedAt:new Date().toISOString()
  };
}

/** 拉取远程健康状态；网络失败或响应异常返回 undefined（视为无数据，不告警）。 */
export async function fetchHealthStatus():Promise<HealthStatus|undefined>{
  try{
    const response=await fetch(HEALTH_URL,{signal:AbortSignal.timeout(8000)});
    if(!response.ok)return undefined;
    return parseHealthPayload(await response.json());
  }catch{
    return undefined;
  }
}

/** 执行一次健康检查并缓存到 storage.local；无新数据时保留旧缓存。 */
export async function runHealthCheck():Promise<HealthStatus|undefined>{
  const status=await fetchHealthStatus();
  if(status){
    try{await chrome.storage.local.set({healthStatus:status});}catch{}
  }
  return status;
}

export async function getCachedHealth():Promise<HealthStatus|undefined>{
  try{
    return((await chrome.storage.local.get('healthStatus')).healthStatus as HealthStatus|undefined)||undefined;
  }catch{
    return undefined;
  }
}

const HEALTH_REFRESH_MS=12*60*60*1000;

/** 缓存仍在 12 小时有效期内时直接复用，避免 SW 每次唤醒都发起无效网络请求；force 用于 alarm 到期强制刷新。 */
export async function refreshHealthIfNeeded(force=false):Promise<HealthStatus|undefined>{
  if(!force){
    const cached=await getCachedHealth();
    if(cached?.checkedAt&&Date.now()-Date.parse(cached.checkedAt)<HEALTH_REFRESH_MS)return cached;
  }
  return runHealthCheck();
}

/** 仅任一平台 broken 时弹警示；degraded/unknown 不打扰用户。 */
export function isHealthAlert(status:HealthStatus|undefined):boolean{
  return status?.csdn==='broken'||status?.juejin==='broken'||status?.wechat==='broken'||status?.cnblogs==='broken'||status?.zhihu==='broken'||status?.xiaohongshu==='broken';
}
