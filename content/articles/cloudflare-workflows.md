---
title: "Workflows：长流程、步骤重试，以及和 Queues 怎么分工"
description: 讲解 Cloudflare Workflows 的持久化执行模型：step.do 的缓存与重试、sleep 与 waitForEvent、编写规则与限额，以及它与 Queues 在多步骤流程上的分工与取舍。
date: 2026-10-22
tags: [cloudflare, tutorial, coordination]
category: cloudflare
chapter: 12
---

一个流程如果包含多个步骤、可能跨越几分钟到几天、中途要等外部事件，那它就不是「一个函数调用」了。本文讲 Workflows 的执行模型、步骤重试语义、必须遵守的编写规则，以及它和 [Queues](/articles/cloudflare-queues) 怎么分工。限额与默认值来自官方文档，**以 2026-10 官方文档为准，会变化**；除标明「本地实测」（wrangler dev）的结论外均未实测，线上的调度间隔、休眠恢复与计费本地无法复现。

## 问题：长流程为什么难写

典型场景：用户下单后，依次扣库存、扣款、发确认邮件，等待人工审核，三天后发提醒。

朴素做法一：写在一个请求里。Worker 有执行时间限制，一次失败就要从头来，已经扣过的款不知道该不该再扣。

朴素做法二：用 Queues 拼状态机。每一步发一条消息，消息体里带「当前状态」。可行，但重试、超时、等待、排查「这个订单卡在哪一步」都要自己实现，状态散落在消息和数据库里。

Workflows 的思路是 **durable execution**：你写的是顺序的 TypeScript，平台把每一步的结果持久化，失败或中断后从最后一个完成的步骤继续，而不是从头再来。

## 模型与保证

核心概念：Workflow 是绑定在一个 Worker 脚本上的定义；Instance 是它的一次运行；Step 是可独立重试的单元，其返回值被持久化。

```ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

type Params = { orderId: string; email: string };

export class OrderFlow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const reservation = await step.do("reserve stock", async () => {
      return await reserve(event.payload.orderId);
    });

    const charge = await step.do(
      "charge card",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async (ctx) => {
        if (!reservation.ok) throw new NonRetryableError("no stock");
        return await charge(event.payload.orderId, ctx.attempt);
      },
    );

    const approval = await step.waitForEvent<{ approved: boolean }>("manual review", {
      type: "approval",
      timeout: "2 days",
    });

    await step.sleep("grace period", "1 hour");
    await step.do("send mail", async () => sendMail(event.payload.email, charge.id));
    return { approved: approval.payload.approved };
  }
}
```

配置绑定：

```jsonc
{
  "workflows": [{ "name": "order-flow", "binding": "ORDER_FLOW", "class_name": "OrderFlow" }]
}
```

从 Worker、Queue 消费者、cron、Durable Object 都可以触发：

```ts
const instance = await env.ORDER_FLOW.create({ id: `order-${orderId}`, params: { orderId, email } });
// 之后
await (await env.ORDER_FLOW.get(`order-${orderId}`)).sendEvent({ type: "approval", payload: { approved: true } });
```

### 步骤的重试与缓存

官方文档给出 `step.do` 的默认配置（未实测默认值本身）：重试 5 次，初始延迟 10 秒，指数退避，每次尝试超时 10 分钟。可以用 `retries: { limit, delay, backoff }` 与 `timeout` 覆盖；`delay` 还可以是函数，根据错误动态计算。重试耗尽后，Workflow 进入 Errored 状态，除非你用 `try...catch` 接住它并处理。抛出 `NonRetryableError` 则直接跳过重试。

