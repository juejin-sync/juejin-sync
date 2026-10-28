import type {ExtensionSettings,PlatformId,SyncTask,TaskStatus} from './types';
import {categoryLabels,stageLabels} from './core/diagnostic';
import {platformLabel} from './core/message';
import {defaultSettings,formatCategoryMappings,normalizeSettings,parseCategoryMappings} from './core/settings';
import {isActiveTask,isRetryableTask} from './core/task';

const $=<T extends HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
type LoginStatus='checking'|'logged-in'|'logged-out'|'error';
let loginStatus:LoginStatus='checking';
let wechatLoginStatus:LoginStatus='checking';
let cnblogsLoginStatus:LoginStatus='checking';
let zhihuLoginStatus:LoginStatus='checking';
let xiaohongshuLoginStatus:LoginStatus='checking';
let selectedPlatform:PlatformId='csdn';
let csdnAccount='';
let wechatAccount='';
let cnblogsAccount='';
let zhihuAccount='';
let xiaohongshuAccount='';
let checkSequence=0;
let historyFilter:'all'|'saved'|'failed'|'working'='all';
let currentSettings:ExtensionSettings=defaultSettings;
let currentTab:'history'|'settings'='history';

function renderPlatformTrigger(){
  const trigger=$('#platform-trigger');
  const status=selectedPlatform==='csdn'?loginStatus:selectedPlatform==='wechat'?wechatLoginStatus:selectedPlatform==='cnblogs'?cnblogsLoginStatus:selectedPlatform==='zhihu'?zhihuLoginStatus:xiaohongshuLoginStatus;
  const account=selectedPlatform==='csdn'?csdnAccount:selectedPlatform==='wechat'?wechatAccount:selectedPlatform==='cnblogs'?cnblogsAccount:selectedPlatform==='zhihu'?zhihuAccount:xiaohongshuAccount;
  const name=platformLabel(selectedPlatform);
  trigger.className=`platform-pill ${status==='logged-in'?'logged':status==='logged-out'?'login-link':status}`;
  $('#platform-trigger-text').textContent=status==='checking'?`${name} 检测中…`:status==='logged-in'?`${name}${account?` · ${account}`:''} ✓`:status==='logged-out'?`${name} 未登录`: `${name} 检测失败`;
}

function setPlatformMenu(open:boolean){
  const trigger=$('#platform-trigger');
  const menu=$('#platform-menu');
  trigger.setAttribute('aria-expanded',String(open));
  menu.hidden=!open;
}

function selectPlatform(platform:PlatformId){
  selectedPlatform=platform;
  document.querySelectorAll<HTMLButtonElement>('.platform-option').forEach(option=>{
    const selected=option.dataset.platform===platform;
    option.classList.toggle('selected',selected);
    option.setAttribute('aria-checked',String(selected));
  });
  renderPlatformTrigger();
  setPlatformMenu(false);
}

const labels:Record<TaskStatus,string>={
  saved:'同步成功',
  failed:'同步失败',
  'needs-user':'需要处理',
  'needs-confirmation':'等待确认',
  queued:'等待同步',
  'checking-login':'检查登录',
  transforming:'处理内容',
  writing:'保存草稿'
};

let toastTimer=0;
let currentTasksCache:SyncTask[]=[];
function toast(message:string){
  const element=$('#toast');
  element.textContent=message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=window.setTimeout(()=>element.classList.remove('show'),2400);
}

function switchTab(tab:'history'|'settings'){
  currentTab=tab;
  document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach(button=>{
    const isActive=button.dataset.tab===tab;
    button.classList.toggle('active',isActive);
    button.setAttribute('aria-selected',String(isActive));
  });
  const thumb=$('#spring-thumb');
  if(thumb){
    thumb.style.transform=tab==='settings'?'translateX(100%)':'translateX(0)';
  }
  const historyPane=$('#pane-history');
  const settingsPane=$('#pane-settings');
  historyPane.classList.toggle('active',tab==='history');
  settingsPane.classList.toggle('active',tab==='settings');
  historyPane.hidden=tab!=='history';
  settingsPane.hidden=tab!=='settings';
  if(tab==='history')void loadTasks();
  if(tab==='settings'){void loadSettings();void loadCsdnCategories();}
}

