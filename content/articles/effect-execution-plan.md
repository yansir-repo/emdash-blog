---
title: "Effect ExecutionPlan：把多供应商 fallback 写成一个有序降级链"
description: ExecutionPlan 把「先试 A，重试两次，不行换 B，最后本地兜底」写成一个值：每步提供不同的 Layer，可配 attempts、schedule、while，用 onEvent 观察。unstable 特性，附流式场景的坑。
date: 2026-10-22
tags: [effect, effect-advanced, execution-plan, fallback, resilience]
category: effect
---

调用大模型 API 的时候，几乎所有人都会写出同一段代码：先打 OpenAI，失败了重试两次，还不行就换 Anthropic，再不行退回本地小模型。常见写法是嵌套的 `catch` 夹着 `retry`，每层手工 `provide` 一个 client。能跑，但降级顺序藏在嵌套里，「哪个错误重试、哪个直接换家」的判断散落各处，想知道最后是谁答的还得到处打日志。

`ExecutionPlan` 的立场是：**降级链是一个值，不是一段控制流**。它描述有序的若干步，每一步提供自己的资源（`Context` 或 `Layer`），可以限定尝试次数、挂一个 `Schedule` 决定重试间隔、用 `while` 判断某个错误还值不值得在这一步继续。运行时按顺序走，成功即停，用尽才失败。

先说在前面：**这是 unstable 特性**。`effect@4.0.5` 里 `ExecutionPlan` 模块以及 `Effect.withExecutionPlan`、`Stream.withExecutionPlan` 的 JSDoc 都标着 `@stability unstable`。小版本之间 API 可能变，要放在一层薄封装里。

## 一个有序降级链

下面的例子不依赖真实 SDK。`Llm` 是自定义服务，三个「供应商」是三个 Layer，前两个必然失败，用来看清降级轨迹：

```ts
import { Cause, Context, Data, Effect, ExecutionPlan, Layer, Result, Schedule } from "effect"

class LlmError extends Data.TaggedError("LlmError")<{
  readonly provider: string
  readonly status: number
}> {
  get retryable() {
    return this.status === 429 || this.status >= 500
  }
}

class Llm extends Context.Service<Llm, {
  readonly provider: string
  readonly complete: (prompt: string) => Effect.Effect<string, LlmError>
}>()("app/Llm") {}

// 模拟供应商：status 为 undefined 表示成功，否则以该状态码失败
const provider = (name: string, status?: number) =>
  Layer.succeed(
    Llm,
    Llm.of({
      provider: name,
      complete: (prompt) =>
        status === undefined
          ? Effect.succeed(`[${name}] ${prompt}`)
          : Effect.fail(new LlmError({ provider: name, status }))
    })
  )

const plan = ExecutionPlan.make(
  {
    provide: provider("openai", 503),
    attempts: 2,
    schedule: Schedule.exponential("20 millis"),
    while: (e: LlmError) => e.retryable
  },
  { provide: provider("anthropic", 429), attempts: 1 },
  { provide: provider("local") }
)

const ask = (prompt: string) =>
  Effect.gen(function*() {
    const llm = yield* Llm
    const { attempt, stepIndex } = yield* ExecutionPlan.CurrentMetadata
    yield* Effect.logDebug(`attempt=${attempt} step=${stepIndex} provider=${llm.provider}`)
    return yield* llm.complete(prompt)
  })

const program = Effect.withExecutionPlan(ask("ping"), plan, {
  onEvent: (event) =>
    Effect.sync(() => {
      const prefix = `${event._tag} #${event.attempt} step=${event.stepIndex}`
      if (event._tag === "AttemptFailure") {
        const error = Cause.findError(event.cause)
        console.log(prefix, Result.isSuccess(error) ? error.success.status : "non-LlmError")
      } else {
        console.log(prefix)
      }
    })
})

