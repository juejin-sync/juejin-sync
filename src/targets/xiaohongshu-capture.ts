// 小红书创作服务平台响应解析：从页面自身请求中提取笔记标识、用户标识与笔记状态。
// 端点匹配规则集中在此处，平台改版时只需修正一份常量与对应单测。
export type XiaohongshuUser={accountId:string;account?:string};
export type XiaohongshuNoteSave={ok:boolean;noteId?:string;message?:string};
export type XiaohongshuNoteState='draft'|'published'|'missing'|'unauthorized'|'unknown';

const NOTE_ID_PATTERN=/^[0-9a-zA-Z]{16,32}$/;

export const XIAOHONGSHU_ENDPOINTS={
  save:[/\/web_api\/sns\/v2\/note(?:\?|$)/,/\/api\/galaxy\/(?:[^?]*\/)?note\/(?:create|update|save)(?:\?|$)/],
  user:[/\/api\/sns\/web\/v2\/user\/me(?:\?|$)/,/\/api\/galaxy\/user\/(?:info|self_info)(?:\?|$)/],
  note:[/\/web_api\/sns\/v2\/note\/detail(?:\?|$)/,/\/api\/galaxy\/(?:[^?]*\/)?note\/detail(?:\?|$)/]
} as const;

export type XiaohongshuEndpointKind=keyof typeof XIAOHONGSHU_ENDPOINTS;

export function matchXiaohongshuEndpoint(url:string,kind:XiaohongshuEndpointKind){
  return XIAOHONGSHU_ENDPOINTS[kind].some(pattern=>pattern.test(url));
}

function asRecord(value:unknown):Record<string,unknown>|undefined{
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}

function pickString(record:Record<string,unknown>|undefined,keys:string[]){
  if(!record)return undefined;
  for(const key of keys){
    const value=record[key];
    if(typeof value==='string'&&value.trim())return value.trim();
    if(typeof value==='number'&&Number.isFinite(value))return String(value);
  }
  return undefined;
}

/** 笔记 id 只接受平台形态的 16–32 位字母数字，避免把用户 id 误当笔记 id。 */
function findNoteId(payload:unknown){
  const root=asRecord(payload);
  if(!root)return undefined;
  const data=asRecord(root.data);
  const note=asRecord(data?.note)||asRecord(root.note)||asRecord(data?.note_info);
  const candidates=[data?.note_id,data?.noteId,data?.id,note?.note_id,note?.noteId,note?.id,root.note_id,root.noteId];
  for(const value of candidates){
    const id=String(value??'').trim();
    if(NOTE_ID_PATTERN.test(id))return id;
  }
  return undefined;
}

/** 解析保存笔记响应：明确失败与“成功但缺少标识”必须区分，后者交由上层按不确定处理。 */
export function parseXiaohongshuNoteSave(payload:unknown):XiaohongshuNoteSave{
  const root=asRecord(payload);
  if(!root)return{ok:false,message:'保存响应不是有效 JSON'};
  const code=root.code;
  const failed=root.success===false||(typeof code==='number'&&code!==0);
  const message=pickString(root,['msg','message','error']);
  const noteId=findNoteId(root);
  if(failed)return{ok:false,noteId,message:message||'小红书保存请求失败'};
  return{ok:true,noteId};
}

/** 解析用户信息响应：优先账号稳定标识，昵称仅用于展示。 */
export function parseXiaohongshuUser(payload:unknown):XiaohongshuUser|undefined{
  const root=asRecord(payload);
  if(!root)return undefined;
  const data=asRecord(root.data);
  const basic=asRecord(data?.basic_info)||asRecord(root.basic_info);
  const user=asRecord(data?.user)||asRecord(root.user);
  const accountId=pickString(data,['user_id','userId'])||pickString(user,['user_id','userId','id'])||pickString(root,['user_id','userId']);
  if(!accountId||!NOTE_ID_PATTERN.test(accountId))return undefined;
  const account=pickString(basic,['nickname','nick_name','name'])||pickString(data,['nickname','nick_name','name'])||pickString(user,['nickname','nick_name','name'])||pickString(root,['nickname','nick_name','name']);
  return{accountId,account};
}

/** 解析笔记详情状态：仅识别明确语义，其余交给上层保持 unknown 而不误判。 */
export function parseXiaohongshuNoteState(payload:unknown):XiaohongshuNoteState{
  const root=asRecord(payload);
  if(!root)return 'unknown';
  const data=asRecord(root.data)||{};
  const note=asRecord(data.note)||asRecord(root.note)||data;
  const raw=String(note.state??note.status??data.state??data.status??'').toLowerCase();
  if(raw==='published'||raw==='publish'||raw==='已发布')return 'published';
  if(raw==='draft'||raw==='editing'||raw==='草稿')return 'draft';
  if(raw==='deleted'||raw==='missing'||raw==='not_exist'||raw==='removed'||raw==='已删除')return 'missing';
  if(root.success===false||(typeof root.code==='number'&&root.code!==0))return 'missing';
  return 'unknown';
}

/** 从发布页 DOM 文案兜底判断笔记状态：只在出现明确的“不存在/已删除”时下结论，避免误判已发布而阻断更新。 */
export function detectNoteStateFromText(text:string):XiaohongshuNoteState{
  if(/笔记不存在|笔记已被删除|笔记已删除|内容已删除/.test(text))return 'missing';
  return 'unknown';
}
