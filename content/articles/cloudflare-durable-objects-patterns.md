---
title: "Durable Objects 的典型模式：协调器、限流、房间、WebSocket 休眠与 alarm"
description: 基于单线程与单实例的模型，讲 Durable Objects 的几种典型模式：串行协调器、滑动窗口限流、聊天房间、WebSocket Hibernation 与 alarm 定时任务，以及各自的取舍与边界。
date: 2026-10-22
tags: [cloudflare, tutorial, coordination]
category: cloudflare
chapter: 10
---

模型讲清楚之后，问题变成：什么形状的需求值得交给 Durable Objects（下称 DO）。本文按「一个 ID 对应一个串行执行者」这条不变量，梳理几种典型模式。模型本身见 [Durable Objects：单线程模型、一个 ID 一个实例与存储](/articles/cloudflare-durable-objects-model)，建议先读。限额与计费数字以 2026-10 官方文档为准，会变化，本文引用的均来自官方文档，未实测；代码行为在本地 wrangler dev 下验证过的会特别注明。

## 判断一个需求是否适合

模式的共同点是：存在一个**自然的分片键**（房间、用户、文档、租户、订单），键内需要串行或强一致，键之间互不相关。没有分片键、或者所有请求都落在同一个键上，DO 就帮不上忙。官方 Rules 页给的粗略吞吐参考是：简单转发约 1000 req/s，带处理的约 500 到 750，带存储写入的复杂逻辑约 200 到 500（以 2026-10 官方文档为准，会变化，来自官方文档、未实测，本地模拟的吞吐没有参考意义）。超出就要继续切分键。

## 模式一：协调器

典型场景：同一个用户的订单号生成、同一份文档的版本推进、同一个库存条目的预留。做法是让一个 DO 代表这个实体，所有修改都走它的方法。

```ts
export class Inventory extends DurableObject<Env> {
  reserve(qty: number): boolean {
    const sql = this.ctx.storage.sql;
    const left = sql.exec("SELECT stock FROM item WHERE id = 1").one().stock as number;
    if (left < qty) return false;
    sql.exec("UPDATE item SET stock = stock - ? WHERE id = 1", qty);
    return true;
  }
}
```

关键是 `reserve` 里没有 `await`，读和写在一个同步段内完成，不会被其他请求穿插。本地并发 50 次同类调用，结果精确无丢失；而把读和写拆在 `await` 两侧、中间有 `setTimeout` 之类的非存储等待时，本地实测出现了丢失更新（`fetch` 属于同一类，官方文档明确说输入闸门不保护它，本地未单独测）。所以协调器要守住的纪律就一条：**判断与修改之间不要有非存储的 await**；必须有时，用版本号做乐观锁。

何时别用：如果协调的对象本来就在 D1 里，行级事务够用，就不要引入 DO 再造一份状态。DO 适合「这个实体的所有状态都归我」，不适合「给别人的数据加个锁」。

## 模式二：限流

按 key（用户、IP、API token）限流，是 DO 的经典用法：每个 key 一个对象，计数在对象内串行，没有分布式计数的不一致。

```ts
export class Limiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS w(ts INTEGER)");
  }

  allow(limit: number, windowMs: number): boolean {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM w WHERE ts < ?", now - windowMs);
    const c = sql.exec("SELECT count(*) AS c FROM w").one().c as number;
    if (c >= limit) return false;
    sql.exec("INSERT INTO w VALUES (?)", now);
    return true;
  }
}
```

本地实测：窗口 60 秒、上限 5，连续 7 次调用，前 5 次通过，后 2 次拒绝。

取舍上要清醒：每次判断都是一次到 DO 的往返，若调用者离该对象很远会有额外延迟；每次通过还会写一行，计入 SQLite 的 rows written 计费。如果你只需要「大致限流」，比如防止明显滥用，在边缘做粗粒度判断会更便宜。需要**精确**且按 key 隔离时，DO 才值。别忘了单个热点 key（比如一个共享 IP）会把单个对象打到软上限。

## 模式三：房间（聚合连接）

聊天室、协作文档、多人游戏会话的共同需求：多个客户端的消息要汇到同一处，再广播。让「房间 ID」映射到 DO，客户端的 WebSocket 都连到这个对象，对象在内存里持有连接并转发。

这里有一个和协调器同源的约束：房间里所有消息都在一个线程里处理，这正是你想要的顺序保证，也是单房间规模的天花板。大房间要按业务切分，例如按频道分片。

## 模式四：WebSocket Hibernation

朴素写法是 `server.accept()`，对象因此一直驻留内存并持续计费，哪怕所有人都沉默。官方推荐改用 Hibernation API：由 `ctx.acceptWebSocket()` 接受连接，把处理逻辑放在类的 `webSocketMessage`、`webSocketClose`、`webSocketError` 方法里。对象空闲后可以从内存中移除，而客户端连接依然保持，来消息时运行时重建对象，重新执行构造函数。

```ts
export class Room extends DurableObject<Env> {
  async fetch(_req: Request) {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ["room"]);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    server.serializeAttachment({ joinedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const who = ws.deserializeAttachment();
    for (const peer of this.ctx.getWebSockets("room")) {
      peer.send(`${JSON.stringify(who)}:${msg}`);
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }
}
```

