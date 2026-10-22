---
title: "Effect 重试与 Schedule：退避、抖动、repeat、超时与限流"
description: 把重试、轮询、定时任务统一成 Schedule 策略值：怎么组合退避、上限与抖动，哪些错误该重试，以及 repeat、timeout、cron 和限流的边界。
date: 2026-10-06
category: effect
tags: [effect, guide]
---

重试是最容易写错的代码之一。手写 `while` 循环加 `setTimeout`，一不小心就是无上限、无退避、对所有错误一视同仁，还没法测。Effect 的做法是把「什么时候再来一次、间隔多久、什么时候放弃」抽成一个值：`Schedule`。同一个值可以喂给 `Effect.retry`、`Effect.repeat`、`Stream.retry`，它们只是消费方。

这一篇的立场很明确：**策略和动作分离，策略是值，值可以组合、可以打印、可以测**。顺着这条线讲完退避、抖动、上限，再讲最重要的问题，哪些错误根本不该重试。

## v4 的 Schedule：和 v3 记忆不一样的地方

我先把旧写法的坑讲掉，因为网上和很多笔记里还是 v3 的组合方式。在 effect 4.0.5 的 `Schedule` 里：

- `Schedule.intersect`、`Schedule.andThen`、`Schedule.recurWhile`、`Schedule.identity` 都不存在了。
- 「同时满足两个策略」用 `Schedule.max([a, b])`：所有策略都还想继续才继续，延迟取最慢的。
- 「任意一个还想继续就继续」用 `Schedule.min([a, b])`，延迟取最快的。两者都是数组入参，不能在 `pipe` 里链式调用。
- 「先跑完 a，再跑 b」用 `Schedule.concat(a, b)`。
- 限制次数或时长用 `Schedule.upTo({ times, duration })`，而不是 v3 的 `upTo("30 seconds")`。
- 按输入过滤用 `Schedule.while(({ input }) => ...)`，输入类型用 `Schedule.setInputType<E>()` 声明。

最有价值的是看清一个策略到底产出什么延迟。`Schedule.toStep` 能把策略变成可单步驱动的函数，我用它写了个打印延迟的小工具，后面的结论都能用它复现：

```ts
import { Duration, Effect, Schedule } from "effect"

export const delays = <O>(schedule: Schedule.Schedule<O>, n: number) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    const out: Array<number> = []
    for (let i = 0; i < n; i++) {
      const exit = yield* Effect.exit(step(0, undefined))
      if (exit._tag === "Failure") {
        out.push(-1) // -1 表示策略在这里结束
        break
      }
      out.push(Duration.toMillis(exit.value[1]))
    }
    return out
  })

export const show = Effect.gen(function* () {
  const exp = Schedule.exponential("100 millis")
  console.log("exponential", yield* delays(exp, 5))
  console.log("fibonacci", yield* delays(Schedule.fibonacci("100 millis"), 6))
  console.log("max", yield* delays(Schedule.max([exp, Schedule.recurs(3)]), 5))
  console.log(
    "min",
    yield* delays(Schedule.min([exp, Schedule.spaced("500 millis")]), 6)
  )
  console.log(
    "concat",
    yield* delays(
      Schedule.concat(
        Schedule.exponential("50 millis").pipe(Schedule.upTo({ times: 3 })),
        Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 2 }))
      ),
      8
    )
  )
})
// exponential [ 100, 200, 400, 800, 1600 ]
// fibonacci [ 100, 200, 300, 500, 800, 1300 ]
// max [ 100, 200, 400, -1 ]
// min [ 100, 200, 400, 500, 500, 500 ]
// concat [ 50, 100, 200, 1000, 1000, -1 ]
```

三个细节。`exponential` 默认倍率是 2，`Schedule.exponential("100 millis", 1.5)` 才是 100、150、225。`fibonacci` 的序列是 100、200、300、500，参考资料里写的 100、100、200 与 4.0.5 不符。`Schedule.min` 搭配 `spaced` 就是**给退避封顶**：延迟涨到 500ms 以后不再增长，这是我最常用的写法。

## Effect.retry 的三个入口

`Effect.retry` 接受三种形态，对应三类需求：

