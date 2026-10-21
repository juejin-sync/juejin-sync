// 掘金页面集成：新文章在发布成功后同步，历史文章通过统一弹窗立即同步。
import type {Article,PlatformId,SyncTask} from './types';
import {extractArticleId} from './source/juejin-api';
import {CNBLOGS_LOGO,CSDN_LOGO,WECHAT_LOGO,ZHIHU_LOGO} from './targets/logos';
import {refreshPlatformSelection,syncReplyState} from './core/sync-dialog';
import {BatchSyncQueue,type BatchTaskItem,type BatchStats} from './core/batch-queue';

type EditorSnapshot={title:string;markdown:string;draftId:string;sourceUrl:string;tags?:string[];cover?:string;summary?:string};
type PlatformAuth={platform:PlatformId;name:string;ok:boolean;loggedIn:boolean;loading?:boolean;account?:string;accountId?:string;message?:string};
type SyncSource={kind:'history';articleId:string;title:string};
const READ_EDITOR_EVENT='article-ferry:read-editor';
const SNAPSHOT_ATTRIBUTE='data-article-ferry-editor';
const PUBLISH_EVENT='article-ferry:published';
const PUBLISH_START_EVENT='article-ferry:publish-start';
const PUBLISH_ATTRIBUTE='data-article-ferry-published';
const SYNC_ICON='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5.5A5.5 5.5 0 0 0 3.2 4L2 5.5M3 10.5A5.5 5.5 0 0 0 12.8 12l1.2-1.5M2 2.8V5.5h2.7M14 13.2v-2.7h-2.7"/></svg>';
const PLATFORM_META:Record<PlatformId,{name:string;badge:string;logo:string;check:string;login:string}>={
  csdn:{name:'CSDN',badge:'博客草稿',logo:CSDN_LOGO,check:'CHECK_CSDN_STATUS',login:'OPEN_CSDN_LOGIN'},
  wechat:{name:'微信公众号',badge:'图文草稿',logo:WECHAT_LOGO,check:'CHECK_WECHAT_STATUS',login:'OPEN_WECHAT_LOGIN'},
  cnblogs:{name:'博客园',badge:'随笔草稿',logo:CNBLOGS_LOGO,check:'CHECK_CNBLOGS_STATUS',login:'OPEN_CNBLOGS_LOGIN'},
  zhihu:{name:'知乎',badge:'文章草稿',logo:ZHIHU_LOGO,check:'CHECK_ZHIHU_STATUS',login:'OPEN_ZHIHU_LOGIN'}
};
let syncedIds:Promise<Set<string>>|undefined;
let currentDialogRefresh:(()=>Promise<void>)|null=null;
let currentPublishRefresh:(()=>Promise<void>)|null=null;
let publishPanel:HTMLElement|null=null;
let publishSelected=new Set<PlatformId>();
let publishAuths:PlatformAuth[]=[];
const selectedArticles=new Map<string,{articleId:string;title:string}>();
let currentBatchQueue:BatchSyncQueue|null=null;
// 请求快照独立于面板生命周期；关闭面板不会丢失已提交的同步意图。
type PendingPublish={article?:Article;error?:string;platforms:PlatformId[];auths:PlatformAuth[];panel:HTMLElement|null;selection:Set<PlatformId>};
const pendingPublishes=new Map<string,PendingPublish>();

function isExtensionAlive():boolean{
  try{
    return typeof chrome!=='undefined'&&Boolean(chrome?.runtime?.id);
  }catch{
    return false;
  }
}

let isTeardown=false;
let globalObserver:MutationObserver|null=null;

function teardownContentScript(){
  if(isTeardown)return;
  isTeardown=true;
  if(globalObserver){
    globalObserver.disconnect();
    globalObserver=null;
  }
  window.removeEventListener('focus',onWindowFocus);
  document.removeEventListener(PUBLISH_EVENT,handleJuejinPublished);
  document.removeEventListener(PUBLISH_START_EVENT,handleJuejinPublishStart);
  try{chrome.runtime.onMessage.removeListener(onRuntimeMessage);}catch{}
  pendingPublishes.clear();
  selectedArticles.clear();
  if(currentBatchQueue){
    currentBatchQueue.stop();
    currentBatchQueue=null;
  }
  document.querySelector('.jc-sync-dialog-root')?.remove();
  document.querySelector('.jc-batch-modal-root')?.remove();
  document.querySelector('.jc-batch-action-bar')?.remove();
}

async function safeSendMessage<T=any>(message:any):Promise<T|undefined>{
  if(!isExtensionAlive()){
    teardownContentScript();
    return undefined;
  }
  try{
    const response=await chrome.runtime.sendMessage(message);
    return response as T;
  }catch(error){
    const errorMsg=String((error as Error)?.message||error);
    if(errorMsg.includes('Extension context invalidated')||!isExtensionAlive()){
      teardownContentScript();
      return undefined;
    }
    throw error;
  }
}

function escapeHtml(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));}
function readSelectedTagsFromDom(){const popup=document.querySelector<HTMLElement>('.publish-popup');if(!popup)return[];return[...new Set([...popup.querySelectorAll<HTMLElement>('[class*="tag"]')].filter(element=>typeof element.className==='string'&&/(?:^|[-\s])(?:active|selected|checked)(?:[-\s]|$)/i.test(element.className)).filter(element=>!element.querySelector('[class*="tag"]')).map(element=>element.textContent?.trim()||'').filter(text=>text.length>=1&&text.length<=30))];}
function readEditorArticle():Article{document.documentElement.removeAttribute(SNAPSHOT_ATTRIBUTE);document.dispatchEvent(new Event(READ_EDITOR_EVENT));const raw=document.documentElement.getAttribute(SNAPSHOT_ATTRIBUTE);document.documentElement.removeAttribute(SNAPSHOT_ATTRIBUTE);if(!raw)throw new Error('无法连接掘金编辑器');const snapshot=JSON.parse(raw) as EditorSnapshot;if(snapshot.title.trim().length<2||snapshot.markdown.trim().length<20)throw new Error('文章标题或正文不完整');return{id:snapshot.draftId||`draft-${Date.now()}`,sourceDraftId:snapshot.draftId||undefined,title:snapshot.title.trim(),markdown:snapshot.markdown,cover:snapshot.cover,summary:snapshot.summary,tags:snapshot.tags?.length?snapshot.tags:readSelectedTagsFromDom(),sourceUrl:snapshot.sourceUrl};}
function getJuejinUuid(){for(const entry of performance.getEntriesByType('resource'))try{const url=new URL(entry.name);const uuid=url.searchParams.get('uuid');if(url.hostname==='api.juejin.cn'&&uuid)return uuid;}catch{}return'';}
async function checkPlatform(platform:PlatformId):Promise<PlatformAuth>{
  const meta=PLATFORM_META[platform];
  if(!isExtensionAlive()){
    teardownContentScript();
    return{platform,name:meta.name,ok:false,loggedIn:false,message:'扩展已重载，请刷新网页'};
  }
  try{
    const result=await safeSendMessage({type:meta.check});
    if(!result){
      return{platform,name:meta.name,ok:false,loggedIn:false,message:'扩展已重载，请刷新网页'};
    }
    const loggedIn=result?.loggedIn===true&&(platform!=='cnblogs'||result?.blogEnabled===true);
    return{platform,name:meta.name,ok:result?.ok===true,loggedIn,account:result?.account,accountId:result?.accountId,message:result?.message};
  }catch(error){
    return{platform,name:meta.name,ok:false,loggedIn:false,message:(error as Error).message};
  }
}

