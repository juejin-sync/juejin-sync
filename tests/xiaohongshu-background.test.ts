// 小红书后台消息链路回归：真实任务存储配合模拟小红书适配器，验证账号隔离与草稿状态边界。
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const platform=vi.hoisted(()=>({
  account:'小红书测试员',
  accountId:'xhs_a' as string,
  loggedIn:true,
  mode:'success' as 'success'|'uncertain'|'fail',
  noteState:'draft' as 'draft'|'published'|'missing'|'unauthorized'|'unknown',
  writes:0,
  lastNoteId:undefined as string|undefined
}));

vi.mock('../src/targets/xiaohongshu-api',async()=>{
  return{
    checkXiaohongshuAuth:async()=>({
      ok:true,
      loggedIn:platform.loggedIn,
      account:platform.loggedIn?platform.account:undefined,
      accountId:platform.loggedIn?platform.accountId:undefined
    }),
    fetchXiaohongshuNoteState:async(_noteId:string,expectedAccountId?:string)=>{
      if(expectedAccountId&&expectedAccountId!==platform.accountId)return 'unauthorized';
      return platform.noteState;
    },
    saveXiaohongshuDraft:async(_article:any,options:any)=>{
      const {SyncError}=await import('../src/core/diagnostic');
      if(options.expectedAccountId&&options.expectedAccountId!==platform.accountId){
        throw new SyncError('当前登录的小红书账号与目标账号不一致','blocked','authentication');
      }
      platform.writes++;
      if(platform.mode==='uncertain'){
        throw new SyncError('等待小红书保存结果超时，请先检查草稿箱，不要直接重复同步','interrupted','draft');
      }
      if(platform.mode==='fail'){
        throw new SyncError('小红书编辑器填充失败，页面可能已改版','platform-change','content');
      }
      const noteId=options.noteId||`note-${platform.accountId}`;
      platform.lastNoteId=noteId;
      return{
        articleId:noteId,
        draftUrl:`https://creator.xiaohongshu.com/publish/publish?noteId=${noteId}`,
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
const article={id:'source',title:'小红书同步测试文章',markdown:'这是超过二十个字符的文章正文，用于验证小红书后台实际任务链路。',cover:'',tags:['前端'],sourceUrl:'https://juejin.cn/post/1'};
const send=(message:Record<string,unknown>)=>new Promise<any>(resolve=>listener(message,{},resolve));

beforeEach(async()=>{
  vi.resetModules();
  vi.useFakeTimers();
  platform.accountId='xhs_a';
  platform.loggedIn=true;
  platform.mode='success';
  platform.noteState='draft';
  platform.writes=0;
  platform.lastNoteId=undefined;
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

describe('后台小红书同步消息链路', ()=>{
  it('首次同步保存草稿并写入账号维度的草稿映射',async()=>{
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.ok).toBe(true);
    expect(result.task).toMatchObject({platform:'xiaohongshu',status:'saved',xiaohongshuAccountId:'xhs_a',xiaohongshuNoteId:'note-xhs_a'});
    expect(store['xiaohongshuDraftMapping:xhs_a:source']).toMatchObject({xiaohongshuNoteId:'note-xhs_a',xiaohongshuAccountId:'xhs_a'});
  });

  it('切换小红书账号时按账号隔离保存映射',async()=>{
    await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    platform.accountId='xhs_b';
    await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_b'});
    expect(store['xiaohongshuDraftMapping:xhs_a:source'].xiaohongshuNoteId).toBe('note-xhs_a');
    expect(store['xiaohongshuDraftMapping:xhs_b:source'].xiaohongshuNoteId).toBe('note-xhs_b');
  });

  it('原笔记已发布时阻断更新',async()=>{
    store['xiaohongshuDraftMapping:xhs_a:source']={articleId:'source',xiaohongshuAccountId:'xhs_a',xiaohongshuNoteId:'published-note'};
    platform.noteState='published';
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('已发布');
    const failed=(store.syncTasks as any[])[0];
    expect(failed.status).toBe('needs-user');
    expect(failed.diagnostic.category).toBe('blocked');
    expect(platform.writes).toBe(0);
  });

  it('笔记状态无法确认时暂停更新，避免覆盖',async()=>{
    store['xiaohongshuDraftMapping:xhs_a:source']={articleId:'source',xiaohongshuAccountId:'xhs_a',xiaohongshuNoteId:'unknown-note'};
    platform.noteState='unknown';
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法确认小红书笔记仍是草稿');
    const failed=(store.syncTasks as any[])[0];
    expect(failed.status).toBe('needs-user');
    expect(platform.writes).toBe(0);
  });

  it('保存结果不确定时标记为需要人工确认，并阻止自动重复创建',async()=>{
    platform.mode='uncertain';
    const first=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(first.ok).toBe(false);
    expect(first.message).toContain('等待小红书保存结果超时');
    const failed=(store.syncTasks as any[])[0];
    expect(failed.status).toBe('needs-user');
    expect(failed.diagnostic.category).toBe('interrupted');

    const second=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(second.ok).toBe(false);
    expect(second.message).toContain('上次写入结果尚未确认');
  });

  it('另存新草稿会清除旧笔记关联并重新保存',async()=>{
    platform.mode='uncertain';
    await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    const failedTask=(store.syncTasks as any[])[0];
    // 模拟掘金侧回填正文：storage 中的任务只保留元信息。
    failedTask.article.markdown=article.markdown;
    store['xiaohongshuDraftMapping:xhs_a:source']={articleId:'source',xiaohongshuAccountId:'xhs_a',xiaohongshuNoteId:'old-note'};
    platform.mode='success';
    const retry=await send({type:'RETRY_TASK',id:failedTask.id,asNew:true,confirmUncertain:true});
    expect(retry.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const saved=(store.syncTasks as any[]).find(task=>task.id===failedTask.id);
    expect(saved).toMatchObject({status:'saved',xiaohongshuNoteId:'note-xhs_a'});
    expect(store['xiaohongshuDraftMapping:xhs_a:source'].xiaohongshuNoteId).toBe('note-xhs_a');
  });

  it('内容校验失败时归类为内容异常且不写远端',async()=>{
    platform.mode='fail';
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('小红书编辑器填充失败');
    const failed=(store.syncTasks as any[])[0];
    expect(failed.status).toBe('failed');
    expect(failed.diagnostic).toMatchObject({category:'platform-change',stage:'content'});
    expect(platform.writes).toBe(1);
  });

  it('无法取得账号标识时拒绝创建任务',async()=>{
    platform.accountId='';
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:''});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法确认小红书账号身份');
    expect(platform.writes).toBe(0);
  });

  it('CHECK_XIAOHONGSHU_STATUS 透传登录态',async()=>{
    const result=await send({type:'CHECK_XIAOHONGSHU_STATUS'});
    expect(result).toMatchObject({ok:true,loggedIn:true,accountId:'xhs_a'});
  });
});
