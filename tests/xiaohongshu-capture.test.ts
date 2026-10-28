// 实测小红书契约回归：只接受 galaxy 用户信息和浏览器本地草稿记录。
import {describe,expect,it} from 'vitest';
import {parseXiaohongshuUser,parseXiaohongshuLocalDraft} from '../src/targets/xiaohongshu-capture';

describe('小红书已验证的数据契约',()=>{
  it('读取真实用户字段 userId/userName，业务失败不复用残留身份',()=>{
    const data={userId:'6512ab34cd56ef7890123456',userName:'测试作者'};
    expect(parseXiaohongshuUser({success:true,code:0,data})).toEqual({accountId:data.userId,account:data.userName});
    expect(parseXiaohongshuUser({success:false,code:-99,data})).toBeUndefined();
    expect(parseXiaohongshuUser({success:true,code:0,data:{userName:'无标识'}})).toBeUndefined();
    expect(parseXiaohongshuUser('<html>登录</html>')).toBeUndefined();
  });
  it('本地 draftId 独立于服务端 note_id，并核对图片的 fileId',()=>{
    const content={draftStore:{title:'标题',desc:'正文',imgList:[{fileId:'uploaded-image'}]}};
    expect(parseXiaohongshuLocalDraft({draftId:'local-uuid',uid:'account',content})).toEqual({draftId:'local-uuid',accountId:'account',title:'标题',body:'正文',imageCount:1,imagesComplete:true});
    expect(parseXiaohongshuLocalDraft({draftId:'local-uuid',uid:'account',content:{draftStore:{...content.draftStore,imgList:[{}]}}})?.imagesComplete).toBe(false);
    expect(parseXiaohongshuLocalDraft({success:true,data:{note_id:'published-note'}})).toBeUndefined();
    expect(parseXiaohongshuLocalDraft(null)).toBeUndefined();
  });
});
