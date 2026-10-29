// 小红书长文导入契约：独立构造本地草稿，只写新 ID，不复制或覆盖用户草稿。
import {xhsWordCount,xhsArticleImageWeight} from './xiaohongshu-budget';
import {parseXiaohongshuLocalDraft,normalizeXiaohongshuText} from './xiaohongshu-capture';
export type ArticleImport={draftId:string;accountId:string;title:string;body:string;richJson:unknown;imageCount:number};
export function buildArticleDraft(input:ArticleImport){
  // 长文图片也占平台字数预算，上传完成后按实际尺寸再次校验。
  let imageWeight=0,text='';
  const countImages=(node:any)=>{
    if(node.type==='text')text+=node.text||'';
    if(node.type==='image')for(const image of node.attrs?.imgs||[]){
      imageWeight+=xhsArticleImageWeight(image.width,image.height);
    }
    if(Array.isArray(node.content))node.content.forEach(countImages);
  };
  countImages(input.richJson);
  const textWeight=xhsWordCount(text),total=textWeight+imageWeight;
  if(total>10000)throw new Error(`长文正文计数 ${textWeight} 字，图片占用 ${imageWeight} 字，合计 ${total} 字，超过10000字预算 ${total-10000} 字；请精简原文或在偏好设置中选择仅精简图文`);
  const record={draftId:input.draftId,uid:input.accountId,timeStamp:Date.now(),content:{
    contextStore:{liveContext:{time:0,title:''},previewAuditContext:{status:0,detail:{hasLimit:true,remainingCalls:0,taskId:'',taskType:'1',status:0,taskResultInfo:{detectionStatus:1,optimizationPoints:[]}},isChange:false},coverContext:{coverUrl:'',cover:{width:0,height:0,fileid:'',frame:{ts:0,isUserSelect:false,isUpload:false},stickers:{version:2,neptune:[]},fonts:[],coverTemplateId:'',extra_info_json:''},templateBlob:null,rate:0,recommendCoverIdx:-1},goodsContext:{goodsInfo:{},goodsPreviewDetail:[]},bizRelationContext:{bizRelation:[]},recommendCovers:[]},
    draftStore:{title:input.title,desc:'',descInnerHTML:'',descLength:0,imgList:[],ats:[],hashTag:[],video:{width:0,height:0,fileid:'',fsize:0,duration:0,videoId:'',videoMarks:[],timelines:[],frame:{ts:0,userSelect:false},transcodeVideoFileId:'',coverInfo:{}},videoInfo:null,audioInfo:null,videoMeta:'',audioMeta:'',cover:{width:0,height:0,fileid:'',frame:{ts:0,userSelect:false},stickers:{neptune:[],version:2},fonts:[]},chapters:[],markers:[],needTranscode:false,colorGroup:null},
    settingStore:{privacyInfo:{opType:1,type:0,userIds:[]},collectionId:'',orderId:'',brandAccountId:'',noteSketch:{id:'',name:''},original:false,originalDateStamp:'',coProduceBind:{enable:true},noteCopyBind:{copyable:true},coOrderId:'',interactionPermissionBind:{commentPermission:0},fileRelate:{fileId:'',docId:'',docName:'',docShowName:'',docType:'',docSize:0}},
    articleStore:{articleTitle:input.title,richJson:input.richJson,articleContent:JSON.stringify({metaInfo:{author_text:''}}),summeryContent:JSON.stringify({pic_title:input.title,pic_summary:''}),orderPattern:JSON.stringify({ol_prefix:'{}',subtitle_prefix:'{}'}),articleEditorMode:0,authorAndSummaryTemp:{author:'',summary:'',readingStats:''},selectedThemeId:6,selectedColorIndexMap:{},blob2Map:{},coverSetting:{styleType:0,showAuthor:true,showReadingStats:true,showSummery:true},editPageSource:'import',schemaCopy:{},url2FileIdMap:{}},
    shortDraftStore:{isShort:true,editStatus:0,textCardList:[{createTime:Date.now(),text:'',originText:'',length:0,image:'',imageFileId:'',isManualInsert:false}],coverList:[],currentCoverIdx:0,cacheData:{}},
    publishStore:{publishType:1,imageNoteOrigin:0,systemId:'web',step:0,uploadState:2,status:0,codec:'unknown'}
  }};
  assertImportedArticle(record,input);return record;
}
export function assertImportedArticle(record:unknown,input:ArticleImport){
  const draft=parseXiaohongshuLocalDraft(record,'article');
  if(!input.draftId||!input.accountId||!input.title.trim()||input.title.length>64||!draft||draft.draftId!==input.draftId||draft.accountId!==input.accountId||draft.title!==input.title||!draft.imagesComplete||draft.imageCount!==input.imageCount||normalizeXiaohongshuText(draft.body)!==normalizeXiaohongshuText(input.body))throw new Error('长文导入数据不完整，已停止写入');
}
/** 不带版本打开已存在的数据库；禁止创建或升级站点数据库。 */
export async function importArticleDraft(input:ArticleImport){
  const record=buildArticleDraft(input);
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('draft-database-v1');
    request.onupgradeneeded=()=>request.transaction?.abort();
    request.onerror=()=>reject(new Error('小红书草稿数据库未就绪，请打开创作服务平台后重试'));
    request.onsuccess=()=>resolve(request.result);
  });
  try{
    if(!db.objectStoreNames.contains('article-draft'))throw new Error('小红书长文草稿结构已变化，已停止导入');
    await new Promise<void>((resolve,reject)=>{
      const transaction=db.transaction('article-draft','readwrite');
      transaction.oncomplete=()=>resolve();transaction.onabort=()=>reject(new Error('长文草稿事务未完成，未确认保存成功'));
      // add 遇到相同 ID 时失败，绝不覆盖已有内容。
      transaction.objectStore('article-draft').add(record);
    });
    const saved=await new Promise<unknown>((resolve,reject)=>{
      const transaction=db.transaction('article-draft','readonly');let value:unknown;
      const request=transaction.objectStore('article-draft').get(input.draftId);request.onsuccess=()=>{value=request.result;};
      transaction.oncomplete=()=>resolve(value);transaction.onabort=()=>reject(new Error('长文草稿读回失败'));
    });
    assertImportedArticle(saved,input);
    return{ok:true,draftId:input.draftId,accountId:input.accountId};
  }finally{db.close();}
}
