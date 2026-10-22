---
title: "Durable Objects：单线程模型、一个 ID 一个实例与存储"
description: 理解 Durable Objects 的核心模型：同一 ID 全局只有一个实例、单线程处理事件、输入输出闸门与 await 竞态，以及 SQLite 存储、生命周期与取舍。
date: 2026-10-22
tags: [cloudflare, tutorial, coordination]
category: cloudflare
chapter: 9
---

Workers 天生无状态：任何一个请求可能落在任何一台机器的任何一个 isolate 里，彼此看不见。这对大多数请求处理是优点，但一旦问题变成「这一千个请求要对同一件东西排队」，比如同一个聊天室、同一份文档、同一个用户的额度，无状态就成了障碍。Durable Objects（下称 DO）解决的正是这一类问题。

本文只讲模型：它保证什么、不保证什么、存储怎么用。典型用法放在 [Durable Objects 的典型模式](/articles/cloudflare-durable-objects-patterns)。文中涉及限额与计费的数字以 2026-10 官方文档为准，会变化，且均来自官方文档，未实测。

## 朴素做法为什么不够

要让多个请求对同一份状态做「读-改-写」，常见做法有三种：

- 用数据库事务或行锁：能行，但每次都要往返数据库，热点行上锁竞争明显，且你得自己设计锁与超时。
- 用 KV 存计数：KV 最终一致，读到旧值是常态，不能当协调工具，详见 [KV：最终一致的真实含义](/articles/cloudflare-kv)。
- 在 Worker 内存里放变量：不同 isolate 各有一份，互不可见，也随时被回收。

DO 的思路是反过来：不让请求去找锁，而是让**状态所在的那个实例**成为唯一的处理者，所有相关请求都路由到它。

## 模型：一个 ID，一个实例，一个线程

三条核心事实：

1. 每个 DO 由 ID 标识。同一个 ID 在全球同一时刻最多只有一个活动实例，所有对它的调用都被路由到那里。
2. 实例是单线程的：同一时刻只有一段 JS 在跑，没有并行的数据竞争。
3. 实例自带私有的持久化存储，只有它自己能访问。

创建 ID 有两种方式。`getByName`（等价于 `idFromName` 加 `get`）从名字派生出确定性 ID，最常用，用于「房间 xyz」「用户 123」这类天然有业务键的对象。`newUniqueId` 生成随机 ID，需要你自己保存映射。官方文档提到，名字派生的 ID 首次使用时要做一次全局检查，可能多花几百毫秒，之后位置会被缓存。创建 stub 本身不会唤醒对象，第一次调用方法才会。

先看一个最小例子，配置用 wrangler.jsonc，类必须通过迁移声明为 SQLite 后端：

```jsonc
{
  "name": "counter",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "durable_objects": {
    "bindings": [{ "name": "COUNTER", "class_name": "Counter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

```ts
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS hits(id INTEGER PRIMARY KEY, n INTEGER)",
      );
      ctx.storage.sql.exec("INSERT OR IGNORE INTO hits VALUES (1, 0)");
    });
  }

  inc() {
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE hits SET n = n + 1 WHERE id = 1");
    return sql.exec("SELECT n FROM hits WHERE id = 1").one().n as number;
  }
}

