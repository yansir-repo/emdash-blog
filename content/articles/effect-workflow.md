---
title: "Effect Workflow：把长流程做成可恢复、幂等、可补偿的执行"
description: 当一个业务流程要跨越进程重启与人工等待，普通 Effect.gen 就不够了。本文用 effect/workflow 讲 Activity 记忆化、三层幂等、补偿的真实语义，并用 SQLite 实测重启后的恢复。
date: 2026-10-16
tags: [effect, workflow, durable-execution, idempotency]
category: effect
---

前面几篇处理的都是「一次进程生命周期内」的问题。这一篇处理跨越生命周期的流程：下单后预留库存，大额订单要等人工审批，审批可能隔一天才来，其间服务可能重启、发布、崩溃。

先说结论和范围。**绝大多数多步骤代码不需要 workflow。** 一个请求里先查再写再通知，用 `Effect.gen` 加事务加补偿即可。只有当流程必须在进程重启、网络失败、延迟回调或人工等待之后继续，才需要持久化执行。

关于验证范围：我自己沉淀的规则库里没有针对 workflow 的机器规则，对应的参考文档也只有一段边界原则和一个没有真实 API 的骨架。所以这一篇的所有 API 事实都来自 `effect@4.0.5` 的实际安装包，行为结论都是我写代码跑出来的。涉及的 API 在源码里仍标注为 `unstable`，请当作会变化的接口对待。

## 先纠正包的位置

旧资料写的是 `@effect/workflow` 与 `@effect/cluster`。我查了 npm：`@effect/workflow` 最新版是 0.19.1，peer 依赖 `effect ^3.22.1`，它是 v3 时代的包。在 4.0.5 里这两个能力都在核心包的子路径下：`effect/workflow` 与 `effect/cluster`。本文只用这两个子路径。持久化那一节另外需要 `@effect/sql-sqlite-node@4.0.5` 与 `@effect/platform-node@4.0.5`。

```bash
npm install effect@4.0.5 @effect/sql-sqlite-node@4.0.5 @effect/platform-node@4.0.5
```

## 不变量：领域代数在前，runner 在后

这是最重要的一条架构边界：**领域逻辑不知道自己跑在 workflow 里**。库存、支付这些能力用普通的 `Context.Service` 定义，方法返回普通 `Effect`；workflow 只负责编排这些调用的顺序、记忆和补偿。

这样换 runner（内存引擎、集群引擎）不影响领域代码，领域服务也可以脱离 workflow 单独测试。反过来，如果领域服务里出现 `Activity`、`WorkflowEngine` 之类的类型，边界就泄漏了。

## 定义一个 Workflow

下面是一个简化的结账流程：预留库存，大额订单等待审批，扣款，发货。其中扣款失败要释放库存，发货失败要退款并释放库存。

```ts
// checkout.ts
import { Context, Effect, Schema } from "effect"
import { Activity, DurableDeferred, Workflow } from "effect/workflow"

export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  orderId: Schema.String
}) {}
export class GatewayTimeout extends Schema.TaggedError<GatewayTimeout>()("GatewayTimeout", {}) {}
export class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  orderId: Schema.String
}) {}

// domain services: they know nothing about the workflow runner
export class Inventory extends Context.Service<Inventory, {
  readonly reserve: (orderId: string) => Effect.Effect<void>
  readonly release: (orderId: string) => Effect.Effect<void>
  readonly dispatch: (orderId: string) => Effect.Effect<void, OutOfStock>
}>()("app/Inventory") {}

export class Payments extends Context.Service<Payments, {
  readonly charge: (key: string, cents: number) => Effect.Effect<string, PaymentDeclined | GatewayTimeout>
  readonly refund: (chargeId: string) => Effect.Effect<void>
}>()("app/Payments") {}

export const Approval = DurableDeferred.make("Approval")

export const Checkout = Workflow.make("Checkout", {
  payload: { orderId: Schema.String, cents: Schema.Number },
  idempotencyKey: ({ orderId }) => orderId,
  success: Schema.Struct({ chargeId: Schema.String }),
  error: Schema.Union([PaymentDeclined, GatewayTimeout, OutOfStock])
})

export const CheckoutLive = Checkout.toLayer(
  Effect.fn("Checkout.run")(function* (payload) {
    const inventory = yield* Inventory
    const payments = yield* Payments

    yield* Checkout.withCompensation(
      Activity.make({ name: "reserve", execute: inventory.reserve(payload.orderId) }),
      () => inventory.release(payload.orderId)
    )

    if (payload.cents > 100_000) {
      yield* DurableDeferred.await(Approval)
    }

    const chargeId = yield* Checkout.withCompensation(
      Activity.make({
        name: "charge",
        success: Schema.String,
        error: Schema.Union([PaymentDeclined, GatewayTimeout]),
        execute: Effect.gen(function* () {
          const key = yield* Activity.idempotencyKey("charge")
          return yield* payments.charge(key, payload.cents)
        }).pipe(Activity.retry({ times: 2, while: (e) => e._tag === "GatewayTimeout" }))
      }),
      (id) => payments.refund(id)
    )

    yield* Activity.make({
      name: "dispatch",
      error: OutOfStock,
      execute: inventory.dispatch(payload.orderId)
    })

    return { chargeId }
  })
)
```

