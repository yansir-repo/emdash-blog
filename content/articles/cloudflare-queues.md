---
title: "Queues：投递语义、重试与死信、幂等"
description: 讲清 Cloudflare Queues 的 at-least-once 投递、批量消费、重试与死信队列的配置与行为，以及为什么消费者必须幂等，并给出与 Workflows、Durable Objects 的取舍。
date: 2026-10-22
tags: [cloudflare, tutorial, coordination]
category: cloudflare
chapter: 11
---

Queues 解决的是一个很朴素的问题：请求处理里有一部分工作不需要用户等，也不该因为下游抖动而丢失。本文讲它的投递语义、批量与重试、死信队列，以及为什么「消费者必须幂等」不是建议而是前提。文中限额与默认值来自官方文档，**以 2026-10 官方文档为准，会变化**；除标明「本地实测」（wrangler dev 里的 miniflare/workerd）的结论外，均未实测，线上的重试间隔、调度、吞吐与计费本地无法复现。

## 为什么不直接 waitUntil 或 fetch

朴素做法有两种：在请求里同步调用下游，或用 `ctx.waitUntil()` 把工作挂到响应之后。前者把下游的延迟和失败直接暴露给用户；后者没有持久化，也没有重试，Worker 实例被回收或下游报错，这件事就消失了。官方文档还特别提到，`waitUntil` 是非阻塞的，在里面调用 `send()` 或 `sendBatch()` 抛出的错误会被隐式忽略。

需要的是一个**持久缓冲区**：生产者写入成功后，消息不会丢，消费者按自己的节奏处理，失败可以重来。这就是 Queues。

## 模型与保证

生产者通过 Queue 绑定调用 `send(body, options?)` 或 `sendBatch(messages, options?)`。消费者是 Worker 默认导出上的 `queue(batch, env, ctx)` 处理器，收到的是一个 `MessageBatch`，里面是 `Message` 数组。消费者有两种形态：Worker 消费者（push，平台调用你的 `queue` 处理器）和 HTTP pull 消费者，一个队列只能选其一，本文只讨论前者。

保证部分务必读准：

- 投递语义是 **at-least-once**：消息保证至少被投递一次，极少数情况下会重复。
- **不保证按发布顺序**：官方在 `MessageBatch` 的 API 说明里写的是消息顺序为 best effort，不保证与发布顺序一致；交付语义页没有承诺 FIFO。
- 官方称 at-least-once 是为可靠性优化的默认选择：消息保证至少到达一次，不会因为平台选择而丢失（这是文档的表述，不是对线上故障的担保）。
- 官方文档称更强的 exactly-once 会增加确认开销、降低吞吐，所以平台选择了 at-least-once。

两条推论：第一，凡是依赖顺序的逻辑（比如「先创建后更新」）不能靠 Queues 保证，要把顺序信息放进消息体，或改用 [Durable Objects](/articles/cloudflare-durable-objects-model) 这类单点串行的东西；第二，重复投递是常态设计假设，下面的幂等一节会展开。

## 批量、重试与死信

先看一份真实的配置，字段名对照官方文档：

```jsonc
{
  "name": "jobs-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "JOBS" }],
    "consumers": [
      {
        "queue": "jobs",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 3,
        "retry_delay": 30,
        "dead_letter_queue": "jobs-dlq",
        "max_concurrency": 5
      }
    ]
  }
}
```

官方文档给出的默认值与范围（以 2026-10 官方文档为准，未实测）：`max_batch_size` 默认 10（上限 100），`max_batch_timeout` 默认 5 秒（上限 60），`max_retries` 默认 3（上限 100），批量先到先触发。`max_concurrency` 不设时由平台自动扩缩，官方建议不设，除非下游扛不住高并发。

消费者代码的关键是**逐条确认**：

```ts
export default {
  async queue(batch: MessageBatch<{ orderId: string }>, env: Env) {
    for (const msg of batch.messages) {
      try {
        await handle(msg.body, msg.id, env);
        msg.ack();
      } catch (e) {
        // 退避：用 attempts 做指数延迟；delaySeconds 官方最大 24 小时，这里自己封顶 1 小时
        msg.retry({ delaySeconds: Math.min(2 ** msg.attempts * 10, 3600) });
      }
    }
  },
} satisfies ExportedHandler<Env>;
```

默认行为是整批语义：官方文档说处理器抛异常，整批会被重新投递，除非其中部分消息已被显式 `ack()`。所以只要一批里混着可能失败的消息，就应该逐条 `ack()` / `retry()`，否则一条坏消息会拖着九条好消息反复重放。同一条消息上第一次 `ack()` 或 `retry()` 生效，后续调用被忽略，本地实测成立：先 `ack()` 再 `retry()` 的消息没有被重投。`msg.attempts` 从 1 开始（本地实测），适合做指数退避；`delaySeconds` 最大 24 小时。

这里本地行为和官方文字有出入，值得单独说明：本地实测，一批 3 条消息，其中 2 条已 `ack()`、处理器随后抛异常，**3 条全部**被重投（`attempts` 都变成 2），已确认的两条也没有幸免。官方文档的表述是已显式确认的消息不会重投，线上以官方为准；但这说明两件事：不要依赖「抛异常前的部分 ack 一定生效」，以及消费者无论如何都要幂等。更稳的写法是逐条 `try...catch`，用 `retry()` 表达失败，让处理器正常返回，不要抛出。

### 死信队列

