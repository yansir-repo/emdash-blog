---
title: "D1：迁移、事务与批处理、读副本与 Sessions，以及什么时候该离开它"
description: "D1 是托管的 SQLite。本文讲清迁移工作流、为什么不能用 BEGIN 而要用 batch、读副本与 Sessions API 的一致性保证，以及单库上限与单线程特性决定的离开时机。"
date: 2026-10-22
tags: [cloudflare, tutorial, storage]
category: cloudflare
chapter: 6
---

D1 是 Cloudflare 的托管 SQLite 数据库。它的价值在于：有真正的 SQL 和约束，按用量计费，Worker 里一个绑定就能用。但它的模型和你熟悉的 Postgres/MySQL 有几处关键差异，不理解就会写出看似正确的错误代码。

> 限额与行为以 2026-10 官方文档为准，会变化。标注「本地实测」的部分在 wrangler/miniflare 本地验证过；其余（限额数字、读副本延迟与路由、计费、线上单线程吞吐）均来自官方文档，未实测。

## 迁移：把 schema 当作有序文件

朴素做法是在控制台手动改表，或在应用启动时 `CREATE TABLE IF NOT EXISTS`。前者不可复现，后者在多实例并发时不可控。D1 的做法是版本化的 SQL 文件：

```bash
wrangler d1 migrations create <DATABASE_NAME> init
wrangler d1 migrations list <DATABASE_NAME> --local
wrangler d1 migrations apply <DATABASE_NAME> --local
```

`create` 生成带版本号的空 SQL 文件，`list` 显示未应用的迁移，`apply` 依次执行。已应用的记录保存在数据库里的 `d1_migrations` 表中（默认，可用 `migrations_table` 修改），目录默认是 `migrations/`（`migrations_dir`）。本地实测：`apply --local` 后 list 显示该文件状态为已应用。注意本地与线上是两份独立数据，线上用 `--remote`，需要自己确认目标。

官方建议迁移命令使用**数据库名**而不是绑定名，因为绑定名可能被改，造成迁移打到错误的库。涉及外键违例的结构变更，官方给出的做法是先 `PRAGMA defer_foreign_keys = true`。

```jsonc
{
  "name": "app",
  "main": "src/index.ts",
  "compatibility_date": "2025-09-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app-db",
      "database_id": "<填入你的 database_id>",
      "migrations_dir": "migrations"
    }
  ]
}
```

原则：迁移文件只增不改，已上线的文件不要再编辑；破坏性变更拆成"加新列、回填、切换读、删旧列"多步。

## 事务：用 batch，不是 BEGIN

这是最容易踩的点。在 Postgres 里你会写 `BEGIN ... COMMIT`，D1 里不行。本地实测：`env.DB.exec("BEGIN")` 与 `prepare("BEGIN").run()` 都直接报错，信息要求改用 DO 的 storage 事务 API，D1 不接受 SQL 级别的 BEGIN。

D1 的事务单位是 `batch()`。官方文档说明：batch 中的语句顺序执行，且被当作 SQL 事务，任一语句失败则整个序列中止并回滚。本地实测：

```ts
const stmts = [
  env.DB.prepare("UPDATE accounts SET balance = balance + 50 WHERE id = 2"),
  env.DB.prepare("UPDATE accounts SET balance = balance - 150 WHERE id = 1"), // 违反 CHECK (balance >= 0)
];
try {
  await env.DB.batch(stmts);
} catch (e) {
  // 第二条触发 CHECK 约束失败，第一条也被回滚
}
```

执行后两个账户的余额都保持原值，第一条的 +50 没有留下。含义是：**把"必须一起成功"的写入放进同一个 batch，并把不变量写成约束（CHECK、UNIQUE、外键），让数据库来拒绝非法状态**。

batch 的局限：语句必须事先全部构造好，你不能在 batch 中间读出一个值、在 JS 里判断、再决定下一条写什么。需要"读-判断-写"的逻辑，要么用单条带条件的 SQL（`UPDATE ... WHERE balance >= ?` 并检查 `meta.changes`，本地实测条件满足时为 1、不满足时为 0），要么把这个流程放到 Durable Objects 里串行化。

官方限额里与此相关的（以 2026-10 官方文档为准，会变化，未实测）：单次 Worker 调用的查询数 Free 50 / Paid 1000，单条查询 30 秒上限，同时也作用于整个 batch；绑定参数每条最多 100 个；行大小上限 2 MB。批量插入大量行时要按参数个数分块。本地实测：一条带 101 个参数的查询会被拒绝（`too many SQL variables`）。

## 一个朴素做法为什么不够

很多人从其他数据库迁来时，会在 Worker 里先 SELECT 余额、在 JS 里判断、再 UPDATE。在 D1 里这条路有两个问题：一是没有交互式事务，两次调用之间别的请求可以插入；二是每次调用都是一次到数据库的往返，查询数也受单次调用上限约束。把判断下推进 SQL（条件更新加约束），再用 batch 合并往返，既正确又省查询额度。这是 D1 与"远程连接型"数据库在编程模型上最大的区别：你写的是声明式的整体操作，而不是一段持有连接的过程。

