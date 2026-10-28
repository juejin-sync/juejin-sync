// 小红书响应解析回归测试：端点匹配、保存结果、账号标识与笔记状态。
import {describe,expect,it} from 'vitest';
import {
  detectNoteStateFromText,
  matchXiaohongshuEndpoint,
  parseXiaohongshuNoteSave,
  parseXiaohongshuNoteState,
  parseXiaohongshuUser
} from '../src/targets/xiaohongshu-capture';

const NOTE_ID='6512ab34cd56ef7890123456';

describe('小红书端点匹配',()=>{
  it('识别保存、用户与笔记详情端点',()=>{
    expect(matchXiaohongshuEndpoint('https://edith.xiaohongshu.com/web_api/sns/v2/note', 'save')).toBe(true);
    expect(matchXiaohongshuEndpoint('https://creator.xiaohongshu.com/api/galaxy/note/create', 'save')).toBe(true);
    expect(matchXiaohongshuEndpoint('https://creator.xiaohongshu.com/api/galaxy/user/info', 'user')).toBe(true);
    expect(matchXiaohongshuEndpoint('https://creator.xiaohongshu.com/web_api/sns/v2/note/detail?id=1', 'note')).toBe(true);
  });

  it('不把笔记详情或图片接口误判为保存请求',()=>{
    expect(matchXiaohongshuEndpoint('https://edith.xiaohongshu.com/web_api/sns/v2/note/detail', 'save')).toBe(false);
    expect(matchXiaohongshuEndpoint('https://creator.xiaohongshu.com/api/galaxy/note/list', 'save')).toBe(false);
    expect(matchXiaohongshuEndpoint('https://creator.xiaohongshu.com/api/galaxy/upload/file', 'note')).toBe(false);
  });
});

describe('小红书保存响应解析',()=>{
  it('data.note_id 形式返回笔记标识',()=>{
    expect(parseXiaohongshuNoteSave({success:true,data:{note_id:NOTE_ID}})).toEqual({ok:true,noteId:NOTE_ID});
  });

  it('data.id 形式在符合 id 形态时返回标识',()=>{
    expect(parseXiaohongshuNoteSave({code:0,data:{id:NOTE_ID}})).toEqual({ok:true,noteId:NOTE_ID});
  });

  it('成功但缺少标识时不伪造 id，交由上层按不确定处理',()=>{
    expect(parseXiaohongshuNoteSave({success:true,data:{}})).toEqual({ok:true,noteId:undefined});
  });

  it('业务失败返回错误信息',()=>{
    expect(parseXiaohongshuNoteSave({code:-1,msg:'图片上传失败'})).toMatchObject({ok:false,message:'图片上传失败'});
    expect(parseXiaohongshuNoteSave({success:false})).toMatchObject({ok:false});
  });

  it('非对象响应视为失败',()=>{
    expect(parseXiaohongshuNoteSave('<html>')).toMatchObject({ok:false});
    expect(parseXiaohongshuNoteSave(undefined)).toMatchObject({ok:false});
  });

  it('不会把用户 id 等其他字段误当笔记 id',()=>{
    expect(parseXiaohongshuNoteSave({success:true,data:{user_id:'user_123',note:{title:'标题'}}})).toEqual({ok:true,noteId:undefined});
  });
});

describe('小红书用户响应解析',()=>{
  it('galaxy user info 形式返回账号标识与昵称',()=>{
    expect(parseXiaohongshuUser({data:{user_id:NOTE_ID,basic_info:{nickname:'掘金作者'}}})).toEqual({accountId:NOTE_ID,account:'掘金作者'});
  });

  it('user 嵌套形式同样可用',()=>{
    expect(parseXiaohongshuUser({data:{user:{user_id:NOTE_ID,nickname:'作者'}}})).toEqual({accountId:NOTE_ID,account:'作者'});
  });

  it('缺少账号标识时返回 undefined',()=>{
    expect(parseXiaohongshuUser({data:{basic_info:{nickname:'作者'}}})).toBeUndefined();
    expect(parseXiaohongshuUser('登录页')).toBeUndefined();
  });
});

describe('小红书笔记状态解析',()=>{
  it('识别已发布、草稿与已删除',()=>{
    expect(parseXiaohongshuNoteState({data:{note:{state:'published'}}})).toBe('published');
    expect(parseXiaohongshuNoteState({data:{note:{status:'draft'}}})).toBe('draft');
    expect(parseXiaohongshuNoteState({data:{state:'deleted'}})).toBe('missing');
  });

  it('业务错误码视为笔记不存在',()=>{
    expect(parseXiaohongshuNoteState({code:-1,msg:'笔记不存在'})).toBe('missing');
  });

  it('无法判断时保持 unknown，避免误判覆盖',()=>{
    expect(parseXiaohongshuNoteState({data:{note:{}}}),).toBe('unknown');
    expect(parseXiaohongshuNoteState(null)).toBe('unknown');
  });

  it('DOM 文案兜底只在明确不存在时下结论',()=>{
    expect(detectNoteStateFromText('该笔记已被删除')).toBe('missing');
    expect(detectNoteStateFromText('已发布')).toBe('unknown');
    expect(detectNoteStateFromText('编辑笔记')).toBe('unknown');
  });
});
