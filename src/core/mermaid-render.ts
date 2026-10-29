// Mermaid 图表端侧离屏渲染调度器：在 Service Worker 环境中调用离屏 Chromium DOM 生成 PNG 图片。
import {Marked} from 'marked';
import {normalizeMarkdown} from '../targets/csdn-api';

const MERMAID_KEYWORDS=[
  'flowchart',
  'graph',
  'sequencediagram',
  'statediagram',
  'statediagram-v2',
  'classdiagram',
  'classdiagram-v2',
  'erdiagram',
  'gantt',
  'pie',
  'gitgraph',
  'mindmap',
  'timeline',
  'quadrantchart',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
  'c4deployment',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'kanban',
  'architecture-beta'
];

const KNOWN_CODE_LANGUAGES=new Set([
  'javascript','js','typescript','ts','jsx','tsx','vue','html','css','scss','sass','less',
  'json','yaml','yml','xml','markdown','md','sql','python','py','java','c','cpp','c++','cs','csharp',
  'go','golang','rust','rs','php','rb','ruby','swift','kotlin','kt','scala','dart','sh','bash','shell','zsh'
]);

/** 过滤开头的 frontmatter (---) 与注释 (%%)，提取首条图表声明指令 */
function getFirstMermaidCommand(text:string):string{
  const lines=text.split('\n').map(l=>l.trim());
  let inFrontmatter=false;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(!line)continue;
    if(i===0&&line==='---'){
      inFrontmatter=true;
      continue;
    }
    if(inFrontmatter){
      if(line==='---')inFrontmatter=false;
      continue;
    }
    if(line.startsWith('%%'))continue;
    return line;
  }
  return '';
}

/**
 * 判断代码块是否属于 Mermaid 图表，并输出规范化的渲染源码
 */
export function resolveMermaidDiagram(lang:string|undefined,text:string):{isDiagram:boolean;renderCode:string}{
  const trimmedText=text.trim();
  const rawLang=(lang||'').trim();
  const firstLangWord=rawLang.split(/\s+/)[0].toLowerCase();

  // 若明确标注为常规编程语言，则不当作图表处理
  if(KNOWN_CODE_LANGUAGES.has(firstLangWord)){
    return{isDiagram:false,renderCode:''};
  }

  const firstCommand=getFirstMermaidCommand(trimmedText);
  const firstTextWord=firstCommand.toLowerCase().split(/[\s:;]/)[0];

  const isDiagramTypeLang=['mermaid','flowchart','flow','graph','sequence','sequencediagram','statediagram'].includes(firstLangWord);
  const isKeywordInLang=MERMAID_KEYWORDS.some(k=>firstLangWord.startsWith(k));
  const isKeywordInText=MERMAID_KEYWORDS.includes(firstTextWord);

  if(firstLangWord==='mermaid'||isDiagramTypeLang||isKeywordInLang||isKeywordInText){
    let renderCode=trimmedText;
    // 如果语言围栏包含方向指令（如 ```flowchart TD），而代码正文首行未包含，补充首行声明
    if(!isKeywordInText&&isKeywordInLang){
      renderCode=`${rawLang}\n${trimmedText}`;
    }
    return{isDiagram:true,renderCode};
  }

  return{isDiagram:false,renderCode:''};
}

export interface MermaidBlock{
  originalText:string;
  renderCode:string;
}

/**
 * 完整解析 Markdown AST，提取所有 Mermaid/Flowchart/Graph 等图表代码块
 */
export function extractMermaidBlocks(markdown:string):MermaidBlock[]{
  const marked=new Marked({gfm:true});
  const tokens=marked.lexer(normalizeMarkdown(markdown));
  const blocks:MermaidBlock[]=[];

  function walk(tokenList:Array<any>){
    for(const token of tokenList){
      if(token.type==='code'){
        const {isDiagram,renderCode}=resolveMermaidDiagram(token.lang,token.text);
        if(isDiagram){
          blocks.push({originalText:token.text.trim(),renderCode});
        }
      }
      if('tokens' in token&&Array.isArray(token.tokens)){
        walk(token.tokens);
      }
      if('items' in token&&Array.isArray(token.items)){
        for(const item of token.items){
          if('tokens' in item&&Array.isArray(item.tokens)){
            walk(item.tokens);
          }
        }
      }
    }
  }

  walk(tokens);
  return blocks;
}

let creatingDocument:Promise<boolean>|null=null;

