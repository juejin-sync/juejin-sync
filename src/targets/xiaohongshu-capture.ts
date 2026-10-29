// 小红书真实页面契约：解析 galaxy 用户信息与两类本地草稿保存记录。
import type {XiaohongshuFormat} from '../types';
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
export function parseXiaohongshuLocalDraft(value:unknown,format:XiaohongshuFormat='image'):XiaohongshuLocalDraft|undefined{
  if(format==='article'){
    const record=value as {draftId?:unknown;uid?:unknown;content?:{articleStore?:{articleTitle?:unknown;richJson?:unknown}}}|null;
    const article=record?.content?.articleStore;
    if(typeof record?.draftId!=='string'||!record.draftId||typeof record.uid!=='string'||!record.uid||typeof article?.articleTitle!=='string')return undefined;
    const text:string[]=[],images:string[]=[];
    function walk(node:any):boolean{
      if(!node||typeof node.type!=='string')return false;
      if(node.type==='text'){if(typeof node.text!=='string')return false;text.push(node.text);}
      if(node.type==='hardBreak')text.push('\n');
      if(node.type==='image'){
        if(!Array.isArray(node.attrs?.imgs)||!node.attrs.imgs.length)return false;
        for(const image of node.attrs.imgs){if(typeof image.src!=='string')return false;images.push(image.src);}
      }
      if(node.content!==undefined){if(!Array.isArray(node.content)||!node.content.every(walk))return false;}
      if(['paragraph','heading'].includes(node.type))text.push('\n');
      return true;
    }
    if(!walk(article.richJson))return undefined;
    return{draftId:record.draftId,accountId:record.uid,title:article.articleTitle,body:text.join(''),imageCount:images.length,imagesComplete:images.every(src=>/^https:\/\//.test(src))};
  }
  const record=value as {draftId?:unknown;uid?:unknown;content?:{draftStore?:{title?:unknown;desc?:unknown;imgList?:Array<{fileId?:unknown}>}}}|null;
  const note=record?.content?.draftStore;
  if(typeof record?.draftId!=='string'||!record.draftId||typeof record.uid!=='string'||!record.uid)return undefined;
  if(typeof note?.title!=='string'||typeof note.desc!=='string'||!Array.isArray(note.imgList))return undefined;
  return{draftId:record.draftId,accountId:record.uid,title:note.title,body:note.desc,imageCount:note.imgList.length,
    imagesComplete:note.imgList.length>0&&note.imgList.every(image=>typeof image?.fileId==='string'&&!!image.fileId)};
}