Effect.runPromise(program).then(console.log)
```

这段代码在 4.0.5 下实际跑过，输出是：

```text
AttemptStart #1 step=0
AttemptFailure #1 step=0 503
AttemptStart #2 step=0
AttemptFailure #2 step=0 503
AttemptStart #3 step=1
AttemptFailure #3 step=1 429
AttemptStart #4 step=2
AttemptSuccess #4 step=2
[local] ping
```

被降级的 `ask` 完全不知道计划的存在，它只依赖 `Llm`，计划在每次尝试前提供这一步的 Layer。降级策略是外挂的，业务代码保持单一职责。

## 每一步的四个旋钮

- `provide`：`Context` 或 `Layer`，这一步每次尝试拿到的服务。
- `attempts`：本步最多尝试几次，默认 1。`attempts: 2` 是总共两次，不是「重试两次」。
- `schedule`：同一步内两次尝试之间的等待。我用 `Schedule.spaced("100 millis")` 实测过，三次尝试间隔约 100ms。它和 `attempts` 叠加，先到先停，所以无限的 `exponential` 在上例里也只跑两次。Schedule 的组合见 [重试与 Schedule](/articles/effect-retry-and-schedule)。
- `while`：拿到上次的错误，返回布尔值（或 Effect）。返回 false 表示不值得在本步继续，直接进入下一步。我实测过：`attempts: 5` 的步骤遇到不可重试错误，只尝试 1 次就转到下一步。

`while` 区分「换一家」和「再来一次」：429、5xx 值得原地退避，400、401 试一百次也没用。参数类型要自己标注，如 `(e: LlmError) => ...`。

全部用尽后，effect 以**最后一次尝试的错误**失败，我用两步都失败的计划实测过，不会聚合前面的错误。要完整历史就在 `onEvent` 里收集。

## 观察：onEvent 与 CurrentMetadata

最怕的是悄悄降级没人知道。有两个观察入口，职责不同。

`onEvent` 在计划外观察。每次尝试发出 `AttemptStart`，随后有且仅有一个终止事件：`AttemptSuccess` 或 `AttemptFailure`。`attempt` 是跨步骤的累计次数（从 1 开始），`stepAttempt` 是本步内次数，`stepIndex` 是步骤下标（从 0 开始）。`AttemptFailure` 带完整 `cause`，缺陷和中断也看得到。文档写明的性质：

- handler 被内联等待，事件严格有序，所以要廉价。
- handler 不能失败，观察不会改变结果；它的 requirements 会加到最终 effect 上。
- 终止事件像 finalizer，被中断时也会发出。

`ExecutionPlan.CurrentMetadata` 在计划内观察。它是一个 `Context.Reference`（见 [Context.Reference](/articles/effect-context-reference)），在被降级的 effect 里读到 `{ attempt, stepIndex }`；计划之外读取回落到默认值 `{ attempt: 0, stepIndex: 0 }`，我实测过。

我的分工：要把「最终由谁答复」写进响应或 span，用 `CurrentMetadata`，它在业务代码里能和当前 Layer 的 provider 名放在一起；要统计失败率、告警，用 `onEvent`，它能看到每次失败，包括被降级吞掉的。整体可观测性见 [可观测性](/articles/effect-observability)。

## 和 Layer 的关系：重建与 requirements

两个实测得到的事实。

第一，**每次尝试都会重新构建这一步的 Layer**。我用带日志的 `Layer.effect` 试过，`attempts: 2` 的步骤构建了两次。昂贵的连接池应放在计划外，由上层 Layer 提供，step 的 Layer 只做轻量适配。

第二，step 的 Layer 若依赖别的服务（如 `ApiKey`），依赖会出现在 `withExecutionPlan` 结果的 requirements 里，我验证过类型是 `Effect<string, LlmError, ApiKey>`。想把依赖收进服务自己的 Layer，用 `plan.captureRequirements`：它是一个 effect，用当前 Context 满足 requirements，返回无 requirements 的等价计划。官方 AI 示例就在 `Layer.effect` 里这样用。

`ExecutionPlan.merge(p1, p2)` 把多份计划按顺序拼接，我验证过「带 `attempts: 2` 的远程步骤加本地兜底」的拼接结果正确。

## Stream：流式 fallback 的坑

`Stream.withExecutionPlan` 和 Effect 版本参数一致，多了一个选项 `preventFallbackOnPartialStream`。流式场景下它很关键，因为失败可能发生在已经吐出一半 token 之后。

```ts
import { Context, Effect, ExecutionPlan, Layer, Stream } from "effect"