async function checkLogin(){
  const current=++checkSequence;
  const pill=$('#login-state');
  const text=$('#login-text');
  loginStatus='checking';
  pill.className='platform-option checking'+(selectedPlatform==='csdn'?' selected':'');
  pill.title='正在检测 CSDN 登录状态…';
  text.textContent='检测中…';
  try{
    const result=await Promise.race([
      chrome.runtime.sendMessage({type:'CHECK_CSDN_STATUS'}),
      new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('检测超时')),7000))
    ]);
    if(current!==checkSequence)return;
    if(result?.loggedIn){
      loginStatus='logged-in';
      csdnAccount=result.account||'';
      pill.className='platform-option logged'+(selectedPlatform==='csdn'?' selected':'');
      pill.title='CSDN 已登录，点击可刷新状态';
      text.textContent=result.account?`CSDN · ${result.account}`:'CSDN 已登录';
    }else if(result?.ok){
      loginStatus='logged-out';
      csdnAccount='';
      pill.className='platform-option login-link'+(selectedPlatform==='csdn'?' selected':'');
      pill.title='CSDN 未登录，点击前往登录';
      text.textContent='CSDN 未登录 ↗';
    }else throw new Error(result?.message||'检测失败');
  }catch(error){
    if(current!==checkSequence)return;
    loginStatus='error';
    pill.className='platform-option error'+(selectedPlatform==='csdn'?' selected':'');
    pill.title='登录状态检测失败，点击重试';
    text.textContent='CSDN 检测失败 ↻';
    toast((error as Error).message);
  }finally{renderPlatformTrigger();}
}

async function checkWechatLogin(){
  const pill=$('#wechat-login-state');const text=$('#wechat-login-text');
  wechatLoginStatus='checking';pill.className='platform-option checking'+(selectedPlatform==='wechat'?' selected':'');text.textContent='微信检测中…';renderPlatformTrigger();
  try{
    const result=await chrome.runtime.sendMessage({type:'CHECK_WECHAT_STATUS'});
    if(result?.loggedIn){wechatLoginStatus='logged-in';wechatAccount=result.account||'';pill.className='platform-option logged'+(selectedPlatform==='wechat'?' selected':'');text.textContent=result.account?`微信公众号 · ${result.account}`:'微信公众号已登录';pill.title='微信公众号已登录，点击刷新状态';}
    else if(result?.ok){wechatLoginStatus='logged-out';wechatAccount='';pill.className='platform-option login-link'+(selectedPlatform==='wechat'?' selected':'');text.textContent='微信公众号未登录 · 点击登录';pill.title='点击登录微信公众平台';}
    else throw new Error(result?.message||'微信登录检测失败');
  }catch(error){wechatLoginStatus='error';pill.className='platform-option error'+(selectedPlatform==='wechat'?' selected':'');text.textContent='微信公众号检测失败 · 点击重试';toast((error as Error).message);}finally{renderPlatformTrigger();}
}

async function checkCnblogsLogin(){
  const pill=$('#cnblogs-login-state');const text=$('#cnblogs-login-text');
  cnblogsLoginStatus='checking';pill.className='platform-option checking'+(selectedPlatform==='cnblogs'?' selected':'');text.textContent='博客园检测中…';renderPlatformTrigger();
  try{
    const result=await chrome.runtime.sendMessage({type:'CHECK_CNBLOGS_STATUS'});
    if(result?.loggedIn&&result?.blogEnabled){cnblogsLoginStatus='logged-in';cnblogsAccount=result.account||'';pill.className='platform-option logged'+(selectedPlatform==='cnblogs'?' selected':'');text.textContent=result.account?`博客园 · ${result.account}`:'博客园已登录';pill.title='博客园已登录，点击刷新状态';}
    else if(result?.loggedIn){cnblogsLoginStatus='error';cnblogsAccount=result.account||'';pill.className='platform-option error'+(selectedPlatform==='cnblogs'?' selected':'');text.textContent='博客园尚未开通 · 点击处理';pill.title=result.message||'博客园账号尚未开通博客';}
    else if(result?.ok){cnblogsLoginStatus='logged-out';cnblogsAccount='';pill.className='platform-option login-link'+(selectedPlatform==='cnblogs'?' selected':'');text.textContent='博客园未登录 · 点击登录';pill.title='点击登录博客园';}
    else throw new Error(result?.message||'博客园登录检测失败');
  }catch(error){cnblogsLoginStatus='error';pill.className='platform-option error'+(selectedPlatform==='cnblogs'?' selected':'');text.textContent='博客园检测失败 · 点击重试';toast((error as Error).message);}finally{renderPlatformTrigger();}
}

