// 防风控批量同步队列：提供有限并发、随机抖动延迟、暂停/继续与单篇失败隔离。
import type {PlatformId} from '../types';

export type BatchTaskStatus='pending'|'syncing'|'saved'|'failed'|'skipped';

export interface BatchTaskItem{
  id:string;
  articleId:string;
  title:string;
  platform:PlatformId;
  status:BatchTaskStatus;
  draftUrl?:string;
  error?:string;
}

export interface BatchStats{
  total:number;
  completed:number;
  success:number;
  failed:number;
  skipped:number;
  state:'idle'|'running'|'paused'|'stopped'|'completed';
}

export type TaskWorker=(item:BatchTaskItem)=>Promise<{ok:boolean;draftUrl?:string;error?:string}>;

export interface BatchQueueOptions{
  concurrency?:number;
  jitterMinMs?:number;
  jitterMaxMs?:number;
  worker:TaskWorker;
  onProgress?:(item:BatchTaskItem,stats:BatchStats)=>void;
}

export class BatchSyncQueue{
  private items:BatchTaskItem[]=[];
  private concurrency:number;
  private jitterMinMs:number;
  private jitterMaxMs:number;
  private worker:TaskWorker;
  private onProgress?:(item:BatchTaskItem,stats:BatchStats)=>void;
  private state:'idle'|'running'|'paused'|'stopped'|'completed'='idle';
  private pausePromise:Promise<void>|null=null;
  private pauseResolver:(()=>void)|null=null;
  private currentIndex=0;
  private activeCount=0;

  constructor(options:BatchQueueOptions){
    this.concurrency=Math.max(1,options.concurrency??2);
    this.jitterMinMs=Math.max(0,options.jitterMinMs??1000);
    this.jitterMaxMs=Math.max(this.jitterMinMs,options.jitterMaxMs??2500);
    this.worker=options.worker;
    this.onProgress=options.onProgress;
  }

  getStats():BatchStats{
    const total=this.items.length;
    let success=0,failed=0,skipped=0;
    for(const item of this.items){
      if(item.status==='saved')success++;
      else if(item.status==='failed')failed++;
      else if(item.status==='skipped')skipped++;
    }
    return{
      total,
      completed:success+failed+skipped,
      success,
      failed,
      skipped,
      state:this.state
    };
  }

  getItems():BatchTaskItem[]{
    return this.items;
  }

  getFailedItems():BatchTaskItem[]{
    return this.items.filter(item=>item.status==='failed');
  }

  private sleep(ms:number):Promise<void>{
    return new Promise(resolve=>setTimeout(resolve,ms));
  }

  private async jitterDelay():Promise<void>{
    if(this.jitterMaxMs<=0)return;
    const duration=this.jitterMinMs+Math.random()*(this.jitterMaxMs-this.jitterMinMs);
    await this.sleep(duration);
  }

  private async waitIfPaused():Promise<void>{
    while(this.state==='paused'&&this.pausePromise){
      await this.pausePromise;
    }
  }

  pause():void{
    if(this.state!=='running')return;
    this.state='paused';
    this.pausePromise=new Promise<void>(resolve=>{
      this.pauseResolver=resolve;
    });
    this.notifyProgress();
  }

  resume():void{
    if(this.state!=='paused')return;
    this.state='running';
    if(this.pauseResolver){
      const resolve=this.pauseResolver;
      this.pauseResolver=null;
      this.pausePromise=null;
      resolve();
    }
    this.notifyProgress();
  }

  stop():void{
    this.state='stopped';
    if(this.pauseResolver){
      this.pauseResolver();
      this.pauseResolver=null;
      this.pausePromise=null;
    }
    for(let i=this.currentIndex;i<this.items.length;i++){
      if(this.items[i].status==='pending'){
        this.items[i].status='skipped';
        this.items[i].error='用户终止了批量任务';
      }
    }
    this.notifyProgress();
  }

  private notifyProgress(item?:BatchTaskItem):void{
    if(this.onProgress){
      this.onProgress(item||this.items[0],this.getStats());
    }
  }

  private isStopped():boolean{
    return(this.state as string)==='stopped';
  }

  async start(items:BatchTaskItem[]):Promise<BatchStats>{
    this.items=items.map(item=>({...item}));
    this.currentIndex=0;
    this.state='running';
    this.notifyProgress();

    const dispatchNext=async():Promise<void>=>{
      while(this.currentIndex<this.items.length){
        if(this.isStopped())break;
        await this.waitIfPaused();
        if(this.isStopped())break;

        const index=this.currentIndex++;
        const item=this.items[index];
        if(!item||item.status!=='pending')continue;

        // 注入抖动延迟，防范突发流量触发频控
        await this.jitterDelay();
        if(this.isStopped())break;
        await this.waitIfPaused();
        if(this.isStopped())break;

        item.status='syncing';
        this.notifyProgress(item);

        try{
          const result=await this.worker(item);
          if(result.ok){
            item.status='saved';
            item.draftUrl=result.draftUrl;
            item.error=undefined;
          }else{
            item.status='failed';
            item.error=result.error||'同步失败';
          }
        }catch(error){
          // 单篇异常彻底隔离，决不阻断后续任务
          item.status='failed';
          item.error=(error as Error).message||String(error);
        }

        this.notifyProgress(item);
      }
    };

    const workers:Promise<void>[]=[];
    const workerCount=Math.min(this.concurrency,this.items.length);
    for(let i=0;i<workerCount;i++){
      workers.push(dispatchNext());
    }

    await Promise.all(workers);

    if(!this.isStopped()){
      this.state='completed';
    }
    this.notifyProgress();
    return this.getStats();
  }

  async retryFailed():Promise<BatchStats>{
    const failedIndices:number[]=[];
    this.items.forEach((item,index)=>{
      if(item.status==='failed'){
        item.status='pending';
        item.error=undefined;
        failedIndices.push(index);
      }
    });
    if(!failedIndices.length)return this.getStats();

    this.state='running';
    this.notifyProgress();

    let pointer=0;
    const dispatchNext=async():Promise<void>=>{
      while(pointer<failedIndices.length){
        if(this.isStopped())break;
        await this.waitIfPaused();
        if(this.isStopped())break;

        const idx=pointer++;
        const itemIndex=failedIndices[idx];
        const item=this.items[itemIndex];
        if(!item||item.status!=='pending')continue;

        await this.jitterDelay();
        if(this.isStopped())break;
        await this.waitIfPaused();
        if(this.isStopped())break;

        item.status='syncing';
        this.notifyProgress(item);

        try{
          const result=await this.worker(item);
          if(result.ok){
            item.status='saved';
            item.draftUrl=result.draftUrl;
            item.error=undefined;
          }else{
            item.status='failed';
            item.error=result.error||'同步失败';
          }
        }catch(error){
          item.status='failed';
          item.error=(error as Error).message||String(error);
        }

        this.notifyProgress(item);
      }
    };

    const workers:Promise<void>[]=[];
    const workerCount=Math.min(this.concurrency,failedIndices.length);
    for(let i=0;i<workerCount;i++){
      workers.push(dispatchNext());
    }

    await Promise.all(workers);

    if(!this.isStopped()){
      this.state='completed';
    }
    this.notifyProgress();
    return this.getStats();
  }
}