```ts
import { Data, Effect, Schedule } from "effect"

export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly status: number
}> {}
export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly reason: string
}> {}
type CallError = Unavailable | InvalidInput

declare const call: Effect.Effect<string, CallError>

// 1. 只限次数：立即重试，没有间隔
export const a = call.pipe(Effect.retry({ times: 3 }))

// 2. 一个 Schedule：间隔和上限都由策略决定
export const b = call.pipe(
  Effect.retry(Schedule.exponential("200 millis").pipe(Schedule.upTo({ times: 4 })))
)

// 3. 选项对象：schedule/times 和 while/until 可以叠加
export const c = call.pipe(
  Effect.retry({
    schedule: Schedule.exponential("200 millis"),
    times: 4,
    while: (e) => e._tag === "Unavailable"
  })
)
```

选项对象里 `times` 和 `schedule` 同时给，两者都生效。我实测过：`schedule` 加 `times: 2`，一共尝试 3 次，也就是首次加 2 次重试。`while` 的参数是类型化的错误，所以 `e._tag` 能收窄，这是重试和 Effect 类型化错误结合最舒服的地方。

有一个必须记住的陷阱：**只写 `while`，不写 `times` 也不写 `schedule`，就是无间隔、无上限地重试**。我跑过这种配置，在几次让出之后它已经重试了上百次。对应的 `Schedule` 也一样：`Schedule.exponential(...)` 本身是永远继续的，没有任何上限。所以我的规则是：**任何 retry 都必须有明确的次数或时长上界**，退避只决定「每次等多久」，不决定「什么时候放弃」。

## 哪些错误该重试

这是整篇最重要的一节，因为 Schedule 再精巧，重试了不该重试的错误，只是更慢地失败，还可能放大伤害。

我的判断标准是三个问题：

1. **这个失败是暂时的吗？** 网络抖动、上游 503、超时、被限流，等一会儿可能就好了，值得重试。输入非法、资源不存在、没有权限，重试一万次结果一样，应该立即失败。
2. **重试安全吗？** 幂等的读操作随便重试。非幂等的写操作（扣款、下单、发消息）在超时后重试，可能让同一件事发生两次；要重试，请求本身必须带幂等键。**能不能重试是操作的属性，不只是错误的属性**。
3. **重试会不会加剧问题？** 上游已经过载时，所有客户端同时重试就是在放大故障。这时要退避加抖动，必要时要放弃。

落到代码上，判断逻辑只放在一个地方，让「哪些可重试」成为类型的一部分，而不是散落在各个调用点：

```ts
import { Data, Duration, Effect, Schedule } from "effect"

export class Timeout extends Data.TaggedError("Timeout")<{}> {}
export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly status: number
}> {}
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfter: Duration.Duration
}> {}
export class NotFound extends Data.TaggedError("NotFound")<{}> {}
export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly reason: string
}> {}

export type CallError =
  | Timeout
  | Unavailable
  | RateLimited
  | NotFound
  | InvalidInput

// 唯一的事实来源：哪些错误是暂时性的
export type Transient = Timeout | Unavailable | RateLimited
export const isTransient = (e: CallError): e is Transient =>
  e._tag === "Timeout" || e._tag === "Unavailable" || e._tag === "RateLimited"

declare const call: Effect.Effect<string, CallError>

export const resilientCall = call.pipe(
  Effect.retry({
    schedule: Schedule.exponential("200 millis").pipe(
      Schedule.upTo({ times: 4 })
    ),
    while: isTransient
  })
)
```

`NotFound` 和 `InvalidInput` 不在 `Transient` 里，所以第一次失败就直接穿透，不会消耗任何重试预算。以后加一种新错误，类型检查会逼你在 `isTransient` 的旁边做决定，而不是默默落进「默认也重试」。

还有一类东西 `Effect.retry` 根本不碰：**defect**。`Effect.die` 产生的缺陷不是类型化失败，`retry` 不会重试它，我验证过，抛出缺陷后只尝试了 1 次。bug 不会因为多跑几次就修好，这和[类型化错误那一篇](/articles/effect-typed-errors)里 failure 与 defect 的分野是一致的。所以重试的对象从来只是你写进 `E` 里的那部分错误。