async function checkZhihuLogin(){
  const pill=$('#zhihu-login-state');const text=$('#zhihu-login-text');
  zhihuLoginStatus='checking';pill.className='platform-option checking'+(selectedPlatform==='zhihu'?' selected':'');text.textContent='知乎检测中…';renderPlatformTrigger();
  try{
    const result=await chrome.runtime.sendMessage({type:'CHECK_ZHIHU_STATUS'});
    if(result?.loggedIn){zhihuLoginStatus='logged-in';zhihuAccount=result.account||'';pill.className='platform-option logged'+(selectedPlatform==='zhihu'?' selected':'');text.textContent=result.account?`知乎 · ${result.account}`:'知乎已登录';pill.title='知乎已登录，点击刷新状态';}
    else if(result?.ok){zhihuLoginStatus='logged-out';zhihuAccount='';pill.className='platform-option login-link'+(selectedPlatform==='zhihu'?' selected':'');text.textContent='知乎未登录 · 点击登录';pill.title='点击登录知乎专栏';}
    else throw new Error(result?.message||'知乎登录检测失败');
  }catch(error){zhihuLoginStatus='error';pill.className='platform-option error'+(selectedPlatform==='zhihu'?' selected':'');text.textContent='知乎检测失败 · 点击重试';toast((error as Error).message);}finally{renderPlatformTrigger();}
}

async function checkXiaohongshuLogin(){
  const pill=$('#xiaohongshu-login-state');const text=$('#xiaohongshu-login-text');
  xiaohongshuLoginStatus='checking';pill.className='platform-option checking'+(selectedPlatform==='xiaohongshu'?' selected':'');text.textContent='小红书检测中…';renderPlatformTrigger();
  try{
    const result=await chrome.runtime.sendMessage({type:'CHECK_XIAOHONGSHU_STATUS'});
    if(result?.loggedIn){xiaohongshuLoginStatus='logged-in';xiaohongshuAccount=result.account||'';pill.className='platform-option logged'+(selectedPlatform==='xiaohongshu'?' selected':'');text.textContent=result.account?`小红书 · ${result.account}`:'小红书已登录';pill.title='小红书已登录，点击刷新状态';}
    else if(result?.ok){xiaohongshuLoginStatus='logged-out';xiaohongshuAccount='';pill.className='platform-option login-link'+(selectedPlatform==='xiaohongshu'?' selected':'');text.textContent='小红书未登录 · 点击登录';pill.title='点击登录小红书创作服务平台';}
    else throw new Error(result?.message||'小红书登录检测失败');
  }catch(error){xiaohongshuLoginStatus='error';pill.className='platform-option error'+(selectedPlatform==='xiaohongshu'?' selected':'');text.textContent='小红书检测失败 · 点击重试';toast((error as Error).message);}finally{renderPlatformTrigger();}
}

function escapeHtml(value:string){
  return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
}

function formatDate(value:string){
  return new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).replaceAll('/','-');
}

function formatDuration(durationMs:number){
  if(durationMs<1000)return`${(durationMs/1000).toFixed(1)}s`;
  if(durationMs<60000)return`${(durationMs/1000).toFixed(1)}s`;
  return`${Math.floor(durationMs/60000)}m ${Math.round(durationMs%60000/1000)}s`;
}

function statusKind(task:SyncTask){
  if(task.status==='saved')return task.warnings?.length?'warning':'success';
  if(task.status==='failed'||task.status==='needs-user')return'failure';
  if(task.status==='needs-confirmation')return'warning';
  return'working';
}