几个设计点值得拆开讲。

**Workflow 的输入输出都是 Schema。** payload、success、error 都要声明 Schema，因为它们会被序列化存起来。这就是为什么这里的错误类用 `Schema.TaggedError` 而不是前面常用的 `Data.TaggedError`：能被持久化的错误必须有编码形式。

**`idempotencyKey` 决定执行 id。** 我声明的是 `orderId`，同一个订单号无论提交多少次，都映射到同一次执行。后面会验证。

**Activity 是记忆化的单位。** 每个 `Activity.make` 有稳定的 `name`，它的完成结果会被保存，重放时不会再次执行。这个 `name` 是流程历史的一部分，**改名等于改历史**：线上已有执行的流程里，不要随意重命名或调换已发布 Activity 的顺序。

**补偿是流程级的。** `Checkout.withCompensation(step, compensate)` 的语义是：这一步成功后，如果整个 workflow 最终失败，就用这一步的返回值执行补偿。源码里写明了限制：它只对 workflow 顶层的 effect 生效，嵌套在 Activity 内部的不行。所以每个需要补偿的步骤，要放在 workflow 顶层，补偿动作自己必须是幂等的。

## 用内存引擎先把语义测清楚

`WorkflowEngine.layerMemory` 是进程内的引擎，不持久，但语义与真实引擎一致，适合当测试替身。我把领域服务换成会记录调用的假实现，用一个小脚本来驱动场景：

```ts
// checkout-test.ts
import { Effect, Layer } from "effect"
import { WorkflowEngine } from "effect/workflow"
import {
  Checkout, CheckoutLive, GatewayTimeout, Inventory, OutOfStock, PaymentDeclined, Payments
} from "./checkout.ts"

interface Script {
  readonly gatewayTimeouts?: number
  readonly outOfStock?: boolean
}

const makeWorld = (script: Script) => {
  const calls: Array<string> = []
  const keys = new Set<string>()
  let timeouts = 0
  const Domain = Layer.mergeAll(
    Layer.succeed(Inventory, {
      reserve: (id) => Effect.sync(() => { calls.push(`reserve ${id}`) }),
      release: (id) => Effect.sync(() => { calls.push(`release ${id}`) }),
      dispatch: (id): Effect.Effect<void, OutOfStock> =>
        Effect.suspend(() => {
          calls.push(`dispatch ${id}`)
          return script.outOfStock === true ? Effect.fail(new OutOfStock({ orderId: id })) : Effect.void
        })
    }),
    Layer.succeed(Payments, {
      charge: (key, cents): Effect.Effect<string, PaymentDeclined | GatewayTimeout> =>
        Effect.suspend(() => {
          calls.push(`charge ${cents}`)
          keys.add(key)
          if (timeouts < (script.gatewayTimeouts ?? 0)) {
            timeouts++
            return Effect.fail(new GatewayTimeout())
          }
          return Effect.succeed("ch_1")
        }),
      refund: (id) => Effect.sync(() => { calls.push(`refund ${id}`) })
    })
  )
  const layer = CheckoutLive.pipe(
    Layer.provideMerge(Domain),
    Layer.provideMerge(WorkflowEngine.layerMemory)
  )
  return { calls, keys, layer }
}

const scenario = async (label: string, script: Script, orderId: string, times = 1) => {
  const world = makeWorld(script)
  const program = Effect.gen(function* () {
    let last: unknown
    for (let i = 0; i < times; i++) {
      last = yield* Checkout.execute({ orderId, cents: 500 })
    }
    return last
  })
  const exit = await Effect.runPromise(program.pipe(Effect.provide(world.layer), Effect.exit))
  console.log(label, exit._tag, world.calls.join(" > "), `keys=${world.keys.size}`)
}

await scenario("same order twice", {}, "o1", 2)
await scenario("gateway flaky", { gatewayTimeouts: 2 }, "o2")
await scenario("gateway down", { gatewayTimeouts: 5 }, "o3")
await scenario("out of stock", { outOfStock: true }, "o4")
```

运行结果如下，我逐条解释：

