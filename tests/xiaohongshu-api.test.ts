// 小红书本地草稿适配器：先传图后填文、独立标签页、账号复核及自动保存后的中断保护。
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {checkXiaohongshuAuth,saveXiaohongshuDraft,XHS_PUBLISH_URL} from '../src/targets/xiaohongshu-api';
import type {Article} from '../src/types';
const PIXEL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const article:Article={id:'source',title:'小红书同步测试',markdown:'这是用于测试小红书本地图文草稿的完整正文内容。',tags:[],sourceUrl:'https://juejin.cn/post/1',cover:PIXEL};
let actions:string[];
let handler:(message:any)=>any;
let remove:ReturnType<typeof vi.fn>;
let create:ReturnType<typeof vi.fn>;

beforeEach(()=>{
  vi.useFakeTimers();actions=[];
  handler=message=>{
    if(message.action==='GET_SESSION')return{ok:true,loggedIn:true,accountId:'account-a'};
    if(message.action==='SAVE_NOTE')return{ok:true,draftId:'local-draft',accountId:'account-a'};
    return{ok:true};
  };
  create=vi.fn(async()=>({id:9}));remove=vi.fn(async()=>{});
  vi.stubGlobal('chrome',{tabs:{query:vi.fn(async()=>[{id:1,url:XHS_PUBLISH_URL}]),create,remove,sendMessage:vi.fn(async(_id,message)=>{actions.push(message.action);return handler(message);})}});
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network');}));
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
async function save(options:any={},input:Article=article){
  const pending=saveXiaohongshuDraft(input,options);
  // 立即注册拒绝处理，避免 fake timer 推进时产生未处理拒绝。
  const outcome=pending.then(value=>({value}),error=>({error}));
  await vi.advanceTimersByTimeAsync(600);
  const result=await outcome;
  if('error' in result)throw result.error;
  return result.value;
}

describe('本地图文草稿保存',()=>{
  it('新建独立页，按切图文→上传→编辑器→正文→复核账号→保存顺序执行',async()=>{
    const onSaving=vi.fn(()=>{actions.push('WRITING');});
    const result=await save({expectedAccountId:'account-a',onSaving});
    expect(create).toHaveBeenCalledWith({url:XHS_PUBLISH_URL,active:false});
    expect(actions).toEqual(['PING','GET_SESSION','PREPARE_IMAGE_NOTE','WRITING','UPLOAD_IMAGE','WAIT_EDITOR','FILL_TEXT','GET_SESSION','SAVE_NOTE']);
    expect(result).toMatchObject({articleId:'local-draft',draftUrl:XHS_PUBLISH_URL,stats:{imageTotal:1,imageSucceeded:1,imageFailed:0}});
    expect(result.warnings.join('')).toContain('当前浏览器本地');
    expect(remove).toHaveBeenCalledWith(9);
  });
  it('任务账号不一致时在首次写入前停止并关闭自建页',async()=>{
    await expect(save({expectedAccountId:'other-account'})).rejects.toMatchObject({category:'blocked'});
    expect(actions).not.toContain('UPLOAD_IMAGE');
    expect(remove).toHaveBeenCalledWith(9);
  });
  it('图片进入页面后上传失败，标记不确定并保留编辑页',async()=>{
    handler=message=>message.action==='GET_SESSION'?{ok:true,loggedIn:true,accountId:'account-a'}:message.action==='UPLOAD_IMAGE'?{ok:false,message:'图片上传失败'}:{ok:true};
    await expect(save()).rejects.toMatchObject({category:'interrupted',draftUrl:XHS_PUBLISH_URL});
    expect(actions).not.toContain('SAVE_NOTE');
    expect(remove).not.toHaveBeenCalled();
  });
  it('填充失败时不点击保存，保留可能已经自动保存的内容',async()=>{
    const original=handler;handler=message=>message.action==='FILL_TEXT'?{ok:false,message:'正文不一致'}:original(message);
    await expect(save()).rejects.toMatchObject({category:'interrupted'});
    expect(actions).not.toContain('SAVE_NOTE');expect(remove).not.toHaveBeenCalled();
  });
  it('图片上传期间切换账号时阻断保存',async()=>{
    const original=handler;let authCalls=0;
    handler=message=>message.action==='GET_SESSION'?{ok:true,loggedIn:true,accountId:++authCalls===1?'account-a':'account-b'}:original(message);
    await expect(save()).rejects.toThrow('账号在同步过程中发生变更');
    expect(actions).not.toContain('SAVE_NOTE');expect(remove).not.toHaveBeenCalled();
  });
  it.each([{ok:false,message:'事务回滚'},{ok:true},{ok:true,draftId:'local',accountId:'other'}])('缺失或不匹配本地保存凭证时不报成功：%j',async result=>{
    const original=handler;handler=message=>message.action==='SAVE_NOTE'?result:original(message);
    await expect(save()).rejects.toMatchObject({category:'interrupted'});
    expect(remove).not.toHaveBeenCalled();
  });
  it('没有配图时不创建标签页',async()=>{
    await expect(save({}, {...article,cover:undefined})).rejects.toMatchObject({category:'content'});
    expect(create).not.toHaveBeenCalled();
  });
  it('首张图片格式不支持时不写入页面',async()=>{
    await expect(save({}, {...article,cover:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='})).rejects.toMatchObject({category:'content',stage:'images'});
    expect(actions).not.toContain('UPLOAD_IMAGE');expect(remove).toHaveBeenCalledWith(9);
  });
});
describe('小红书账号检测',()=>{
  it('真实用户信息字段返回账号与昵称',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>({success:true,code:0,data:{userId:'account-a',userName:'作者'}})})));
    await expect(checkXiaohongshuAuth()).resolves.toMatchObject({ok:true,loggedIn:true,accountId:'account-a',account:'作者'});
  });
  it('后台读取失败时降级到现有页面的即时账号检测',async()=>{
    await expect(checkXiaohongshuAuth()).resolves.toMatchObject({ok:true,loggedIn:true,accountId:'account-a'});
  });
});
