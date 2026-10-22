---
title: "Effect RateLimiter：按 key 限速，以及 Semaphore、Schedule、PartitionedSemaphore、Latch 的分工"
description: 讲清 RateLimiter 的两种算法、delay 与 fail、内存与 Redis store，对比 Semaphore 和 Schedule，并介绍 PartitionedSemaphore 与 Latch 的用法。
date: 2026-10-22
tags: [effect, effect-advanced, rate-limiter, semaphore, latch]
category: effect
---

「限流」这个词在代码里至少指三件不同的事：同时最多几个在跑（并发上限）、单位时间最多放行几个（速率上限）、一个循环每隔多久跑一次（节拍）。Effect 里这三件事分别由不同的工具承担，混用最常见的后果是：想限速却用了信号量，想按用户限流却只有一个全局计数。

这篇文章围绕 `RateLimiter` 展开，它是 effect 本体里 `effect/persistence` 提供的按 key 限速服务；再对比 `Semaphore` 与 `Schedule`，最后讲两个相关的并发原语：`PartitionedSemaphore`（按租户公平分配许可）和 `Latch`（开关闸门）。

先说稳定性，因为这是选型的一部分：

- `RateLimiter`（以及 `RateLimiterStore`、`Redis`）的 JSDoc 标注是 `@stability unstable`，4.0.5 里 API 仍可能变动
- `PartitionedSemaphore` 同样是 `@stability unstable`
- `Latch`、`Semaphore` 是 `@stability stable`

文中示例在 effect 4.0.5、`strict` 加 `exactOptionalPropertyTypes` 下编译并运行过；Redis 部分只核对了类型签名，没有连真实 Redis 运行，下文会单独标注。

## RateLimiter 的基本形状

`RateLimiter` 是一个服务，核心只有一个方法 `consume`。它对一个字符串 key 消耗若干 token，参数如下：

- `key`：限流维度，比如 `api:tenant-42`
- `limit` 与 `window`：窗口内最多 `limit` 个 token
- `tokens`：这次消耗几个，默认 1，可以用来表达「重请求」
- `algorithm`：`"fixed-window"`（默认）或 `"token-bucket"`
- `onExceeded`：`"fail"`（默认）或 `"delay"`

组装方式是「服务加存储」两层：`RateLimiter.layer` 依赖 `RateLimiterStore`，存储可以换。进程内用 `RateLimiter.layerStoreMemory`，跨进程用 Redis 版。

```ts
import { Layer } from "effect"
import { RateLimiter } from "effect/persistence"

export const RateLimiterLive = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
```

注意默认值是 `fail` 而不是 `delay`。忘了写 `onExceeded` 的代码会在超限时直接失败，而不是排队等待。

## 两种算法：fixed-window 与 token-bucket

两种算法在「超限后怎么办」上差别很大。下面用 `makeWithRateLimiter` 包装一个 effect，`limit` 为 3、窗口 600ms、超限策略为 `delay`，同时发起 7 个任务，记录每个任务实际执行的时间点（四舍五入到 100ms）。`makeWithRateLimiter` 是一个 Effect，产出一个函数，调用它得到一个可以套在任意 effect 上的包装器。

```ts
import { Effect, Layer } from "effect"
import { RateLimiter } from "effect/persistence"

const Live = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))

const program = Effect.gen(function*() {
  const withLimiter = yield* RateLimiter.makeWithRateLimiter

  for (const algorithm of ["fixed-window", "token-bucket"] as const) {
    const start = Date.now()
    const times: Array<number> = []
    yield* Effect.forEach(
      [1, 2, 3, 4, 5, 6, 7],
      () =>
        Effect.sync(() => times.push(Math.round((Date.now() - start) / 100) * 100)).pipe(
          withLimiter({ key: algorithm, limit: 3, window: "600 millis", algorithm, onExceeded: "delay" })
        ),
      { concurrency: "unbounded", discard: true }
    )
    console.log(algorithm, times.join(" "))
  }
}).pipe(Effect.provide(Live))

Effect.runPromise(program)
// fixed-window 0 0 0 600 600 600 1200
// token-bucket 0 0 0 200 400 600 800
```

读这个输出：