function platformCard(auth:PlatformAuth,selected:boolean){
  const meta=PLATFORM_META[auth.platform];
  const isLoading=auth.loading===true;
  const isLogged=!isLoading&&auth.loggedIn;
  let statusHtml='';
  if(isLoading){
    statusHtml='<span class="jc-card-status is-checking"><span class="jc-status-spinner"></span><span>检测登录状态…</span></span>';
  }else if(isLogged){
    const accountDisplay=auth.account?`已登录 · ${escapeHtml(auth.account)}`:'已登录 · 账号就绪';
    statusHtml=`<span class="jc-card-status is-logged" title="${escapeHtml(auth.account||'已登录')}"><span class="jc-status-dot"></span><span>${accountDisplay}</span></span>`;
  }else{
    const tip=auth.message?escapeHtml(auth.message):'未登录，需登录后同步';
    statusHtml=`<span class="jc-card-status is-unlogged" title="${tip}"><span class="jc-status-dot"></span><span>${tip}</span></span>`;
  }

  let actionHtml='';
  if(isLoading){
    actionHtml='<span class="jc-action-skeleton"></span>';
  }else if(isLogged){
    actionHtml=`<div class="jc-custom-checkbox ${selected?'is-checked':''}" aria-checked="${selected}" role="checkbox" aria-label="${meta.name} 同步选择"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8.5 6.5 12 13 4" /></svg></div>`;
  }else{
    actionHtml=`<button class="jc-login-action-btn" type="button" data-platform="${auth.platform}" title="在新标签页前往 ${meta.name} 登录"><span>去登录</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9.5l7-7M9.5 7.5v-5h-5"/></svg></button>`;
  }

  return `<div class="jc-platform-card ${selected?'is-selected':''} ${isLoading?'is-loading':''} ${isLogged?'is-logged':'is-unlogged'}" data-platform="${auth.platform}" role="button" tabindex="${isLoading?'-1':'0'}" aria-label="${meta.name}，${isLogged?(selected?'已选择':'未选择'):'未登录'}">
    <div class="jc-card-logo"><img src="${meta.logo}" alt="${meta.name} Logo" class="jc-logo-img" /></div>
    <div class="jc-card-content">
      <div class="jc-card-header-row"><b class="jc-card-title">${meta.name}</b><span class="jc-card-badge">${meta.badge}</span></div>
      <div class="jc-card-meta-row">${statusHtml}</div>
    </div>
    <div class="jc-card-control">${actionHtml}</div>
  </div>`;
}

async function openSyncDialog(source:SyncSource,trigger:HTMLElement){
  document.querySelector('.jc-sync-dialog-root')?.remove();
  const root=document.createElement('div');
  root.className='jc-sync-dialog-root';
  root.innerHTML=`<div class="jc-sync-backdrop"></div>
<section class="jc-sync-dialog" role="dialog" aria-modal="true" aria-labelledby="jc-sync-title" tabindex="-1">
  <header class="jc-dialog-header">
    <div class="jc-dialog-brand">
      <img class="jc-dialog-emblem" src="${chrome.runtime.getURL('logo.svg')}" width="36" height="36" alt="" aria-hidden="true">
      <div class="jc-dialog-titles">
        <h2 id="jc-sync-title">同步到多平台</h2>
        <p>检测平台状态 · 一键同步为对应草稿</p>
      </div>
    </div>
    <div class="jc-header-actions">
      <button class="jc-btn-icon jc-auth-refresh" type="button" title="重新检测平台状态" aria-label="重新检测平台状态">
        <svg class="jc-refresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
      </button>
      <button class="jc-btn-icon jc-dialog-close" type="button" title="关闭弹窗" aria-label="关闭弹窗">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  </header>
  <div class="jc-dialog-body">
    <div class="jc-platform-list" aria-live="polite"></div>
    <div class="jc-sync-note">
      <div class="jc-note-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
      </div>
      <div class="jc-note-content">
        <b>纯端侧同步 · 仅保存至草稿箱</b>
        <span>绝不自动公开发布。正文外链图片与源封面将在端侧安全转存至目标平台 CDN。</span>
      </div>
    </div>
  </div>
  <footer class="jc-dialog-footer">
    <div class="jc-footer-status">
      <span class="jc-status-dot"></span>
      <span class="jc-selected-count">正在检测平台状态…</span>
    </div>
    <div class="jc-footer-buttons">
      <button class="jc-dialog-cancel" type="button">取消</button>
      <button class="jc-dialog-confirm" type="button" disabled>
        <span class="jc-confirm-icon-wrap">${SYNC_ICON}</span>
        <span class="jc-confirm-text">确认同步</span>
      </button>
    </div>
  </footer>
</section>`;
  document.body.appendChild(root);

  const dialog=root.querySelector<HTMLElement>('.jc-sync-dialog')!;
  const list=root.querySelector<HTMLElement>('.jc-platform-list')!;
  const confirmButton=root.querySelector<HTMLButtonElement>('.jc-dialog-confirm')!;
  const count=root.querySelector<HTMLElement>('.jc-selected-count')!;
  const footerStatus=root.querySelector<HTMLElement>('.jc-footer-status')!;
  const refreshButton=root.querySelector<HTMLButtonElement>('.jc-auth-refresh')!;

  let auths:PlatformAuth[]=[
    {platform:'csdn',name:'CSDN',ok:true,loggedIn:false,loading:true},
    {platform:'wechat',name:'微信公众号',ok:true,loggedIn:false,loading:true},
    {platform:'cnblogs',name:'博客园',ok:true,loggedIn:false,loading:true},
    {platform:'zhihu',name:'知乎',ok:true,loggedIn:false,loading:true}
  ];
  const selected=new Set<PlatformId>();
  // 提交期间冻结选择与刷新；默认勾选仅在首次检测完成时应用。
  let submitting=false;
  let initialized=false;
  let refreshing=false;

  const close=()=>{
    currentDialogRefresh=null;
    root.remove();
    trigger.focus();
  };

  const updateFooter=()=>{
    const hasSelected=selected.size>0;
    confirmButton.disabled=submitting||refreshing||!hasSelected;
    footerStatus.dataset.hasSelected=hasSelected?'true':'false';
    if(!hasSelected){
      count.textContent='请勾选要同步的目标平台';
    }else{
      count.textContent=`已选择 ${selected.size} 个平台 (${[...selected].map(p=>PLATFORM_META[p].name).join('、')})`;
    }
  };

  const render=()=>{
    list.innerHTML=auths.map(auth=>platformCard(auth,selected.has(auth.platform))).join('');
    updateFooter();

    list.querySelectorAll<HTMLElement>('.jc-platform-card').forEach(card=>{
      card.addEventListener('click',async()=>{
        const platform=card.dataset.platform as PlatformId;
        const auth=auths.find(item=>item.platform===platform);
        if(submitting||refreshing||!auth||auth.loading)return;

        if(!auth.loggedIn){
          if(!isExtensionAlive()){
            teardownContentScript();
            alert('扩展已重新加载或更新，请刷新网页后再试。');
            return;
          }
          await safeSendMessage({type:PLATFORM_META[platform].login});
          return;
        }

        if(selected.has(platform)){
          selected.delete(platform);
        }else{
          selected.add(platform);
        }
        render();
      });

      card.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){
          event.preventDefault();
          card.click();
        }
      });
    });
  };

  const refresh=async(silent=false)=>{
    if(submitting||refreshing)return;
    refreshing=true;
    updateFooter();
    if(!silent){
      auths=[
        {platform:'csdn',name:'CSDN',ok:true,loggedIn:false,loading:true},
        {platform:'wechat',name:'微信公众号',ok:true,loggedIn:false,loading:true},
        {platform:'cnblogs',name:'博客园',ok:true,loggedIn:false,loading:true},
        {platform:'zhihu',name:'知乎',ok:true,loggedIn:false,loading:true}
      ];
      render();
    }
    refreshButton.classList.add('is-spinning');
    try{
      const freshAuths=await Promise.all((['csdn','wechat','cnblogs','zhihu'] as PlatformId[]).map(checkPlatform));
      auths=freshAuths;
      refreshPlatformSelection(selected,auths,!initialized);
      initialized=true;
    }finally{
      refreshing=false;
      refreshButton.classList.remove('is-spinning');
      render();
    }
  };

  currentDialogRefresh=async()=>{
    await refresh(true);
  };

  root.querySelector('.jc-sync-backdrop')!.addEventListener('click',close);
  root.querySelector('.jc-dialog-close')!.addEventListener('click',close);
  root.querySelector('.jc-dialog-cancel')!.addEventListener('click',close);
  refreshButton.addEventListener('click',()=>void refresh());
  root.addEventListener('keydown',event=>{if(event.key==='Escape')close();});

  confirmButton.addEventListener('click',async()=>{
    if(submitting||refreshing||!selected.size)return;
    if(!isExtensionAlive()){
      teardownContentScript();
      alert('扩展已重新加载或更新，请刷新网页后再试。');
      return;
    }
    submitting=true;
    confirmButton.disabled=true;
    confirmButton.classList.add('is-loading');
    const label=confirmButton.querySelector<HTMLElement>('.jc-confirm-text')!;
    const platforms=[...selected];
    label.textContent=`正在同步到 ${platforms.length} 个平台…`;

    const results=await Promise.all(platforms.map(async platform=>{
      try{
        const currentAuth=auths.find(item=>item.platform===platform);
        const accountId=currentAuth?.accountId;
        if(platform==='wechat'&&!accountId)throw new Error('无法确认公众号身份，请重新检测登录状态');
        const result=await safeSendMessage({type:'SYNC_HISTORY_ARTICLE',platform,articleId:source.articleId,title:source.title,sourceUrl:`https://juejin.cn/post/${source.articleId}`,uuid:getJuejinUuid(),wechatAccountId:platform==='wechat'?accountId:undefined,accountId});
        if(result===undefined)throw new Error('扩展已重载，请刷新网页后重试');
        const state=syncReplyState(result);
        if(state.saved)rememberSynced(source.articleId,platform);
        return{platform,ok:true,...state};
      }catch(error){
        return{platform,ok:false,saved:false,message:(error as Error).message};
      }
    }));

    const failed=results.filter(item=>!item.ok);
    const pending=results.filter(item=>item.ok&&!item.saved);
    const saved=results.filter(item=>item.saved);
    close();
    setSyncButtonState(trigger,saved.length===results.length?'saved':'idle',`已保存 ${saved.length} 个平台${pending.length?`，${pending.length} 个待处理`:''}${failed.length?`，${failed.length} 个失败`:''}`);
    if(failed.length||pending.length)alert(`掘金同步助手：\n${[...failed,...pending].map(item=>`• ${PLATFORM_META[item.platform].name}：${item.message}`).join('\n')}`);
  });

  render();
  dialog.focus();
  await refresh(true);
}

