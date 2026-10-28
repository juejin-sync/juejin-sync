// 小红书适配器回归测试：登录检测、标签页复用/释放、账号隔离、保存结果与状态判定。
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {
  XHS_DRAFT_MANAGER_URL,
  checkXiaohongshuAuth,
  fetchXiaohongshuNoteState,
  saveXiaohongshuDraft
} from '../src/targets/xiaohongshu-api';
import {SyncError} from '../src/core/diagnostic';
import type {Article} from '../src/types';

const NOTE_ID='6512ab34cd56ef7890123456';
const PIXEL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const buildArticle=(overrides:Partial<Article>={}):Article=>({
  id:'article-1',
  title:'小红书同步测试',
  markdown:'## 小节\n\n这篇正文用于验证小红书图文草稿的保存契约。',
  tags:['前端'],
  sourceUrl:'https://juejin.cn/post/1',
  cover:PIXEL,
  ...overrides
});

type SendHandler=(message:{action?:string;payload?:unknown})=>unknown;

function installChrome(options:{tabs?:Array<{id:number;url:string}>;handler:SendHandler;createdId?:number}={handler:()=>({ok:true})}){
  const sendMessage=vi.fn(async(_tabId:number,message:any)=>options.handler(message));
  const create=vi.fn(async()=>({id:options.createdId??9}));
  const remove=vi.fn(async()=>undefined);
  (globalThis as any).chrome={
    tabs:{
      query:vi.fn(async()=>options.tabs??[{id:7,url:'https://creator.xiaohongshu.com/publish/publish'}]),
      create,
      remove,
      sendMessage
    }
  };
  return{sendMessage,create,remove};
}

function installFetch(handler:()=>Promise<unknown>|unknown){
  const fetchMock=vi.fn(async(input:any)=>{
    const result=await handler();
    if(result===undefined)throw new Error('network error');
    return result as any;
  });
  globalThis.fetch=fetchMock as any;
  return fetchMock;
}

function jsonResponse(body:unknown,status=200){
  return{
    ok:status>=200&&status<300,
    status,
    headers:{get:()=>'application/json;charset=UTF-8'},
    json:async()=>body
  };
}

beforeEach(()=>{
  vi.restoreAllMocks();
  globalThis.fetch=vi.fn(async()=>{throw new Error('network error');}) as any;
});

describe('小红书登录检测',()=>{
  it('后台探针命中用户信息时返回登录态与稳定账号标识',async()=>{
    installFetch(()=>jsonResponse({data:{user_id:NOTE_ID,basic_info:{nickname:'掘金作者'}}}));
    await expect(checkXiaohongshuAuth()).resolves.toMatchObject({ok:true,loggedIn:true,accountId:NOTE_ID,account:'掘金作者'});
  });

  it('探针返回 401 时视为未登录',async()=>{
    installFetch(()=>jsonResponse({},401));
    await expect(checkXiaohongshuAuth()).resolves.toMatchObject({ok:true,loggedIn:false});
  });

  it('探针失败时降级到已打开标签页的 Bridge 会话',async()=>{
    installFetch(()=>undefined);
    installChrome({
      tabs:[{id:5,url:'https://creator.xiaohongshu.com/publish/publish'}],
      handler:message=>message.action==='PING'?{ok:true}:{ok:true,loggedIn:true,accountId:NOTE_ID,account:'作者'}
    });
    await expect(checkXiaohongshuAuth()).resolves.toMatchObject({ok:true,loggedIn:true,accountId:NOTE_ID});
  });

  it('探针与标签页都不可用时保持“无法确认”，不谎报未登录',async()=>{
    installFetch(()=>undefined);
    installChrome({tabs:[],handler:()=>({ok:true})});
    await expect(checkXiaohongshuAuth()).resolves.toMatchObject({ok:false,loggedIn:false});
  });
});

