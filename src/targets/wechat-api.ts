// 微信公众号 Web 端适配器：复用当前浏览器登录态，转存图片、裁剪封面并创建草稿。
import type {Article,TaskProgress,WechatCodeTheme} from '../types';
import {mapConcurrent,retry} from '../core/async';
import {SyncError} from '../core/diagnostic';
import {downloadImageBlob,extractSummary,imageExtension,stripJuejinImageParams} from './csdn-api';
import {collectWechatImageUrls,compileWechatHtml,replaceWechatImageUrls} from './wechat-content';
import {renderAllMermaidBlocks} from '../core/mermaid-render';

const HOME='https://mp.weixin.qq.com/';
type WechatMeta={token:string;ticket:string;userName:string;nickName:string;svrTime:number};
type UploadedImage={url:string;fileId:number;width?:number;height?:number};
type CropConfig={ratio:'16_9'|'1_1'|'3_4';x1:number;y1:number;x2:number;y2:number;x1Abs:number;y1Abs:number;x2Abs:number;y2Abs:number};

function field(html:string,pattern:RegExp){return html.match(pattern)?.[1]||'';}
export function parseWechatMeta(html:string):WechatMeta|undefined{
  const token=field(html,/(?:\bt|token)\s*:\s*["'](\d+)["']/);
  if(!token)return undefined;
  return{token,ticket:field(html,/ticket\s*:\s*["']([^"']+)["']/),userName:field(html,/user_name\s*:\s*["']([^"']+)["']/),nickName:field(html,/nick_name\s*:\s*["']([^"']*)["']/),svrTime:Number(field(html,/time\s*:\s*["']?(\d+)["']?/))||Math.floor(Date.now()/1000)};
}

export async function checkWechatAuth(){
  try{
    const response=await fetch(HOME,{credentials:'include',signal:AbortSignal.timeout(8000)});
    if(!response.ok)return{ok:false,loggedIn:false,message:`微信公众平台访问异常 (${response.status})`};
    const meta=parseWechatMeta(await response.text());
    return meta?{ok:true,loggedIn:true,account:meta.nickName,meta}:{ok:true,loggedIn:false};
  }catch(error){return{ok:false,loggedIn:false,message:(error as Error).message||'微信公众平台登录检测失败'};}
}

async function requireMeta(expectedAccountId?:string){
  const auth=await checkWechatAuth();
  if(!auth.ok)throw new SyncError(auth.message||'微信公众平台登录检测失败','network','authentication');
  if(!auth.loggedIn||!auth.meta)throw new SyncError('请先登录微信公众平台','login','authentication');
  if(!auth.meta.ticket||!auth.meta.userName)throw new SyncError('微信公众平台登录信息不完整，请刷新后台后重试','platform-change','authentication');
  if(expectedAccountId&&auth.meta.userName!==expectedAccountId)throw new SyncError('当前公众号与任务绑定账号不同，请切回原公众号后重试','blocked','authentication');
  return auth.meta;
}

/** 对外只提供稳定账号标识，票据留在后台适配器中。 */
export async function requireWechatAccount(expectedAccountId?:string){return(await requireMeta(expectedAccountId)).userName;}

async function downloadImage(src:string){
  return downloadImageBlob(src);
}

async function uploadImage(src:string,meta:WechatMeta):Promise<UploadedImage>{
  const blob=await downloadImage(src);
  const extension=imageExtension(src,blob);
  const form=new FormData();
  const now=Date.now();
  form.append('type',blob.type);form.append('id',String(now));form.append('name',`${now}.${extension}`);form.append('lastModifiedDate',new Date(now).toString());form.append('size',String(blob.size));form.append('file',blob,`${now}.${extension}`);
  const url=new URL(`${HOME}cgi-bin/filetransfer`);
  Object.entries({action:'upload_material',f:'json',scene:'8',writetype:'doublewrite',groupid:'1',ticket_id:meta.userName,ticket:meta.ticket,svr_time:String(meta.svrTime),token:meta.token,lang:'zh_CN',seq:String(now),t:String(Math.random())}).forEach(([key,value])=>url.searchParams.set(key,value));
  const response=await fetch(url,{method:'POST',credentials:'include',body:form});
  if(!response.ok)throw new SyncError(`上传图片到微信失败 (${response.status})`,response.status===429?'rate-limit':'network','images');
  const result=await response.json() as {base_resp?:{err_msg?:string;ret?:number};cdn_url?:string;content?:string};
  if(result.base_resp?.err_msg!=='ok'||!result.cdn_url)throw new SyncError(`微信图片上传失败：${result.base_resp?.err_msg||result.base_resp?.ret||'返回格式异常'}`,'platform-change','images');
  return{url:result.cdn_url,fileId:Number(result.content)||0};
}

export function calculateCoverCrop(ratio:CropConfig['ratio'],width:number,height:number):CropConfig{
  const value=ratio==='16_9'?16/9:ratio==='1_1'?1:3/4;
  let x1=0,y1=0,x2=1,y2=1;
  if(width/height>value){const pad=(width-height*value)/2/width;x1=pad;x2=1-pad;}else{const pad=(height-width/value)/2/height;y1=pad;y2=1-pad;}
  return{ratio,x1,y1,x2,y2,x1Abs:Math.round(x1*width),y1Abs:Math.round(y1*height),x2Abs:Math.round(x2*width),y2Abs:Math.round(y2*height)};
}

async function imageDimensions(blob:Blob){
  const bitmap=await createImageBitmap(blob);
  const result={width:bitmap.width,height:bitmap.height};bitmap.close();return result;
}

async function uploadCover(src:string,meta:WechatMeta){
  const blob=await downloadImage(src);
  const dimensions=await imageDimensions(blob);
  const uploaded=await uploadImage(src,meta);
  const configs=(['16_9','1_1','3_4'] as const).map(ratio=>calculateCoverCrop(ratio,dimensions.width,dimensions.height));
  const form=new FormData();form.append('imgurl',uploaded.url);form.append('size_count',String(configs.length));
  configs.forEach((config,index)=>{form.append(`size${index}_x1`,String(config.x1));form.append(`size${index}_y1`,String(config.y1));form.append(`size${index}_x2`,String(config.x2));form.append(`size${index}_y2`,String(config.y2));});
  form.append('token',meta.token);form.append('lang','zh_CN');form.append('f','json');form.append('ajax','1');
  const response=await fetch(`${HOME}cgi-bin/cropimage?action=crop_multi`,{method:'POST',credentials:'include',body:form});
  const result=await response.json() as {base_resp?:{err_msg?:string};result?:Array<{cdnurl:string;file_id:number;width:number;height:number}>};
  if(!response.ok||result.base_resp?.err_msg!=='ok'||result.result?.length!==configs.length)throw new SyncError(`微信封面裁剪失败：${result.base_resp?.err_msg||response.status}`,'platform-change','images');
  return result.result.map((item,index)=>({...item,config:configs[index]}));
}

export function buildWechatDraftForm(article:Article,content:string,meta:WechatMeta,covers:Awaited<ReturnType<typeof uploadCover>>,appMsgId?:string){
  const form=new URLSearchParams();
  const base:Record<string,string>={token:meta.token,lang:'zh_CN',f:'json',ajax:'1',random:String(Math.random()),AppMsgId:appMsgId||'',count:'1',data_seq:'0',operate_from:'Chrome',isnew:'0',ad_video_transition0:'',can_reward0:'0',related_video0:'',is_video_recommend0:'-1',title0:article.title,author0:'',writerid0:'0',fileid0:'',digest0:article.summary?.trim().slice(0,120)||extractSummary(article.markdown,120),auto_gen_digest0:article.summary?.trim()?'0':'1',content0:content,sourceurl0:'',need_open_comment0:'1',only_fans_can_comment0:'0'};
  const byRatio=new Map(covers.map(item=>[item.config.ratio,item]));
  const fallback=byRatio.get('16_9')||byRatio.get('1_1');
  Object.assign(base,{cdn_url0:fallback?.cdnurl||'',cdn_235_1_url0:fallback?.cdnurl||'',cdn_16_9_url0:byRatio.get('16_9')?.cdnurl||'',cdn_3_4_url0:byRatio.get('3_4')?.cdnurl||'',cdn_1_1_url0:byRatio.get('1_1')?.cdnurl||'',cdn_url_back0:byRatio.get('1_1')?.cdnurl||''});
  const crop_list=covers.map(item=>({ratio:item.config.ratio,x1:item.config.x1Abs,y1:item.config.y1Abs,x2:item.config.x2Abs,y2:item.config.y2Abs,file_id:item.file_id}));
  const crop_list_percent=covers.map(item=>({ratio:item.config.ratio,x1:item.config.x1,y1:item.config.y1,x2:item.config.x2,y2:item.config.y2,file_id:item.file_id}));
  Object.assign(base,{crop_list0:JSON.stringify({crop_list,crop_list_percent}),music_id0:'',video_id0:'',voteid0:'',voteismlt0:'',supervoteid0:'',cardid0:'',cardquantity0:'',cardlimit0:'',vid_type0:'',show_cover_pic0:'0',shortvideofileid0:'',copyright_type0:'0',releasefirst0:'',platform0:'',reprint_permit_type0:'',allow_reprint0:'',allow_reprint_modify0:'',original_article_type0:'',ori_white_list0:'',free_content0:'',fee0:'0',ad_id0:'',guide_words0:'',is_share_copyright0:'0',share_copyright_url0:'',source_article_type0:'',reprint_recommend_title0:'',reprint_recommend_content0:'',share_page_type0:'0',share_imageinfo0:'{"list":[]}',share_video_id0:'',dot0:'{}',share_voice_id0:'',insert_ad_mode0:'',categories_list0:'[]',sections0:'[]',compose_info0:'{"list":[]}'});
  Object.entries(base).forEach(([key,value])=>form.set(key,value));return form;
}

type SaveOptions={appMsgId?:string;accountId?:string;theme?:WechatCodeTheme;onPreparing?:()=>void;onProgress?:(progress:TaskProgress)=>void|Promise<void>;onSaving?:()=>void|Promise<void>};
export async function saveWechatDraft(article:Article,options:SaveOptions={}){
  if(article.title.trim().length<1||article.title.trim().length>64)throw new SyncError('微信公众号标题需为 1～64 个字符','content','validation');
  if(article.markdown.trim().length<20)throw new SyncError('文章正文不完整，暂无法同步到微信公众号','content','validation');
  if(options.appMsgId&&!options.accountId)throw new SyncError('旧微信草稿未绑定公众号，无法安全更新，请先核对旧草稿记录','blocked','authentication');
  const meta=await requireMeta(options.accountId);
  options.onPreparing?.();
  let html:string;
  try{
    const mermaidImages=await renderAllMermaidBlocks(article.markdown);
    html=compileWechatHtml(article.markdown,{mermaidImages,theme:options.theme});
  }catch(error){
    throw new SyncError(`微信文章排版编译失败：${(error as Error).message}`,'content','content');
  }
  const sources=collectWechatImageUrls(html).filter(src=>{
    if(src.startsWith('data:image/'))return true;
    try{const url=new URL(src);if(!['http:','https:'].includes(url.protocol))throw new Error();return !/(?:^|\.)mmbiz\.qpic\.cn$/i.test(url.hostname);}
    catch{throw new SyncError('正文包含无法转存的图片地址，请使用完整 HTTP(S) 图片地址','content','images');}
  });
  const imageTotal=sources.length+(article.cover?1:0);
  const replacements=new Map<string,string>();
  const uploaded=await mapConcurrent(sources,2,async(src,index)=>{
    await options.onProgress?.({current:index,total:imageTotal,message:`正在转存正文图片 ${index+1}/${sources.length}`});
    const image=await retry(()=>uploadImage(src,meta),2,400);replacements.set(src,image.url);return image;
  });
  html=replaceWechatImageUrls(html,replacements);
  if(article.cover)await options.onProgress?.({current:sources.length,total:imageTotal,message:'正在上传并裁剪封面'});
  const covers=article.cover?await retry(()=>uploadCover(article.cover!,meta),2,400):[];
  // 图片处理期间可能切换公众号；最终写入前再次核验，并使用新鲜凭据。
  const writeMeta=await requireMeta(meta.userName);
  await options.onSaving?.();
  const isEdit=!!options.appMsgId;
  const url=new URL(`${HOME}cgi-bin/operate_appmsg`);
  Object.entries({t:'ajax-response',sub:isEdit?'edit':'create',type:'77',token:writeMeta.token,lang:'zh_CN'}).forEach(([key,value])=>url.searchParams.set(key,value));
  let response:Response;
  let result:{appMsgId?:string|number;base_resp?:{err_msg?:string;ret?:number};errmsg?:string};
  try{
    response=await fetch(url,{method:'POST',credentials:'include',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8'},body:buildWechatDraftForm(article,html,writeMeta,covers,options.appMsgId)});
    result=await response.json();
    if(!result||typeof result!=='object'||response.status>=500)throw new Error();
  }catch{
    throw new SyncError('无法确认微信草稿是否已保存，请先检查公众号草稿箱，不要直接重复同步','interrupted','draft');
  }
  // 微信特定错误响应精细化识别
  if(result.base_resp?.ret===200003||result.base_resp?.ret===-6){
    throw new SyncError(`微信公众平台登录已过期 (错误码 ${result.base_resp.ret})，请重新登录公众号后台后重试`,'login','authentication');
  }
  if(result.base_resp?.ret===200013){
    throw new SyncError('微信公众平台请求过于频繁 (错误码 200013)，请稍后重试','rate-limit','draft');
  }
  // 更新失败绝不隐式转为新建；不认识的响应也不能借旧 ID 冒充保存成功。
  if(response.ok&&result.base_resp?.ret===undefined&&!result.appMsgId)throw new SyncError('微信保存响应缺少结果，无法确认是否已保存，请先检查草稿箱','interrupted','draft');
  const finalAppMsgId=result.appMsgId||options.appMsgId;
  if(response.ok&&result.base_resp?.ret===0&&!finalAppMsgId)throw new SyncError('微信返回成功但缺少草稿标识，请先检查草稿箱确认保存结果','interrupted','draft');
  if(!response.ok||!finalAppMsgId||(result.base_resp?.ret!==undefined&&result.base_resp.ret!==0)){
    const errorDetail=result.base_resp?.err_msg||(result.base_resp?.ret!==undefined?`错误码 (${result.base_resp.ret})`:'')||result.errmsg||(response.ok?'操作未成功':String(response.status));
    throw new SyncError(`保存微信草稿失败：${errorDetail}`,'platform-change','draft');
  }
  const draftUrl=`${HOME}cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${finalAppMsgId}&token=${writeMeta.token}&lang=zh_CN`;
  return{draftUrl,articleId:String(finalAppMsgId),warnings:[] as string[],stats:{imageTotal,imageSucceeded:uploaded.length+(article.cover?1:0),imageFailed:0}};
}