function setSyncButtonState(button:HTMLElement,state:'idle'|'saved',message=''){button.dataset.state=state;const label=button.querySelector<HTMLElement>('.jc-history-label');if(label)label.textContent=message||'同步多平台';if(state==='saved')window.setTimeout(()=>{if(button.isConnected)setSyncButtonState(button,'idle');},3000);}

function resetPublishSelection(){
  publishPanel=null;
  publishSelected=new Set();
  publishAuths=[];
  currentPublishRefresh=null;
}

function findPublishPanel(){
  return[...document.querySelectorAll<HTMLElement>('.publish-popup .panel, .panel')].find(panel=>{
    const title=panel.querySelector<HTMLElement>(':scope > .title')?.textContent?.trim()||'';
    return/(?:发布|更新)文章/.test(title)&&panel.querySelector(':scope > .footer');
  })||null;
}

function injectPublishIntegration(){
  const panel=findPublishPanel();
  if(!panel){if(publishPanel&&!publishPanel.isConnected)resetPublishSelection();return;}
  if(panel!==publishPanel){resetPublishSelection();publishPanel=panel;}
  if(panel.querySelector('.jc-publish-sync-field'))return;
  const footer=panel.querySelector<HTMLElement>(':scope > .footer');
  if(!footer)return;
  const field=document.createElement('div');
  field.className='form-item jc-publish-sync-field';
  const sampleItem=panel.querySelector('.form-item');
  const scopeAttr=sampleItem?[...sampleItem.attributes].find(a=>a.name.startsWith('data-v-'))?.name:null;
  if(scopeAttr)field.setAttribute(scopeAttr,'');
  field.innerHTML=`<div class="label"${scopeAttr?` ${scopeAttr}`:''}>多平台同步：</div><div class="form-item-content jc-publish-sync-content"${scopeAttr?` ${scopeAttr}`:''}>
    <div class="jc-publish-platforms" aria-live="polite">
      <label class="jc-publish-platform is-unlogged" data-platform="csdn">
        <input type="checkbox" class="jc-platform-input" data-platform="csdn" disabled />
        <span class="jc-platform-checkbox" aria-hidden="true">✓</span>
        <img src="${CSDN_LOGO}" class="jc-platform-icon" alt="" />
        <span class="jc-platform-name">CSDN</span>
        <span class="jc-platform-status"><span class="jc-publish-spinner"></span></span>
      </label>
      <label class="jc-publish-platform is-unlogged" data-platform="wechat">
        <input type="checkbox" class="jc-platform-input" data-platform="wechat" disabled />
        <span class="jc-platform-checkbox" aria-hidden="true">✓</span>
        <img src="${WECHAT_LOGO}" class="jc-platform-icon" alt="" />
        <span class="jc-platform-name">微信公众号</span>
        <span class="jc-platform-status"><span class="jc-publish-spinner"></span></span>
      </label>
      <label class="jc-publish-platform is-unlogged" data-platform="cnblogs">
        <input type="checkbox" class="jc-platform-input" data-platform="cnblogs" disabled />
        <span class="jc-platform-checkbox" aria-hidden="true">✓</span>
        <img src="${CNBLOGS_LOGO}" class="jc-platform-icon" alt="" />
        <span class="jc-platform-name">博客园</span>
        <span class="jc-platform-status"><span class="jc-publish-spinner"></span></span>
      </label>
      <label class="jc-publish-platform is-unlogged" data-platform="zhihu">
        <input type="checkbox" class="jc-platform-input" data-platform="zhihu" disabled />
        <span class="jc-platform-checkbox" aria-hidden="true">✓</span>
        <img src="${ZHIHU_LOGO}" class="jc-platform-icon" alt="" />
        <span class="jc-platform-name">知乎</span>
        <span class="jc-platform-status"><span class="jc-publish-spinner"></span></span>
      </label>
    </div>
    <div class="jc-publish-sync-tip">掘金发布成功后自动保存至所选平台的草稿箱</div>
  </div>`;
  panel.insertBefore(field,footer);

  let refreshing=false;

  (['csdn','wechat','cnblogs','zhihu'] as PlatformId[]).forEach(platform=>{
    const card=field.querySelector<HTMLLabelElement>(`.jc-publish-platform[data-platform="${platform}"]`)!;
    const input=card.querySelector<HTMLInputElement>('.jc-platform-input')!;

    input.addEventListener('change',()=>{
      if(input.checked){
        publishSelected.add(platform);
      }else{
        publishSelected.delete(platform);
      }
      card.classList.toggle('is-selected',input.checked);
    });

    card.addEventListener('click',event=>{
      if(!isExtensionAlive()){
        teardownContentScript();
        return;
      }
      const target=event.target as HTMLElement;
      if(target.closest('.jc-publish-login')){
        event.preventDefault();
        void safeSendMessage({type:PLATFORM_META[platform].login});
        return;
      }
      const auth=publishAuths.find(item=>item.platform===platform);
      if(!auth?.loggedIn&&!refreshing){
        event.preventDefault();
        void safeSendMessage({type:PLATFORM_META[platform].login});
      }
    });
  });

  const updateCardAuth=(auth:PlatformAuth)=>{
    const card=field.querySelector<HTMLLabelElement>(`.jc-publish-platform[data-platform="${auth.platform}"]`);
    if(!card)return;
    const input=card.querySelector<HTMLInputElement>('.jc-platform-input')!;
    const status=card.querySelector<HTMLElement>('.jc-platform-status')!;

    if(auth.loading){
      input.disabled=true;
      status.innerHTML='<span class="jc-publish-spinner"></span>';
    }else if(auth.loggedIn){
      input.disabled=false;
      status.innerHTML='';
      card.classList.remove('is-unlogged');
      card.classList.add('is-ready');
      input.checked=publishSelected.has(auth.platform);
      card.classList.toggle('is-selected',input.checked);
    }else{
      input.disabled=true;
      input.checked=false;
      publishSelected.delete(auth.platform);
      card.classList.remove('is-selected','is-ready');
      card.classList.add('is-unlogged');
      status.innerHTML=`<button type="button" class="jc-publish-login" data-login="${auth.platform}" title="前往 ${PLATFORM_META[auth.platform].name} 登录">去登录 ↗</button>`;
    }
  };

  const refresh=async()=>{
    if(refreshing||!isExtensionAlive())return;
    refreshing=true;
    // 加载态只更新界面，保留上次确认的账号供已选平台创建请求快照。
    (['csdn','wechat','cnblogs','zhihu'] as PlatformId[]).forEach(platform=>updateCardAuth({platform,name:PLATFORM_META[platform].name,ok:true,loggedIn:false,loading:true}));
    try{
      const freshAuths=await Promise.all((['csdn','wechat','cnblogs','zhihu'] as PlatformId[]).map(checkPlatform));
      // 旧面板或已移除字段的检测结果不得覆盖当前选择与账号。
      if(publishPanel!==panel||!field.isConnected||currentPublishRefresh!==refresh)return;
      publishAuths=freshAuths;
      publishAuths.forEach(updateCardAuth);
    }finally{
      refreshing=false;
    }
  };

  currentPublishRefresh=refresh;
  void refresh();
}

