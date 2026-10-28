// 通过运行实际 Bridge 脚本验证图文上传选择器、按钮边界与跨世界保存握手。
import {buildSync} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {afterEach,describe,expect,it,vi} from 'vitest';

const code=buildSync({entryPoints:['src/xiaohongshu-bridge.ts'],bundle:true,write:false,format:'iife'}).outputFiles[0].text;
const commandEvent='article-ferry:xhs-command';
const responseEvent='article-ferry:xhs-response';
const commandAttr='data-article-ferry-xhs-command';
const responseAttr='data-article-ferry-xhs';
const ackAttr='data-article-ferry-xhs-ack';
function element(text=''){
  return {textContent:text,disabled:false,click:vi.fn(),closest:()=>null,
    getBoundingClientRect:()=>({width:100,height:40,right:100,bottom:100})};
}
function setup(){
  vi.useFakeTimers();
  const attributes=new Map<string,string>();
  const root={getAttribute:(key:string)=>attributes.get(key),setAttribute:(key:string,value:string)=>attributes.set(key,value),removeAttribute:(key:string)=>attributes.delete(key)};
  const selectors=new Map<string,any[]>();
  const document=Object.assign(new EventTarget(),{documentElement:root,
    querySelector:(selector:string)=>selectors.get(selector)?.[0]||null,
    querySelectorAll:(selector:string)=>selectors.get(selector)||[]});
  let listener:any;
  class Transfer{
    files:any[]=[];
    items={add:(file:File)=>this.files.push(file)};
  }
  runInNewContext(code,{document,Event,File,Uint8Array,atob,DataTransfer:Transfer,crypto:{randomUUID:()=> 'save-op'},Date,setTimeout,clearTimeout,
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    chrome:{runtime:{onMessage:{addListener:(value:any)=>{listener=value;}}}}});
  const send=(action:string,payload?:unknown)=>new Promise<any>(resolve=>listener({target:'xiaohongshu-bridge',action,payload},{},resolve));
  const button=element('暂存离开');
  selectors.set('button',[button]);
  const commands:any[]=[];
  document.addEventListener(commandEvent,()=>{commands.push(JSON.parse(root.getAttribute(commandAttr)!));});
  const acknowledge=()=>document.addEventListener(commandEvent,()=>{
    const value=JSON.parse(root.getAttribute(commandAttr)!);
    if(!value.cancel)root.setAttribute(ackAttr,value.requestId);
  });
  const respond=(value:unknown)=>{root.setAttribute(responseAttr,JSON.stringify(value));document.dispatchEvent(new Event(responseEvent));root.removeAttribute(responseAttr);};
  return{send,selectors,root,button,commands,acknowledge,respond};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
const savePayload={accountId:'account-a',title:'标题',body:'正文',imageCount:1};

describe('小红书隔离世界驱动',()=>{
  it('观测器未确认武装时不点击按钮，并清理请求',async()=>{
    const env=setup();
    await expect(env.send('SAVE_NOTE',savePayload)).resolves.toMatchObject({ok:false,message:expect.stringContaining('未就绪')});
    expect(env.button.click).not.toHaveBeenCalled();
    expect(env.commands.at(-1)).toEqual({requestId:'save-op',cancel:true});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('仅点击可见且精确匹配的暂存按钮，忽略发布和隐藏诱导按钮',async()=>{
    const env=setup();env.acknowledge();
    const publish=element('发布');const combined=element('暂存离开并发布');const hidden=element('暂存离开');hidden.closest=()=>({}) as any;
    env.selectors.set('button',[publish,combined,hidden,env.button]);
    const pending=env.send('SAVE_NOTE',savePayload);
    env.respond({requestId:'other',ok:true,draftId:'wrong'});
    env.respond({requestId:'save-op',ok:true,draftId:'local',accountId:'account-a'});
    await expect(pending).resolves.toMatchObject({ok:true,draftId:'local'});
    expect(env.button.click).toHaveBeenCalledTimes(1);
    for(const button of [publish,combined,hidden])expect(button.click).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('等待按钮就绪后才武装，结果超时后取消并清理监听',async()=>{
    const env=setup();env.acknowledge();env.button.disabled=true;
    const pending=env.send('SAVE_NOTE',savePayload);
    await vi.advanceTimersByTimeAsync(400);
    expect(env.commands).toEqual([]);
    env.button.disabled=false;
    await vi.advanceTimersByTimeAsync(200);
    expect(env.button.click).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45000);
    await expect(pending).resolves.toMatchObject({ok:false,message:expect.stringContaining('超时')});
    expect(env.commands.at(-1)).toEqual({requestId:'save-op',cancel:true});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('首次上传与追加图片使用不同入口，等待上传遮罩消失后才完成',async()=>{
    const env=setup();
    const first=Object.assign(new EventTarget(),{files:[] as any[]});
    const next=Object.assign(new EventTarget(),{files:[] as any[]});
    const firstSelector='input.upload-input[type="file"][multiple][accept*=".jpg"]';
    const nextSelector='.img-list input[type="file"][multiple]';
    env.selectors.set(firstSelector,[first]);
    env.selectors.set('.ProseMirror[contenteditable="true"]',[element()]);
    let uploading=true;
    const thumbnail={querySelector:(selector:string)=>selector==='.mask.failed'?null:uploading?{}:null};
    env.selectors.set('.img-preview-area .img-container',[thumbnail]);
    const payload={base64:'AA==',mime:'image/png',name:'logo.png',imageCount:1};
    let complete=false;
    const pending=env.send('UPLOAD_IMAGE',payload).then(result=>{complete=true;return result;});
    await vi.advanceTimersByTimeAsync(300);
    expect(complete).toBe(false);expect(first.files).toHaveLength(1);
    uploading=false;
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({ok:true});
    env.selectors.delete(firstSelector);env.selectors.set(nextSelector,[next]);
    env.selectors.set('.img-preview-area .img-container',[thumbnail,thumbnail]);
    await expect(env.send('UPLOAD_IMAGE',{...payload,imageCount:2})).resolves.toEqual({ok:true});
    expect(next.files).toHaveLength(1);expect(first.files).toHaveLength(1);
  });

  it('上传失败遮罩出现后立即停止',async()=>{
    const env=setup();
    env.selectors.set('.img-list input[type="file"][multiple]',[new EventTarget()]);
    env.selectors.set('.img-preview-area .img-container',[{querySelector:()=>({})}]);
    await expect(env.send('UPLOAD_IMAGE',{base64:'AA==',mime:'image/png',name:'logo.png',imageCount:1})).resolves.toMatchObject({ok:false,message:expect.stringContaining('上传失败')});
  });
});