describe('小红书草稿保存',()=>{
  it('按 登录→填充→逐图上传→保存 顺序执行，并返回笔记标识',async()=>{
    const calls:string[]=[];
    const{sendMessage,remove}=installChrome({
      handler:message=>{
        calls.push(String(message.action));
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
        if(message.action==='SAVE_NOTE')return{ok:true,noteId:NOTE_ID,draftUrl:`https://creator.xiaohongshu.com/publish/publish?noteId=${NOTE_ID}`};
        return{ok:true};
      }
    });

    const result=await saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID});

    expect(result.articleId).toBe(NOTE_ID);
    expect(result.draftUrl).toContain(NOTE_ID);
    expect(result.stats).toMatchObject({imageTotal:1,imageSucceeded:1,imageFailed:0});
    expect(calls.filter(action=>action==='UPLOAD_IMAGE')).toHaveLength(1);
    expect(calls.indexOf('FILL_TEXT')).toBeLessThan(calls.indexOf('SAVE_NOTE'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('账号与任务绑定时不一致时阻断，不进入填充与保存',async()=>{
    const calls:string[]=[];
    installChrome({
      handler:message=>{
        calls.push(String(message.action));
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:'other-user'};
        return{ok:true};
      }
    });
    await expect(saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID})).rejects.toMatchObject({category:'blocked',stage:'authentication'});
    expect(calls).not.toContain('FILL_TEXT');
    expect(calls).not.toContain('SAVE_NOTE');
  });

  it('未登录时提示登录且不写入',async()=>{
    installChrome({
      handler:message=>message.action==='GET_SESSION'?{ok:true,loggedIn:false}:{ok:true}
    });
    await expect(saveXiaohongshuDraft(buildArticle())).rejects.toMatchObject({name:'SyncError',category:'login'});
  });

  it('无法取得账号标识时阻断写入',async()=>{
    installChrome({
      handler:message=>message.action==='GET_SESSION'?{ok:true,loggedIn:true}:{ok:true}
    });
    await expect(saveXiaohongshuDraft(buildArticle())).rejects.toMatchObject({category:'blocked'});
  });

  it('保存结果不确定时归类为 interrupted 并附带草稿箱入口',async()=>{
    installChrome({
      handler:message=>{
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
        if(message.action==='SAVE_NOTE')return{ok:false,message:'等待小红书保存结果超时，请先检查草稿箱，不要直接重复同步'};
        return{ok:true};
      }
    });
    try{
      await saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID});
      throw new Error('应当失败');
    }catch(error){
      expect(error).toBeInstanceOf(SyncError);
      expect(error).toMatchObject({category:'interrupted',stage:'draft'});
      expect((error as any).draftUrl).toBe(XHS_DRAFT_MANAGER_URL);
    }
  });

  it('保存成功但缺少笔记标识时按不确定处理',async()=>{
    installChrome({
      handler:message=>{
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
        if(message.action==='SAVE_NOTE')return{ok:true};
        return{ok:true};
      }
    });
    await expect(saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID})).rejects.toMatchObject({category:'interrupted'});
  });

  it('图片注入失败时停止保存并归类为图片异常',async()=>{
    installChrome({
      handler:message=>{
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
        if(message.action==='UPLOAD_IMAGE')return{ok:false,message:'未找到小红书图片上传入口，页面可能已改版'};
        return{ok:true};
      }
    });
    await expect(saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID})).rejects.toMatchObject({category:'content',stage:'images'});
  });

  it('没有图片时在联系页面前就阻断',async()=>{
    const{sendMessage}=installChrome({handler:()=>({ok:true})});
    await expect(saveXiaohongshuDraft(buildArticle({cover:undefined,markdown:'只有文字没有配图，长度也足够触发校验。'}))).rejects.toMatchObject({category:'content'});
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('小红书标签页获取与释放',()=>{
  it('复用时长的用户标签页且结束后不关闭',async()=>{
    const{create,remove}=installChrome({handler:message=>{
      if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
      if(message.action==='SAVE_NOTE')return{ok:true,noteId:NOTE_ID};
      return{ok:true};
    }});
    await saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID});
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('自建标签页在保存结束后关闭',async()=>{
    const{create,remove}=installChrome({
      tabs:[],
      createdId:11,
      handler:message=>{
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
        if(message.action==='SAVE_NOTE')return{ok:true,noteId:NOTE_ID};
        return{ok:true};
      }
    });
    await saveXiaohongshuDraft(buildArticle(),{expectedAccountId:NOTE_ID});
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(11);
  });
});

describe('小红书笔记状态判定',()=>{
  const installState=(state:string)=>{
    installChrome({
      tabs:[{id:8,url:`https://creator.xiaohongshu.com/publish/publish?noteId=${NOTE_ID}`}],
      handler:message=>{
        if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:NOTE_ID};
        if(message.action==='CHECK_NOTE')return{ok:true,state};
        return{ok:true};
      }
    });
  };

  it.each(['draft','published','missing'])('透传 %s 状态',async state=>{
    installState(state);
    await expect(fetchXiaohongshuNoteState(NOTE_ID,NOTE_ID)).resolves.toBe(state);
  });

  it('账号不一致时返回 unauthorized',async()=>{
    installChrome({
      tabs:[{id:8,url:`https://creator.xiaohongshu.com/publish/publish?noteId=${NOTE_ID}`}],
      handler:message=>message.action==='GET_SESSION'?{ok:true,loggedIn:true,accountId:'other'}:{ok:true,state:'draft'}
    });
    await expect(fetchXiaohongshuNoteState(NOTE_ID,NOTE_ID)).resolves.toBe('unauthorized');
  });

  it('通信失败时返回 unknown，避免误判覆盖',async()=>{
    installChrome({
      tabs:[{id:8,url:'https://creator.xiaohongshu.com/publish/publish'}],
      handler:message=>{
        if(message.action==='CHECK_NOTE')throw new Error('tab closed');
        return{ok:true,loggedIn:true,accountId:NOTE_ID};
      }
    });
    await expect(fetchXiaohongshuNoteState(NOTE_ID,NOTE_ID)).resolves.toBe('unknown');
  });
});