function handleJuejinPublishStart(){
  if(!isExtensionAlive()){
    console.warn('[掘金同步助手] 扩展上下文已失效，请刷新页面');
    return;
  }
  if(!publishSelected.size){
    console.log('[掘金同步助手] 掘金发布开始，但未勾选同步目标平台');
    return;
  }
  const raw=document.documentElement.getAttribute(PUBLISH_ATTRIBUTE);
  if(!raw)return;
  let requestId:string;
  try{requestId=JSON.parse(raw).requestId;}catch{return;}
  if(!requestId||pendingPublishes.has(requestId))return;
  const pending:PendingPublish={platforms:[...publishSelected],auths:publishAuths.map(auth=>({...auth})),panel:publishPanel,selection:publishSelected};
  try{
    pending.article=readEditorArticle();
    console.log('[掘金同步助手] 已记录发布前文章快照:',pending.article.title,'目标平台:',pending.platforms);
  }catch(error){
    pending.error=(error as Error).message;
    console.warn('[掘金同步助手] 捕获文章快照失败:',pending.error);
  }
  pendingPublishes.set(requestId,pending);
}

function handleJuejinPublished(){
  if(!isExtensionAlive()){
    console.warn('[掘金同步助手] 扩展上下文已失效，请刷新页面');
    teardownContentScript();
    return;
  }
  const raw=document.documentElement.getAttribute(PUBLISH_ATTRIBUTE);
  document.documentElement.removeAttribute(PUBLISH_ATTRIBUTE);
  if(!raw)return;
  let published:{requestId:string;draftId?:string;articleId?:string};
  try{published=JSON.parse(raw) as typeof published;}catch{return;}
  const pending=pendingPublishes.get(published.requestId);
  pendingPublishes.delete(published.requestId);
  if(!pending)return;
  if(!published.draftId||!published.articleId){
    console.warn('[掘金同步助手] 掘金发布未识别到有效的草稿或文章标识:',published);
    return;
  }
  console.log('[掘金同步助手] 掘金发布成功，触发多平台同步:',{published,platforms:pending.platforms});
  const {platforms,auths}=pending;
  // 只消费对应请求的选择，不能清空用户新打开面板中的选择。
  if(publishPanel===pending.panel&&publishSelected===pending.selection){
    publishSelected.clear();
    publishPanel?.querySelectorAll<HTMLInputElement>('.jc-platform-input').forEach(input=>{input.checked=false;});
    publishPanel?.querySelectorAll<HTMLElement>('.jc-publish-platform').forEach(card=>{card.classList.remove('is-selected');});
  }
  try{
    const snapshot=pending.article;
    if(!snapshot)throw new Error(pending.error||'无法读取发布前的文章快照');
    if(snapshot.sourceDraftId&&published.draftId&&/^\d+$/.test(snapshot.sourceDraftId)&&/^\d+$/.test(published.draftId)&&snapshot.sourceDraftId!==published.draftId){
      throw new Error('发布响应与提交草稿不一致，已取消多平台同步');
    }
    const article={...snapshot,id:published.articleId,sourceDraftId:published.draftId,sourceUrl:`https://juejin.cn/post/${published.articleId}`};
    const requests=platforms.map(async platform=>{
      const currentAuth=auths.find(item=>item.platform===platform);
      const accountId=currentAuth?.accountId;
      if(platform==='wechat'&&!accountId)throw new Error('微信公众号身份已失效，请从文章列表重新同步');
      const result=await safeSendMessage({type:'SYNC_NEW_ARTICLE',platform,article,wechatAccountId:platform==='wechat'?accountId:undefined,accountId});
      if(result===undefined)throw new Error('扩展已重载，请刷新网页后从文章列表重试');
      return{platform,...syncReplyState(result)};
    });
    void Promise.allSettled(requests).then(results=>{
      const problems=results.flatMap((result,index)=>result.status==='rejected'?[`• ${PLATFORM_META[platforms[index]].name}：${result.reason instanceof Error?result.reason.message:String(result.reason)}`]:result.value.saved?[]:[`• ${PLATFORM_META[result.value.platform].name}：${result.value.message}`]);
      if(problems.length)alert(`掘金已发布，多平台同步需要处理：\n${problems.join('\n')}`);
    });
  }catch(error){alert(`掘金已发布，但未触发多平台同步：${(error as Error).message}`);}
}

