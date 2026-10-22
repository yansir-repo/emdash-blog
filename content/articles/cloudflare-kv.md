---
title: "KV：最终一致的真实含义与缓存模式"
description: 解释 Workers KV 为什么读得快却不能当数据库：最终一致、约 60 秒或更久的传播、负缓存、cacheTtl 与同 key 每秒一次写入；并给出配置读取、缓存层、会话等模式的取舍与误区。
date: 2026-10-22
tags: [cloudflare, tutorial, storage]
category: cloudflare
chapter: 8
---

> 限额、价格与行为以 2026-10 官方文档为准，会变化。标注「来自官方文档，未实测」的内容没有在本地复现；标注「本地实测」的内容在 wrangler dev（workerd）上跑过。本地只有单进程模拟，**无法复现跨地区的传播延迟，也不会执行同 key 每秒 1 次写入的限流**。

## 问题：全球读多写少的小数据

功能开关、站点配置、重定向表、已渲染 HTML 片段，这些数据读取极频繁，写入很少，且全球用户都要低延迟读到。朴素做法是每次请求都查中心数据库：延迟高、数据库被读流量压垮。再朴素一点是写进 Worker 的全局变量：实例之间不共享，也随时会被回收。

KV 针对的正是这种形状：一个全局的键值存储，读被缓存到离用户近的位置。代价写在官方文档第一句：它通过最终一致来换取高性能。

## KV 的模型与保证

按官方文档的描述（来自官方文档，未实测）：

- 写入进入中心存储，**并不会推送到每个边缘位置**。读取时先看本地缓存，未命中再逐层向区域层、中心层取。
- 同一位置写入后通常立刻可见，但文档明确说**这不被保证**，不能依赖。
- 其他位置可能继续提供旧值，直到该位置的缓存过期。文档的原话是「60 秒或更久」，这是量级而不是上界；最近读过旧值的位置更慢。
- **负缓存**：不存在的 key 也会被缓存。所以「新建 key」和「更新 key」一样慢，别以为新建是即时的。
- `cacheTtl` 默认 60 秒，最小 30 秒（限额页），控制结果在读取位置缓存多久。调大提升读性能，但陈旧窗口也随之变长（后半句是由模型推出的结论，文档并非这样直接表述）。
- 同一个 key 每秒最多写 1 次，超出返回 429（官方限额页与写入 API 页）。官方没有说明并发写同一 key 谁胜出，不要依赖任何胜负顺序。

所以 KV 不适合：依赖读己之写、原子的读改写、事务、跨 key 一致的场景（官方的说法是不适合需要原子操作或单次事务读写的应用）。这不是缺陷，是它能做到全球快读的原因。

## 最小例子

绑定声明：

```jsonc
{
  "name": "edge-config",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "<NAMESPACE_ID>" }
  ]
}
```

读写 API：

```ts
interface Env { CONFIG: KVNamespace }

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    // 写：expirationTtl 最小 60 秒；metadata 序列化后最大 1024 字节
    await env.CONFIG.put("flags:v1", JSON.stringify({ beta: true }), {
      expirationTtl: 3600,
      metadata: { updatedBy: "deploy" },
    });

    // 读：不存在返回 null；type 可为 text/json/arrayBuffer/stream
    const flags = await env.CONFIG.get<{ beta: boolean }>("flags:v1", {
      type: "json",
      cacheTtl: 300, // 本位置最多缓存 300 秒，最小 30
    });

    // 一次读多个 key（最多 100 个），返回 Map，缺失的为 null
    const many = await env.CONFIG.get(["a", "b"]);

    // list：按 key 的 UTF-8 字典序，用 list_complete 判断是否结束
    const page = await env.CONFIG.list({ prefix: "flags:", limit: 100 });

    return Response.json({ flags, many: [...many], done: page.list_complete });
  },
};
```

本地实测确认：缺失 key 的 `get` 返回 `null`；多 key 读返回 `Map`，缺失项为 `null`，一次请求超过 100 个 key 返回 400；`getWithMetadata` 返回 `{ value, metadata }`；`expirationTtl` 小于 60 与 `cacheTtl` 小于 30 都会被拒绝，错误分别是 400 且提示最小值；value 超过 25 MiB 返回 413，key 超过 512 字节返回 414，metadata 超过 1024 字节返回 413，空 key 报错。

本地实测还确认了两件事：一是同一位置写后立刻读能读到新值（但官方说这不被保证，别当成保证）；二是读改写不是原子的，20 个并发的「`get` 后 `put` 加一」，最终计数是 1，丢失了 19 次更新。另一件**本地没有复现**的事：连续 5 次、并发 5 次写同一个 key，本地全部成功，没有 429，所以同 key 每秒 1 次的限制只能信官方文档，不要用本地测试判断自己会不会撞上。

