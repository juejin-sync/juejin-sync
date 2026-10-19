// 后台知乎同步消息链路回归：真实任务存储配合模拟知乎 API，验证账号隔离与草稿状态边界。
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Article,SyncTask} from '../src/types';

const platform=vi.hoisted(()=>({
  account:'知乎测试员',
  accountId:'member_a',
  loggedIn:true,
  failure:false,
  twoPhaseFailure:false,
  draftState:'draft' as 'draft'|'published'|'missing'|'unauthorized'|'unknown',
  writes:0,
  lastArticleId:undefined as string|undefined,
  lastArticle:undefined as Article|undefined
}));

vi.mock('../src/targets/zhihu-api',async()=>{
  return{
    checkZhihuAuth:async()=>({
      ok:true,
      loggedIn:platform.loggedIn,
      account:platform.loggedIn?platform.account:undefined,
      accountId:platform.loggedIn?platform.accountId:undefined
    }),
    fetchZhihuDraftState:async(articleId:string,expectedAccountId?:string)=>{
      const {SyncError}=await import('../src/core/diagnostic');
      if(expectedAccountId&&expectedAccountId!==platform.accountId){
        return 'unauthorized';
      }
      return platform.draftState;
    },
    saveZhihuDraft:async(article:any,options:any)=>{
      const {SyncError}=await import('../src/core/diagnostic');
      if(options.expectedAccountId&&options.expectedAccountId!==platform.accountId){
        throw new SyncError('当前登录的知乎账号与目标账号不一致','blocked','authentication');
      }
      platform.writes++;
      platform.lastArticle=article;
      platform.lastArticleId=options.articleId;
      if(platform.twoPhaseFailure){
        const stage1Id='stage1-id-999';
        const stage1Url=`https://zhuanlan.zhihu.com/p/${stage1Id}/edit`;
        if(options.onDraftCreated){
          await options.onDraftCreated(stage1Id,stage1Url);
        }
        const err=new SyncError('知乎草稿正文写入失败，请检查草稿箱确认结果','interrupted','draft');
        (err as any).articleId=stage1Id;
        (err as any).draftUrl=stage1Url;
        throw err;
      }
      if(platform.failure){
        throw new SyncError('知乎草稿写入异常，保存结果不确定','interrupted','draft');
      }
      const draftId=options.articleId||`draft-${platform.accountId}`;
      return{
        articleId:draftId,
        draftUrl:`https://zhuanlan.zhihu.com/p/${draftId}/edit`,
        warnings:[],
        stats:{imageTotal:0,imageSucceeded:0,imageFailed:0}
      };
    }
  };
});

vi.mock('../src/core/health',()=>({
  HEALTH_CHECK_ALARM:'health',
  refreshHealthIfNeeded:async()=>{},
  getCachedHealth:async()=>undefined,
  isHealthAlert:()=>false
}));
vi.mock('../src/core/notify',()=>({
  buildTaskNotification:()=>undefined,
  showTaskNotification:async()=>{}
}));

let store:Record<string,any>;
let sessionStore:Record<string,any>;
let listener:(message:unknown,sender:unknown,reply:(result:any)=>void)=>void;
const article={id:'source',title:'知乎同步测试文章',markdown:'这是超过二十个字符的文章正文，用于验证知乎后台实际任务链路。',cover:'',tags:[],sourceUrl:'https://juejin.cn/post/1'};
const send=(message:Record<string,unknown>)=>new Promise<any>(resolve=>listener(message,{},resolve));

beforeEach(async()=>{
  vi.resetModules();
  vi.useFakeTimers();
  platform.account='知乎测试员';
  platform.accountId='member_a';
  platform.loggedIn=true;
  platform.failure=false;
  platform.twoPhaseFailure=false;
  platform.draftState='draft';
  platform.writes=0;
  platform.lastArticleId=undefined;
  platform.lastArticle=undefined;
  store={syncTasks:[]};
  sessionStore={};
  vi.stubGlobal('chrome',{
    storage:{
      local:{
        get:async(key:string)=>({[key]:store[key]}),
        set:async(patch:Record<string,unknown>)=>{Object.assign(store,patch);},
        remove:async(key:string)=>{delete store[key];}
      },
      session:{
        get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,sessionStore[key]])),
        set:async(patch:Record<string,unknown>)=>{Object.assign(sessionStore,patch);},
        remove:async(key:string)=>{delete sessionStore[key];}
      }
    },
    runtime:{
      onMessage:{addListener:(callback:typeof listener)=>{listener=callback;}},
      getURL:(path:string)=>path
    },
    action:{
      setBadgeText:async()=>{},
      setBadgeBackgroundColor:async()=>{}
    },
    tabs:{create:async()=>({})},
    notifications:{onClicked:{addListener:()=>{}}},
    alarms:{get:async()=>({}),onAlarm:{addListener:()=>{}}}
  });
  await import('../src/background');
});

