// 验证真实构建产物可按浏览器普通脚本加载，并能建立知乎 Bridge 通信。
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {Script,runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';

describe('Content Script 构建产物',()=>{
  it.each([false,true])('普通脚本能解析且 Bridge PING 可响应（release=%s）',async release=>{
    execFileSync(process.execPath,['build.mjs',...(release?['--release']:[])],{stdio:'pipe'});
    const manifest=JSON.parse(readFileSync('dist/manifest.json','utf8'));
    for(const entry of manifest.content_scripts){
      for(const file of entry.js){
        expect(()=>new Script(readFileSync(`dist/${file}`,'utf8'),{filename:file})).not.toThrow();
      }
    }
    const addListener=vi.fn();
    runInNewContext(readFileSync('dist/zhihu-bridge.js','utf8'),{chrome:{runtime:{onMessage:{addListener}}}});
    expect(addListener).toHaveBeenCalledTimes(1);
    const listener=addListener.mock.calls[0][0];
    const response=await new Promise(resolve=>{
      expect(listener({target:'zhihu-bridge',action:'PING'},{},resolve)).toBe(true);
    });
    expect(response).toEqual({ok:true});

    const xhsAddListener=vi.fn();
    runInNewContext(readFileSync('dist/xiaohongshu-bridge.js','utf8'),{chrome:{runtime:{onMessage:{addListener:xhsAddListener}}}});
    expect(xhsAddListener).toHaveBeenCalledTimes(1);
    const xhsListener=xhsAddListener.mock.calls[0][0];
    const xhsResponse=await new Promise(resolve=>{
      expect(xhsListener({target:'xiaohongshu-bridge',action:'PING'},{},resolve)).toBe(true);
    });
    expect(xhsResponse).toEqual({ok:true});
  },30000);
});