- `same order twice`：调用序列只有一遍 `reserve > charge > dispatch`，第二次 `execute` 没有重新执行，直接得到同一个结果。这就是 `idempotencyKey` 的效果：相同订单号映射到同一个执行，重复提交被合并。
- `gateway flaky`：`charge` 被调用了三次，最终成功。前两次是 `GatewayTimeout`，被 `Activity.retry` 重试，`keys=1` 说明三次尝试用的是**同一个**幂等键。这是我要的：重试不能让网关以为是三笔新交易。
- `gateway down`：重试耗尽后 workflow 以 `GatewayTimeout` 失败，序列末尾是 `release o3`，库存被释放。`charge` 本身没成功，所以没有退款。补偿只针对已经成功的步骤。
- `out of stock`：扣款成功之后发货失败，序列末尾依次是 `refund ch_1`、`release o4`。补偿按**后进先出**执行，先退款再释放库存，与步骤顺序相反。

## 幂等有三层，缺一层都会重复副作用

这些场景揭示了一个分层模型，我在设计 workflow 时会逐层检查：

1. **流程级**：`idempotencyKey` 把相同业务实体映射到同一次执行，防止重复提交开出两条流程。键必须来自业务身份，而不是随机数或时间戳。
2. **步骤级**：Activity 完成后结果被记忆，重放不会重做。这保护的是「已完成的步骤」。
3. **外部调用级**：Activity 内部调用第三方时，进程可能在对方已处理、但结果尚未写入历史的瞬间崩溃，重放时这个 Activity 会再执行一次。这是 at-least-once 语义，源码文档里也明确提醒了：只有已完成的 Activity 结果才会被记忆，副作用必须自己做到幂等。

所以第三层要靠 `Activity.idempotencyKey("charge")`：它由执行 id、名称（可选再加尝试次数）算出确定的摘要，传给支付网关作为幂等键，让对方去重。默认不含尝试次数，所以重试时键不变，这正是上面 `keys=1` 的来源。如果你的对端要求每次重试都用新键，才加 `includeAttempt: true`。

## 人工等待：DurableDeferred

大额订单要审批。流程里写 `DurableDeferred.await(Approval)`，它会让执行**挂起**而不是占着线程等待。外部在批准时用执行 id 构造 token，再完成这个 deferred：

```ts
// approval.ts
import { Effect, Layer, Option } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/workflow"
import { Approval, Checkout, CheckoutLive, Inventory, Payments } from "./checkout.ts"

const calls: Array<string> = []
const Domain = Layer.mergeAll(
  Layer.succeed(Inventory, {
    reserve: (id) => Effect.sync(() => { calls.push(`reserve ${id}`) }),
    release: (id) => Effect.sync(() => { calls.push(`release ${id}`) }),
    dispatch: (id) => Effect.sync(() => { calls.push(`dispatch ${id}`) })
  }),
  Layer.succeed(Payments, {
    charge: (_key, cents) => Effect.sync(() => { calls.push(`charge ${cents}`); return "ch_1" }),
    refund: (id) => Effect.sync(() => { calls.push(`refund ${id}`) })
  })
)
const layer = CheckoutLive.pipe(Layer.provideMerge(Domain), Layer.provideMerge(WorkflowEngine.layerMemory))

const program = Effect.gen(function* () {
  const executionId = yield* Checkout.execute({ orderId: "o6", cents: 200_000 }, { discard: true })
  yield* Effect.sleep("30 millis")
  const before = yield* Checkout.poll(executionId)

  const token = DurableDeferred.tokenFromExecutionId(Approval, { workflow: Checkout, executionId })
  yield* DurableDeferred.succeed(Approval, { token, value: undefined })
  yield* Effect.sleep("30 millis")
  const after = yield* Checkout.poll(executionId)

  const tag = (r: typeof before) => (Option.isSome(r) ? r.value._tag : "pending")
  return { before: tag(before), after: tag(after) }
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(layer))), calls.join(" > "))
```

输出是 `before: Suspended`、`after: Complete`，调用序列是 `reserve > charge > dispatch`。`discard: true` 让 `execute` 只返回执行 id 而不等待结果。

注意一个细节：流程在审批后被**重放**，但 `reserve` 只出现了一次。重放时，已完成的 Activity 直接取记忆的结果，不会再执行。这是「流程可以随时挂起并恢复」的基础，也是前面强调 Activity 命名稳定的原因。

## 真正的持久化：Cluster 引擎加 SQL

内存引擎在进程退出后什么都不剩，它不是持久化，只是测试替身。要让流程跨进程存活，需要集群引擎，状态落在 SQL 里。下面用单机的 `SingleRunner` 加 SQLite 文件搭一个最小环境，脚本分两个阶段，在两个独立的进程里运行：