function syncedArticleIds(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return Promise.resolve(new Set<string>());
  }
  if(!syncedIds)try{
    syncedIds=safeSendMessage({type:'GET_TASKS'}).then(result=>{
      const ids=new Set<string>();
      for(const task of((result?.tasks||[]) as SyncTask[]))if(task.status==='saved'){
        if(task.article?.id)ids.add(`${task.platform}:${task.article.id}`);
        const sourceId=task.article?.sourceUrl?extractArticleId(task.article.sourceUrl):'';
        if(sourceId)ids.add(`${task.platform}:${sourceId}`);
      }
      return ids;
    }).catch(()=>{
      syncedIds=undefined;
      return new Set<string>();
    });
  }catch{
    return Promise.resolve(new Set<string>());
  }
  return syncedIds;
}

function rememberSynced(articleId:string,platform:PlatformId){void syncedArticleIds().then(ids=>ids.add(`${platform}:${articleId}`));}

async function markSyncedButtons(){
  const buttons=document.querySelectorAll<HTMLElement>('.jc-history-sync,.jc-creator-sync');
  if(!buttons.length||!isExtensionAlive())return;
  const ids=await syncedArticleIds();
  buttons.forEach(button=>{
    const articleId=button.dataset.articleId||'';
    if(button.dataset.state==='idle'&&(ids.has(`csdn:${articleId}`)||ids.has(`wechat:${articleId}`)||ids.has(`cnblogs:${articleId}`)||ids.has(`zhihu:${articleId}`)))setSyncButtonState(button,'saved','已同步，可再次选择');
  });
}

function wireHistoryButton(button:HTMLElement){
  button.addEventListener('click',event=>{
    event.preventDefault();
    event.stopPropagation();
    if(!isExtensionAlive()){
      teardownContentScript();
      alert('扩展已重新加载或更新，请刷新网页后再试。');
      return;
    }
    void openSyncDialog({kind:'history',articleId:button.dataset.articleId!,title:button.dataset.title||''},button);
  });
}

function injectHistoryMenus(){
  document.querySelectorAll<HTMLUListElement>('.content-main li.item.more > ul.more-list').forEach(menu=>{
    if(menu.querySelector('.jc-history-sync'))return;
    if(!/编辑/.test(menu.innerText)||!/删除/.test(menu.innerText))return;
    const content=menu.closest<HTMLElement>('.content-main');
    const link=content?.querySelector<HTMLAnchorElement>('a[href^="/post/"]');
    const articleId=link?extractArticleId(link.href):null;
    if(!articleId)return;
    const item=document.createElement('li');
    item.className='item jc-history-sync';
    item.dataset.articleId=articleId;
    item.dataset.title=link?.getAttribute('title')||link?.textContent?.trim()||'';
    item.dataset.state='idle';
    item.innerHTML=`${SYNC_ICON}<span class="jc-history-label">同步多平台</span>`;
    wireHistoryButton(item);
    menu.insertBefore(item,menu.querySelector(':scope > li.delete'));
  });
}

function updateBatchActionBarState(){
  const bar=document.querySelector<HTMLElement>('.jc-batch-action-bar');
  if(!bar)return;
  const countSpan=bar.querySelector<HTMLElement>('.jc-count-number');
  if(countSpan)countSpan.textContent=String(selectedArticles.size);
  const triggerBtn=bar.querySelector<HTMLButtonElement>('.jc-batch-trigger-btn');
  if(triggerBtn){
    triggerBtn.disabled=selectedArticles.size===0;
  }
  const selectAllCheckbox=bar.querySelector<HTMLInputElement>('.jc-batch-select-all-checkbox');
  const allRowCheckboxes=document.querySelectorAll<HTMLInputElement>('.jc-article-select-checkbox');
  if(selectAllCheckbox&&allRowCheckboxes.length>0){
    const checkedCount=[...allRowCheckboxes].filter(cb=>cb.checked).length;
    selectAllCheckbox.checked=checkedCount===allRowCheckboxes.length;
    selectAllCheckbox.indeterminate=checkedCount>0&&checkedCount<allRowCheckboxes.length;
  }
}

async function filterUnsyncedArticles(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return;
  }
  const ids=await syncedArticleIds();
  const checkboxes=document.querySelectorAll<HTMLInputElement>('.jc-article-select-checkbox');
  checkboxes.forEach(cb=>{
    const articleId=cb.dataset.articleId||'';
    const title=cb.dataset.title||'';
    if(!articleId)return;
    const isSynced=ids.has(`csdn:${articleId}`)&&ids.has(`wechat:${articleId}`)&&ids.has(`cnblogs:${articleId}`)&&ids.has(`zhihu:${articleId}`);
    if(!isSynced){
      cb.checked=true;
      selectedArticles.set(articleId,{articleId,title});
    }else{
      cb.checked=false;
      selectedArticles.delete(articleId);
    }
  });
  updateBatchActionBarState();
}

function injectBatchActionBar(container:HTMLElement){
  if(document.querySelector('.jc-batch-action-bar'))return;
  const bar=document.createElement('div');
  bar.className='jc-batch-action-bar';
  bar.innerHTML=`<div class="jc-batch-bar-left">
    <label class="jc-batch-select-all-label">
      <input type="checkbox" class="jc-batch-select-all-checkbox" />
      <span>全选当前页</span>
    </label>
    <button type="button" class="jc-batch-filter-unsynced-btn" title="根据同步历史，自动勾选未同步过目标平台的文章">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      <span>一键勾选未同步文章</span>
    </button>
    <span class="jc-batch-selected-count">已选 <b class="jc-count-number">${selectedArticles.size}</b> 篇</span>
  </div>
  <div class="jc-batch-bar-right">
    <button type="button" class="jc-batch-trigger-btn" ${selectedArticles.size===0?'disabled':''}>
      <span>批量同步向导</span>
      <span class="jc-batch-rocket-icon">🚀</span>
    </button>
  </div>`;

  const selectAllCb=bar.querySelector<HTMLInputElement>('.jc-batch-select-all-checkbox');
  selectAllCb?.addEventListener('change',()=>{
    const checked=selectAllCb.checked;
    const checkboxes=document.querySelectorAll<HTMLInputElement>('.jc-article-select-checkbox');
    checkboxes.forEach(cb=>{
      cb.checked=checked;
      const articleId=cb.dataset.articleId||'';
      const title=cb.dataset.title||'';
      if(checked){
        if(articleId)selectedArticles.set(articleId,{articleId,title});
      }else{
        if(articleId)selectedArticles.delete(articleId);
      }
    });
    updateBatchActionBarState();
  });

  bar.querySelector('.jc-batch-filter-unsynced-btn')?.addEventListener('click',()=>{
    void filterUnsyncedArticles();
  });

  bar.querySelector('.jc-batch-trigger-btn')?.addEventListener('click',()=>{
    if(selectedArticles.size>0){
      openBatchSyncWizard();
    }
  });

  container.parentElement?.insertBefore(bar,container);
}