两个 list 细节来自官方文档（未实测）：空的 `keys` 数组不代表列完了，因为刚过期或删除的 key 会被扫描但不返回，必须看 `list_complete`；带 `prefix` 分页时，每次调用都要重复传同一个 `prefix`。

## 缓存模式

### 模式一：配置分发

发布时写入、运行时读取。流程是部署或管理后台写 KV，Worker 读时带较大的 `cacheTtl`。要点是**接受传播窗口**：功能开关翻转后约一分钟甚至更久（调大 `cacheTtl` 则更久）才全球生效。如果业务不能容忍，比如「撤销权限必须立即生效」，KV 就不是正确的地方。

### 模式二：读穿缓存

Worker 先读 KV，没有再回源（D1、上游 API）并写回，写回时设 `expirationTtl`。注意三点：

1. **缓存击穿**：热点 key 过期瞬间，多个位置同时回源并同时写同一个 key，会撞上每秒 1 次的限制。回源后的写入失败应当吞掉（返回已拿到的数据即可），不要让缓存写失败变成请求失败。
2. **负缓存**：回源发现不存在时，不要写一个「空值」长期缓存，否则资源创建后很久都读不到。给空值很短的 TTL，或者干脆不缓存空结果。
3. 大值请使用 `stream` 或 `arrayBuffer` 读取，单个值上限 25 MiB，单次响应也受此限制。

### 模式三：写入走单点，读取走 KV

官方文档建议的强化办法是：让某个 key 的所有写入先经过一个 [Durable Object](/articles/cloudflare-durable-objects-model) 实例，由它串行化并写 KV，其他 Worker 读 KV。这样得到写与写之间的一致性，同时保留 KV 的读特性。适用于「写不多但不能丢更新」的场景，比如计数结果的快照发布。注意这依旧不能让读者立刻看到最新值。

### 会话与令牌

把 session 放 KV 很常见，也能工作，但要想清楚：登出或封禁后，其他地区最多可能还会读到旧 session 一段时间。如果这是安全边界，请在令牌内做短有效期，或用 Durable Objects / D1 做权威判断，KV 只做加速。

## 限额与计费速览

以下来自官方文档（未实测，以 2026-10 官方文档为准，会变化）：key 最长 512 字节，值最大 25 MiB，metadata 最大 1024 字节，每次 Worker 调用最多 1,000 次 KV 操作，批量请求在该上限里算 1 次，但**计费按读取的 key 数**。批量写入走 Wrangler（`kv bulk`）或 REST API，Worker 绑定里只有单 key 的 `put`。免费计划每天 100,000 次读、1,000 次写，超出后该类操作直接失败；付费计划每月含一定额度，超出按量计费，读、写、删、list 的单价不同，且**读取不存在的 key 同样计费**。具体单价请查官方定价页。

## 取舍与常见误区

**什么时候用 KV**：读远多于写；数据小；可以接受约一分钟甚至更久的陈旧；key 能直接定位（不需要查询）。

**什么时候别用**：

- 需要读己之写、计数器、库存扣减、抢占锁：用 Durable Objects。
- 需要查询、排序、关联：用 [D1](/articles/cloudflare-d1)。
- 大文件：用 [R2](/articles/cloudflare-r2)。
- 同一个 key 高频更新：每秒 1 次写入限制会直接拒绝。

**常见误区**：

1. 「写完立刻读」做测试，在本地或同一位置看似通过，上线后别的地区读到旧值。本地模拟不能暴露这个问题。
2. 把 KV 当计数器：`get` 再 `put` 不是原子的，并发下必丢更新。
3. 用 `list` 做业务查询：它是按前缀列 key，会受最终一致与过期 key 扫描的影响。
4. 对不存在的 key 写负缓存，导致新建后迟迟不可见。
5. 把 `cacheTtl` 调很大却又期望「改了马上生效」。
6. 在 Workers 里用 Effect 等运行时封装 KV 时，要留意异步与资源作用域，可参考 [Effect 在 Workers 上的坑](/articles/effect-workers-pitfalls)。

立场：KV 是**缓存和分发层**，不是事实来源。写入时先落到权威存储（D1 或 DO），再投影到 KV；任何依赖 KV 才能保证正确的逻辑，都应当重新设计。

## 小结

KV 的快来自缓存，缓存带来陈旧，陈旧窗口约一分钟量级、可能更久且不保证。把它放在读多写少、可容忍延迟、可回源重建的位置，它非常好用；一旦业务要求一致性，就选别的产品，或让 Durable Objects 做写入单点。

## 延伸阅读

- [Cloudflare 存储怎么选](/articles/cloudflare-storage-decision-tree)
- [R2：对象存储、预签名上传、公开访问与缓存](/articles/cloudflare-r2)
- [Durable Objects：单线程模型](/articles/cloudflare-durable-objects-model)
- [KV 官方文档](https://developers.cloudflare.com/kv/)
- [KV 如何工作（官方）](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [KV 限制（官方）](https://developers.cloudflare.com/kv/platform/limits/)
