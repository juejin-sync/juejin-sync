// 小红书后台消息链路回归：真实任务存储配合模拟小红书适配器，验证账号隔离与草稿状态边界。
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const platform=vi.hoisted(()=>({
  account:'小红书测试员',
  accountId:'xhs_a' as string,
  loggedIn:true,
  mode:'success' as 'success'|'uncertain'|'fail',
  writes:0,
  progressStatus:undefined as string|undefined,
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
    saveXiaohongshuDraft:async(_article:any,options:any)=>{
      const {SyncError}=await import('../src/core/diagnostic');
      if(options.expectedAccountId&&options.expectedAccountId!==platform.accountId){
        throw new SyncError('当前登录的小红书账号与目标账号不一致','blocked','authentication');
      }
      if(platform.mode==='fail'){
        throw new SyncError('小红书图片校验失败','content','images');
      }
      await options.onSaving?.();
      await options.onProgress?.({current:0,total:1,message:'正在上传图片'});
      const {allTasks}=await import('../src/core/store');
      platform.progressStatus=(await allTasks())[0]?.status;
      platform.writes++;
      if(platform.mode==='uncertain'){
        throw new SyncError('等待小红书保存结果超时，请先检查草稿箱，不要直接重复同步','interrupted','draft');
      }
      const noteId=`local-${platform.accountId}-${platform.writes}`;
      platform.lastNoteId=noteId;
      return{
        articleId:noteId,
        draftUrl:'https://creator.xiaohongshu.com/publish/publish',
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
  platform.writes=0;
  platform.progressStatus=undefined;
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
  it('首次保存只记录本地 draftId，不建立远端映射',async()=>{
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.ok).toBe(true);
    expect(result.task).toMatchObject({platform:'xiaohongshu',status:'saved',xiaohongshuAccountId:'xhs_a',xiaohongshuDraftId:'local-xhs_a-1'});
    expect(store['xiaohongshuDraftMapping:xhs_a:source']).toBeUndefined();
    expect(platform.progressStatus).toBe('writing');
  });

  it('重复同步始终新建，不读取旧版本远端映射或要求确认覆盖',async()=>{
    store['xiaohongshuDraftMapping:xhs_a:source']={articleId:'source',xiaohongshuNoteId:'legacy-note'};
    await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.task).toMatchObject({status:'saved',xiaohongshuDraftId:'local-xhs_a-2'});
    expect(platform.writes).toBe(2);
  });

  it('切换账号后任务独立，各自保存新草稿',async()=>{
    await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    platform.accountId='xhs_b';
    await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_b'});
    expect(store.syncTasks).toHaveLength(2);
    expect(store.syncTasks.map((task:any)=>task.xiaohongshuAccountId).sort()).toEqual(['xhs_a','xhs_b']);
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
    expect(saved).toMatchObject({status:'saved',xiaohongshuDraftId:'local-xhs_a-2'});
    expect(store['xiaohongshuDraftMapping:xhs_a:source']).toBeUndefined();
  });

  it('内容校验失败时归类为内容异常且不写远端',async()=>{
    platform.mode='fail';
    const result=await send({type:'SYNC_NEW_ARTICLE',platform:'xiaohongshu',article,accountId:'xhs_a'});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('小红书图片校验失败');
    const failed=(store.syncTasks as any[])[0];
    expect(failed.status).toBe('failed');
    expect(failed.diagnostic).toMatchObject({category:'content',stage:'images'});
    expect(platform.writes).toBe(0);
  });

  it('重启恢复 writing 任务时需要人工核对，即使有旧保存凭证也不重新上传',async()=>{
    const now=new Date().toISOString();
    store.syncTasks=[{id:'interrupted',article,platform:'xiaohongshu',xiaohongshuAccountId:'xhs_a',xiaohongshuDraftId:'old-local',status:'writing',createdAt:now,updatedAt:now,attempts:1}];
    vi.resetModules();
    await import('../src/background');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.syncTasks[0]).toMatchObject({status:'needs-user',diagnostic:{category:'interrupted',stage:'recovery'}});
    expect(platform.writes).toBe(0);
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