## 读副本与 Sessions

D1 默认所有查询走主库，读副本需要显式开启（官方列出的方式是控制台设置或 REST API）。开启后，D1 会在多个区域创建只读副本，通过 Sessions API 发起的读可就近服务，写仍然转发主库。副本异步更新，所以会滞后（来自官方文档，未实测）。

问题是：用户刚写完，下一次读落到滞后的副本，看不到自己的写入。Sessions API 解决的就是这个：

```ts
export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const bookmark = request.headers.get("x-d1-bookmark") ?? "first-unconstrained";
    const session = env.DB.withSession(bookmark);

    const { results } = await session
      .prepare("SELECT id, title FROM posts ORDER BY id DESC LIMIT 20")
      .all();

    const res = Response.json(results);
    res.headers.set("x-d1-bookmark", session.getBookmark() ?? "");
    return res;
  },
};
```

`withSession()` 的参数控制 session 第一次查询的去向：`first-unconstrained`（默认，可去主库或任一副本），`first-primary`（强制主库，拿最新数据），或者上一次返回的 bookmark（保证至少和该版本一样新）。官方给出的保证是 session 内的**顺序一致性**：读不会回退，写按序，自己的写入后续可见。把 bookmark 通过 header 或 cookie 往返，就能把这个保证延伸到跨请求。

要注意（以下来自官方文档，未实测）：Sessions API 目前只在 Worker 绑定里可用，REST API 不可用；关闭读副本最长可能需要 24 小时才完全停止，Sessions 代码在关闭后仍可运行；读副本没有额外费用，计费仍按 rows read / rows written。

关于 `getBookmark()` 的返回类型：官方页面没有明确写出，示例里用 `session.getBookmark() ?? ""`，而且官方示例代码自身有不一致（变量名、未定义的 `response` 等），**以官方为准**。本地实测：session 还没有执行任何查询时返回 `null`，执行过查询后返回字符串，所以按「`string | null`」处理最稳妥，上面的 `?? ""` 写法就是这个原因。本地的 `served_by_primary` 恒为 true，官方也说明 `wrangler dev` 下副本路由字段不具代表性；本地还会接受随便写的 bookmark 字符串，不会校验。**副本延迟、实际路由与 bookmark 的跨请求保证，只引官方，未实测。**

读副本只改善读延迟和读吞吐，不加速写。写多的应用开了它收益有限。

## 什么时候该离开 D1

D1 不是"小玩具"，但它的边界是明确的，都来自官方限额（以 2026-10 官方文档为准，会变化）：

- **单库上限：Paid 10 GB（官方明确不可提高），Free 500 MB。** 文档建议拆多个库；按租户或用户分库可行，但跨库查询要自己做。无法自然分库的单体大表，应考虑其他数据库。
- **每个库单线程。** 官方文档说每个库一次只处理一个查询，吞吐取决于查询耗时（来自官方文档，未实测），慢查询会堵住其他请求。写密集、需要高并发写入的系统会先撞到这里。
- **没有交互式事务。** 需要大量"读-判断-写"的业务逻辑，用 DO（它的 storage 有事务 API）更合适。
- **已有 Postgres/MySQL 且要保留。** 不必迁移，用 Hyperdrive 做连接池与缓存即可。

反过来，以下场景 D1 很合适：读多写少的内容站、按租户隔离的小库、需要 SQL 与约束的业务后台。

## 实践建议

- 给每个查询检查 `meta.rows_read` 与 `meta.rows_written`，D1 按这两项计费，缺索引的全表扫描会直接体现在账单与耗时上。
- 在 schema 里用 `NOT NULL`、`UNIQUE`、`CHECK` 和外键表达不变量，应用层的校验只负责给出友好错误，不负责保证正确。
- 本地开发用 `--local` 的独立数据，不要假设它和线上数据一致；迁移上线前先在本地与预发环境各跑一遍。
- 读副本只对走 Sessions API 的查询生效：官方写明要使用读副本必须用 Sessions API，否则查询仍留在主库。所以开启之前，先把读路径改成 `withSession`，并想清楚 bookmark 怎么在请求间传递。

## 小结

- 迁移用有序 SQL 文件，目标用数据库名，线上用 `--remote`。
- 事务就是 `batch()`，不变量交给约束。
- 读副本配合 Sessions + bookmark，才有"读到自己的写入"。
- 单库 10 GB（Paid）与单线程是离开 D1 的判断依据，条件满足时越早规划拆分或迁移越好。

## 延伸阅读

- [D1 限制（官方）](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 读副本与 Sessions API（官方）](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [D1 Worker API（官方）](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 迁移（官方）](https://developers.cloudflare.com/d1/reference/migrations/)
- 站内：[存储怎么选](/articles/cloudflare-storage-decision-tree)、[Durable Objects 模型](/articles/cloudflare-durable-objects-model)