- **fixed-window**：每个窗口放行 `limit` 个，放完后整批等到下一个窗口。结果是 3 个、停一个窗口、再 3 个，呈**突发**形状。实现简单，状态只是一个计数加 TTL，缺点是窗口边界附近可能出现两倍突发
- **token-bucket**：桶容量为 `limit`，按 `window / limit` 的速率补充。先用掉初始的 3 个，之后每 200ms 放行一个，呈**平滑**形状。适合保护下游的瞬时承载能力

选择上，我的倾向是：对外 API 配额（每分钟多少次）用 fixed-window，语义和对方文档一致，状态也最轻；保护某个脆弱下游（数据库、第三方 SDK）用 token-bucket，因为你要的是匀速而不是整点放闸。

## onExceeded：delay 与 fail

`onExceeded` 决定超限后 `consume` 的行为。两种策略的责任划分完全不同。

`fail`：超限时 `consume` 以 `RateLimiterError` 失败，其 `reason` 是 `RateLimitExceeded`，带有 `key`、`limit`、`remaining` 和 `retryAfter`。这适合服务端入口，把它翻译成 429 和 `Retry-After`：

```ts
import { Duration, Effect, Layer } from "effect"
import { RateLimiter } from "effect/persistence"

const Live = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))

const handle = (tenant: string) =>
  Effect.gen(function*() {
    const limiter = yield* RateLimiter.RateLimiter
    yield* limiter.consume({ key: `api:${tenant}`, limit: 2, window: "300 millis", onExceeded: "fail" })
    return "200"
  }).pipe(
    Effect.catchTag("RateLimiterError", (e) =>
      e.reason._tag === "RateLimitExceeded"
        ? Effect.succeed(`429 retry-after=${Math.ceil(Duration.toMillis(e.reason.retryAfter) / 100) * 100}ms`)
        : Effect.fail(e)
    )
  )

const program = Effect.gen(function*() {
  console.log(yield* Effect.forEach(["a", "a", "a", "b"], handle))
  // [ '200', '200', '429 retry-after=300ms', '200' ]
}).pipe(Effect.provide(Live))

Effect.runPromise(program)
```

租户 a 的第三次请求被拒绝，租户 b 不受影响，这就是「按 key 限速」的意思：每个 key 一份独立的计数。注意 `RateLimiterError` 有两种 reason：`RateLimitExceeded`（超限）和 `RateLimitStoreError`（存储本身出错，比如 Redis 不可用）。后者不应该被翻译成 429，上面的 `Effect.fail(e)` 就是把它原样抛出。

`delay`：超限时 `consume` **不失败也不睡眠**，而是返回 `ConsumeResult`，其中 `delay` 字段告诉你需要等多久。真正去等的是 `makeWithRateLimiter`（它在 `delay` 非零时把你的 effect 延后执行）或 `RateLimiter.sleep(limiter, options)`（先 sleep 再返回）。这是个容易误解的点：直接调 `limiter.consume({ onExceeded: "delay" })` 只是预约了名额并拿到等待时长，不会阻塞。

几个我实测确认的边角：

- `tokens` 大于 `limit` 时，`fail` 模式直接失败；`delay` 模式返回一个整窗口的 delay
- `tokens` 可以表达权重：`limit: 10, tokens: 6` 的第二次请求在 `fail` 模式下失败
- 超限后继续请求，delay 模式下 `remaining` 会变成负数，表示已经预约了未来窗口的名额，`delay` 随之变长

## 内存 store 与 Redis store

`layerStoreMemory` 是进程内存。有两点需要记住：

- 它**只在当前进程有效**，多实例部署时每个实例各自计数，限制实际放大成「实例数乘以 limit」
- 状态跟着 layer 实例走：我用两次独立的 `Effect.provide(Live)` 实测，两个 limiter 互不可见。所以限流 layer 要在应用根部构建一次共享，不要在每个调用点各自 provide

需要跨进程共享，就换 Redis 版存储。下面这段**只通过了类型检查，没有连接真实 Redis 运行过**，行为属于「未验证」：