本地用 wrangler dev 实测了这些行为：`retries.limit` 为 2 时，一直抛错的步骤共执行 3 次（`ctx.attempt` 为 1、2、3），即 `limit` 是重试次数、总执行次数是它加一；让第三次成功则流程继续，让三次都失败则实例进入 errored 并带上错误信息；抛出 `NonRetryableError` 的步骤只执行一次，实例直接 errored；已完成步骤（本例的第一个 step）只执行一次，不会因为后面步骤的重试而重跑；`waitForEvent` 之后调用实例的 `sendEvent`，实例状态从 running 变为 complete，`output` 为 run 的返回值；`waitForEvent` 超时会在 `run` 里抛错（本地信息为 `Execution timed out after 2000ms`），被 `try...catch` 接住后流程可以继续。以上来自本地实现，线上的调度间隔、休眠恢复细节来自官方文档，未实测。

**一个步骤的结果被缓存，但步骤内部的副作用不是**。步骤超时、重试、或结果持久化前被中断，回调可能被执行多于一次。这与 Queues 的 at-least-once 是同一个道理，所以官方规则第一条就是：让 API 与绑定调用幂等，比如扣款时把 `event.instanceId` 加步骤名作为幂等键传给支付服务。

### 编写规则

官方有一篇 Rules of Workflows，值得完整读。要点是：

1. 步骤要细粒度：别在一个步骤里调用多个服务，否则一个服务失败会重跑全部。
2. 不要依赖步骤外的状态：实例可能休眠并丢失内存，顶层变量只能由 `step.do` 的返回值构造。
3. 步骤外不要做副作用：步骤外的代码在恢复时可能重新执行。
4. 步骤名要确定：名字是缓存键，用时间戳或随机数命名会让缓存失效。
5. 条件分支只依赖 payload 与先前步骤输出；随机或时间相关的判断包进步骤里。
6. 每个 `step.do` 都要 `await`；不要把 `sleep` 或 `waitForEvent` 嵌套进 `step.do`。
7. 实例 ID 要唯一。
8. 单个非流式步骤返回值不超过 1 MiB，大数据放 R2 或 D1，返回引用。

## 限额

以下是官方限额页 Workers Paid 一列的数字（以 2026-10 官方文档为准，会变化，均未实测）。Free 的数字小得多，例如每个 Workflow 1,024 步、单实例状态 100 MB、并发实例 100、每步 CPU 10 ms，请自行查阅：

- 每个 Workflow 默认 10,000 步，可配置到 25,000；`step.sleep` 与 `waitForEvent` 不计入步数。
- 每步 CPU 时间默认 30 秒，可配置到 5 分钟；墙钟时间不限。
- 单个实例持久化状态上限 1 GB；`step.sleep` 最长 365 天。
- 并发实例 50,000；官方脚注说明只有处于 running 状态的实例计入并发，waiting 状态（sleep、`waitForEvent` 等）不计入。
- 已完成实例的状态保留 30 天（Free 为 3 天）。

对设计影响最大的是后两条：**等待是便宜的**，所以「等三天再提醒」这类需求放进 Workflows 很自然；而状态只保留有限时间，意味着它不是业务数据的存放处，结果要落到你自己的库里。

## 一个实例的生命周期

理解状态机有助于排错。官方文档列出的实例状态包括 queued、running、waiting、paused、errored、terminated、complete 等。创建后先排队，开始执行变为 running；遇到 `step.sleep`、重试等待或 `waitForEvent` 时变为 waiting，此时不占并发名额；步骤重试耗尽且未被捕获则 errored。

实例句柄提供 `status()`、`pause()`、`resume()`、`terminate()`、`restart()` 等运维方法。`restart()` 不带参数时从头开始，官方说明它会清掉中间状态，所有步骤重新执行；`restart({ from: { name: "step 名" } })` 则从指定步骤重启，复用更早步骤的缓存结果，目标步骤及之后的步骤重新执行。本地实测两种行为都成立：从 `c` 步骤重启时 `a`、`b` 没有再执行，而不带参数重启时 `a` 重新执行。同时能看到另一件事：写在步骤外的代码（本例的一条日志）在重启后又执行了一次，所以步骤外不能放副作用。排错流程因此很顺畅：定位出错步骤，修复代码，从该步骤重启，而不必让用户重新下单。但要记住，**从中间重启复用的是缓存**，如果你改了某个已完成步骤的逻辑，它不会重新执行，除非从该步骤重启。

