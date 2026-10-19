// 发布后刷新掘金私有图片地址：按资源路径匹配，保留发布快照中的正文和元数据。
import type {Article} from '../types';
import {applyImageTransfers,collectExternalImages} from '../targets/csdn-api';

/** 仅接受掘金 CDN 的存储资源路径；包含模板路径，避免把不同裁剪版本混为一张图。 */
function imageKey(src:string,privateOnly=false):string|undefined{
  try{
    const url=new URL(src.replace(/&amp;/g,'&'));
    if(url.protocol!=='https:')return;
    const allowed=privateOnly
      ?url.hostname.endsWith('-private.juejin.cn')
      :/(^|\.)(juejin\.cn|byteimg\.com|bytecdn\.cn)$/.test(url.hostname);
    if(allowed&&/^\/tos-[^/]+\/[^/]+$/.test(url.pathname))return url.pathname;
  }catch{}
}

export function privateJuejinImages(article:Article):string[]{
  const images=collectExternalImages(article.markdown);
  if(article.cover)images.push(article.cover);
  return[...new Set(images)].filter(src=>imageKey(src,true)!==undefined);
}

/** 新草稿只提供图片的新地址，不替换用户点击发布时冻结的正文、摘要、标签或封面选择。 */
export function refreshJuejinImageUrls(article:Article,fresh:Article):Article{
  const candidates=collectExternalImages(fresh.markdown);
  if(fresh.cover)candidates.push(fresh.cover);
  const byPath=new Map<string,string>();
  for(const src of candidates){
    const key=imageKey(src);
    if(key)byPath.set(key,src.replace(/&amp;/g,'&'));
  }
  const transfers=privateJuejinImages(article).flatMap(src=>{
    const target=byPath.get(imageKey(src,true)!);
    return target&&target!==src?[{src,target}]:[];
  });
  if(!transfers.length)return article;
  const result=applyImageTransfers(article.markdown,article.cover,transfers);
  return{...article,markdown:result.markdown,cover:result.cover??article.cover};
}