```ts
// durable.ts
import { Effect, Layer, Option } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/cluster"
import { DurableDeferred } from "effect/workflow"
import { NodeCrypto } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Approval, Checkout, CheckoutLive, Inventory, Payments } from "./checkout.ts"

const calls: Array<string> = []
const Domain = Layer.mergeAll(
  Layer.succeed(Inventory, {
    reserve: (id) => Effect.sync(() => { calls.push(`reserve ${id}`) }),
    release: (id) => Effect.sync(() => { calls.push(`release ${id}`) }),
    dispatch: (id) => Effect.sync(() => { calls.push(`dispatch ${id}`) })
  }),
  Layer.succeed(Payments, {
    charge: (_key, cents) => Effect.sync(() => { calls.push(`charge ${cents}`); return "ch_1" }),
    refund: (id) => Effect.sync(() => { calls.push(`refund ${id}`) })
  })
)

const Engine = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(SingleRunner.layer({ runnerStorage: "sql" })),
  Layer.provide([SqliteClient.layer({ filename: "workflow.db" }), NodeCrypto.layer])
)
const App = CheckoutLive.pipe(Layer.provideMerge(Domain), Layer.provideMerge(Engine))

const payload = { orderId: "o9", cents: 200_000 }

const start = Effect.gen(function* () {
  yield* Checkout.execute(payload, { discard: true })
  yield* Effect.sleep("500 millis")
})

const approve = Effect.gen(function* () {
  const executionId = yield* Checkout.executionId(payload)
  const token = DurableDeferred.tokenFromExecutionId(Approval, { workflow: Checkout, executionId })
  yield* DurableDeferred.succeed(Approval, { token, value: undefined })
  yield* Effect.sleep("1000 millis")
  const result = yield* Checkout.poll(executionId)
  console.log("result:", Option.isSome(result) ? result.value._tag : "pending")
})

const phase = process.argv[2] === "approve" ? approve : start
await Effect.runPromise(phase.pipe(Effect.provide(App), Effect.scoped))
console.log("calls:", calls.join(" > "))
process.exit(0)
```

先运行 `node durable.ts start`，进程退出；再运行 `node durable.ts approve`。我的实测输出是：

- 第一个进程的调用序列只有 `reserve o9`：流程执行了预留，然后在审批处挂起，进程结束。
- 第二个全新进程的调用序列是 `charge 200000 > dispatch o9`，结果是 `Complete`。

关键事实在第二条：**新进程里没有再次执行 `reserve`**。预留库存的结果从 SQLite 里的历史恢复出来，进程只做了审批之后的剩余工作。这才是持久化执行的含义：崩溃或发布之后，流程从中断点继续，而不是从头再来或者丢失。

这个最小环境只是为了验证语义。生产要考虑的是另一个层面的问题：多个 runner 的分片与故障转移、SQL 后端的选择与迁移、`SingleRunner` 之外的部署形态。这些我没有验证，不在本文讨论。

## 可观测性

workflow 的每个 Activity 执行时，源码里都会以 Activity 的名称创建 span，`execute`、`poll`、`interrupt`、`resume` 也有以 `<WorkflowTag>.<操作>` 命名的 span，并带上 `executionId` 属性。这一点我是从源码确认的，没有另外起导出器验证。实践上，它再次说明了为什么 Activity 的名字要稳定且低基数：它既是历史的 key，也是 trace 里的 span 名，可以参考[可观测性那一篇](/articles/effect-observability)的命名约定。

## 判断是否需要 workflow

我用下面四个问题做门槛，全部为否就不要引入：

- 流程中途丢了进程，业务上是否不可接受？可以整体重试的，不需要。
- 是否存在以小时或天计的等待，或者要等外部回调、人工动作？
- 步骤是否有不可回滚的外部副作用，需要显式补偿？
- 同一个业务实体是否必须保证只有一条在途流程？

只命中最后一条时，数据库唯一约束加幂等键往往就够了。

## 小结

- 领域逻辑在前，runner 在后：库存、支付是普通的 `Context.Service`，workflow 只编排它们。
- 4.0.5 里 workflow 与 cluster 是 `effect/workflow`、`effect/cluster`，旧的 `@effect/workflow` 是 v3 包；这些 API 仍是 unstable。
- 幂等分三层：`idempotencyKey` 合并重复提交，Activity 记忆化保护已完成步骤，`Activity.idempotencyKey` 保护外部调用。
- 补偿只针对已成功的顶层步骤，后进先出，且补偿动作本身要幂等。
- 内存引擎适合测试语义，持久化靠 Cluster 引擎加 SQL；我用 SQLite 与两个进程验证了重启后从挂起点恢复，已完成的步骤不会重做。
- Activity 的名字和顺序是流程历史的一部分，上线后要像数据库 schema 一样对待。