class Llm extends Context.Service<Llm, {
  readonly tokens: Stream.Stream<string, string>
}>()("app/StreamingLlm") {}

const flaky = Layer.succeed(Llm, Llm.of({
  tokens: Stream.concat(Stream.make("你", "好"), Stream.fail("connection reset"))
}))
const stable = Layer.succeed(Llm, Llm.of({ tokens: Stream.make("你", "好", "!") }))

const tokens = Stream.unwrap(Effect.map(Effect.service(Llm), (llm) => llm.tokens))
const plan = ExecutionPlan.make({ provide: flaky }, { provide: stable })

const mixed = Stream.runCollect(Stream.withExecutionPlan(tokens, plan))
const strict = Stream.runCollect(
  Stream.withExecutionPlan(tokens, plan, { preventFallbackOnPartialStream: true })
)

Effect.runPromise(mixed).then((r) => console.log(r))
Effect.runPromiseExit(strict).then((r) => console.log(r._tag))
```

实际输出：

```text
Failure
[ '你', '好', '你', '好', '!' ]
```

默认**照常降级**：下游先收到第一家的「你好」，再收到第二家完整的「你好!」，拼成 `你好你好!`。给用户逐字展示的聊天界面，这是错的。设置 `preventFallbackOnPartialStream: true` 后，已输出过元素的步骤失败，整个流直接失败。

一个我实测发现的细节：这个选项只阻止**跨步骤降级**，同一步内按 `attempts` 重试仍会发生，并从头重新输出。我用 `attempts: 2` 加此选项试过，下游看到两遍开头元素才失败。流式场景要避免重复，就把有部分输出风险的步骤 `attempts` 设为 1，或在下游缓冲到完整消息再放行。

另外文档写明：下游提前停止拉取（如计划外的 `Stream.take`）时，被截断的尝试报告 `AttemptSuccess`，因为是消费者停了，统计失败率时别当成异常。

## 什么时候不该用

只对同一个资源重试，直接用 `Effect.retry` 加 `Schedule`，更简单也更稳定。只有每次重试需要**换一个 Layer**（换供应商、区域、模型档位）时，计划才有价值。它也不管并发：不会同时向两家发请求取最快的，对冲请求要用 `Effect.race`，见 [并发与资源](/articles/effect-concurrency-and-resources)。

[AI 篇](/articles/effect-ai) 的 `LanguageModel` 正是配合这套机制使用的，官方示例把 `OpenAiLanguageModel.model(...)` 之类的模型 Layer 直接放进 `provide`。我这里没接真实供应商，那部分未验证，上面的示例都是模拟 Layer 跑的。

## 小结

- `ExecutionPlan` 把降级链变成值：有序的 step，每步 `provide` 一个 `Context` 或 `Layer`，可配 `attempts`、`schedule`、`while`。
- `while` 区分「原地重试」和「换下一家」；用尽后以最后一次的错误失败。
- 观察用 `onEvent`（计划外、看每次尝试）和 `CurrentMetadata`（计划内、读当前步骤）；每次尝试都会重建这一步的 Layer。
- 流式场景默认会拼接部分输出，`preventFallbackOnPartialStream` 只阻止跨步骤降级，不阻止同步骤重试。
- 整个模块标注 `@stability unstable`，建议用一层薄封装隔离，不要让它散落在业务代码里。