function taskCard(task:SyncTask){
  const kind=statusKind(task);
  let stateText=labels[task.status]||'同步中';
  let stateIcon='⛵';
  if(task.status==='saved'){
    stateText=task.warnings?.length?'已保存，有警告':(task.draftUrl?'已抵达草稿箱':'同步成功');
    stateIcon=task.warnings?.length?'⚠':'✓';
  }else if(task.status==='failed'){
    stateText='同步失败';
    stateIcon='✕';
  }else if(task.status==='needs-user'){
    stateText='需要处理';
    stateIcon='!';
  }else if(task.status==='needs-confirmation'){
    stateText='等待确认';
    stateIcon='⚠';
  }
  const cover=task.article.cover?`<img src="${escapeHtml(task.article.cover)}" alt="">`:'';
  const actions=[];
  if(task.draftUrl)actions.push(`<button class="history-action btn-action-primary" data-open="${escapeHtml(task.draftUrl)}">草稿 ↗</button>`);
  if(task.platform==='csdn'&&!['queued','checking-login','transforming','writing'].includes(task.status))actions.push(`<button class="history-action btn-action-dryrun" data-dryrun="${escapeHtml(task.id)}" title="同步预演：查看分类命中、图片转存与内容风险，不写入 CSDN">预演</button>`);
  if(task.status==='needs-confirmation')actions.push(`<button class="history-action confirm btn-action-confirm" data-confirm="${escapeHtml(task.id)}">确认更新</button>`);
  if(['failed','needs-user'].includes(task.status))actions.push(`<button class="history-action retry btn-action-retry" data-retry="${escapeHtml(task.id)}">重试</button>`);
  if(['failed','needs-user'].includes(task.status)&&(task.wechatAppMsgId||task.csdnArticleId||task.cnblogsPostId||task.zhihuArticleId||task.xiaohongshuNoteId))actions.push(`<button class="history-action retry btn-action-retry" data-retry-new="${escapeHtml(task.id)}" title="忽略旧草稿关联，作为全新草稿重新保存">另存新草稿</button>`);
  if(!['queued','checking-login','transforming','writing'].includes(task.status))actions.push(`<button class="history-action delete btn-action-delete" data-delete="${escapeHtml(task.id)}" title="删除本地记录" aria-label="删除本地记录"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>`);
  const action=`<span class="task-actions">${actions.join('')}</span>`;
  const error=task.error?`<p class="platform-error" title="${escapeHtml(task.error)}">${escapeHtml(task.error)}</p>`:'';
  const diagText=task.diagnostic?`${task.article.title} [${task.diagnostic.category} - ${task.diagnostic.stage}]: ${task.diagnostic.message} (${task.diagnostic.suggestion})`:'';
  const diagnostic=task.diagnostic?`<div class="task-diagnostic"><div class="diagnostic-header"><b>${categoryLabels[task.diagnostic.category]} · ${stageLabels[task.diagnostic.stage]}</b><button class="btn-copy-diag" data-copy-diag="${escapeHtml(diagText)}">复制诊断</button></div><span>${escapeHtml(task.diagnostic.suggestion)}</span></div>`:'';
  const warning=task.warnings?.length?`<p class="platform-warning" title="${escapeHtml(task.warnings.join('\n'))}">${escapeHtml(task.warnings.join('；'))}</p>`:'';
  const stats=task.stats?`耗时 <b>${formatDuration(task.stats.durationMs)}</b><i>·</i>图片 <b>${task.stats.imageSucceeded}/${task.stats.imageTotal}</b>${task.stats.imageFailed?`<i>·</i><strong>${task.stats.imageFailed}</strong> 失败`:''}`:'';
  const progressPercent=task.progress?.total?Math.min(100,Math.max(0,Math.round(task.progress.current/task.progress.total*100))):0;
  const progress=task.progress?`<div class="task-progress-box">
    <div class="progress-info">
      <span class="progress-msg">${escapeHtml(task.progress.message||'正在同步…')}</span>
      <span class="progress-percent">${task.progress.total?`${progressPercent}%`:'进行中…'}</span>
    </div>
    <div class="task-progress ${task.progress.total?'':'indeterminate'}"><span style="width:${task.progress.total?progressPercent:35}%"></span></div>
  </div>`:'';
  const platformName=platformLabel(task.platform);
  const bottomStats=stats?`<span>${platformName}</span><i>·</i>${stats}`:`<span>${platformName}草稿同步</span>`;
  return`<div class="history-card ${kind}">
    <div class="task-main-row">
      <span class="history-cover">${cover}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>
      <div class="task-info">
        <b class="task-title" title="${escapeHtml(task.article.title)}">${escapeHtml(task.article.title)}</b>
        <div class="task-meta">
          <span class="platform-badge ${task.platform}">${platformName}</span>
          <span class="state-tag ${kind}">${stateIcon} ${stateText}</span>
          <span class="task-date">${formatDate(task.updatedAt)}</span>
        </div>
      </div>
    </div>
    ${progress}
    ${error}
    ${diagnostic}
    ${warning}
    <div class="task-bottom-row">
      <div class="task-stats">${bottomStats}</div>
      ${action}
    </div>
  </div>`;
}

