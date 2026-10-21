// 掘金创作者 API：从已发布文章映射到草稿，并读取原始 Markdown。
import type {Article} from '../types';
import {SyncError} from '../core/diagnostic';

const API_BASE='https://api.juejin.cn/content_api/v1';

type ApiResponse<T>={err_no:number;err_msg:string;data:T};
type ArticleListItem={article_info?:{article_id?:string;draft_id?:string;title?:string;brief_content?:string;cover_image?:string};tags?:{tag_name?:string}[]};
type DraftDetail={article_draft?:{id?:string;title?:string;mark_content?:string;brief_content?:string;cover_image?:string;tags?:{tag_name?:string}[]}};

export type JuejinArticleCache=Map<string,ArticleListItem>;

export function createJuejinArticleCache():JuejinArticleCache{
  return new Map<string,ArticleListItem>();
}

export function cacheJuejinArticleItem(item:ArticleListItem,cache?:JuejinArticleCache){
  const id=String(item.article_info?.article_id||'');
  if(id&&cache)cache.set(id,item);
}

async function post<T>(path:string,body:unknown,uuid:string):Promise<T>{
  if(!uuid)throw new SyncError('无法读取掘金请求标识，请刷新文章列表后重试','platform-change','content');
  const query=new URLSearchParams({aid:'2608',uuid,spider:'0'});
  const response=await fetch(`${API_BASE}${path}?${query}`,{
    method:'POST',
    credentials:'include',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  if(!response.ok){
    const status=response.status;
    throw new SyncError(`掘金 API 请求失败 (${status})`,status===429?'rate-limit':status>=500?'network':'platform-change','content');
  }
  const result=await response.json() as ApiResponse<T>;
  if(result.err_no!==0)throw new SyncError(result.err_msg||'掘金返回错误','platform-change','content');
  return result.data;
}

/** 读取草稿正文；掘金公开前台接口只含渲染后 HTML，原始 Markdown 必须走创作者草稿详情。 */
async function fetchDraftContent(draftId:string,uuid:string){
  const detail=await post<DraftDetail>('/article_draft/detail',{draft_id:draftId},uuid);
  const draft=detail.article_draft;
  const markdown=draft?.mark_content?.trim()||'';
  if(markdown.length<20)throw new SyncError('掘金草稿正文为空或过短','content','content');
  // brief_content 为作者在掘金发布面板手填的文章摘要；缺失时交由 CSDN 侧自动提取兜底。
  const summary=draft?.brief_content?.trim();
  // 空字符串是已确认无封面，不能再用文章列表里的旧封面覆盖。
  return{title:draft?.title?.trim()||'',markdown,summary,tags:(draft?.tags||[]).map(tag=>tag.tag_name||'').filter(Boolean),cover:draft?.cover_image};
}

/** 新文章（已知掘金草稿 ID）直接读取草稿详情，用于重试时回填被瘦身的正文。 */
export async function fetchJuejinDraftByDraftId(draftId:string,uuid:string,titleFallback=''):Promise<Article>{
  const content=await fetchDraftContent(draftId,uuid);
  return{
    id:draftId,
    sourceDraftId:draftId,
    title:content.title||titleFallback,
    markdown:content.markdown,
    summary:content.summary,
    tags:content.tags,
    cover:content.cover,
    sourceUrl:`https://juejin.cn/editor/drafts/${draftId}`
  };
}

/** 历史文章先经 list_by_user 反查草稿 ID，再读取原始 Markdown。可传入外部缓存加速批量反查。 */
export async function fetchJuejinDraftByArticleId(articleId:string,uuid:string,titleFallback='',cache?:JuejinArticleCache):Promise<Article>{
  const pageSize=100;
  let entry=cache?.get(articleId);
  for(let pageNo=1;!entry;pageNo++){
    const articles=await post<ArticleListItem[]>('/article/list_by_user',{
      page_no:pageNo,
      page_size:pageSize,
      audit_status:null,
      status:null
    },uuid);
    if(cache){
      for(const item of articles){
        const id=String(item.article_info?.article_id||'');
        if(id)cache.set(id,item);
      }
      entry=cache.get(articleId);
    }else{
      entry=articles.find(item=>String(item.article_info?.article_id||'')===articleId);
    }
    if(entry||articles.length<pageSize)break;
  }
  const draftId=entry?.article_info?.draft_id;
  if(!draftId)throw new SyncError('未在掘金创作者文章中找到对应草稿','platform-change','content');
  const content=await fetchDraftContent(String(draftId),uuid);
  return{
    id:articleId,
    sourceDraftId:String(draftId),
    title:content.title||entry?.article_info?.title?.trim()||titleFallback,
    markdown:content.markdown,
    // 草稿明确清空时保留空值；仅未返回摘要时使用已发布文章摘要。
    summary:content.summary??entry?.article_info?.brief_content?.trim(),
    tags:content.tags.length?content.tags:(entry?.tags||[]).map(tag=>tag.tag_name||'').filter(Boolean),
    cover:content.cover??entry?.article_info?.cover_image,
    sourceUrl:`https://juejin.cn/post/${articleId}`
  };
}

export function extractArticleId(url:string):string|null{
  return url.match(/\/post\/(\d+)/)?.[1]||null;
}
