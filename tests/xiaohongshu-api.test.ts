// 小红书本地草稿适配器：先传图后填文、独立标签页、账号复核及自动保存后的中断保护。
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {checkXiaohongshuAuth,saveXiaohongshuDraft,XHS_PUBLISH_URL} from '../src/targets/xiaohongshu-api';
import {imageKey} from '../src/targets/xiaohongshu-formats';
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
    if(message.action==='UPLOAD_ARTICLE_FILE')return{ok:true,src:'https://ros-preview.xhscdn.com/test'};
    if(message.action==='SAVE_NOTE'||message.action==='IMPORT_ARTICLE')return{ok:true,draftId:'local-draft',accountId:'account-a'};
    return{ok:true};
  };
  create=vi.fn(async()=>({id:9}));remove=vi.fn(async()=>{});
  vi.stubGlobal('chrome',{tabs:{query:vi.fn(async()=>[{id:1,url:XHS_PUBLISH_URL}]),create,remove,sendMessage:vi.fn(async(_id,message)=>{actions.push(message.action);return handler(message);})}});
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:400,height:300,close:vi.fn()})));
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network');}));
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
async function save(options:any={},input:Article=article){
  const pending=saveXiaohongshuDraft(input,{format:'image',imageContent:{title:input.title,body:'已确认的精简正文',cards:[],selectedImageKeys:input.cover?[imageKey(input.cover)]:[]},...options});
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

describe('完整长文保存',()=>{
  it('超长正文保存规则精简后的同一份稿件，记录精简提示且不改源文章',async()=>{
    const input={...article,cover:undefined,markdown:'# 实现\n\n核心方法说明。\n\n```js\n'+'const complete_example = true;\n'.repeat(900)+'```\n\n## 限制\n\n不能省略异常处理。'};
    const original=input.markdown;
    const result=await save({format:'article'},input);
    const imported=(chrome.tabs.sendMessage as any).mock.calls.find((call:any[])=>call[1].action==='IMPORT_ARTICLE')[1].payload;
    expect(imported.body).toContain('本文为本地规则精简版');expect(imported.body).toContain('完整代码见原文');
    expect(imported.body).toContain('不能省略异常处理。');expect(imported.html).not.toContain('complete_example');
    expect(result.warnings.join('')).toContain('已按本地规则精简');expect(input.markdown).toBe(original);
  });
  it('长文按真实图片尺寸预算，正文与配图恰好可放下时保留原文',async()=>{
    const body='文'.repeat(9813);
    const result=await save({format:'article'},{...article,markdown:`${body}\n\n![图](${PIXEL})`});
    const imported=(chrome.tabs.sendMessage as any).mock.calls.find((call:any[])=>call[1].action==='IMPORT_ARTICLE')[1].payload;
    // 400×300 图片占180，首发声明占7；不按每图最坏400而过度精简。
    expect(imported.body).toBe(body+'\n本文首发于掘金');expect(imported.images).toHaveLength(1);
    expect(result.warnings.join('')).not.toContain('已按本地规则精简');
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    const bitmap=await(vi.mocked(createImageBitmap).mock.results[0].value);expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
  it('配图导致必要内容总预算超限时，上传及创建目标页前停止',async()=>{
    const onSaving=vi.fn();
    await expect(save({format:'article',onSaving},{...article,markdown:`${'文'.repeat(9900)}\n\n![图](${PIXEL})`})).rejects.toMatchObject({category:'content',stage:'validation',message:expect.stringContaining('配图占用 180 字')});
    expect(create).not.toHaveBeenCalled();expect(actions).toEqual([]);expect(onSaving).not.toHaveBeenCalled();
  });
  it('只因配图超限时也重新精简完整源文，保留上传图片并保存一次',async()=>{
    const markdown='正文主题。\n\n'+'背景经历'.repeat(1230)+'。\n\n'+'例如经过'.repeat(1230)+'。\n\n必须保留结论。'+`\n\n![图](${PIXEL})`;
    const result=await save({format:'article'},{...article,markdown});
    const imported=(chrome.tabs.sendMessage as any).mock.calls.find((call:any[])=>call[1].action==='IMPORT_ARTICLE')[1].payload;
    expect(imported.body).toContain('本文为本地规则精简版');expect(imported.body).toContain('必须保留结论。');
    expect(imported.images).toHaveLength(1);expect(actions.filter(action=>action==='UPLOAD_ARTICLE_FILE')).toHaveLength(1);
    expect(actions.filter(action=>action==='IMPORT_ARTICLE')).toHaveLength(1);expect(result.warnings.join('')).toContain('配图占用 180 字');
  });
  it('正文超限在打开目标页、上传或写入草稿之前报告具体超出量',async()=>{
    const onSaving=vi.fn();
    await expect(save({format:'article',appendSourceLink:false,onSaving},{...article,markdown:'文'.repeat(10001)})).rejects.toMatchObject({category:'content',stage:'validation',message:expect.stringContaining('10001 字，超过 10000 字上限 1 字')});
    expect(create).not.toHaveBeenCalled();expect(actions).toEqual([]);expect(onSaving).not.toHaveBeenCalled();
  });
  it('默认长文允许纯文字，先标记 writing 再导入完整正文',async()=>{
    const result=await save({format:'article',onSaving:()=>{actions.push('WRITING');}}, {...article,cover:undefined,markdown:'完整长文。'.repeat(240)+'末尾结论。'});
    expect(actions).toEqual(['PING','GET_SESSION','PREPARE_ARTICLE','WRITING','IMPORT_ARTICLE']);
    expect(result.stats.imageTotal).toBe(0);
    const fill=(chrome.tabs.sendMessage as any).mock.calls.find((call:any[])=>call[1].action==='IMPORT_ARTICLE')[1];
    expect(fill.payload.html).toContain('末尾结论');expect(fill.payload.html.length).toBeGreaterThan(1000);
    expect(fill.payload).toMatchObject({accountId:'account-a',images:[]});
  });
  it('长文校验不完整时保留页面并阻断暂存，不自动重建',async()=>{
    const original=handler;handler=message=>message.action==='IMPORT_ARTICLE'?{ok:false,message:'末尾缺失'}:original(message);
    await expect(save({format:'article'})).rejects.toMatchObject({category:'interrupted'});
    expect(actions).not.toContain('SAVE_NOTE');expect(remove).not.toHaveBeenCalled();
  });
  it('带图长文先上传配图再一次导入，完整正文与图片位置随请求固定',async()=>{
    await save({format:'article'},{...article,cover:undefined,markdown:`前段完整说明。\n\n![图](${PIXEL})\n\n末尾必要限制。`});
    expect(actions).toEqual(['PING','GET_SESSION','PREPARE_ARTICLE','UPLOAD_ARTICLE_FILE','IMPORT_ARTICLE']);
    expect(remove).toHaveBeenCalledWith(9);
  });
});