async function loadTasks(){
  try{
    const result=await chrome.runtime.sendMessage({type:'GET_TASKS'});
    const all=((result?.tasks||[]) as SyncTask[]).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
    currentTasksCache=all;
    const tasks=all.filter(task=>historyFilter==='all'||(historyFilter==='saved'?task.status==='saved':historyFilter==='failed'?['failed','needs-user'].includes(task.status):['queued','checking-login','transforming','writing','needs-confirmation'].includes(task.status)));
    const list=$('#task-list');
    
    const savedCount=all.filter(t=>t.status==='saved').length;
    const failedCount=all.filter(t=>['failed','needs-user'].includes(t.status)).length;
    const workingCount=all.filter(t=>['queued','checking-login','transforming','writing','needs-confirmation'].includes(t.status)).length;
    
    const countAll=$('#count-all');
    if(countAll)countAll.textContent=all.length?String(all.length):'';
    const countSaved=$('#count-saved');
    if(countSaved)countSaved.textContent=savedCount?String(savedCount):'';
    const countFailed=$('#count-failed');
    if(countFailed)countFailed.textContent=failedCount?String(failedCount):'';
    const countWorking=$('#count-working');
    if(countWorking)countWorking.textContent=workingCount?String(workingCount):'';

    $('#history-count').textContent=historyFilter==='all'?'':`${tasks.length}/${all.length} 篇`;
    const badge=$('#history-badge');
    badge.textContent=all.length?String(all.length):'';
    const clearButton=$<HTMLButtonElement>('#history-clear');
    clearButton.disabled=!all.length||all.some(isActiveTask);
    clearButton.title=all.some(isActiveTask)?'仍有文章正在同步，请等待完成后再清空历史':'';
    $<HTMLButtonElement>('#history-retry-all').disabled=!all.some(isRetryableTask);
    if(!tasks.length){
      list.innerHTML=`<div class="empty-state-view harbor-empty-view">
        <div class="harbor-beacon-stage">
          <div class="water-ripple"></div>
          <div class="harbor-boat-card">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 17l20 0"/>
              <path d="M4 17l2 -6h12l2 6"/>
              <path d="M12 5v6"/>
              <path d="M12 5l6 3.5h-6"/>
            </svg>
            <span class="beacon-star"></span>
          </div>
        </div>
        <h2 class="empty-headline harbor-headline">${all.length?'当前筛选下无记录':'准备开始同步'}</h2>
        <p class="empty-subtext harbor-subtext">${all.length?'可尝试切换上方的状态筛选条件。':'在掘金发文时选择同步平台，文章与图片将保存到目标草稿箱。'}</p>
        ${all.length?'':`<button id="btn-goto-juejin" class="btn-launch-juejin btn-embark">
          <span>前往掘金文章管理</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 17l9.2-9.2M17 17V8H8"/></svg>
        </button>
        <div class="guide-card">
          <div class="guide-card-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
            <span>只需 3 步完成同步</span>
          </div>
          <div class="guide-steps">
            <div class="guide-step-item">
              <span class="step-num-pill">1</span>
              <span class="step-title">掘金写完</span>
              <span class="step-desc">正常撰写并发布</span>
            </div>
            <div class="guide-step-item">
              <span class="step-num-pill">2</span>
              <span class="step-title">勾选同步</span>
              <span class="step-desc">面板开启 CSDN</span>
            </div>
            <div class="guide-step-item">
              <span class="step-num-pill">3</span>
              <span class="step-title">草稿直达</span>
              <span class="step-desc">打开草稿箱确认</span>
            </div>
          </div>
        </div>`}
      </div>`;
      $('#btn-goto-juejin')?.addEventListener('click',()=>void chrome.tabs.create({url:'https://juejin.cn/creator/content/article/essays?status=all',active:true}));
      return;
    }
    list.innerHTML=tasks.map(taskCard).join('');
    list.querySelectorAll<HTMLImageElement>('.history-cover img').forEach(image=>image.addEventListener('error',()=>image.remove()));
    list.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button=>button.addEventListener('click',()=>void chrome.tabs.create({url:button.dataset.open,active:true})));
    list.querySelectorAll<HTMLButtonElement>('[data-dryrun]').forEach(button=>button.addEventListener('click',()=>void runDryRun(button.dataset.dryrun||'',button)));
    list.querySelectorAll<HTMLButtonElement>('[data-copy-diag]').forEach(button=>button.addEventListener('click',async()=>{
      const text=button.dataset.copyDiag||'';
      if(!text)return;
      try{
        await navigator.clipboard.writeText(text);
        toast('诊断信息已复制到剪贴板');
      }catch{
        toast('复制失败，请手动复制');
      }
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach(button=>button.addEventListener('click',async()=>{
      const task=all.find(item=>item.id===button.dataset.retry);
      const confirmUncertain=task?.diagnostic?.category==='interrupted';
      if(confirmUncertain&&!confirm('上次保存结果不确定。请先检查目标草稿箱；仅在确认需要重新写入后继续，重试可能产生重复草稿。是否继续？'))return;
      button.disabled=true;
      button.textContent='重试中…';
      const retry=await chrome.runtime.sendMessage({type:'RETRY_TASK',id:button.dataset.retry,confirmUncertain});
      if(!retry?.ok)toast(retry?.message||'重新同步失败');
      else toast('已重新发起同步');
      setTimeout(()=>void loadTasks(),600);
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-retry-new]').forEach(button=>button.addEventListener('click',async()=>{
      button.disabled=true;
      button.textContent='同步中…';
      const retry=await chrome.runtime.sendMessage({type:'RETRY_TASK',id:button.dataset.retryNew,asNew:true});
      if(!retry?.ok)toast(retry?.message||'重新同步失败');
      else toast('已作为新草稿发起同步');
      setTimeout(()=>void loadTasks(),600);
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-confirm]').forEach(button=>button.addEventListener('click',async()=>{
      button.disabled=true;
      button.textContent='更新中…';
      const result=await chrome.runtime.sendMessage({type:'CONFIRM_TASK_UPDATE',id:button.dataset.confirm});
      if(!result?.ok)toast(result?.message||'确认更新失败');
      else toast('已确认更新草稿');
      setTimeout(()=>void loadTasks(),500);
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(button=>button.addEventListener('click',async()=>{
      if(!confirm('确定删除这条本地同步记录吗？此操作不会删除远端草稿。'))return;
      const result=await chrome.runtime.sendMessage({type:'DELETE_TASK',id:button.dataset.delete,removeMapping:true});
      if(!result?.ok)toast(result?.message||'删除失败');
      else{toast('本地记录及关联已删除');await loadTasks();}
    }));
  }catch(error){toast((error as Error).message);}
}

function renderSettings(settings:ExtensionSettings){
  $<HTMLInputElement>('#sync-cover').checked=settings.syncCover;
  $<HTMLInputElement>('#auto-summary').checked=settings.autoSummary;
  $<HTMLInputElement>('#append-source-link').checked=settings.appendSourceLink;
  $<HTMLInputElement>('#confirm-update').checked=settings.confirmDraftUpdate;
  $<HTMLSelectElement>('#image-failure').value=settings.imageFailurePolicy;
  $<HTMLSelectElement>('#wechat-code-theme').value=settings.wechatCodeTheme||'onedark';
  $<HTMLInputElement>('#default-category').value=settings.defaultCsdnCategory;
  $<HTMLTextAreaElement>('#category-mappings').value=formatCategoryMappings(settings.categoryMappings);
}

async function saveSettingsFromForm(){
  currentSettings=normalizeSettings({
    syncCover:$<HTMLInputElement>('#sync-cover').checked,
    autoSummary:$<HTMLInputElement>('#auto-summary').checked,
    appendSourceLink:$<HTMLInputElement>('#append-source-link').checked,
    confirmDraftUpdate:$<HTMLInputElement>('#confirm-update').checked,
    imageFailurePolicy:$<HTMLSelectElement>('#image-failure').value,
    wechatCodeTheme:$<HTMLSelectElement>('#wechat-code-theme').value,
    defaultCsdnCategory:$<HTMLInputElement>('#default-category').value,
    categoryMappings:parseCategoryMappings($<HTMLTextAreaElement>('#category-mappings').value)
  });
  const result=await chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:currentSettings});
  if(!result?.ok){toast(result?.message||'设置保存失败');return;}
  renderSettings(currentSettings);
  toast('设置已保存');
}

async function loadSettings(){
  const result=await chrome.runtime.sendMessage({type:'GET_SETTINGS'});
  currentSettings=normalizeSettings(result?.settings);
  renderSettings(currentSettings);
}

/** 拉取 CSDN 分类专栏填充下拉建议；失败时静默降级为纯手输，不阻塞设置页。 */
async function loadCsdnCategories(){
  const hint=$('#category-hint');
  try{
    const result=await chrome.runtime.sendMessage({type:'FETCH_CSDN_CATEGORIES'});
    if(!result?.ok||!Array.isArray(result.categories)||!result.categories.length){
      if(result?.message)hint.textContent=`分类拉取失败（${result.message}），可直接手动输入。`;
      return;
    }
    const datalist=$('#csdn-category-options');
    datalist.innerHTML=(result.categories as string[]).slice(0,100).map(name=>`<option value="${escapeHtml(name)}"></option>`).join('');
    hint.textContent=`已载入你账号下的 ${result.categories.length} 个 CSDN 分类专栏，点击输入框选择。`;
  }catch{
    hint.textContent='分类拉取失败，可直接手动输入。';
  }
}

/** 远程健康状态：仅任一平台 broken 时展示警示条，点击详情跳转公开状态页。 */
async function checkHealthBanner(){
  const banner=$('#health-banner');
  try{
    const result=await chrome.runtime.sendMessage({type:'GET_HEALTH_STATUS'});
    if(!result?.alert)return;
    const status=result.status;
    const healthPlatforms:PlatformId[]=['csdn','wechat','cnblogs','zhihu','xiaohongshu'];
    const brokenPlatform=healthPlatforms.find(platform=>status?.[platform]==='broken');
    const broken=brokenPlatform?platformLabel(brokenPlatform):'掘金';
    $('#health-title').textContent=`${broken}接口状态异常`;
    $('#health-message').textContent=status?.message||'平台接口近期变动，同步可能失败';
    banner.hidden=false;
  }catch{
    // 后台不可达时静默隐藏
  }
}

const STATUS_PAGE_URL='https://juejin-sync.github.io/juejin-sync/status.html';

type DryRunReport={titleLength:number;contentLength:number;summaryPreview:string;categories:string[];imageCount:number;images:string[];containerCount:number;codeFenceCount:number;issues:string[];notices:string[]};

function closeDryRunModal(){
  $('#dryrun-modal').hidden=true;
}

function showDryRunModal(task:SyncTask,report:DryRunReport){
  const rows=[
    {label:'标题长度',value:`${report.titleLength} / 100 字`},
    {label:'正文字数',value:`约 ${report.contentLength} 字符`},
    {label:'命中分类',value:report.categories.length?report.categories.join('、'):'未命中（将不设置分类）'},
    {label:'待转存图片',value:report.imageCount?`${report.imageCount} 张外链图片`:'无外链图片'},
    {label:'容器转换',value:report.containerCount?`${report.containerCount} 个 ::: 容器将转为引用块`:'无掘金特有容器'},
    {label:'代码围栏',value:`${report.codeFenceCount} 个`}
  ];
  const summary=report.summaryPreview?`<div class="dryrun-summary"><span class="dryrun-summary-label">摘要预览</span><p>${escapeHtml(report.summaryPreview)}</p></div>`:'';
  const issues=report.issues.length?`<div class="dryrun-issues">${report.issues.map(item=>`<p>· ${escapeHtml(item)}</p>`).join('')}</div>`:'<div class="dryrun-issues ok"><p>· 未发现阻断风险，可放心同步</p></div>';
  const notices=report.notices.length?`<div class="dryrun-notices">${report.notices.map(item=>`<p>· ${escapeHtml(item)}</p>`).join('')}</div>`:'';
  $('#dryrun-body').innerHTML=`
    <b class="dryrun-task-title" title="${escapeHtml(task.article.title)}">${escapeHtml(task.article.title)}</b>
    <div class="dryrun-grid">${rows.map(row=>`<div class="dryrun-row"><span>${row.label}</span><b>${escapeHtml(row.value)}</b></div>`).join('')}</div>
    ${summary}
    ${issues}
    ${notices}`;
  $('#dryrun-modal').hidden=false;
}

async function runDryRun(taskId:string,button:HTMLButtonElement){
  button.disabled=true;
  const original=button.innerHTML;
  button.innerHTML='<span>预演中…</span>';
  try{
    const result=await chrome.runtime.sendMessage({type:'DRY_RUN_TASK',id:taskId});
    if(!result?.ok){toast(result?.message||'预演失败');return;}
    showDryRunModal(currentTasksCache.find(item=>item.id===taskId)||{article:{title:''}} as SyncTask,result.report as DryRunReport);
  }catch(error){
    toast((error as Error).message);
  }finally{
    button.disabled=false;
    button.innerHTML=original;
  }
}

document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach(button=>{
  button.addEventListener('click',()=>switchTab(button.dataset.tab as 'history'|'settings'));
  button.addEventListener('keydown',event=>{
    if(event.key==='ArrowRight'||event.key==='ArrowLeft'){
      event.preventDefault();
      const target=button.dataset.tab==='history'?'settings':'history';
      const targetBtn=$<HTMLButtonElement>(`.tab-button[data-tab="${target}"]`);
      targetBtn?.focus();
      switchTab(target);
    }
  });
});

$('#platform-trigger').addEventListener('click',event=>{
  event.stopPropagation();
  setPlatformMenu($('#platform-menu').hidden);
});
$('#login-state').addEventListener('click',()=>{
  selectPlatform('csdn');
  if(loginStatus==='logged-out')void chrome.runtime.sendMessage({type:'OPEN_CSDN_LOGIN'});
  else if(loginStatus==='error')void checkLogin();
});
$('#wechat-login-state').addEventListener('click',()=>{
  selectPlatform('wechat');
  if(wechatLoginStatus==='logged-out')void chrome.runtime.sendMessage({type:'OPEN_WECHAT_LOGIN'});
  else if(wechatLoginStatus==='error')void checkWechatLogin();
});
$('#cnblogs-login-state').addEventListener('click',()=>{
  selectPlatform('cnblogs');
  if(cnblogsLoginStatus==='logged-out')void chrome.runtime.sendMessage({type:'OPEN_CNBLOGS_LOGIN'});
  else if(cnblogsLoginStatus==='error')void chrome.runtime.sendMessage({type:'OPEN_CNBLOGS_LOGIN'});
  else void checkCnblogsLogin();
});
$('#zhihu-login-state').addEventListener('click',()=>{
  selectPlatform('zhihu');
  if(zhihuLoginStatus==='logged-out')void chrome.runtime.sendMessage({type:'OPEN_ZHIHU_LOGIN'});
  else if(zhihuLoginStatus==='error')void chrome.runtime.sendMessage({type:'OPEN_ZHIHU_LOGIN'});
  else void checkZhihuLogin();
});
$('#xiaohongshu-login-state').addEventListener('click',()=>{
  selectPlatform('xiaohongshu');
  if(xiaohongshuLoginStatus==='logged-out')void chrome.runtime.sendMessage({type:'OPEN_XIAOHONGSHU_LOGIN'});
  else if(xiaohongshuLoginStatus==='error')void chrome.runtime.sendMessage({type:'OPEN_XIAOHONGSHU_LOGIN'});
  else void checkXiaohongshuLogin();
});
document.addEventListener('click',event=>{
  if(!(event.target as Element).closest('.platform-switcher'))setPlatformMenu(false);
});

document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
  historyFilter=button.dataset.filter as typeof historyFilter;
  document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));
  void loadTasks();
}));