本地用两个 WebSocket 客户端验证：一个发 hello，两个客户端都收到带附件的广播；发 ping 立即得到自动应答 pong。休眠本身（空闲后被移出内存）在本地不容易观察，这部分只能引用文档。

使用时有几条要点，来自官方文档：

- 内存状态在休眠时丢失，每连接的小元数据放进 `serializeAttachment`，上限 16384 字节，更大的数据放存储、附件里只存键。
- 连接任何一端关闭，附件就消失。
- 有未完成的 `setTimeout`、`setInterval`、进行中的 I/O 或未完成的 `waitUntil`、出站连接，或使用标准 WebSocket API，都会阻止休眠。生命周期页给出的休眠触发约为空闲 10 秒，并注明具体值由运行时决定、可能变化。
- 休眠期间不累计时长计费；计费上，WebSocket 连接建立算一次请求，入站消息按 20:1 折算为请求，出站消息与协议 ping 不计，`setWebSocketAutoResponse` 的自动应答不产生时长费用（来自官方文档，未实测，价格以官方定价页为准）。
- 部署新版本会重启所有对象并断开所有 WebSocket，客户端要有重连逻辑。
- 兼容日期 2026-04-07 及以后，运行时会自动回复 Close 帧；更早的日期要在 `webSocketClose` 里手动 `close`，否则客户端可能看到 1006。

误区：以为休眠后「房间状态」还在。构造函数会重跑，成员列表、游标等如果只在内存里，就没了。要么每次用 `ctx.getWebSockets()` 重建，要么落存储。

## 模式五：alarm

alarm 是每个对象一个的、可持久的定时器。`setAlarm(时间戳毫秒)` 设置，到点调用 `alarm()` 方法。典型用法：会话过期、延迟清理、批量刷盘、对同一实体的周期任务。

```ts
export class Session extends DurableObject<Env> {
  async touch() {
    await this.ctx.storage.setAlarm(Date.now() + 30 * 60_000);
  }

  async alarm(info?: AlarmInvocationInfo) {
    this.ctx.storage.sql.exec("DELETE FROM data");
    // 周期任务需要在这里再次 setAlarm
  }
}
```

本地实测：`setAlarm(now + 500ms)` 后，`alarm()` 在约半秒后触发，`alarmInfo` 里有 `retryCount: 0` 与 `isRetry: false`。再让 `alarm()` 前两次都抛错：第二次、第三次调用的 `retryCount` 分别是 1、2，`isRetry` 为 true，重试间隔大约 2 秒、再约 4 到 5 秒，符合「从 2 秒起指数退避」；`alarm()` 运行期间 `getAlarm()` 返回 `null`。这些是本地 workerd 的行为，线上的调度精度未实测。

以下语义来自官方文档，未实测（重试上限 6 次等数值以 2026-10 官方文档为准）：

- 每个对象同一时刻只有一个 alarm，再次 `setAlarm` 会覆盖。
- 保证至少一次执行，所以 `alarm()` 必须幂等。
- `alarm()` 抛未捕获异常时自动重试，从 2 秒起指数退避，最多 6 次，且重试只针对最近一次 `setAlarm`。想无限重试，就自己捕获并重新 `setAlarm`。
- alarm 不自动重复，周期任务要在处理完再设置下一次。
- 对象从休眠中醒来时构造函数先于 `alarm()` 运行，构造里若无条件 `setAlarm` 会覆盖已有的，要先 `getAlarm()` 判断。
- 每次 `setAlarm` 在 SQLite 后端计一次写入，每次 alarm 调用计一次请求。

多事件的做法是：把待办放进表里，`alarm()` 处理所有到期项，然后只为最近的下一项设置 alarm。

取舍：alarm 是**按实体**的定时器，不是全局 cron。全站定时任务用 Workers 的 Cron Triggers；跨步骤、可恢复的长流程见 [Workflows](/articles/cloudflare-workflows)；需要可靠地「至少一次」投递给别的系统，见 [Queues](/articles/cloudflare-queues)。

## 通用的边界

- 每个模式都依赖「一个键一个对象」。键的选择是设计的主体，选差了，要么热点，要么无法聚合。
- 跨对象的事务不存在。多个对象要一起成功，得用 Workflows 之类的编排，或者设计成幂等的补偿。
- 对 DO 的调用可能因过载或临时故障失败，文档建议检查错误的 `retryable` 与 `overloaded` 属性并带退避地重试，所以方法要设计成可安全重试。

## 小结

协调器、限流、房间、Hibernation、alarm 其实是同一件事的五种面孔：把一个实体的串行执行者、私有存储与定时器放在一起。选用时先问分片键是什么、单个键的负载上限在哪、状态丢了能否从存储重建。这三问答得出来，就值得用 DO；答不出来，多半该用 D1、KV、Queues 或 Workflows。

## 延伸阅读

- [Durable Objects：单线程模型、一个 ID 一个实例与存储](/articles/cloudflare-durable-objects-model)
- [Cloudflare 存储怎么选](/articles/cloudflare-storage-decision-tree)
- [Workflows：长流程、步骤重试，以及和 Queues 怎么分工](/articles/cloudflare-workflows)
- 官方文档：Durable Objects 的 WebSockets、Alarms 与 Rules of Durable Objects 页面
