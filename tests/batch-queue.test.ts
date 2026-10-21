import {describe,expect,it,vi} from 'vitest';
import {BatchSyncQueue,type BatchTaskItem} from '../src/core/batch-queue';

describe('BatchSyncQueue 防风控批量同步队列',()=>{
  const mockItems:BatchTaskItem[]=[
    {id:'1:csdn',articleId:'1',title:'文章一',platform:'csdn',status:'pending'},
    {id:'1:wechat',articleId:'1',title:'文章一',platform:'wechat',status:'pending'},
    {id:'2:csdn',articleId:'2',title:'文章二',platform:'csdn',status:'pending'}
  ];

  it('能成功按顺序执行并正确汇总统计',async()=>{
    const handled:string[]=[];
    const queue=new BatchSyncQueue({
      concurrency:2,
      jitterMinMs:0,
      jitterMaxMs:0,
      worker:async item=>{
        handled.push(item.id);
        return{ok:true,draftUrl:`https://example.com/draft/${item.id}`};
      }
    });

    const stats=await queue.start(mockItems);
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(3);
    expect(stats.success).toBe(3);
    expect(stats.failed).toBe(0);
    expect(stats.state).toBe('completed');
    expect(handled).toEqual(['1:csdn','1:wechat','2:csdn']);
    expect(queue.getItems().every(i=>i.status==='saved')).toBe(true);
  });

  it('单篇失败彻底隔离，不阻塞后续任务执行',async()=>{
    const queue=new BatchSyncQueue({
      concurrency:1,
      jitterMinMs:0,
      jitterMaxMs:0,
      worker:async item=>{
        if(item.id==='1:wechat'){
          throw new Error('微信接口限流 200013');
        }
        return{ok:true,draftUrl:`https://example.com/draft/${item.id}`};
      }
    });

    const stats=await queue.start(mockItems);
    expect(stats.total).toBe(3);
    expect(stats.completed).toBe(3);
    expect(stats.success).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.state).toBe('completed');

    const items=queue.getItems();
    expect(items[0].status).toBe('saved');
    expect(items[1].status).toBe('failed');
    expect(items[1].error).toContain('微信接口限流 200013');
    expect(items[2].status).toBe('saved');
  });

  it('支持在运行中暂停并在恢复后继续完成剩余任务',async()=>{
    let callCount=0;
    let queueRef:BatchSyncQueue|null=null;

    const queue=new BatchSyncQueue({
      concurrency:1,
      jitterMinMs:0,
      jitterMaxMs:0,
      worker:async item=>{
        callCount++;
        if(item.id==='1:csdn'){
          // 第一个任务处理完后暂停
          queueRef?.pause();
        }
        return{ok:true};
      }
    });
    queueRef=queue;

    const startPromise=queue.start(mockItems);

    // 等待第一个任务完成并触发 pause
    await new Promise(r=>setTimeout(r,50));
    expect(queue.getStats().state).toBe('paused');
    expect(callCount).toBe(1);

    // 唤醒继续
    queue.resume();
    const stats=await startPromise;

    expect(stats.state).toBe('completed');
    expect(stats.success).toBe(3);
    expect(callCount).toBe(3);
  });

  it('支持中途终止并将剩余任务标记为 skipped',async()=>{
    const queue=new BatchSyncQueue({
      concurrency:1,
      jitterMinMs:0,
      jitterMaxMs:0,
      worker:async item=>{
        if(item.id==='1:csdn'){
          queue.stop();
        }
        return{ok:true};
      }
    });

    const stats=await queue.start(mockItems);
    expect(stats.state).toBe('stopped');
    expect(stats.success).toBe(1);
    expect(stats.skipped).toBe(2);
    expect(queue.getItems()[1].status).toBe('skipped');
    expect(queue.getItems()[2].status).toBe('skipped');
  });

  it('支持仅重试失败项',async()=>{
    let failFirst=true;
    const queue=new BatchSyncQueue({
      concurrency:1,
      jitterMinMs:0,
      jitterMaxMs:0,
      worker:async item=>{
        if(item.id==='1:wechat'&&failFirst){
          return{ok:false,error:'临时网络超时'};
        }
        return{ok:true};
      }
    });

    const initialStats=await queue.start(mockItems);
    expect(initialStats.failed).toBe(1);

    failFirst=false;
    const retryStats=await queue.retryFailed();
    expect(retryStats.success).toBe(3);
    expect(retryStats.failed).toBe(0);
    expect(queue.getItems().every(i=>i.status==='saved')).toBe(true);
  });
});