$<HTMLButtonElement>('#history-retry-all').addEventListener('click',async()=>{
  const result=await chrome.runtime.sendMessage({type:'RETRY_FAILED_TASKS'});
  if(!result?.ok){toast(result?.message||'批量重试失败');return;}
  toast(result.count?`已重试 ${result.count} 个失败任务`:'没有可重试任务');
  setTimeout(()=>void loadTasks(),500);
});

$<HTMLButtonElement>('#history-clear').addEventListener('click',async()=>{
  if(!confirm('确定清空全部同步历史吗？此操作不会删除目标平台草稿。'))return;
  const result=await chrome.runtime.sendMessage({type:'CLEAR_TASKS'});
  if(!result?.ok){toast(result?.message||'清空失败');return;}
  toast('同步历史已清空');
  await loadTasks();
});

['#sync-cover','#auto-summary','#append-source-link','#confirm-update','#image-failure','#wechat-code-theme'].forEach(selector=>$(selector).addEventListener('change',()=>void saveSettingsFromForm()));
['#default-category','#category-mappings'].forEach(selector=>$(selector).addEventListener('change',()=>void saveSettingsFromForm()));

$('#health-detail').addEventListener('click',()=>void chrome.tabs.create({url:STATUS_PAGE_URL,active:true}));
$('#dryrun-close').addEventListener('click',closeDryRunModal);
$('#dryrun-modal').addEventListener('click',event=>{
  if(event.target===$('#dryrun-modal'))closeDryRunModal();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
    if(!$('#dryrun-modal').hidden)closeDryRunModal();
    setPlatformMenu(false);
  }
});

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.syncTasks&&$('#pane-history').classList.contains('active'))void loadTasks();
});

try{
  const version=chrome.runtime.getManifest()?.version;
  if(version){
    const versionEl=$('#app-version');
    if(versionEl)versionEl.textContent=`版本 v${version}`;
    const brandVersionEl=$('#brand-version');
    if(brandVersionEl)brandVersionEl.textContent=`v${version}`;
  }
}catch{}

void loadTasks();
void loadSettings();
void loadCsdnCategories();
void checkLogin();
void checkWechatLogin();
void checkCnblogsLogin();
void checkZhihuLogin();
void checkXiaohongshuLogin();
void checkHealthBanner();