function openBatchSyncWizard(){
  document.querySelector('.jc-batch-modal-root')?.remove();
  const root=document.createElement('div');
  root.className='jc-batch-modal-root';

  const selectedList=[...selectedArticles.values()];
  const platformsSelected=new Set<PlatformId>(['csdn','wechat','cnblogs','zhihu']);
  let modalAuths:PlatformAuth[]=[];

  root.innerHTML=`<div class="jc-batch-modal-backdrop"></div>
  <div class="jc-batch-modal" role="dialog" aria-modal="true" aria-labelledby="jc-batch-modal-title">
    <div class="jc-batch-modal-header">
      <div class="jc-batch-modal-title-row">
        <img src="${chrome.runtime.getURL('logo.svg')}" width="28" height="28" alt="" aria-hidden="true" />
        <div>
          <h3 id="jc-batch-modal-title">历史文章批量同步向导</h3>
          <p>多选文章 · 多平台防风控限速分发</p>
        </div>
      </div>
      <button class="jc-btn-icon jc-dialog-close" type="button" title="关闭弹窗" aria-label="关闭弹窗">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>

    <div class="jc-batch-modal-body">
      <!-- 步骤指示器 -->
      <div class="jc-batch-steps">
        <div class="jc-batch-step is-active" data-step="1">
          <span class="jc-batch-step-num">1</span>
          <span>勾选清单确认</span>
        </div>
        <div class="jc-batch-step-line"></div>
        <div class="jc-batch-step is-active" data-step="2">
          <span class="jc-batch-step-num">2</span>
          <span>目标平台选择</span>
        </div>
        <div class="jc-batch-step-line"></div>
        <div class="jc-batch-step is-active" data-step="3">
          <span class="jc-batch-step-num">3</span>
          <span>耗时与风控预估</span>
        </div>
      </div>

      <!-- 配置视图 (Config View) -->
      <div class="jc-batch-view-config">
        <!-- 1. 清单确认 -->
        <div class="jc-batch-section">
          <div class="jc-batch-section-title">
            <span>待同步文章清单 (<span class="jc-batch-list-count">${selectedList.length}</span> 篇)</span>
          </div>
          <div class="jc-batch-article-list">
            ${selectedList.map(a=>`
              <div class="jc-batch-article-item" data-id="${a.articleId}">
                <span class="jc-item-title" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</span>
                <button type="button" class="jc-batch-article-remove" data-id="${a.articleId}" title="从本次批量同步中移除">✕</button>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 2. 目标平台选择 -->
        <div class="jc-batch-section">
          <div class="jc-batch-section-title">
            <span>目标平台选择</span>
          </div>
          <div class="jc-sync-platform-grid" id="jc-batch-platform-grid">
            ${(['csdn','wechat','cnblogs','zhihu'] as PlatformId[]).map(p=>`
              <div class="jc-platform-card is-selected is-loading" data-platform="${p}">
                <div class="jc-card-logo"><img src="${PLATFORM_META[p].logo}" alt="" class="jc-logo-img" /></div>
                <div class="jc-card-content">
                  <div class="jc-card-header-row"><b class="jc-card-title">${PLATFORM_META[p].name}</b><span class="jc-card-badge">${PLATFORM_META[p].badge}</span></div>
                  <div class="jc-card-meta-row"><span class="jc-card-status is-checking"><span class="jc-status-spinner"></span><span>检测登录状态…</span></span></div>
                </div>
                <div class="jc-card-control">
                  <div class="jc-custom-checkbox is-checked"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><polyline points="3 8.5 6.5 12 13 4" /></svg></div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 3. 耗时预估与风控提示 -->
        <div class="jc-batch-section">
          <div class="jc-batch-estimate-card">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <div>
              <div class="jc-estimate-summary">
                已选 <b id="jc-est-articles">${selectedList.length}</b> 篇文章 × <b id="jc-est-platforms">${platformsSelected.size}</b> 个平台 = <b id="jc-est-tasks">${selectedList.length*platformsSelected.size}</b> 个同步任务，预计耗时约 <b id="jc-est-duration">${Math.max(3,Math.ceil((selectedList.length*platformsSelected.size/2)*2.5))}</b> 秒。
              </div>
              <div style="font-size:11.5px;color:#4e5969;margin-top:4px;">
                🛡️ 已启用稳健防风控限速队列（并发上限 2，任务间注入 1.0~2.5s 动态随机抖动延迟，保障账号安全）。
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 执行看板视图 (Execution View) -->
      <div class="jc-batch-view-exec" style="display:none;">
        <div class="jc-batch-exec-header">
          <div class="jc-batch-progress-bar-wrap">
            <div class="jc-batch-progress-bar-fill" id="jc-batch-progress-fill"></div>
          </div>
          <div class="jc-batch-progress-stat">
            <span id="jc-batch-stat-text">准备执行批量同步…</span>
            <span id="jc-batch-stat-counts">已完成 0 / 0</span>
          </div>
        </div>

        <div class="jc-batch-controls">
          <button type="button" class="jc-batch-btn-outline" id="jc-batch-pause-btn">
            <span>⏸ 暂停队列</span>
          </button>
          <button type="button" class="jc-batch-btn-outline is-danger" id="jc-batch-stop-btn">
            <span>⏹ 终止批次</span>
          </button>
          <button type="button" class="jc-batch-btn-outline" id="jc-batch-retry-btn" style="display:none;">
            <span>🔄 重试失败项</span>
          </button>
        </div>

        <div class="jc-batch-log-list" id="jc-batch-log-list"></div>
      </div>
    </div>

    <div class="jc-batch-modal-footer">
      <button type="button" class="jc-dialog-secondary-btn jc-batch-cancel-btn">取消</button>
      <button type="button" class="jc-dialog-confirm-btn jc-batch-start-btn" ${selectedList.length===0||platformsSelected.size===0?'disabled':''}>
        <span>开始批量同步 🚀</span>
      </button>
    </div>
  </div>`;

  document.body.appendChild(root);

  const closeDialog=()=>{
    if(currentBatchQueue){
      const stats=currentBatchQueue.getStats();
      if(stats.state==='running'||stats.state==='paused'){
        if(!confirm('批量同步仍在进行中，确定要关闭窗口并终止批次吗？'))return;
        currentBatchQueue.stop();
        currentBatchQueue=null;
      }
    }
    root.remove();
  };

  root.querySelector('.jc-batch-modal-backdrop')?.addEventListener('click',closeDialog);
  root.querySelector('.jc-dialog-close')?.addEventListener('click',closeDialog);
  root.querySelector('.jc-batch-cancel-btn')?.addEventListener('click',closeDialog);

  const updateEstimate=()=>{
    const articlesCount=selectedList.length;
    const platformsCount=platformsSelected.size;
    const taskCount=articlesCount*platformsCount;
    const estDuration=Math.max(3,Math.ceil((taskCount/2)*2.5));

    const estArticles=root.querySelector('#jc-est-articles');
    if(estArticles)estArticles.textContent=String(articlesCount);
    const estPlatforms=root.querySelector('#jc-est-platforms');
    if(estPlatforms)estPlatforms.textContent=String(platformsCount);
    const estTasks=root.querySelector('#jc-est-tasks');
    if(estTasks)estTasks.textContent=String(taskCount);
    const estDurationEl=root.querySelector('#jc-est-duration');
    if(estDurationEl)estDurationEl.textContent=String(estDuration);

    const startBtn=root.querySelector<HTMLButtonElement>('.jc-batch-start-btn');
    if(startBtn)startBtn.disabled=articlesCount===0||platformsCount===0;
  };

  // 绑定清单移除事件
  root.querySelectorAll('.jc-batch-article-remove').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const articleId=(btn as HTMLElement).dataset.id;
      if(!articleId)return;
      const idx=selectedList.findIndex(a=>a.articleId===articleId);
      if(idx>=0)selectedList.splice(idx,1);
      selectedArticles.delete(articleId);
      btn.closest('.jc-batch-article-item')?.remove();
      const countEl=root.querySelector('.jc-batch-list-count');
      if(countEl)countEl.textContent=String(selectedList.length);
      const rowCb=document.querySelector<HTMLInputElement>(`.jc-article-select-checkbox[data-article-id="${articleId}"]`);
      if(rowCb)rowCb.checked=false;
      updateBatchActionBarState();
      updateEstimate();
    });
  });

  // 刷新平台登录态
  const refreshPlatformCards=async()=>{
    try{
      const fresh=await Promise.all((['csdn','wechat','cnblogs','zhihu'] as PlatformId[]).map(checkPlatform));
      modalAuths=fresh;
      const grid=root.querySelector('#jc-batch-platform-grid');
      if(!grid)return;
      grid.innerHTML=fresh.map(auth=>platformCard(auth,platformsSelected.has(auth.platform))).join('');

      // 绑定平台卡片点击切换与去登录
      grid.querySelectorAll<HTMLElement>('.jc-platform-card').forEach(card=>{
        const platform=card.dataset.platform as PlatformId;
        const auth=modalAuths.find(a=>a.platform===platform);
        card.addEventListener('click',event=>{
          const target=event.target as HTMLElement;
          if(target.closest('.jc-login-action-btn')||!auth?.loggedIn){
            event.preventDefault();
            void safeSendMessage({type:PLATFORM_META[platform].login});
            return;
          }
          if(platformsSelected.has(platform)){
            platformsSelected.delete(platform);
          }else{
            platformsSelected.add(platform);
          }
          const checkbox=card.querySelector('.jc-custom-checkbox');
          checkbox?.classList.toggle('is-checked',platformsSelected.has(platform));
          card.classList.toggle('is-selected',platformsSelected.has(platform));
          updateEstimate();
        });
      });
    }catch{}
  };
  void refreshPlatformCards();

  // 启动批量同步
  const startBtn=root.querySelector<HTMLButtonElement>('.jc-batch-start-btn');
  startBtn?.addEventListener('click',async()=>{
    if(selectedList.length===0||platformsSelected.size===0)return;

    // 切换到执行看板视图
    const configView=root.querySelector<HTMLElement>('.jc-batch-view-config');
    const execView=root.querySelector<HTMLElement>('.jc-batch-view-exec');
    const footer=root.querySelector<HTMLElement>('.jc-batch-modal-footer');
    if(configView)configView.style.display='none';
    if(execView)execView.style.display='block';
    if(footer)footer.style.display='none';

    // 构造任务项
    const tasks:BatchTaskItem[]=[];
    for(const article of selectedList){
      for(const platform of platformsSelected){
        tasks.push({
          id:`${article.articleId}:${platform}`,
          articleId:article.articleId,
          title:article.title,
          platform,
          status:'pending'
        });
      }
    }

    const logList=root.querySelector<HTMLElement>('#jc-batch-log-list')!;
    logList.innerHTML=tasks.map(t=>`
      <div class="jc-batch-log-item" id="jc-log-${t.articleId}-${t.platform}">
        <div class="jc-batch-log-info">
          <span class="jc-batch-log-platform">${PLATFORM_META[t.platform].name}</span>
          <span class="jc-batch-log-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
        </div>
        <span class="jc-batch-log-status is-pending">排队中</span>
      </div>
    `).join('');

    const progressFill=root.querySelector<HTMLElement>('#jc-batch-progress-fill')!;
    const statText=root.querySelector<HTMLElement>('#jc-batch-stat-text')!;
    const statCounts=root.querySelector<HTMLElement>('#jc-batch-stat-counts')!;
    const pauseBtn=root.querySelector<HTMLButtonElement>('#jc-batch-pause-btn')!;
    const stopBtn=root.querySelector<HTMLButtonElement>('#jc-batch-stop-btn')!;
    const retryBtn=root.querySelector<HTMLButtonElement>('#jc-batch-retry-btn')!;

    const renderProgress=(item:BatchTaskItem,stats:BatchStats)=>{
      const percent=stats.total>0?Math.round((stats.completed/stats.total)*100):0;
      progressFill.style.width=`${percent}%`;
      statCounts.textContent=`已完成 ${stats.completed} / ${stats.total} (成功 ${stats.success}，失败 ${stats.failed})`;

      if(stats.state==='paused'){
        statText.textContent='⏸ 批量同步已暂停';
      }else if(stats.state==='stopped'){
        statText.textContent='⏹ 批量同步已终止';
      }else if(stats.state==='completed'){
        statText.textContent=`🎉 批量同步完成！成功 ${stats.success} 篇，失败 ${stats.failed} 篇`;
      }else{
        statText.textContent=`正在同步：${escapeHtml(item.title)} → ${PLATFORM_META[item.platform].name}`;
      }

      if(stats.state==='paused'){
        pauseBtn.innerHTML='<span>▶ 继续队列</span>';
      }else{
        pauseBtn.innerHTML='<span>⏸ 暂停队列</span>';
      }

      if(stats.state==='completed'||stats.state==='stopped'){
        pauseBtn.style.display='none';
        stopBtn.style.display='none';
        if(stats.failed>0){
          retryBtn.style.display='inline-flex';
        }
      }

      // 更新单项 DOM
      const itemEl=root.querySelector<HTMLElement>(`#jc-log-${item.articleId}-${item.platform}`);
      if(itemEl){
        const statusSpan=itemEl.querySelector('.jc-batch-log-status');
        if(statusSpan){
          if(item.status==='syncing'){
            statusSpan.className='jc-batch-log-status is-syncing';
            statusSpan.innerHTML='<span class="jc-publish-spinner" style="width:10px;height:10px;margin-right:3px;"></span><span>同步中</span>';
          }else if(item.status==='saved'){
            statusSpan.className='jc-batch-log-status is-saved';
            statusSpan.innerHTML=item.draftUrl?`<a href="${escapeHtml(item.draftUrl)}" target="_blank" rel="noreferrer" style="color:#00b42a;text-decoration:underline;">✓ 查看草稿 ↗</a>`:'<span>✓ 已保存</span>';
          }else if(item.status==='failed'){
            statusSpan.className='jc-batch-log-status is-failed';
            statusSpan.innerHTML=`<span title="${escapeHtml(item.error||'失败')}">✗ ${escapeHtml(item.error?.slice(0,18)||'失败')}</span>`;
          }else if(item.status==='skipped'){
            statusSpan.className='jc-batch-log-status is-skipped';
            statusSpan.textContent='已跳过';
          }
        }
      }
    };

    pauseBtn.onclick=()=>{
      if(!currentBatchQueue)return;
      const stats=currentBatchQueue.getStats();
      if(stats.state==='paused'){
        currentBatchQueue.resume();
      }else if(stats.state==='running'){
        currentBatchQueue.pause();
      }
    };

    stopBtn.onclick=()=>{
      if(!currentBatchQueue)return;
      if(confirm('确定要终止剩余任务吗？')){
        currentBatchQueue.stop();
      }
    };

    retryBtn.onclick=async()=>{
      if(!currentBatchQueue)return;
      retryBtn.style.display='none';
      pauseBtn.style.display='inline-flex';
      stopBtn.style.display='inline-flex';
      await currentBatchQueue.retryFailed();
    };

    // 实例化并启动防风控队列
    currentBatchQueue=new BatchSyncQueue({
      concurrency:2,
      jitterMinMs:1000,
      jitterMaxMs:2500,
      worker:async item=>{
        const uuid=getJuejinUuid();
        const currentAuth=modalAuths.find(a=>a.platform===item.platform);
        const accountId=currentAuth?.accountId;
        const result=await safeSendMessage({
          type:'SYNC_HISTORY_ARTICLE',
          articleId:item.articleId,
          title:item.title,
          platform:item.platform,
          uuid,
          accountId,
          wechatAccountId:item.platform==='wechat'?accountId:undefined,
          zhihuAccountId:item.platform==='zhihu'?accountId:undefined
        });
        if(!result)throw new Error('扩展已重载，请刷新网页');
        if(!result.ok)throw new Error(result.message||'草稿保存失败');
        rememberSynced(item.articleId,item.platform);
        return{ok:true,draftUrl:result.task?.draftUrl};
      },
      onProgress:renderProgress
    });

    await currentBatchQueue.start(tasks);
    syncedIds=undefined;
    void markSyncedButtons();
  });
}

