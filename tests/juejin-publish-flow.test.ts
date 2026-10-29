// 发布流程时序回归：执行实际页面脚本，模拟跨世界事件、面板更换和异步网络响应。
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {buildSync} from 'esbuild';
import {describe,expect,it,vi} from 'vitest';

function bundle(file:string,extra=''){
  return buildSync({stdin:{contents:readFileSync(resolve('src',file),'utf8')+extra,resolveDir:resolve('src'),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser'}).outputFiles[0].text;
}
const contentCode=bundle('juejin-content.ts',`
  globalThis.testApi={injectPublishIntegration,resetPublishSelection,handleJuejinPublishStart,handleJuejinPublished,
    refresh:()=>currentPublishRefresh(),
    select:(platform)=>publishSelected.add(platform),
    state:()=>({selected:[...publishSelected],auths:publishAuths,pending:pendingPublishes.size})};
`);
const pageCode=bundle('juejin-page.ts','\nglobalThis.readSnapshotForTest=editorSnapshot;');
const attr='data-article-ferry-published';
const snapshotAttr='data-article-ferry-editor';
const publishUrl='https://api.juejin.cn/content_api/v1/article/publish';
const initialSnapshot={title:'请求发出时的标题',markdown:'请求发出时的正文，长度超过二十个字符用于同步校验。',draftId:'123',tags:['TypeScript'],sourceUrl:'https://juejin.cn/editor/drafts/123'};
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
function baseDocument(){
  const attrs=new Map<string,string>();
  const doc=Object.assign(new EventTarget(),{
    documentElement:{setAttribute:(key:string,value:string)=>attrs.set(key,value),getAttribute:(key:string)=>attrs.get(key)??null,removeAttribute:(key:string)=>attrs.delete(key)},
    querySelector:vi.fn(()=>null),querySelectorAll:vi.fn(()=>[]),createElement:vi.fn()
  });
  return doc;
}
function field(){
  const cards=new Map(['csdn','wechat'].map(platform=>{
    const input={checked:false,disabled:true,addEventListener:vi.fn()};
    const status={innerHTML:''};
    const card={appendChild:vi.fn(),classList:{add:vi.fn(),remove:vi.fn(),toggle:vi.fn()},addEventListener:vi.fn(),querySelector:(selector:string)=>selector==='.jc-platform-input'?input:status};
    return[platform,card];
  }));
  return{dataset:{},appendChild:vi.fn(),isConnected:true,setAttribute:vi.fn(),innerHTML:'',className:'',querySelector:(selector:string)=>cards.get(selector.includes('csdn')?'csdn':'wechat')};
}
function panel(){
  let injected:ReturnType<typeof field>|undefined;
  return{isConnected:true,querySelector:(selector:string)=>selector===':scope > .title'?{textContent:'发布文章'}:selector===':scope > .footer'?{}:selector==='.jc-publish-sync-field'?injected:null,
    querySelectorAll:()=>[],insertBefore:(node:ReturnType<typeof field>)=>{injected=node;},detach(){this.isConnected=false;if(injected)injected.isConnected=false;}};
}
function contentHarness(){
  const document=baseDocument();
  const chrome={runtime:{id:'',sendMessage:vi.fn(async(message:any)=>message.type==='CHECK_WECHAT_STATUS'?{ok:true,loggedIn:true,accountId:'account-a'}:message.type==='CHECK_CSDN_STATUS'?{ok:true,loggedIn:true}:{ok:true,task:{status:'saved'}})}};
  const context:any={document,chrome,Event,URL,performance:{getEntriesByType:()=>[]},alert:vi.fn(),window:{},location:{pathname:'/editor/drafts/123'}};
  let activePanel=panel();
  let snapshot={...initialSnapshot};
  document.querySelectorAll.mockImplementation(()=>[activePanel] as never);
  document.createElement.mockImplementation(()=>field());
  document.addEventListener('article-ferry:read-editor',()=>document.documentElement.setAttribute(snapshotAttr,JSON.stringify(snapshot)));
  runInNewContext(contentCode,context);
  chrome.runtime.id='extension';
  const api=context.testApi;
  function emit(requestId:string,success=false){document.documentElement.setAttribute(attr,JSON.stringify({requestId,...(success?{draftId:'123',articleId:'456'}:{})}));(success?api.handleJuejinPublished:api.handleJuejinPublishStart)();}
  return{api,chrome,document,context,emit,setSnapshot:(value:typeof snapshot)=>{snapshot=value;},replacePanel(){activePanel.detach();activePanel=panel();api.injectPublishIntegration();}};
}

describe('发布快照与面板状态',()=>{
  it('小红书后台双格式使用发布时偏好，不创建预览，部分成功不重发成功格式',async()=>{
    const h=contentHarness();let mode='both';
    h.chrome.runtime.sendMessage.mockImplementation(async(message:any)=>{
      if(message.type==='GET_SETTINGS')return{ok:true,settings:{xiaohongshuMode:mode}};
      if(message.type==='PREPARE_XIAOHONGSHU_CONTENT')return{ok:true,article:message.article,imageContent:message.xiaohongshuFormat==='image'?{title:'精简',body:'重点',cards:[],selectedImageKeys:[]}:undefined};
      if(message.type==='SYNC_NEW_ARTICLE')return{ok:true,task:{status:message.xiaohongshuFormat==='article'?'saved':'failed',error:'图文失败'}};
      return{ok:true,loggedIn:true,accountId:'xhs-account'};
    });
    h.api.injectPublishIntegration();await flush();h.api.select('xiaohongshu');h.emit('xhs');await flush();mode='article';h.emit('xhs',true);await flush();await flush();
    const calls=h.chrome.runtime.sendMessage.mock.calls.map(([message])=>message).filter(message=>message.type==='SYNC_NEW_ARTICLE');
    expect(calls.map(message=>message.xiaohongshuFormat)).toEqual(['article','image']);
    expect(calls.every(message=>message.article.title===initialSnapshot.title)).toBe(true);
    expect(h.chrome.runtime.sendMessage.mock.calls.some(([message])=>message.type==='PREVIEW_XIAOHONGSHU')).toBe(false);
  });

  it('关闭面板并修改正文后，仍同步请求发出时的内容和账号，重复成功事件不重复创建',async()=>{
    const h=contentHarness();h.api.injectPublishIntegration();await flush();h.api.select('wechat');h.emit('one');
    h.api.resetPublishSelection();h.setSnapshot({...initialSnapshot,title:'后续修改的标题'});h.emit('one',true);h.emit('one',true);await flush();
    const requests=h.chrome.runtime.sendMessage.mock.calls.map(([message])=>message).filter(message=>message.type==='SYNC_NEW_ARTICLE');
    expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({wechatAccountId:'account-a',article:{title:initialSnapshot.title,id:'456',sourceDraftId:'123'}});
    expect(h.api.state().pending).toBe(0);
  });
  it('焦点刷新未完成时，发布仍使用已确认的公众号身份',async()=>{
    const h=contentHarness();h.api.injectPublishIntegration();await flush();h.api.select('wechat');
    const pending=deferred<any>();h.chrome.runtime.sendMessage.mockImplementation((message:any)=>message.type.startsWith('CHECK_')?pending.promise:Promise.resolve({ok:true,task:{status:'saved'}}));
    const refreshing=h.api.refresh();h.emit('two');h.emit('two',true);await flush();
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({type:'SYNC_NEW_ARTICLE',wechatAccountId:'account-a'}));
    pending.resolve({ok:true,loggedIn:true,accountId:'account-b'});await refreshing;
  });
  it('旧面板较晚返回的检测结果不会清除新选择或覆盖新账号',async()=>{
    const h=contentHarness();const old=deferred<any>();h.chrome.runtime.sendMessage.mockImplementation(()=>old.promise);h.api.injectPublishIntegration();
    h.chrome.runtime.sendMessage.mockImplementation(async()=>({ok:true,loggedIn:true,accountId:'account-b'}));h.replacePanel();await flush();h.api.select('wechat');
    old.resolve({ok:true,loggedIn:false});await flush();
    expect(h.api.state().selected).toEqual(['wechat']);expect(h.api.state().auths.find((item:any)=>item.platform==='wechat').accountId).toBe('account-b');
  });
  it('失败响应释放快照但保留选择，重试成功后才创建任务',async()=>{
    const h=contentHarness();h.api.injectPublishIntegration();await flush();h.api.select('csdn');h.emit('failed');
    h.document.documentElement.setAttribute(attr,JSON.stringify({requestId:'failed'}));h.api.handleJuejinPublished();
    expect(h.api.state()).toMatchObject({pending:0,selected:['csdn']});
    expect(h.chrome.runtime.sendMessage.mock.calls.some(([message])=>message.type==='SYNC_NEW_ARTICLE')).toBe(false);
    h.emit('retry');h.emit('retry',true);await flush();
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({type:'SYNC_NEW_ARTICLE',platform:'csdn'}));
  });
  it('旧请求成功不会消费重新打开面板后的选择',async()=>{
    const h=contentHarness();h.api.injectPublishIntegration();await flush();h.api.select('csdn');h.emit('old');
    h.replacePanel();await flush();h.api.select('wechat');h.emit('old',true);await flush();
    expect(h.api.state().selected).toEqual(['wechat']);
  });
});

function pageHarness(){
  const document=baseDocument();const events:any[]=[];
  for(const type of ['article-ferry:publish-start','article-ferry:published'])document.addEventListener(type,()=>events.push({type,...JSON.parse(document.documentElement.getAttribute(attr)!)}));
  class Xhr extends EventTarget{response='';status=0;open(){}send(){} }
  const network=deferred<Response>();const fetch=vi.fn(()=>network.promise);
  const context:any={document,Event,Request,URL,URLSearchParams,location:{pathname:'/editor/drafts/123',origin:'https://juejin.cn'},window:{fetch},XMLHttpRequest:Xhr};
  runInNewContext(pageCode,context);
  return{context,network,events,Xhr};
}
describe('发布请求桥接',()=>{
  it('接口摘要缓存使用 brief_content，表单清空时不恢复旧摘要',async()=>{
    const h=pageHarness();
    const reading=h.context.window.fetch('https://api.juejin.cn/content_api/v1/article_draft/detail',{method:'POST'});
    h.network.resolve(new Response(JSON.stringify({err_no:0,data:{article_draft:{id:'123',brief_content:'缓存摘要'}}})));
    await reading;
    expect(h.context.readSnapshotForTest().summary).toBe('缓存摘要');
    h.context.document.querySelector.mockImplementation((selector:string)=>selector==='.panel .summary textarea'?{value:''}:null);
    expect(h.context.readSnapshotForTest().summary).toBe('');
  });
  it('发布面板清除封面后不恢复草稿缓存中的旧封面',async()=>{
    const h=pageHarness();
    const reading=h.context.window.fetch('https://api.juejin.cn/content_api/v1/article_draft/detail',{method:'POST'});
    h.network.resolve(new Response(JSON.stringify({err_no:0,data:{article_draft:{id:'123',cover_image:'https://example.com/old.png'}}})));
    await reading;
    expect(h.context.readSnapshotForTest().cover).toBe('https://example.com/old.png');
    h.context.document.querySelectorAll.mockImplementation((selector:string)=>selector==='.panel .form-item'?[{querySelector:()=>({textContent:'文章封面'})}]:[]);
    expect(h.context.readSnapshotForTest().cover).toBe('');
  });
  it('fetch 在网络完成前发送开始事件，业务成功后带同一请求身份发送结果',async()=>{
    const h=pageHarness();const response=h.context.window.fetch(publishUrl,{method:'POST',body:JSON.stringify({draft_id:'123'})});
    expect(h.events).toEqual([{type:'article-ferry:publish-start',requestId:'1'}]);
    h.network.resolve(new Response(JSON.stringify({err_no:0,data:{article_id:'456'}})));await response;
    expect(h.events[1]).toEqual({type:'article-ferry:published',requestId:'1',draftId:'123',articleId:'456'});
  });
  it('fetch 网络失败通知释放快照并保留原始异常',async()=>{
    const h=pageHarness();const response=h.context.window.fetch(publishUrl,{method:'POST',body:'{}'});h.network.reject(new Error('offline'));
    await expect(response).rejects.toThrow('offline');expect(h.events[1]).toEqual({type:'article-ferry:published',requestId:'1'});
  });
  it('XHR 失败及复用时分别完成对应请求，不残留旧事件监听器',()=>{
    const h=pageHarness();const xhr:any=new h.Xhr();xhr.open('POST',publishUrl);xhr.send(JSON.stringify({draft_id:'123'}));xhr.dispatchEvent(new Event('loadend'));
    xhr.open('POST',publishUrl);xhr.send(JSON.stringify({draft_id:'123'}));xhr.status=200;xhr.response=JSON.stringify({err_no:0,data:{article_id:'456'}});xhr.dispatchEvent(new Event('loadend'));
    expect(h.events).toHaveLength(4);expect(h.events[1]).toEqual({type:'article-ferry:published',requestId:'1'});expect(h.events[3]).toEqual({type:'article-ferry:published',requestId:'2',draftId:'123',articleId:'456'});
  });
});
