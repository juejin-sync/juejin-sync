// 主世界长文服务：复用站点签名上传图片、导入新草稿；不调用笔记发布接口。
import {parseXiaohongshuUser} from './targets/xiaohongshu-capture';
import {importArticleDraft,type ArticleImport} from './targets/xiaohongshu-article-draft';
const REQUEST='article-ferry:xhs-article-request',RESPONSE='article-ferry:xhs-article-response';
const ATTR='data-article-ferry-xhs-article';
async function process(command:any){
  if(location.origin!=='https://creator.xiaohongshu.com')throw new Error('小红书页面来源不匹配');
  const response=await fetch('/api/galaxy/user/info',{credentials:'include'});
  const user=parseXiaohongshuUser(await response.json());
  if(!user||user.accountId!==command.payload.accountId)throw new Error('小红书账号已变化，已停止写入');
  if(command.action==='import')return importArticleDraft(command.payload as ArticleImport);
  if(command.action!=='upload')throw new Error('不支持的长文操作');
  const path='/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web';
  const signer=(window as any)._webmsxyw;
  if(typeof signer!=='function')throw new Error('小红书图片上传环境未就绪');
  const signed=signer(path),headers:Record<string,string>={};
  for(const name of ['X-s','X-t','X-s-common'])if(typeof signed?.[name]==='string')headers[name]=signed[name];
  const permitResponse=await fetch(path,{headers,credentials:'include'});
  const permit=await permitResponse.json();
  const target=permit?.data?.uploadTempPermits?.find((item:any)=>item.uploadAddr==='ros-upload.xiaohongshu.com');
  const fileId=target?.fileIds?.[0];
  if(!permit.success||!fileId||typeof target.token!=='string')throw new Error('小红书图片上传许可不可用');
  const bytes=Uint8Array.from(atob(command.payload.base64),(char:string)=>char.charCodeAt(0));
  const uploaded=await fetch(`https://ros-upload.xiaohongshu.com/${fileId}`,{method:'PUT',headers:{Authorization:target.token,'Content-Type':command.payload.mime,'x-cos-security-token':target.token},body:new Blob([bytes],{type:command.payload.mime})});
  if(!uploaded.ok)throw new Error(`小红书图片上传失败（${uploaded.status}）`);
  const src=uploaded.headers.get('x-ros-preview-url');
  if(!src||!/^https:\/\//.test(src))throw new Error('小红书未返回可用图片地址');
  return{ok:true,src};
}
document.addEventListener(REQUEST,()=>{
  const root=document.documentElement,raw=root.getAttribute(ATTR);root.removeAttribute(ATTR);
  if(!raw)return;
  let command:any;try{command=JSON.parse(raw);}catch{return;}
  if(typeof command.requestId!=='string')return;
  const reply=(result:unknown)=>{root.setAttribute(ATTR,JSON.stringify({requestId:command.requestId,...result as object}));document.dispatchEvent(new Event(RESPONSE));root.removeAttribute(ATTR);};
  process(command).then(reply).catch(error=>reply({ok:false,message:error instanceof Error?error.message:'长文导入失败'}));
});