function injectCreatorCenterSync(){
  if(!location.pathname.startsWith('/creator/content/article'))return;
  const dropdowns=document.querySelectorAll<HTMLElement>('.byte-dropdown');
  let firstRow:HTMLElement|null=null;

  dropdowns.forEach(dropdown=>{
    const cell=dropdown.parentElement;
    let row:HTMLElement|null=dropdown;
    let link:HTMLAnchorElement|null=null;
    while(row&&row!==document.body){
      if(row.querySelectorAll('.byte-dropdown').length>1)break;
      if(row instanceof HTMLAnchorElement&&row.href.includes('/post/')){link=row;break;}
      link=row.querySelector('a[href*="/post/"]');
      if(link)break;
      row=row.parentElement;
    }
    if(!link)return;
    const articleId=extractArticleId(link.href);
    if(!articleId)return;
    const title=link.getAttribute('title')||link.querySelector<HTMLElement>('.title')?.textContent?.trim()||link.textContent?.trim()||'';

    if(!firstRow&&row)firstRow=row;

    // 1. 注入行级 Checkbox
    const containerCell=link.parentElement;
    if(containerCell&&!containerCell.querySelector(`.jc-article-select-checkbox[data-article-id="${articleId}"]`)){
      const wrap=document.createElement('div');
      wrap.className='jc-article-select-wrap';
      const checkbox=document.createElement('input');
      checkbox.type='checkbox';
      checkbox.className='jc-article-select-checkbox';
      checkbox.dataset.articleId=articleId;
      checkbox.dataset.title=title;
      checkbox.checked=selectedArticles.has(articleId);
      checkbox.addEventListener('change',()=>{
        if(checkbox.checked){
          selectedArticles.set(articleId,{articleId,title});
        }else{
          selectedArticles.delete(articleId);
        }
        updateBatchActionBarState();
      });
      wrap.appendChild(checkbox);
      containerCell.insertBefore(wrap,link);
    }

    // 2. 注入单篇“同步多平台”按钮
    if(cell&&!cell.querySelector('.jc-creator-sync')){
      const button=document.createElement('button');
      button.type='button';
      button.className='jc-creator-sync';
      button.dataset.articleId=articleId;
      button.dataset.title=title;
      button.dataset.state='idle';
      button.title='选择平台并同步草稿';
      button.innerHTML=`${SYNC_ICON}<span class="jc-history-label">同步多平台</span>`;
      wireHistoryButton(button);
      cell.insertBefore(button,dropdown);
    }
  });

  // 3. 注入顶部浮动操作条
  const targetRow=firstRow as HTMLElement|null;
  if(targetRow){
    const listParent=targetRow.parentElement;
    if(listParent)injectBatchActionBar(listParent);
  }
  updateBatchActionBarState();
}

