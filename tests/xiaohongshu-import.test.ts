// 长文导入与偏好回归：不覆盖既有记录，只在事务完成及读回一致后确认成功。
import {describe,it,expect,vi,afterEach} from 'vitest';
import {buildArticleDraft,importArticleDraft,type ArticleImport} from '../src/targets/xiaohongshu-article-draft';
import {normalizeSettings} from '../src/core/settings';
import {xhsFormats} from '../src/core/xiaohongshu-mode';
const input:ArticleImport={draftId:'new-id',accountId:'account',title:'长文测试',body:'完整正文\n末尾结论',imageCount:0,richJson:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'完整正文'},{type:'hardBreak'},{type:'text',text:'末尾结论'}]}]}};
afterEach(()=>vi.unstubAllGlobals());
describe('小红书后台偏好',()=>{
  it('缺少设置或非法值默认双格式，合法值单独保留',()=>{
    for(const value of [{},{xiaohongshuMode:'invalid'}])expect(xhsFormats(normalizeSettings(value).xiaohongshuMode)).toEqual(['article','image']);
    expect(xhsFormats(normalizeSettings({xiaohongshuMode:'image'}).xiaohongshuMode)).toEqual(['image']);
    expect(xhsFormats(normalizeSettings({xiaohongshuMode:'article'}).xiaohongshuMode)).toEqual(['article']);
  });
});
describe('长文结构化导入',()=>{
  it('完整正文及末尾必须匹配，不能写入临时配图或错位图片',()=>{
    expect(buildArticleDraft(input)).toMatchObject({draftId:'new-id',uid:'account',content:{articleStore:{articleTitle:'长文测试',richJson:input.richJson}}});
    expect(()=>buildArticleDraft({...input,body:'少了末尾'})).toThrow('不完整');
    expect(()=>buildArticleDraft({...input,imageCount:1})).toThrow('不完整');
  });
  it('图片也计入长文字数，不能让正文未超限掩盖实际超限',()=>{
    const body='文'.repeat(9800);
    expect(()=>buildArticleDraft({...input,body,imageCount:1,richJson:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:body}]},{type:'image',attrs:{imgs:[{src:'https://ros-preview.xhscdn.com/image',width:410,height:1480}]}}]}})).toThrow('正文计数 9800 字，图片占用 400 字，合计 10200 字，超过10000字预算 200 字');
  });
  it('导入按实际 richJson 计数，段落边界和 hardBreak 不计入预算',()=>{
    const first='文'.repeat(5000),last='末'.repeat(5000),body=first+'\n'+last;
    for(const content of [
      [{type:'paragraph',content:[{type:'text',text:first}]},{type:'paragraph',content:[{type:'text',text:last}]}],
      [{type:'paragraph',content:[{type:'text',text:first},{type:'hardBreak'},{type:'text',text:last}]}]
    ])expect(()=>buildArticleDraft({...input,body,richJson:{type:'doc',content}})).not.toThrow();
  });
  it('真实文本节点中的空白必须计数，不能通过删掉正文换行逃过预算',()=>{
    const body='文'.repeat(10000)+'\n';
    expect(()=>buildArticleDraft({...input,body,richJson:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:body}]}]}})).toThrow('正文计数 10001 字');
  });
  it('缺少真实长文 store 时不写入、不升级并关闭数据库',async()=>{
    const transaction=vi.fn();const db={objectStoreNames:{contains:()=>false},close:vi.fn(),transaction};
    vi.stubGlobal('indexedDB',{open:()=>{const request:any={};queueMicrotask(()=>{request.result=db;request.onsuccess();});return request;}});
    await expect(importArticleDraft(input)).rejects.toThrow('结构已变化');
    expect(transaction).not.toHaveBeenCalled();expect(db.close).toHaveBeenCalled();
  });
  it.each(['complete','abort','mismatch'])('事务结果为 %s 时正确确认或拒绝；不调用 put 覆盖旧草稿',async(outcome)=>{
    let record:any;const add=vi.fn((value:any)=>{record=value;});let resolveWrite!:()=>void;
    const db={objectStoreNames:{contains:()=>true},close:vi.fn(),transaction:vi.fn((_store:string,mode:string)=>{
      const tx:any={objectStore:()=>({add,get:()=>{const req:any={};queueMicrotask(()=>{req.result=outcome==='mismatch'?{...record,uid:'other'}:record;req.onsuccess();tx.oncomplete();});return req;}})};
      if(mode==='readwrite')resolveWrite=()=>outcome==='abort'?tx.onabort():tx.oncomplete();return tx;
    })};
    vi.stubGlobal('indexedDB',{open:()=>{const request:any={};queueMicrotask(()=>{request.result=db;request.onsuccess();});return request;}});
    const pending=importArticleDraft(input);const checked=pending.then(value=>({value}),error=>({error}));
    await Promise.resolve();await Promise.resolve();expect(add).toHaveBeenCalledTimes(1);
    let settled=false;void checked.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);
    resolveWrite();const result=await checked;
    if(outcome==='complete')expect(result).toMatchObject({value:{ok:true,draftId:'new-id',accountId:'account'}});else expect(result).toHaveProperty('error');
    expect(db.close).toHaveBeenCalled();
  });
});