async function pingOffscreen(timeoutMs=4000):Promise<boolean>{
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    const ready=await new Promise<boolean>((resolve)=>{
      const timer=setTimeout(()=>resolve(false),500);
      try{
        chrome.runtime.sendMessage({target:'offscreen',type:'PING'},(resp)=>{
          clearTimeout(timer);
          if(!chrome.runtime?.lastError&&resp?.ok){
            resolve(true);
          }else{
            resolve(false);
          }
        });
      }catch{
        clearTimeout(timer);
        resolve(false);
      }
    });
    if(ready)return true;
    await new Promise((r)=>setTimeout(r,100));
  }
  return false;
}

export async function ensureOffscreenDocument():Promise<boolean>{
  if(typeof chrome==='undefined'||!chrome.offscreen?.createDocument)return false;
  if(creatingDocument)return creatingDocument;
  creatingDocument=(async()=>{
    const reasons = [
      chrome.offscreen?.Reason?.DOM_PARSER || ('DOM_PARSER' as any),
      chrome.offscreen?.Reason?.BLOBS || ('BLOBS' as any)
    ];
    const create=()=>chrome.offscreen.createDocument({url:'offscreen.html',reasons,justification:'Render Mermaid diagrams into PNG images for WeChat Official Accounts'});
    try{
      let exists=false;
      try{
        if(typeof chrome.runtime?.getContexts==='function'){
          const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT' as any],documentUrls:[chrome.runtime.getURL('offscreen.html')]});
          exists=contexts.length>0;
        }else if(typeof (self as any).clients?.matchAll==='function'){
          const clients=await (self as any).clients.matchAll();
          const offscreenUrl=chrome.runtime.getURL('offscreen.html');
          exists=clients.some((client:any)=>client.url===offscreenUrl||client.url?.endsWith('offscreen.html'));
        }
      }catch{}
      if(exists){
        if(await pingOffscreen(1500))return true;
        await chrome.offscreen.closeDocument();
      }
      try{await create();}
      catch(error:any){
        // 其他调用者先创建了文档时先探活；失去响应则只关闭并重建一次。
        if(!/single offscreen|already exists/i.test(error?.message||''))throw error;
        if(await pingOffscreen(1500))return true;
        await chrome.offscreen.closeDocument();
        await create();
      }
      return await pingOffscreen(4000);
    }catch(error){
      console.warn('创建离屏渲染文档失败：',error);
      return false;
    }
  })();
  try{return await creatingDocument;}
  finally{creatingDocument=null;}
}

/**
 * 将单个 Mermaid 代码块调度至离屏文档渲染为 PNG DataURL
 */
export async function renderMermaidToPng(code:string):Promise<string|undefined>{
  const hasOffscreen=await ensureOffscreenDocument();
  if(!hasOffscreen)return undefined;
  for(let attempt=0;attempt<3;attempt++){
    const result=await new Promise<string|undefined>((resolve,reject)=>{
      const timer=setTimeout(()=>resolve(undefined),10000);
      try{
        chrome.runtime.sendMessage(
          {target:'offscreen',type:'RENDER_MERMAID',code},
          (response:{ok?:boolean;dataUrl?:string;error?:string}|undefined)=>{
            clearTimeout(timer);
            if(chrome.runtime?.lastError){
              resolve(undefined);
            }else if(response?.ok===false&&response.error){
              // 离屏渲染已明确失败，保留语法/光栅化原因，不重复执行相同源码。
              reject(new Error(response.error));
            }else if(!response?.ok||!response?.dataUrl){
              resolve(undefined);
            }else{
              resolve(response.dataUrl);
            }
          }
        );
      }catch{
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    if(result)return result;
    await new Promise((r)=>setTimeout(r,150));
  }
  return undefined;
}

/**
 * 扫描并批量渲染 Markdown 中的所有 Mermaid/Flowchart 代码块，生成源码到 PNG DataURL 的映射表
 */
export async function renderAllMermaidBlocks(markdown:string):Promise<Map<string,string>>{
  const blocks=extractMermaidBlocks(markdown);
  const map=new Map<string,string>();
  for(let i=0;i<blocks.length;i++){
    const block=blocks[i];
    // 包含图表类型和方向的完整源码才是图片身份，不能仅使用围栏正文。
    if(map.has(block.renderCode))continue;
    let dataUrl:string|undefined;
    try{
      dataUrl=await renderMermaidToPng(block.renderCode);
    }catch(error){
      throw new Error(`第 ${i+1} 个 Mermaid 图表渲染失败：${error instanceof Error?error.message:String(error)}`);
    }
    if(!dataUrl)throw new Error(`第 ${i+1} 个 Mermaid 图表渲染失败，请检查图表语法或重新加载扩展后重试`);
    map.set(block.renderCode,dataUrl);
  }
  return map;
}