async function resumePendingHistory(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return;
  }
  try{
    const result=await safeSendMessage({type:'RESUME_PENDING_HISTORY'});
    if(!result?.ok){
      if(result?.message)alert(`掘金同步助手：${result.message}`);
      return;
    }
    if(result.resumed||result.errors?.length){
      const notices:string[]=[];
      const completed=(result.results||[]) as {articleId:string;platform:PlatformId;task:SyncTask}[];
      const errors=(result.errors||[]) as {articleId:string;platform:PlatformId;message:string}[];
      for(const resumed of completed){
        const state=syncReplyState({ok:true,task:resumed.task});
        if(state.saved)rememberSynced(String(resumed.articleId),resumed.platform);
        else notices.push(`• ${PLATFORM_META[resumed.platform].name}：${state.message}`);
      }
      for(const error of errors)notices.push(`• ${PLATFORM_META[error.platform].name}：${error.message}`);
      if(notices.length)alert(`掘金同步助手：\n${notices.join('\n')}`);
      syncedIds=undefined;
      void markSyncedButtons();
    }
  }catch{}
}

function inject(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return;
  }
  document.querySelectorAll('.jc-editor-sync-control,.jc-sync-option').forEach(element=>element.remove());
  injectPublishIntegration();
  injectHistoryMenus();
  injectCreatorCenterSync();
  void markSyncedButtons();
}

let injectScheduled=false;
function scheduleInject(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return;
  }
  if(injectScheduled)return;
  injectScheduled=true;
  requestAnimationFrame(()=>{
    injectScheduled=false;
    if(!isExtensionAlive()){
      teardownContentScript();
      return;
    }
    inject();
  });
}

function reportJuejinUuid(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return;
  }
  const uuid=getJuejinUuid();
  if(uuid)void safeSendMessage({type:'REPORT_JUEJIN_UUID',uuid}).catch(()=>{});
}

function onWindowFocus(){
  if(!isExtensionAlive()){
    teardownContentScript();
    return;
  }
  reportJuejinUuid();
  void resumePendingHistory();
  syncedIds=undefined;
  void markSyncedButtons();
  if(currentDialogRefresh)void currentDialogRefresh();
  if(currentPublishRefresh)void currentPublishRefresh();
}

function onRuntimeMessage(message:any,_sender:chrome.runtime.MessageSender,sendResponse:(response:any)=>void){
  if(!isExtensionAlive()){
    teardownContentScript();
    return false;
  }
  if(message?.type==='DOWNLOAD_IMAGE_VIA_PAGE'&&typeof message.url==='string'){
    (async()=>{
      try{
        const response=await fetch(message.url,{credentials:'include'});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const blob=await response.blob();
        const reader=new FileReader();
        reader.onload=()=>sendResponse({ok:true,dataUrl:reader.result});
        reader.onerror=()=>sendResponse({ok:false,error:'读取图片失败'});
        reader.readAsDataURL(blob);
      }catch(err){
        sendResponse({ok:false,error:(err as Error)?.message||'页面下载图片失败'});
      }
    })();
    return true;
  }
  return false;
}

if(isExtensionAlive()){
  reportJuejinUuid();
  inject();
  globalObserver=new MutationObserver(scheduleInject);
  globalObserver.observe(document.documentElement,{childList:true,subtree:true});

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  document.addEventListener(PUBLISH_EVENT,handleJuejinPublished);
  document.addEventListener(PUBLISH_START_EVENT,handleJuejinPublishStart);
  window.addEventListener('focus',onWindowFocus);
}
