// 小红书平台元信息回归：平台清单、标签、账号隔离与通知目的地。
import {describe,expect,it} from 'vitest';
import {SUPPORTED_PLATFORMS,isSupportedMessage,platformLabel} from '../src/core/message';
import {findMatchingTask,isUncertainCreateTask,targetArticleId,taskAccountId} from '../src/core/task';
import {buildTaskNotification} from '../src/core/notify';
import {isHealthAlert} from '../src/core/health';
import type {Article,SyncTask} from '../src/types';

const article:Article={id:'source',title:'小红书平台契约',markdown:'正文内容足够长以通过校验。',tags:[],sourceUrl:'https://juejin.cn/post/1'};

const task=(overrides:Partial<SyncTask>={}):SyncTask=>({
  id:'task',
  article,
  platform:'xiaohongshu',
  status:'saved',
  createdAt:'2026-10-28T00:00:00Z',
  updatedAt:'2026-10-28T00:00:00Z',
  attempts:1,
  ...overrides
});

describe('平台清单元信息',()=>{
  it('小红书纳入受支持平台与消息协议',()=>{
    expect(SUPPORTED_PLATFORMS).toEqual(['csdn','wechat','cnblogs','zhihu','xiaohongshu']);
    expect(isSupportedMessage({type:'CHECK_XIAOHONGSHU_STATUS'})).toBe(true);
    expect(isSupportedMessage({type:'OPEN_XIAOHONGSHU_LOGIN'})).toBe(true);
    expect(isSupportedMessage({type:'CHECK_UNKNOWN_STATUS'})).toBe(false);
  });

  it('平台中文名集中维护',()=>{
    expect(platformLabel('xiaohongshu')).toBe('小红书');
    expect(platformLabel('wechat')).toBe('微信公众号');
    expect(SUPPORTED_PLATFORMS.map(platformLabel)).toHaveLength(5);
  });
});

describe('小红书任务身份',()=>{
  it('任务账号标识取小红书用户标识',()=>{
    expect(taskAccountId(task({xiaohongshuAccountId:'xhs_a'}))).toBe('xhs_a');
    expect(taskAccountId(task({platform:'csdn'}))).toBeUndefined();
  });

  it('同一文章在不同账号下不互相匹配',()=>{
    const accountA=task({id:'a',xiaohongshuAccountId:'xhs_a',status:'failed'});
    const accountB=task({id:'b',xiaohongshuAccountId:'xhs_b',status:'failed'});
    expect(findMatchingTask([accountA,accountB],article,'xiaohongshu','xhs_b')?.id).toBe('b');
    expect(findMatchingTask([accountA,accountB],article,'xiaohongshu','xhs_c')).toBeUndefined();
  });

  it('本地草稿标识不参与覆盖判断，写入中断始终需要确认',()=>{
    expect(targetArticleId(task({xiaohongshuDraftId:'local-1'}))).toBeUndefined();
    expect(isUncertainCreateTask(task({status:'writing'}))).toBe(true);
    expect(isUncertainCreateTask(task({status:'writing',xiaohongshuDraftId:'local-1'}))).toBe(true);
  });
});

describe('小红书通知与健康度',()=>{
  it('成功通知目的地为小红书草稿箱',()=>{
    const notification=buildTaskNotification(task({draftUrl:'https://creator.xiaohongshu.com/publish/publish',stats:{imageTotal:3,imageSucceeded:3,imageFailed:0,durationMs:1000}}),1000);
    expect(notification).toMatchObject({kind:'saved',title:'文章已抵达 小红书本地草稿箱'});
  });

  it('小红书标记为 broken 时触发健康警示',()=>{
    const base={csdn:'ok' as const,juejin:'ok' as const,message:'',sourceUrl:'',updatedAt:'',checkedAt:''};
    expect(isHealthAlert({...base,xiaohongshu:'broken'})).toBe(true);
    expect(isHealthAlert({...base,xiaohongshu:'degraded'})).toBe(false);
  });
});