有些服务会在响应里告诉你多久后再来，比如 429 的 `Retry-After`。这时延迟不该由退避公式单独决定，用 `Schedule.modifyDelay` 把它并进去：

```ts
import { Data, Duration, Effect, Schedule } from "effect"

export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly retryAfter: Duration.Duration
}> {}
export class Unavailable extends Data.TaggedError("Unavailable")<{}> {}
type CallError = RateLimited | Unavailable

export const policy = Schedule.exponential("100 millis").pipe(
  Schedule.setInputType<CallError>(),
  Schedule.modifyDelay((meta) =>
    Effect.succeed(
      meta.input._tag === "RateLimited"
        ? Duration.max(meta.duration, meta.input.retryAfter)
        : meta.duration
    )
  ),
  Schedule.upTo({ times: 2 })
)
```

`modifyDelay` 的回调只收一个 metadata 参数，里面有 `input`（上一次的错误）、`duration`（策略本来要等的时间）、`attempt`、`elapsed` 等。我把 `retryAfter` 设为 3 秒，实测三次尝试发生在 0、3000、6000 毫秒，退避公式给出的 100ms 被服务端的要求盖过去了。

## 抖动：什么时候必须加

`Schedule.jittered` 把每一次延迟乘上一个随机因子，4.0.5 里的范围是 0.8 到 1.2。我把 1000ms 的 `spaced` 跑了五次，得到的延迟在 933 到 1030 之间。

加抖动的理由是**打散同步重试**：一批客户端同时遇到同一次故障，不加抖动，它们会在同一毫秒集体重试，把刚恢复的下游再次压垮。所以我的判断是边界性的，不是机械规则：

- 面向共享下游、批量 worker、定时任务同时启动、队列 consumer、用户请求扇出的重试，要加。
- 单 fiber 内部轮询、本地固定次数、需要精确节拍的调度，可以不加。

顺序也有讲究：先封顶再抖动，上限才不会被抖动撑破。一个我常用的完整形态是：

```ts
import { Duration, Effect, Schedule } from "effect"

export const retryPolicy = Schedule.min([
  Schedule.exponential("200 millis"),
  Schedule.spaced("2 seconds")
]).pipe(Schedule.upTo({ times: 5 }), Schedule.jittered)

// 不含抖动的骨架：200, 400, 800, 1600, 2000, 然后结束
const skeleton = Schedule.min([
  Schedule.exponential("200 millis"),
  Schedule.spaced("2 seconds")
]).pipe(Schedule.upTo({ times: 5 }))

export const inspect = Effect.gen(function* () {
  const step = yield* Schedule.toStep(skeleton)
  const out: Array<number> = []
  for (let i = 0; i < 6; i++) {
    const exit = yield* Effect.exit(step(0, undefined))
    if (exit._tag === "Failure") break
    out.push(Duration.toMillis(exit.value[1]))
  }
  return out
})
```

封顶用 `min` 加 `spaced`，限次用 `upTo`，最后 `jittered`。这三步分别回答「最长等多久」「最多几次」「怎么打散」，互相正交。

## 超时：单次尝试和整体要分开

`Effect.timeout` 超时后失败为 `TimeoutError`，被超时的 Effect 会被中断；`timeoutOption` 则是返回 `Option.none`。放在重试的内侧还是外侧，意思完全不同，我把两种都跑了：

```ts
import { Effect, Schedule } from "effect"

declare const attempt: Effect.Effect<string, "Transient">

// 单次尝试限时：每次最多 1 秒，最多重试 2 次，一共 3 次尝试
export const perAttempt = attempt.pipe(
  Effect.timeout("1 second"),
  Effect.retry({ times: 2 })
)

// 整体限时：包括所有尝试和退避等待，总共 1 秒
export const overall = attempt.pipe(
  Effect.retry(Schedule.exponential("100 millis")),
  Effect.timeoutOption("1 second")
)
```

