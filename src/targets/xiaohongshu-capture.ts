// 小红书真实页面契约：解析 galaxy 用户信息与 image-draft 本地保存记录。
export type XiaohongshuUser={accountId:string;account?:string};
export type XiaohongshuLocalDraft={draftId:string;accountId:string;title:string;body:string;imageCount:number;imagesComplete:boolean};

export function normalizeXiaohongshuText(text:string){return text.replace(/\s+/g,' ').trim();}

/** 只接收已实测的 galaxy/user/info 返回格式，不把业务错误里的残留账号当成登录成功。 */
export function parseXiaohongshuUser(payload:unknown):XiaohongshuUser|undefined{
  const root=payload as {success?:boolean;code?:number;data?:{userId?:unknown;userName?:unknown}}|null;
  if(root?.success!==true||root.code!==0)return undefined;
  const user=root.data;
  if(typeof user?.userId!=='string'||!user.userId.trim())return undefined;
  return{accountId:user.userId.trim(),account:typeof user.userName==='string'?user.userName:undefined};
}

/** 仅提取保存凭证，图片二进制、完整编辑器状态和其他平台数据不经过扩展桥接。 */
export function parseXiaohongshuLocalDraft(value:unknown):XiaohongshuLocalDraft|undefined{
  const record=value as {draftId?:unknown;uid?:unknown;content?:{draftStore?:{title?:unknown;desc?:unknown;imgList?:Array<{fileId?:unknown}>}}}|null;
  const note=record?.content?.draftStore;
  if(typeof record?.draftId!=='string'||!record.draftId||typeof record.uid!=='string'||!record.uid)return undefined;
  if(typeof note?.title!=='string'||typeof note.desc!=='string'||!Array.isArray(note.imgList))return undefined;
  return{draftId:record.draftId,accountId:record.uid,title:note.title,body:note.desc,imageCount:note.imgList.length,
    imagesComplete:note.imgList.length>0&&note.imgList.every(image=>typeof image?.fileId==='string'&&!!image.fileId)};
}