重试次数用完后，消息默认被**永久删除**。配置了 `dead_letter_queue` 就会转入该队列；它本身就是一个普通队列，可以单独消费。官方文档的几个细节（未实测）：死信队列必须与源队列在同一 jurisdiction；名字不存在时会自动创建；没有消费者的死信队列里，消息保留四天后删除；每次重试按一次读操作计费，进入死信队列算一次写入。

本地用 wrangler dev 实测了这条链路：把 `max_retries` 设为 2、`retry_delay` 设为 1 秒，一批始终调用 `retry()` 的消息共被投递 3 次（`attempts` 为 1、2、3，间隔约 2 秒），随后进入死信队列，死信队列的消费者收到它时 `attempts` 重新从 1 开始。也就是说在本地，**`max_retries: 2` 对应总共 3 次投递，即 `max_retries` 按「重试次数」计，总尝试次数是它加一**。官方文档在这一点上措辞并不一致：配置页写「重试三次后标记为失败」，而 pull 消费者一节写 `attempts` 达到 `max_retries` 时消息被删除。**以官方为准**；写业务逻辑时不要依赖精确的总次数，只依赖「最终会进入死信队列或被删除」。线上真实的重试间隔与调度来自官方文档，未实测。

死信队列不是垃圾桶，而是告警入口：给它配一个消费者，至少记录并报警，否则消息四天后无声消失。

## 幂等是前提

at-least-once 加上「处理成功但 ack 前 Worker 被中断」，意味着同一条消息会被处理两次。官方文档的建议是：写入队列时生成唯一 ID，数据库插入以它为主键，或把它作为幂等键传给邮件、支付等上游。

```ts
await env.JOBS.send({ jobId: crypto.randomUUID(), orderId });

// 消费者
await env.DB
  .prepare("INSERT OR IGNORE INTO processed (job_id) VALUES (?)")
  .bind(msg.body.jobId)
  .run();
```

注意幂等键必须在**生产端**生成并放进消息体。用 `msg.id` 也行，但它标识的是队列里的那条消息，如果生产者自己重发了一次（比如 HTTP 请求被客户端重试），会得到两个不同的 `msg.id`。业务幂等键要来自业务。

## 并发与背压

push 消费者默认自动扩缩：官方文档说明（未实测）Queues 在每个批次结束后，根据积压大小与增长速度、失败调用与成功调用的比例以及你设置的 `max_concurrency` 决定增减并发调用数，并发上限为 250。几个容易忽略的点：只有处理器抛出未捕获异常才算「失败调用」，显式 `retry()` 不计入；并发越高总成本大致不变，只是更快处理完。

因此 `max_concurrency` 的正确用途是**保护下游**，比如第三方 API 有速率限制，把并发压到 1 到 5 并接受更大的积压。如果只是想「省钱」而限制并发，得到的只是更高的延迟。积压本身也有边界（以 2026-10 官方文档为准）：Paid 消息保留期默认 4 天、可配到最长 14 天，Free 固定 24 小时，队列积压上限 25 GB，所以消费者长期落后时，消息会在被处理前过期，这类问题要靠监控积压量发现。

## 取舍与常见误区

什么时候用：

- 请求之后的异步工作：发邮件、写审计日志、调用慢的第三方。
- 削峰：消费者并发可控，保护下游。
- 扇出：一个事件触发一批独立小任务。

什么时候别用：

- 需要严格顺序或「同一个 key 串行」：用 Durable Objects（Queues 的顺序只是 best effort）。
- 多步骤、步骤间有依赖、需要等人工审批或睡几天：用 [Workflows](/articles/cloudflare-workflows)。把这种逻辑硬塞进队列，会变成一堆靠消息体里的状态字段拼起来的状态机。
- 需要请求-响应：Queues 没有返回值。

常见误区：

1. 把 at-least-once 当 exactly-once，消费者里直接累加计数或扣款。
2. 依赖消息顺序。
3. 没配死信队列，消息重试耗尽后静默消失。
4. 一批里混合处理，只靠抛异常表达失败，导致好消息被重复处理。
5. 单条消息处理耗时过长。官方文档给出消费者 wall clock 15 分钟、CPU 默认 30 秒（可配到 5 分钟）的限制，更长的流程应拆分或交给 Workflows。
6. 忽略限额（来自官方限额页，以 2026-10 官方文档为准）：消息体最大 128 KB，`sendBatch` 最多 100 条或 256 KB，单队列吞吐 5000 条/秒，超出会抛 Too Many Requests。大载荷应放进 [R2](/articles/cloudflare-r2)，消息里只传引用。本地实测：`sendBatch` 100 条成功、101 条被拒绝，超过 128 KB 的消息与超过 24 小时的 `delaySeconds` 也会被拒绝（本地错误信息只是笼统的 Unknown Internal Error）；吞吐与积压上限未实测。

## 小结

Queues 是一个持久、至少一次、不保序的缓冲区。用它的正确姿势是：生产端生成幂等键，消费端逐条确认，配置死信队列并监控它，把顺序和长流程的需求交给更合适的产品。

## 延伸阅读

- [Workflows：长流程、步骤重试，以及和 Queues 怎么分工](/articles/cloudflare-workflows)
- [Durable Objects 的典型模式](/articles/cloudflare-durable-objects-patterns)
- [交付保证（官方）](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [批处理与重试（官方）](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [死信队列（官方）](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Queues 限制（官方）](https://developers.cloudflare.com/queues/platform/limits/)