export default {
  async fetch(req: Request, env: Env) {
    const stub = env.COUNTER.getByName("home");
    return Response.json({ n: await stub.inc() });
  },
};
```

公有方法就是 RPC 端点（兼容日期 2024-04-03 及以后），不必再手写 `fetch` 去解析请求。调用时务必 `await`，否则错误和返回值都会丢。

本地用 wrangler dev 实测：对同一个名字并发发起 50 次 `inc()`，最终值是 50，没有丢失更新。

## 单线程不等于没有竞态

这是最容易误解的一点。单线程保证的是**一段同步代码执行期间不会被打断**，而不是整个方法不会被其他请求穿插。一旦出现 `await`，实例就可以去处理别的事件。

DO 为此提供了两道闸门：

- **输入闸门**：在同步执行和存储操作期间，暂不投递新事件，所以「读存储、改、写存储」这类只依赖存储的流程通常是安全的。
- **输出闸门**：回复、出站消息会被扣住，直到之前的写入落盘确认，客户端不会收到「已保存」却实际丢失的确认。同时，连续不夹 `await` 的写入会被合并为一次原子提交。

但输入闸门**只保护存储 I/O**，不保护 `fetch()`、R2、`setTimeout` 这类非存储等待。官方文档明确说，这些点上其他请求可以插进来。

本地实测：把「先读 `storage.get`，等待 5ms，再 `storage.put(v+1)`」并发调用 10 次，返回值全是 1，最终存储值是 1，更新全部丢失；内存字段同样的写法也是 1。而全部用同步的 `sql.exec` 完成的版本，50 次并发得到精确的 50。再做一组对照：读改写只用异步的 `storage.get` 加 `storage.put`、中间**没有**任何非存储的 `await`，并发 30 次，最终值精确是 30，这正是输入闸门在起作用。也就是说，丢更新的条件不是「用了 async API」，而是「在读和写之间放了非存储的等待」。输出闸门在本地难以观察（需要制造写盘失败），这部分只引官方文档，未实测。结论很直接：

- 读-改-写尽量写成中间没有 `await` 的同步段，SQL 一条语句或 `transactionSync` 最理想。
- 必须跨 `await` 时，用乐观锁：写之前检查版本号，不对就重试。
- 别把内存变量当作可跨 `await` 安全维护的真值。

`transactionSync(() => {...})` 里抛错会回滚，本地实测抛错后值保持原样。它的回调必须是同步的。`BEGIN`/`SAVEPOINT` 不能直接用 `exec` 执行，本地实测会抛出要求改用 `transaction()`/`transactionSync()` 的错误。

`blockConcurrencyWhile` 会暂停所有并发，官方建议只用于构造函数里的初始化和迁移，不要包住外部 I/O，否则单实例吞吐会被拖垮（文档按每次约 5ms 估算，约 200 req/s）。

## 存储

SQLite 后端是官方推荐的新对象默认选择，两套 API 并存：

- `ctx.storage.sql.exec(query, ...bindings)` 返回游标，可用 `toArray()`、`one()`、`raw()`。游标应在下一个 `await` 之前消费完。
- 键值接口：同步的 `ctx.storage.kv`，以及异步的 `ctx.storage.get/put/delete/list`（批量最多 128 个键）。

官方文档列出的几个限额（以 2026-10 官方文档为准，会变化，均来自官方文档、未实测）：Paid 账户每个 DO 最多 10 GB；键加值合计 2 MB，SQL 单行或单个字符串 2 MB，单条语句 100 KB，绑定参数最多 100 个。单对象的软上限约为每秒 1000 个请求，超过会收到「overloaded」错误；复杂处理通常只能到几百。另外 SQLite 后端支持 30 天内的时间点恢复，本地开发不可用。

**Free 账户的存储上限官方页面自相矛盾**：限额表写单对象 10 GB、Free 账户合计 5 GB，同一页的 FAQ 却写 Free 每个对象 1 GB。以官方为准；规划 Free 账户时保守地按「合计 5 GB、单对象别指望超过 1 GB」处理。另外本地模拟不执行这些大小限制：本地实测往 SQL 里写入 2.1 MB 的单个字符串并没有报错，别用本地结果判断自己有没有超限，而 101 个绑定参数在本地会被拒绝。

存储是**每个对象一份**。这意味着你不能对「所有房间」做一条 SQL 查询。需要跨对象的聚合，要么放进 D1（见 [D1：迁移、事务与批处理](/articles/cloudflare-d1)），要么由父对象或外部系统汇总。

## 生命周期与易失性

内存状态随时可能消失。官方文档给出的行为是（来自官方文档，未实测，且官方注明具体数值由运行时决定、可能变化）：空闲约 10 秒后，满足条件的对象可以被休眠（hibernate）；没有休眠条件的空闲对象大约 70 到 140 秒后被移出内存；挂起的 `fetch()`、RPC 调用等未完成操作最多可使对象留在内存约 15 分钟；代码部署、运行时更新、宿主迁移都会让对象重启，构造函数重新执行，WebSocket 连接被终止。文档没有提供关闭钩子，推荐增量写入存储。

由此得到一条规则：**任何丢了会心疼的东西，写进存储；内存里只放可由存储重建的缓存**。

## 取舍与常见误区

什么时候用：需要对某个实体串行化处理、强一致的读改写、长连接的汇聚点、按实体定时。什么时候别用：

- 无状态、可并行的请求。DO 的本质是排队，给它加流量只会堆积。
- 全局单例。一个 `idFromName("global")` 扛全站流量，会成为瓶颈。官方的建议是按协调单元切分（吞吐规划见[典型模式](/articles/cloudflare-durable-objects-patterns)一文）。
- 全局只读配置：用 KV 或 Cache 更合适。
- 需要跨实体查询、报表：用 D1。

选型对照见 [Cloudflare 存储怎么选](/articles/cloudflare-storage-decision-tree)。

几个误区：

- 「单线程所以我不用考虑并发」：见上，`await` 处会穿插。
- 「DO 是全球就近的」：一个实例只在一个位置，离它远的调用者要付跨区域延迟。可以用 location hint 或 jurisdiction 影响放置，但 hint 只是建议。
- 「内存变量就是缓存」：对，但只是缓存。
- 「抛异常无所谓」：未捕获异常可能让对象处于未知状态，甚至被重置，关键路径要自己 `try...catch`。

## 小结

DO 的价值来自一个简单的不变量：一个 ID 对应一个串行执行者，加上与之同处一地的存储。理解这个不变量和 `await` 处的边界，就能判断一个问题适不适合它。下一篇看这个模型如何落成协调器、限流、房间与定时任务。

## 延伸阅读

- [Durable Objects 的典型模式](/articles/cloudflare-durable-objects-patterns)
- [Queues：投递语义、重试与死信](/articles/cloudflare-queues)
- [Rules of Durable Objects（官方）](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object 生命周期（官方）](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Durable Objects 限制（官方）](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [SQL Storage API（官方）](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