afterEach(()=>{
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('后台知乎同步消息链路', ()=>{
  it('发布快照先刷新同资源私有图片，再进入目标适配器，保留提交时元数据',async()=>{
    const path='/tos-cn-i-73owjymdk6/image-a~tplv-watermark.awebp';
    const oldUrl=`https://p0-xtjj-private.juejin.cn${path}?x-orig-sign=old`;
    const newUrl=`https://p6-xtjj-sign.byteimg.com${path}?x-signature=new`;
    const snapshot={...article,sourceDraftId:'2',summary:'',markdown:`提交时的正文保留，不能被发布后的编辑覆盖。\n![图](${oldUrl})`,cover:oldUrl};
    store.juejinUuid='test-uuid';
    const fetch=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({err_no:0,data:{article_draft:{id:'2',title:'后续标题',mark_content:`后来修改的正文不应替换发布时快照。\n![图](${newUrl})`,brief_content:'后续摘要',cover_image:'https://example.com/other.png'}}}));
    vi.stubGlobal('fetch',fetch);
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article:snapshot,accountId:'member_a'});
    expect(result.task.status).toBe('saved');
    expect(platform.lastArticle).toEqual({...snapshot,markdown:snapshot.markdown.replace(oldUrl,newUrl),cover:newUrl});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({draft_id:'2'});
  });

  it('关闭封面同步且正文没有私有图片时，不读取源接口',async()=>{
    store.settings={syncCover:false};
    const fetch=vi.fn();
    vi.stubGlobal('fetch',fetch);
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',accountId:'member_a',article:{...article,sourceDraftId:'2',cover:'https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/cover.png?x-orig-sign=old'}});
    expect(result.task.status).toBe('saved');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('刷新私有图片的源接口失败时，不写目标草稿并保留可重试状态',async()=>{
    store.juejinUuid='test-uuid';
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:503})));
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',accountId:'member_a',article:{...article,sourceDraftId:'2',cover:'https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/cover.png?x-orig-sign=old'}});
    expect(result.ok).toBe(false);
    expect(platform.writes).toBe(0);
    expect(store.syncTasks[0]).toMatchObject({status:'failed',diagnostic:{category:'network'}});
  });

  it('任务与映射绑定当前知乎账号，同一篇文章在另一账号单独建档',async()=>{
    const first=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_a'});
    expect(first.task).toMatchObject({status:'saved',zhihuAccountId:'member_a',zhihuArticleId:'draft-member_a'});
    
    platform.accountId='member_b';
    platform.account='知乎第二账号';
    const second=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_b'});
    expect(second.task).toMatchObject({status:'saved',zhihuAccountId:'member_b',zhihuArticleId:'draft-member_b'});

    expect(store.syncTasks).toHaveLength(2);
    expect(store['zhihuDraftMapping:member_a:source'].zhihuArticleId).toBe('draft-member_a');
    expect(store['zhihuDraftMapping:member_b:source'].zhihuArticleId).toBe('draft-member_b');
  });

  it('弹窗检测后知乎账号切换，入队前拒绝写入',async()=>{
    platform.accountId='member_b';
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('账号不一致');
    expect(platform.writes).toBe(0);
  });

  it('需要确认时返回待确认，不实际保存；确认后继续执行',async()=>{
    store.settings={confirmDraftUpdate:true};
    store.juejinUuid='test-uuid';
    store['zhihuDraftMapping:member_a:source']={articleId:'source',zhihuAccountId:'member_a',zhihuArticleId:'existing-draft'};
    const testArticle={...article,sourceDraftId:'draft-src-1'};
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({
      err_no:0,
      data:{article_draft:{mark_content:article.markdown,cover_image:''}}
    })));

    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article:testArticle,zhihuAccountId:'member_a'});
    expect(result).toMatchObject({ok:true,task:{status:'needs-confirmation'}});
    expect(platform.writes).toBe(0);

    const confirmRes=await send({type:'CONFIRM_TASK_UPDATE',id:result.task.id});
    expect(confirmRes).toMatchObject({ok:true});
    await vi.waitFor(()=>expect(store.syncTasks[0].status).toBe('saved'));
    expect(platform.writes).toBe(1);
    expect(platform.lastArticleId).toBe('existing-draft');
  });

  it('目标草稿已发布时阻止覆盖',async()=>{
    store.syncTasks=[{
      id:'task-zh-1',
      article,
      platform:'zhihu',
      status:'saved',
      createdAt:'2026-10-01T00:00:00Z',
      updatedAt:'2026-10-01T00:00:00Z',
      attempts:1,
      zhihuAccountId:'member_a',
      zhihuArticleId:'published-draft'
    }];
    store['zhihuDraftMapping:member_a:source']={articleId:'source',zhihuAccountId:'member_a',zhihuArticleId:'published-draft'};
    platform.draftState='published';

    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('已发布');
    expect(platform.writes).toBe(0);

    const task=store.syncTasks[0] as SyncTask;
    expect(task.status).toBe('needs-user');
    expect(task.diagnostic?.category).toBe('blocked');
  });

  it('无法确认草稿状态（unknown）时暂停更新',async()=>{
    store.syncTasks=[{
      id:'task-zh-2',
      article,
      platform:'zhihu',
      status:'saved',
      createdAt:'2026-10-01T00:00:00Z',
      updatedAt:'2026-10-01T00:00:00Z',
      attempts:1,
      zhihuAccountId:'member_a',
      zhihuArticleId:'unknown-draft'
    }];
    store['zhihuDraftMapping:member_a:source']={articleId:'source',zhihuAccountId:'member_a',zhihuArticleId:'unknown-draft'};
    platform.draftState='unknown';

    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法确认知乎文章仍是草稿');
    expect(platform.writes).toBe(0);

    const task=store.syncTasks[0] as SyncTask;
    expect(task.status).toBe('needs-user');
    expect(task.diagnostic?.category).toBe('blocked');
  });

  it('知乎旧草稿已不存在（missing）时降级为新建，清除旧映射',async()=>{
    store.syncTasks=[{
      id:'task-zh-3',
      article,
      platform:'zhihu',
      status:'saved',
      createdAt:'2026-10-01T00:00:00Z',
      updatedAt:'2026-10-01T00:00:00Z',
      attempts:1,
      zhihuAccountId:'member_a',
      zhihuArticleId:'deleted-draft'
    }];
    store['zhihuDraftMapping:member_a:source']={articleId:'source',zhihuAccountId:'member_a',zhihuArticleId:'deleted-draft'};
    platform.draftState='missing';

    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_a'});
    expect(result.ok).toBe(true);
    expect(result.task).toMatchObject({status:'saved',zhihuArticleId:'draft-member_a'});
    expect(platform.writes).toBe(1);
    expect(platform.lastArticleId).toBeUndefined(); // 重新作为新建草稿
    expect(store['zhihuDraftMapping:member_a:source'].zhihuArticleId).toBe('draft-member_a');
  });

  it('不确定写入暂停，批量重试及重复同步不再次写入',async()=>{
    platform.failure=true;
    const message={type:'SYNC_NEW_ARTICLE',platform:'zhihu',article,zhihuAccountId:'member_a'};
    expect((await send(message)).ok).toBe(false);

    const task=store.syncTasks[0] as SyncTask;
    expect(task).toMatchObject({status:'needs-user',diagnostic:{category:'interrupted'}});
    expect(await send({type:'RETRY_FAILED_TASKS'})).toMatchObject({count:0});
    expect((await send({type:'RETRY_TASK',id:task.id})).ok).toBe(false);
    expect((await send(message)).ok).toBe(false);
    expect(platform.writes).toBe(1);
  });

  it('CHECK_ZHIHU_STATUS 返回登录状态与账号信息',async()=>{
    const result=await send({type:'CHECK_ZHIHU_STATUS'});
    expect(result).toMatchObject({ok:true,loggedIn:true,accountId:'member_a'});
  });

  it('拦截不支持的非法目标平台',async()=>{
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'invalid_platform' as any,article});
    expect(result).toMatchObject({ok:false,message:expect.stringContaining('不支持的目标平台')});
    expect(platform.writes).toBe(0);
  });

  it('知乎未登录时历史文章排队，登录后可恢复同步',async()=>{
    platform.loggedIn=false;
    const request={
      type:'SYNC_HISTORY_ARTICLE',
      platform:'zhihu',
      articleId:'999',
      title:'历史知乎文章',
      sourceUrl:'https://juejin.cn/post/999',
      uuid:'test-uuid',
      zhihuAccountId:'member_a'
    };
    const reqRes=await send(request);
    expect(reqRes.needsLogin).toBe(true);
    expect(sessionStore.pendingHistories).toHaveLength(1);

    platform.loggedIn=true;
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>Response.json({
      err_no:0,
      data:String(input).includes('list_by_user')
        ?[{article_info:{article_id:'999',draft_id:'999'}}]
        :{article_draft:{mark_content:article.markdown,cover_image:''}}
    })));

    const resumed=await send({type:'RESUME_PENDING_HISTORY'});
    expect(resumed.results).toHaveLength(1);
    expect(sessionStore.pendingHistories).toEqual([]);
    expect(platform.writes).toBe(1);
  });

  it('新建草稿在两阶段第二步失败时，依然持久化已创建的 zhihuArticleId 与 draftUrl，并将任务置为 needs-user', async () => {
    platform.twoPhaseFailure = true;
    const message = { type: 'SYNC_NEW_ARTICLE', platform: 'zhihu', article, zhihuAccountId: 'member_a' };
    const res = await send(message);
    expect(res.ok).toBe(false);

    const task = store.syncTasks[0] as SyncTask;
    expect(task).toMatchObject({
      status: 'needs-user',
      zhihuArticleId: 'stage1-id-999',
      draftUrl: 'https://zhuanlan.zhihu.com/p/stage1-id-999/edit',
      diagnostic: { category: 'interrupted' }
    });
    expect(store['zhihuDraftMapping:member_a:source'].zhihuArticleId).toBe('stage1-id-999');
  });
});