```ts
import { Layer } from "effect"
import { RateLimiter } from "effect/persistence"
import * as Redis from "effect/persistence/Redis"

// 只核对签名：Redis 服务由使用者自己提供，未验证运行时行为
declare const RedisLive: Layer.Layer<Redis.Redis>

export const RateLimiterLive = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreRedis({ prefix: "rl:" })),
  Layer.provide(RedisLive)
)
```

从签名能读出的信息：`layerStoreRedis` 需要环境里已有一个 `Redis` 服务，可选 `prefix` 用于键前缀；还有 `layerStoreRedisConfig`，参数用 `Config.Wrap` 包装，可以从配置读取；`Redis.make` 接收 `send` 与 `subscribe` 两个原始操作来构造服务，所以对接 ioredis 或 node-redis 需要自己写这层适配。按 JSDoc，Redis 存储使用 Lua 脚本实现，但原子性与时钟漂移的实际表现我没有验证，上生产前应该自己压测。

## 与 Semaphore、Schedule 的取舍

三个工具回答的是不同问题：

- `Semaphore` 限**并发**：同时最多 N 个在飞。它不关心速率，我实测 10 个瞬间完成的任务通过 2 个许可，总耗时几乎为零，速率完全没有被限制。适合保护连接池、文件句柄、有并发上限的下游
- `Schedule` 限**节拍**：一个循环按什么节奏重复。`Effect.repeat({ schedule: Schedule.spaced("50 millis"), times: 4 })` 让同一个循环两次执行之间间隔 50ms，我实测约 200ms 完成 5 次。它约束的是「这一个调用链」，不是「所有调用者共享的额度」，详见 [重试与 Schedule](/articles/effect-retry-and-schedule)
- `RateLimiter` 限**速率配额**：多个调用方、多个 key 共享一份额度，可以选择失败或排队，可以换成跨进程存储

决策顺序可以这样走：

1. 担心的是同时占用资源，用 `Semaphore`
2. 只有一个循环，需要控制节奏，用 `Schedule`
3. 有多个调用方共享额度，或者需要按用户、租户、API key 分别计数，或者要跨进程，用 `RateLimiter`
4. 既要限并发又要限速率，两者叠加：外层 `RateLimiter` 决定什么时候可以开始，内层 `Semaphore` 决定同时跑几个

另外，`RateLimiter` 还是 unstable。如果你只需要进程内的简单限速，一个 `Semaphore` 加 `Schedule.spaced` 往往够用，也更稳定。

## PartitionedSemaphore：按租户公平分配许可

普通 `Semaphore` 是先到先得。一个租户突然灌进来一大批任务，会把别的租户全部堵在后面。`PartitionedSemaphore<K>` 共享一个许可池，但按分区 key 记录等待者，释放许可时在各个等待的分区之间轮转分配。

下面让租户 A 先提交 6 个任务，B 和 C 各 2 个，许可只有 1 个，对比两种信号量的完成顺序：

```ts
import { Effect, PartitionedSemaphore, Semaphore } from "effect"

const run = (guard: (tenant: string) => <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const order: Array<string> = []
    const job = (tenant: string, i: number) =>
      Effect.sleep("5 millis").pipe(Effect.tap(() => Effect.sync(() => order.push(`${tenant}${i}`))))

    const plan: Array<[string, number]> = []
    for (let i = 1; i <= 6; i++) plan.push(["A", i])
    for (const tenant of ["B", "C"]) for (let i = 1; i <= 2; i++) plan.push([tenant, i])

    yield* Effect.forEach(plan, ([tenant, i]) => guard(tenant)(job(tenant, i)), {
      concurrency: "unbounded",
      discard: true
    })
    return order.join(" ")
  })

const program = Effect.gen(function*() {
  const plain = yield* Semaphore.make(1)
  console.log("plain      ", yield* run(() => plain.withPermits(1)))
  // plain       A1 A2 A3 A4 A5 A6 B1 B2 C1 C2

  const partitioned = yield* PartitionedSemaphore.make<string>({ permits: 1 })
  console.log("partitioned", yield* run((tenant) => partitioned.withPermit(tenant)))
  // partitioned A1 A2 B1 C1 A3 B2 C2 A4 A5 A6
})

Effect.runPromise(program)
```

