// 验证主世界只观测页面自己的本地保存事务，并严格关联本次内容与账号。
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {afterEach,describe,expect,it,vi} from 'vitest';

const code=buildSync({entryPoints:['src/xiaohongshu-page.ts'],bundle:true,write:false,format:'iife'}).outputFiles[0].text;
const commandEvent='article-ferry:xhs-command';
const responseEvent='article-ferry:xhs-response';
const commandAttr='data-article-ferry-xhs-command';
const responseAttr='data-article-ferry-xhs';
const expected={requestId:'op-1',accountId:'account-a',title:'测试标题',body:'正文\n第二行',imageCount:2};
const record=()=>({draftId:'local-uuid',uid:'account-a',content:{draftStore:{title:'测试标题',desc:'正文\n第二行',imgList:[{fileId:'file-1'},{fileId:'file-2'}]}}});

function setup(){
  vi.useFakeTimers();
  const attributes=new Map<string,string>();
  const root={getAttribute:(key:string)=>attributes.get(key),setAttribute:(key:string,value:string)=>attributes.set(key,value),removeAttribute:(key:string)=>attributes.delete(key)};
  const document=Object.assign(new EventTarget(),{documentElement:root});
  const writes=vi.fn();
  class Store{
    name='image-draft';
    transaction=new EventTarget();
    put(value:unknown,key?:unknown){writes(value,key);return new EventTarget();}
  }
  const context={document,window:{},IDBObjectStore:Store,Event,setTimeout,clearTimeout};
  const responses:any[]=[];
  document.addEventListener(responseEvent,()=>responses.push(JSON.parse(root.getAttribute(responseAttr)!)));
  runInNewContext(code,context);
  const arm=(value:unknown=expected)=>{root.setAttribute(commandAttr,JSON.stringify(value));document.dispatchEvent(new Event(commandEvent));};
  return{Store,root,document,writes,responses,arm,context};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('小红书本地保存事务观测',()=>{
  it('仅在整个事务完成后确认，保留原始 put 返回值且不主动写入',()=>{
    const env=setup();
    expect(env.writes).not.toHaveBeenCalled();
    env.arm();
    expect(env.root.getAttribute('data-article-ferry-xhs-ack')).toBe('op-1');
    const store=new env.Store();
    const request=store.put(record());
    request.dispatchEvent(new Event('success'));
    expect(env.responses).toEqual([]);
    store.transaction.dispatchEvent(new Event('complete'));
    expect(env.responses).toEqual([{requestId:'op-1',ok:true,draftId:'local-uuid',accountId:'account-a'}]);
    expect(env.writes).toHaveBeenCalledTimes(1);
    expect(env.root.getAttribute(responseAttr)).toBeUndefined();
  });

  it.each(['account','title','body','count','file','store'])('忽略不匹配的自动保存：%s',field=>{
    const env=setup();env.arm();
    const data=record();
    const store=new env.Store();
    if(field==='account')data.uid='other';
    if(field==='title')data.content.draftStore.title='other';
    if(field==='body')data.content.draftStore.desc='other';
    if(field==='count')data.content.draftStore.imgList.pop();
    if(field==='file')data.content.draftStore.imgList[0].fileId='';
    if(field==='store')store.name='video-draft';
    store.put(data);store.transaction.dispatchEvent(new Event('complete'));
    expect(env.responses).toEqual([]);
    expect(env.writes).toHaveBeenCalledTimes(1);
  });

  it('request 成功但事务回滚时返回失败',()=>{
    const env=setup();env.arm();const store=new env.Store();
    store.put(record()).dispatchEvent(new Event('success'));
    store.transaction.dispatchEvent(new Event('abort'));
    expect(env.responses).toEqual([expect.objectContaining({requestId:'op-1',ok:false,message:expect.stringContaining('回滚')})]);
  });

  it('已取消或被新操作替代的事务不能确认下一次保存',()=>{
    const env=setup();env.arm();const old=new env.Store();old.put(record());
    env.arm({...expected,requestId:'op-2'});
    old.transaction.dispatchEvent(new Event('complete'));
    expect(env.responses).toEqual([]);
    const current=new env.Store();current.put(record());
    env.arm({requestId:'op-2',cancel:true});
    current.transaction.dispatchEvent(new Event('complete'));
    expect(env.responses).toEqual([]);
  });

  it('过期后不再观测；重复加载不会叠加 hook 或写入',()=>{
    const env=setup();runInNewContext(code,env.context);env.arm();
    vi.advanceTimersByTime(45001);
    const store=new env.Store();store.put(record());store.transaction.dispatchEvent(new Event('complete'));
    expect(env.responses).toEqual([]);
    expect(env.writes).toHaveBeenCalledTimes(1);
  });
});