第一种用在「某次调用可能卡死」的场景，卡死的那次被中断，下一次重来。第二种用在「用户只愿意等这么久」的场景，我让一个立即失败的任务按 100ms 起步的指数退避重试，整体限时 1 秒，实际发生了 4 次尝试（0、100、300、700 毫秒），随后在退避等待中被整体超时中断。

时长上界还有一个选择：`Schedule.upTo({ duration })`。它不会中断正在运行的尝试，只是在策略层面判断已用时长。同样的任务限 1 秒，我实测发生了 5 次尝试，最后一次开始于超过 1 秒之后，因为判断发生在上一次失败时。所以，**需要硬截止用 `timeout`，需要「不要再开始新的」用 `upTo`**，两者可以同时用。

## repeat：同一个策略，不同的语义

`Effect.repeat` 是 retry 的镜像：retry 在失败时再来，repeat 在成功时再来。有几个反直觉的地方，每一个我都实测过：

```ts
import { Effect, Schedule } from "effect"

export const semantics = Effect.gen(function* () {
  let n = 0
  const task = Effect.sync(() => ++n)

  // times: 2 → 先执行一次，再重复 2 次，共 3 次；返回最后一次的值
  const a = yield* task.pipe(Effect.repeat({ times: 2 }))
  console.log("times:2 ->", a, "runs", n) // 3, runs 3

  // 传 Schedule → 返回的是策略的输出，不是任务的结果
  n = 0
  const b = yield* task.pipe(Effect.repeat(Schedule.recurs(2)))
  console.log("recurs(2) ->", b, "runs", n) // 2, runs 3

  // until：满足条件就停
  n = 0
  const c = yield* task.pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (x) => x >= 3 })
  )
  console.log("until ->", c, "runs", n) // 3, runs 3
})
```

三点：第一，**首次执行是立即的**，策略只管「之后」。第二，传 `Schedule` 时返回值是策略的输出，传 `{ times }` 或 `until` 选项时才是任务本身的返回值，拿结果的话用选项形态。第三，**任务一失败，repeat 就结束**，并且把错误抛出去。

`spaced` 和 `fixed` 的区别在任务本身耗时的时候才出现。任务耗时 300ms，`spaced("1 second")` 的每次启动间隔是 1300ms（任务结束后再等 1 秒），`fixed("1 second")` 则对齐固定的时间格子，我测到的启动时刻是 0、1300、2300、3300。要「两次执行之间留出间隔」选 `spaced`，要「大致每秒一次」选 `fixed`。

后台循环（健康检查、缓存刷新）的标准写法，是把 repeat 放进 Scope 的 fork 里，让它随 Scope 一起结束；循环体内部处理自己的失败，否则一次失败就终止整个循环：

```ts
import { Console, Effect, Schedule } from "effect"

declare const healthCheck: Effect.Effect<void, "Unhealthy">

export const monitor = Effect.scoped(
  Effect.gen(function* () {
    yield* healthCheck.pipe(
      Effect.catch((e) => Console.log(`check failed: ${e}`)),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped
    )
    // ... 主业务逻辑；Scope 关闭时，循环被中断
  })
)
```

这里的 `Effect.catch` 是 v3 `catchAll` 的新名字。我验证了 Scope 关闭后循环不再触发：让它每秒跑一次，在 3.5 秒处关闭，之后推进时钟，计数不再增加。这也比 `setInterval` 好得多：`setInterval` 没有关闭语义，也没有错误通道。

## cron 与限流

`Schedule.cron` 接受标准的五段表达式，输出下一次触发前的等待时长，它读的是 `Clock` 服务，所以可以被 TestClock 驱动。我在时钟 00:00:52 处算 `*/15 * * * *`，得到的等待是 848000 毫秒，也就是正好到 00:15:00。

```ts
import { Effect, Schedule } from "effect"

declare const report: Effect.Effect<void>

export const everyQuarter = report.pipe(
  Effect.repeat(Schedule.cron("*/15 * * * *"))
)
```

一个小建议：大家都爱写整点 `0 * * * *`，所以整点是最拥挤的时刻。没有强业务要求的话，把分钟偏移到 `7`、`23` 这样的值，让集中的请求错开。

限流要分清三件不同的事，Schedule 都不是答案：

