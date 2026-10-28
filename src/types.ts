// 多平台任务契约：小红书 draftId 仅作为本地保存凭证，不作为远端更新标识。
export type PlatformId='csdn'|'wechat'|'cnblogs'|'zhihu'|'xiaohongshu';
export type Article={id:string;sourceDraftId?:string;title:string;markdown:string;summary?:string;cover?:string;tags:string[];sourceUrl:string};
export type TaskStatus='queued'|'checking-login'|'transforming'|'writing'|'saved'|'failed'|'needs-user'|'needs-confirmation';
export type TaskProgress={current:number;total:number;message:string};
export type TaskStage='validation'|'authentication'|'content'|'images'|'draft'|'recovery';
export type TaskErrorCategory='login'|'network'|'rate-limit'|'platform-change'|'content'|'blocked'|'interrupted'|'unknown';
export type TaskDiagnostic={stage:TaskStage;category:TaskErrorCategory;message:string;suggestion:string;occurredAt:string};
export type TaskStats={imageTotal:number;imageSucceeded:number;imageFailed:number;durationMs:number};
// 微信任务绑定稳定公众号标识；博客园绑定博客标识；知乎绑定稳定账号标识；小红书绑定稳定用户标识；令牌与票据不参与任务身份。
export type SyncTask={id:string;article:Article;platform:PlatformId;wechatAccountId?:string;cnblogsAccountId?:string;zhihuAccountId?:string;xiaohongshuAccountId?:string;status:TaskStatus;createdAt:string;updatedAt:string;draftUrl?:string;csdnArticleId?:string;wechatAppMsgId?:string;cnblogsPostId?:string;zhihuArticleId?:string;xiaohongshuDraftId?:string;error?:string;diagnostic?:TaskDiagnostic;warnings?:string[];progress?:TaskProgress;stats?:TaskStats;attempts:number};
export type CsdnDraftMapping={articleId:string;csdnArticleId:string;draftUrl?:string;updatedAt:string};
export type WechatDraftMapping={articleId:string;wechatAccountId?:string;wechatAppMsgId:string;draftUrl?:string;updatedAt:string};
export type CnblogsDraftMapping={articleId:string;cnblogsAccountId?:string;cnblogsPostId:string;draftUrl?:string;updatedAt:string};
export type ZhihuDraftMapping={articleId:string;zhihuAccountId?:string;zhihuArticleId:string;draftUrl?:string;updatedAt:string};
export type PlatformDraftMapping=CsdnDraftMapping|WechatDraftMapping|CnblogsDraftMapping|ZhihuDraftMapping;
export type PlatformState={id:PlatformId;name:string;loggedIn:'unknown'|'yes'|'no'};
export type CategoryMapping={sourceTag:string;targetCategory:string};
export type ImageFailurePolicy='continue'|'abort';
export type WechatCodeTheme='onedark'|'github-light'|'monokai';
export type ExtensionSettings={defaultCsdnCategory:string;categoryMappings:CategoryMapping[];syncCover:boolean;autoSummary:boolean;appendSourceLink:boolean;imageFailurePolicy:ImageFailurePolicy;confirmDraftUpdate:boolean;wechatCodeTheme:WechatCodeTheme};
export const uid=()=>crypto.randomUUID();