普通信号量里 B 和 C 要等 A 的 6 个任务全部跑完；分区信号量里 B1、C1 在 A 的第 3 个任务之前就完成了。注意它不是严格的 A、B、C 逐个轮转（A2 排在了 B1 前面），我实测的顺序是上面这样，所以文档里的「round-robin」应理解为分区之间轮转的倾向，不要依赖精确顺序。

API 上，`withPermit(key)` 和 `withPermits(key, n)` 对应普通信号量的同名方法，只是多一个分区 key；`withPermitsIfAvailable(n)` 是非阻塞的尝试版本，返回 `Option`；`available`、`capacity` 可以查询许可池状态。注意「请求的许可数超过总容量」的 `take` 永远不会完成。

它的定位是**并发层面的多租户公平**，和 `RateLimiter` 的「速率层面的配额」互补：前者保证一个租户占满资源池时别人不会饿死，后者保证一个租户在单位时间内的总量不超标。同样别忘了它是 `unstable`。

## Latch：开关闸门，不是倒数器

如果你熟悉其他语言的 `CountDownLatch`，要先纠正一个直觉：v4 的 `Latch` **不是倒数器**，它是一个可反复开关的闸门。`Latch.make(open?)` 默认关闭；`open` 打开闸门并放行所有当前和之后的等待者；`close` 再次关闭；`release` 只放行**当前**等待者而不改变开关状态；`await` 阻塞到被放行；`whenOpen(effect)` 是「等闸门放行后再执行 effect」。

我用一个暂停和恢复的工作循环验证了这套语义，开关状态通过 `isOpen()` 查询：

```ts
import { Effect, Fiber, Latch } from "effect"

const program = Effect.gen(function*() {
  const gate = yield* Latch.make()
  console.log("default open?", gate.isOpen()) // false

  let ticks = 0
  const worker = yield* Effect.forkChild(
    Effect.forever(
      gate.whenOpen(
        Effect.sync(() => ticks++).pipe(Effect.andThen(Effect.sleep("5 millis")))
      )
    )
  )

  yield* Effect.sleep("30 millis")
  console.log("while closed:", ticks) // 0

  yield* gate.open
  yield* Effect.sleep("50 millis")
  console.log("while open, progressed:", ticks > 3) // true

  yield* gate.close
  yield* Effect.sleep("10 millis")
  const frozen = ticks
  yield* Effect.sleep("50 millis")
  console.log("closed again, frozen:", ticks - frozen <= 1) // true

  yield* Fiber.interrupt(worker)
})

Effect.runPromise(program)
```

典型用途是：启动阶段等待依赖就绪后再放行请求；运维开关（暂停消费、维护窗口）；测试里让多个 fiber 在同一个起跑线上同时开始。它和限流结合时，职责是「一刀切的总开关」：当下游熔断或进入维护时 `close` 整个工作循环，恢复后 `open`，限速则仍然交给 `RateLimiter`。

用 `release` 时要小心：它只放行已经在等的 fiber，之后新来的仍会阻塞。我实测在 `release` 之后新启动的 fiber 确实继续被挡在门外，直到 `open`。如果你想要的是「一次性放行所有人并保持开放」，用 `open`；`release` 更像「脉冲」。

## 小结

- 限流分三件事：`Semaphore` 限并发，`Schedule` 限单个循环的节拍，`RateLimiter` 限多调用方共享的速率配额，不要混用
- `RateLimiter` 来自 `effect/persistence`，默认 `fixed-window` 加 `fail`；fixed-window 呈批量突发，token-bucket 呈匀速平滑，我分别实测了放行时间点
- `onExceeded: "delay"` 时 `consume` 只返回需要等待的时长，真正等待由 `makeWithRateLimiter` 或 `RateLimiter.sleep` 完成；`fail` 时用 `RateLimiterError` 的 `RateLimitExceeded` 翻译成 429
- 内存 store 只在单进程内有效且跟随 layer 实例；Redis store 我只核对了签名，行为未验证
- `RateLimiter`、`RateLimiterStore`、`Redis`、`PartitionedSemaphore` 都是 `unstable`，`Latch`、`Semaphore` 是 `stable`
- `PartitionedSemaphore` 按分区轮转分配许可，让大租户无法饿死小租户；`Latch` 是可反复开关的闸门，`release` 只放行当前等待者