另一个设计点是实例 ID。ID 在保留期内不能复用，`create` 遇到重复 ID 会抛错（本地实测错误为 `instance.already_exists`）。所以应该用业务上稳定且唯一的 ID，比如 `order-<orderId>`，让「同一订单只会有一个流程」成为由构造保证的不变量，而不是靠代码里的判断。若一个业务对象需要多次流程，ID 里加上流程类型或序号。

## 和 Queues 怎么分工

两者的核心差别是**谁持有流程状态**。

- Queues：消息是独立的，没有「流程」概念；顺序只是 best effort；平台只负责投递与重试。适合独立、无依赖的小任务，以及削峰。
- Workflows：实例是一个有状态的流程，步骤顺序、已完成步骤结果、等待事件都由平台持久化。适合多步骤、有依赖、要等待、要补偿的业务。

立场是：**只要出现「第二步依赖第一步的结果」或「要等一段时间/一个外部信号」，就上 Workflows；只做单步异步、批量扇出，就用 Queues。** 两者组合也很常见：Queues 负责接入与削峰（官方文档明确支持在 `queue` 处理器里调用 `create` 触发 Workflow），每条消息创建一个 Workflow 实例；用确定的实例 ID，重复投递的消息会因 ID 已存在而被拒绝，这就是一种免费的幂等去重。需要批量创建时，官方文档提供 `createBatch`，重复 ID 不抛错而是列入 `errors`。本地实测对象形式 `createBatch({ instances })` 返回 `{ created, errors }`，同一批里的重复 ID 与已存在的 ID 都会出现在 `errors` 里并带错误码；对象形式需要较新的 Wrangler（官方文档标注 4.148.0 及以上），旧的数组形式已被标为 deprecated。

和 Durable Objects 的关系：需要对同一个 key 做串行协调或实时连接，用 [Durable Objects](/articles/cloudflare-durable-objects-patterns)；需要一条可靠走完的长流程，用 Workflows。

## 常见误区

- 把 Workflow 当作「带重试的函数」，一个大步骤包住所有逻辑，失败全部重跑。
- 在步骤外 `console.log` 当审计日志，恢复时重复输出。
- 用 `Date.now()` 或随机数做步骤名或分支条件。
- 把大 JSON 当步骤返回值，撞上 1 MiB 的限制。
- 忘记 `waitForEvent` 默认超时 24 小时且超时会抛错；需要更长要显式设置，需要容忍超时要 `try...catch`。
- 假设重试耗尽后流程会「自动回滚」：默认只是进入 Errored，补偿逻辑要自己写（官方 API 提供了 `rollback` 处理函数，用于 saga 式补偿，具体用法请读官方文档，本文未实测）。

## 小结

Workflows 把「长流程的状态」从你的消息体和数据库里收回到平台里：步骤结果持久化、失败按步骤重试、等待不占并发。代价是你要遵守确定性与幂等的规则。与 Queues 的分工很简单：单步异步用 Queues，多步有依赖用 Workflows，二者可以首尾相接。

## 延伸阅读

- [Queues：投递语义、重试与死信、幂等](/articles/cloudflare-queues)
- [Durable Objects：单线程模型、一个 ID 一个实例与存储](/articles/cloudflare-durable-objects-model)
- [Effect 在 Workers 上的坑](/articles/effect-workers-pitfalls)
- [Rules of Workflows（官方）](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Workflows 限制（官方）](https://developers.cloudflare.com/workflows/reference/limits/)
- [Workers API（官方）](https://developers.cloudflare.com/workflows/build/workers-api/)
- [睡眠与重试（官方）](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