- **限制并发数**：同一时刻最多 N 个在飞。用 `Semaphore`，`semaphore.withPermits(1)` 包住任务。我跑了 6 个任务、2 个许可，观测到的最大并发是 2。
- **限制速率**：单位时间最多 N 次。流式场景用 `Stream.throttle`（注意上一篇讲的，cost 按块算）；服务调用用 `effect/persistence` 里的 `RateLimiter`。
- **应对对方的限流**：对方返回 429，用前面的 `modifyDelay` 尊重 `Retry-After`。

并发和速率不是一回事：并发限 2、每个任务 10ms，一秒可以完成上百次；速率限制才约束「每秒几次」。`RateLimiter` 的用法如下：

```ts
import { Effect, Layer } from "effect"
import { RateLimiter } from "effect/persistence"

export const program = Effect.gen(function* () {
  const limited = yield* RateLimiter.makeWithRateLimiter
  for (let i = 0; i < 5; i++) {
    yield* Effect.sync(() => console.log("call", i)).pipe(
      limited({
        key: "external-api",
        limit: 2,
        window: "300 millis",
        onExceeded: "delay"
      })
    )
  }
})

export const MemoryRateLimiter = RateLimiter.layer.pipe(
  Layer.provide(RateLimiter.layerStoreMemory)
)

// Effect.runPromise(program.pipe(Effect.provide(MemoryRateLimiter)))
```

我跑出来五次调用发生在 0、0、300、300、600 毫秒：每个窗口 2 次，超出的被延迟到下一个窗口。`onExceeded: "fail"` 则是直接失败为 `RateLimitExceeded`。需要注意，`layerStoreMemory` 是进程内的，多实例共享额度要换成 `layerStoreRedis`，这一点我只核对了类型签名，没有连 Redis 实测。另外 `consume` 本身只返回应当延迟的时间，不会替你 sleep；要自动等待，用 `makeWithRateLimiter` 或 `RateLimiter.sleep`。

## 测试：不用真的等

Schedule 的所有延迟都走 `Clock`，所以 TestClock 可以让时间跳跃。下面是验证退避时刻的最小写法，这是[运行边界与测试那一篇](/articles/effect-runtime-boundaries-and-testing)里 TestClock 的直接应用：

```ts
import { Data, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"

class Transient extends Data.TaggedError("Transient")<{}> {}

export const timing = Effect.gen(function* () {
  const times: Array<number> = []
  const flaky = Effect.gen(function* () {
    times.push(yield* Effect.clockWith((c) => c.currentTimeMillis))
    return yield* Effect.fail(new Transient())
  })

  const fiber = yield* flaky.pipe(
    Effect.retry(
      Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 3 }))
    ),
    Effect.result,
    Effect.forkChild
  )
  yield* TestClock.adjust("5 seconds")
  yield* Fiber.join(fiber)
  return times.map((t) => t - times[0]!)
}).pipe(Effect.provide(TestClock.layer()))
// [ 0, 100, 300, 700 ]
```

四次尝试在 0、100、300、700 毫秒，正是 100、200、400 的累加。这样的断言写进测试，就把「退避策略」变成了有回归保护的行为，而不是靠肉眼读日志。

## 小结

Schedule 是策略值，retry、repeat、`Stream.retry` 只是消费它（后者会从头重放整条流，细节见 [Effect Stream](/articles/effect-streams)）。v4 里组合它的词汇是 `max`、`min`、`concat`、`upTo`、`while`，而不是 v3 的 `intersect`、`andThen`。

写重试时，我按这个顺序想：先决定哪些错误是暂时的，把这个判断集中在一处并让类型承载它；再确认操作是否幂等；然后给退避封顶、给次数或时长设上界，只写 `while` 或裸的 `exponential` 会无限重试；面向共享下游时加抖动；最后区分单次超时和整体超时。repeat 的返回值取决于传的是策略还是选项，首次执行总是立即的；后台循环放进 `forkScoped`，循环体自己处理失败；限流则要分清并发、速率和对方的限流三件事。

最后，所有这些行为都能用 TestClock 在毫秒内验证。写不出测试的退避策略，大概率也说不清它到底想做什么。
