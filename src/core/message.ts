import type {PlatformId} from '../types';

export const messageTypes=[
  'SYNC_NEW_ARTICLE','CHECK_CSDN_STATUS','OPEN_CSDN_LOGIN','REPORT_JUEJIN_UUID',
  'CHECK_WECHAT_STATUS','OPEN_WECHAT_LOGIN',
  'CHECK_CNBLOGS_STATUS','OPEN_CNBLOGS_LOGIN',
  'CHECK_ZHIHU_STATUS','OPEN_ZHIHU_LOGIN',
  'CHECK_XIAOHONGSHU_STATUS','OPEN_XIAOHONGSHU_LOGIN',
  'SYNC_HISTORY_ARTICLE','RESUME_PENDING_HISTORY','GET_TASKS','GET_SETTINGS','SAVE_SETTINGS','RETRY_TASK','CONFIRM_TASK_UPDATE',
  'RETRY_FAILED_TASKS','DELETE_TASK','CLEAR_TASKS','FETCH_CSDN_CATEGORIES','DRY_RUN_TASK','GET_HEALTH_STATUS'
] as const;

export const SUPPORTED_PLATFORMS: readonly PlatformId[]=['csdn','wechat','cnblogs','zhihu','xiaohongshu'];

/** 平台中文名：后台消息、通知与弹窗共用，避免各处三元链在新增平台时漏改。 */
export const PLATFORM_LABELS:Record<PlatformId,string>={csdn:'CSDN',wechat:'微信公众号',cnblogs:'博客园',zhihu:'知乎',xiaohongshu:'小红书'};

export function platformLabel(platform:PlatformId){return PLATFORM_LABELS[platform]||platform;}

export function isValidPlatform(value:unknown):value is PlatformId{
  return typeof value==='string'&&SUPPORTED_PLATFORMS.includes(value as PlatformId);
}

export function isSupportedMessage(value:unknown):value is Record<string,unknown>&{type:typeof messageTypes[number]}{
  return!!value&&typeof value==='object'&&messageTypes.includes((value as {type:typeof messageTypes[number]}).type);
}
