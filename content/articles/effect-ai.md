---
title: Effect AI：把 LLM 调用当成带类型错误、可重试、可观测的服务
description: 用 effect/ai 把 LLM 调用建模成 LanguageModel 服务：AiError 的 reason、重试与超时的顺序、ExecutionPlan 回退，全部用本地替身验证，不调用真实 API。
date: 2026-10-18
category: effect
tags: [effect, guide]
---

LLM 调用是一个程序里最脆弱的外部依赖：慢、贵、会限流、输出不确定，provider 还随时可能换。用 `fetch` 加 `try/catch` 去写，所有这些都会被压成一个 `unknown`，调用方除了打日志什么也做不了。

我的立场是：LLM 调用应该是一个有类型的服务。失败有名字，哪些值得重试由类型回答，每次调用自带 span，换 provider 只是换一个 Layer。Effect 的 AI 模块恰好就是这么设计的。

本文没有调用任何真实的 LLM API。所有行为都用本地替身验证：替身直接实现 provider 那一层，上面的解码、错误映射、span 都是真实代码在跑。代码在 strict 与 `exactOptionalPropertyTypes` 下编译通过，测试用 `@effect/vitest` 实际跑过。

## 包在哪里：v4 里抽象属于 effect/ai

v4 里 AI 的抽象层已经在核心包里，从 `effect/ai` 导入：`LanguageModel`、`Prompt`、`Tool`、`Toolkit`、`Chat`、`AiError`、`Model` 都在这里。provider 是独立的包，例如 `@effect/ai-openai` 和 `@effect/ai-anthropic`，版本与 effect 同步（本文用的都是 4.0.5）。

有两个旧写法要避开。npm 上的 `@effect/ai` 最新版本停在 0.37，是 v3 那条线，`import { LanguageModel } from "@effect/ai"` 对应的是它。另外有些资料写 `effect/unstable/ai`，在 4.0.5 里这个子路径并不存在，HTTP 客户端也不再来自 `@effect/platform`，而是 `effect/http`。我在 4.0.5 上逐个验证过，这些导入都解析不出来。

## 业务代码只依赖 LanguageModel

先定下函数的形状：输入是文章，输出是结构化摘要，依赖只有 `LanguageModel`，失败只有四种领域错误。调用方不应该知道 OpenAI 有十几种错误码。

```ts
// summarize.ts
import { Cause, Data, Duration, Effect, Schedule, Schema } from "effect"
import { AiError, LanguageModel } from "effect/ai"

export const Summary = Schema.Struct({
  title: Schema.String,
  bullets: Schema.Array(Schema.String),
  sentiment: Schema.Literals(["positive", "neutral", "negative"])
})

export class AiUnavailable extends Data.TaggedError("AiUnavailable")<{
  readonly retryAfter: Duration.Duration | undefined
}> {}
export class AiRefused extends Data.TaggedError("AiRefused")<{ readonly detail: string }> {}
export class AiBadOutput extends Data.TaggedError("AiBadOutput")<{ readonly detail: string }> {}
export class AiMisconfigured extends Data.TaggedError("AiMisconfigured")<{ readonly detail: string }> {}
```

这四个名字回答的是「调用方该怎么办」，而不是「provider 出了什么事」：暂时不可用就稍后再来，被拒绝就换内容，输出不合格就降级，配置错了就该有人被叫醒。

## AiError：一个壳，十八种 reason

`generateText`、`generateObject` 的错误通道是 `AiError`。它本身只带 `module`、`method` 和一个 `reason`，真正的信息都在 `reason` 里，这是一个带 `_tag` 的联合：`RateLimitError`、`QuotaExhaustedError`、`AuthenticationError`、`ContentPolicyError`、`NetworkError`、`StructuredOutputError` 等共十八种。

每个 reason 都有一个 `isRetryable`，限流和 5xx 是 `true`，鉴权失败和额度耗尽是 `false`；`AiError` 自己也转发这个属性，还提供 `retryAfter`。这是**库给出的事实**，我不会在自己的代码里再维护一张「哪些错误可重试」的表。

映射到领域错误则是**我自己的事实**，用一个没有 `default` 分支的 `switch`：

```ts
// summarize.ts（续）
const toDomain = (
  error: AiError.AiError
): Effect.Effect<never, AiUnavailable | AiRefused | AiBadOutput | AiMisconfigured> => {
  const reason = error.reason
  switch (reason._tag) {
    case "RateLimitError":
      return Effect.fail(new AiUnavailable({ retryAfter: reason.retryAfter }))
    case "InternalProviderError":
    case "NetworkError":
      return Effect.fail(new AiUnavailable({ retryAfter: undefined }))
    case "ContentPolicyError":
      return Effect.fail(new AiRefused({ detail: reason.description }))
    case "InvalidOutputError":
    case "StructuredOutputError":
      return Effect.fail(new AiBadOutput({ detail: reason.description }))
    case "QuotaExhaustedError":
    case "AuthenticationError":
    case "InvalidRequestError":
    case "UnsupportedSchemaError":
      return Effect.fail(new AiMisconfigured({ detail: reason.message }))
    case "UnknownError":
    case "ToolNotFoundError":
    case "ToolParameterValidationError":
    case "InvalidToolResultError":
    case "ToolResultEncodingError":
    case "ToolConfigurationError":
    case "ToolkitRequiredError":
    case "InvalidUserInputError":
      return Effect.die(error)
  }
}
```

没有 `default` 是故意的。我试过删掉其中一个 case，编译器立刻报 `TS2366`（函数缺少结尾 return）：以后 provider 新增一种 reason，这里在编译期就会炸，而不是在凌晨三点落进兜底分支。最后一组我选择 `Effect.die`：调用方式写错、toolkit 配置错，是程序 bug，不是可以恢复的失败，这和 [typed errors 那篇](/articles/effect-typed-errors)里「failure 与 defect」的划分一致。

如果你只想单独处理某一种 reason，而保留其余错误，4.0.5 提供了 `Effect.catchReason("AiError", "RateLimitError", handler)`，handler 拿到的是已经解开的 reason。

## 重试与超时：顺序就是语义

接下来是策略。我要的是：指数退避加抖动，provider 给了 `retryAfter` 就以它为下限，只重试 `isRetryable` 的错误，并且最多三次。

```ts
// summarize.ts（续）
export const backoff = Schedule.exponential("200 millis").pipe(
  Schedule.jittered,
  Schedule.setInputType<AiError.AiError | Cause.TimeoutError>(),
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(
      Cause.isTimeoutError(input) ? duration : Duration.max(duration, input.retryAfter ?? Duration.zero)
    )
  )
)

const shouldRetry = (e: AiError.AiError | Cause.TimeoutError) =>
  Cause.isTimeoutError(e) || e.isRetryable

export const summarize = Effect.fn("summarize")(function* (article: string) {
  yield* Effect.annotateCurrentSpan("ai.article_chars", article.length)
  const response = yield* LanguageModel.generateObject({
    objectName: "summary",
    prompt: `Summarize in three bullets:\n${article}`,
    schema: Summary
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.retry({ schedule: backoff, times: 3, while: shouldRetry }),
    Effect.catchTag("TimeoutError", () => Effect.fail(new AiUnavailable({ retryAfter: undefined }))),
    Effect.catchTag("AiError", toDomain)
  )
  return response.value
})
```

`jittered` 必须放在 `modifyDelay` 之前：先给退避加抖动，再用 `retryAfter` 兜底下限，否则抖动可能把延迟压到 provider 要求的时间以下。

`timeout` 放在 `retry` 里面还是外面，语义完全不同：放里面，20 秒是**每次尝试**的预算，最坏情况总耗时是四次尝试加退避；放外面，20 秒是整个操作的总预算。我这里选前者，因为 LLM 的长尾延迟是常态，一次卡死不该吃掉全部重试机会。超时后底层调用会被中断，我验证过替身里的 `onInterrupt` 确实被触发，也不会留下悬空请求。

在 4.0.5 里，`Effect.timeout` 的失败是 `TimeoutError`（v3 里叫 `TimeoutException`），所以 `catchTag` 写的是 `"TimeoutError"`。

最后是成本问题。`StructuredOutputError`（模型输出不符合 schema）的 `isRetryable` 是 `true`，这合理，因为重试一次有可能就好了，但每次重试都要付 token 的钱。所以 `times` 要小，而且应该监控耗尽后的 `AiBadOutput`。

## 用 LanguageModel.make 写替身

怎么在不碰网络的情况下验证上面这些？`LanguageModel.make` 要的只是 provider 那一层：给它 `generateText` 和 `streamText`，它会负责 prompt 处理、响应解码、结构化输出校验和 span。所以替身只需要回放一段脚本：

```ts
// stub.ts
import { Duration, Effect, Layer, Ref, Stream } from "effect"
import { AiError, LanguageModel, type Response } from "effect/ai"

export type Step = Effect.Effect<Array<Response.PartEncoded>, AiError.AiError>

export const done = (text: string): Step =>
  Effect.succeed<Array<Response.PartEncoded>>([
    { type: "text", text },
    {
      type: "finish",
      reason: "stop",
      usage: {
        inputTokens: { uncached: 10, total: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 }
      }
    }
  ])

export const fail = (reason: AiError.AiErrorReason) =>
  Effect.fail(AiError.make({ module: "Stub", method: "generateText", reason }))

export const rateLimited = (retryAfter: Duration.Input) =>
  fail(new AiError.RateLimitError({ retryAfter: Duration.fromInputUnsafe(retryAfter) }))

export const scripted = (steps: ReadonlyArray<Step>, calls: Ref.Ref<number>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.gen(function* () {
          const i = yield* Ref.getAndUpdate(calls, (n) => n + 1)
          return yield* steps[Math.min(i, steps.length - 1)]!
        }),
      streamText: () => Stream.empty
    })
  )
```

`calls` 这个 `Ref` 用来断言重试了几次。替身返回的是 `PartEncoded`（provider 的原始形态），所以 `generateObject` 里的 JSON 解析与 schema 校验是真实走过的。

有了它，就可以用 `TestClock` 把时间变成确定的。下面三个测试分别验证：`retryAfter` 被当成延迟下限、不可重试的错误只调用一次、持续返回坏输出时用尽四次尝试后变成 `AiBadOutput`。

```ts
// summarize.test.ts
import { it, expect } from "@effect/vitest"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { AiError } from "effect/ai"
import { summarize } from "./summarize.ts"
import { done, fail, rateLimited, scripted } from "./stub.ts"

const good = done(JSON.stringify({ title: "t", bullets: ["a"], sentiment: "neutral" }))

it.effect("retryAfter 是延迟下限", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const fiber = yield* summarize("hello").pipe(
      Effect.provide(scripted([rateLimited("5 seconds"), good], calls)),
      Effect.forkChild
    )
    yield* TestClock.adjust("4900 millis")
    expect(yield* Ref.get(calls)).toBe(1)
    yield* TestClock.adjust("100 millis")
    expect((yield* Fiber.join(fiber)).title).toBe("t")
    expect(yield* Ref.get(calls)).toBe(2)
  })
)

it.effect("鉴权失败不重试", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const error = yield* summarize("hello").pipe(
      Effect.provide(scripted([fail(new AiError.AuthenticationError({ kind: "InvalidKey" }))], calls)),
      Effect.flip
    )
    expect(error._tag).toBe("AiMisconfigured")
    expect(yield* Ref.get(calls)).toBe(1)
  })
)

it.effect("坏输出用尽重试后变成 AiBadOutput", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const fiber = yield* summarize("hello").pipe(
      Effect.provide(scripted([done("not json")], calls)),
      Effect.flip,
      Effect.forkChild
    )
    yield* TestClock.adjust("1 minute")
    expect((yield* Fiber.join(fiber))._tag).toBe("AiBadOutput")
    expect(yield* Ref.get(calls)).toBe(4)
  })
)
```

我还用同样的方式验证了另外几件事：持续挂起的调用会在每次 20 秒后超时，四次尝试之后变成 `AiUnavailable`；`InvalidUserInputError` 这类调用方 bug 会变成 defect 而不是失败。时间相关的细节见 [运行时边界与测试](/articles/effect-runtime-boundaries-and-testing)，重试策略本身的更多写法见 [retry 与 schedule](/articles/effect-retry-and-schedule)。

## 可观测：span 是自带的

`LanguageModel.generateText`、`generateObject` 每次调用都会开一个名为 `LanguageModel.generateText`（或 `generateObject`）的 `client` 类型 span，并成为你当前 span 的子 span，属性里有输出类型、tool choice 等。provider 实现还会按 GenAI 的约定补充模型名、token 用量。你不需要手写任何包装，只要调用方本身有 span：

```ts
// span.test.ts
import { it, expect } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { LanguageModel } from "effect/ai"

const seen: Array<string> = []

const spy = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: (options) =>
      Effect.sync(() => {
        const parent = Option.getOrUndefined(options.span.parent)
        const parentName = parent?._tag === "Span" ? parent.name : undefined
        seen.push(`${options.span.name} ${options.span.kind} ${parentName}`)
        return [{ type: "text", text: "hi" } as const]
      }),
    streamText: () => Stream.empty
  })
)

const ask = Effect.fn("ask")(function* (question: string) {
  return yield* LanguageModel.generateText({ prompt: question })
})

it.effect("LanguageModel 的 span 挂在调用方 span 下", () =>
  ask("x").pipe(
    Effect.provide(spy),
    Effect.tap(() => Effect.sync(() => expect(seen).toEqual(["LanguageModel.generateText client ask"])))
  )
)
```

断言通过：provider 层看到的 span 名是 `LanguageModel.generateText`，类型是 `client`，父 span 是 `ask`。所以 `Effect.fn("summarize")` 这一个名字，就把业务语义和模型调用串成了同一条 trace。token 用量也不用另外埋点：`response.usage` 在成功响应里，你想算成本，在 `summarize` 里读一下即可。导出到 OpenTelemetry 的部分在 [observability 那篇](/articles/effect-observability)。

## provider 回退：ExecutionPlan

生产上你大概率需要回退：主 provider 连续失败，就换一个。`ExecutionPlan` 描述一串步骤，每步有自己的 provider、尝试次数与条件，业务代码一行不用改。

```ts
// plan.test.ts
import { it, expect } from "@effect/vitest"
import { Effect, ExecutionPlan, Ref } from "effect"
import { AiError, LanguageModel, Model } from "effect/ai"
import { done, fail, scripted } from "./stub.ts"

it.effect("第一个 provider 持续失败后回退到第二个", () =>
  Effect.gen(function* () {
    const callsA = yield* Ref.make(0)
    const callsB = yield* Ref.make(0)
    const providerA = Model.make(
      "a",
      "model-a",
      scripted([fail(new AiError.InternalProviderError({ description: "boom" }))], callsA)
    )
    const providerB = Model.make("b", "model-b", scripted([done("from b")], callsB))

    const plan = ExecutionPlan.make(
      { provide: providerA, attempts: 2, while: (e: AiError.AiError) => Effect.succeed(e.isRetryable) },
      { provide: providerB, attempts: 1 }
    )

    const [provider, text] = yield* Effect.gen(function* () {
      const name = yield* Model.ProviderName
      const response = yield* LanguageModel.generateText({ prompt: "x" })
      return [name, response.text] as const
    }).pipe(Effect.withExecutionPlan(plan))

    expect([provider, text]).toEqual(["b", "from b"])
    expect([yield* Ref.get(callsA), yield* Ref.get(callsB)]).toEqual([2, 1])
  })
)
```

跑出来的结果是 A 被调用两次，B 一次，`Model.ProviderName` 在业务代码里读到的是 `"b"`，这对日志和成本归因很有用。`while` 里仍然用 `isRetryable`：不可重试的错误（比如鉴权）没必要在同一个 provider 上耗掉次数。

接真实 provider 的 wiring 长这样。这一段我只做了类型检查，没有运行，因为运行就要真实的 key 和网络：

```ts
// live.ts
import { Config, Effect, ExecutionPlan, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"

const OpenAiLive = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("OPENAI_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

const AnthropicLive = AnthropicClient.layerConfig({
  apiKey: Config.Redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

const plan = ExecutionPlan.make(
  { provide: OpenAiLanguageModel.model("gpt-4.1"), attempts: 2 },
  { provide: AnthropicLanguageModel.model("claude-sonnet-4-5"), attempts: 1 }
)

export const withFallback = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const captured = yield* plan.captureRequirements
    return yield* self.pipe(Effect.withExecutionPlan(captured))
  }).pipe(Effect.provide([OpenAiLive, AnthropicLive]))
```

有几个细节值得注意。`OpenAiLanguageModel.model("gpt-4.1")` 本身就是一个 Layer，同时提供 `LanguageModel`、`ProviderName` 与 `ModelName`。`captureRequirements` 把 plan 里各 provider 的 client 依赖提升到外层，这样业务函数的 `R` 里不会混进 `OpenAiClient`。密钥用 `Config.Redacted` 读取（v3 的 `Config.redacted` 在 4.0.5 里不存在），缺 key 不会等到调用时才暴露：我在没有任何环境变量的情况下构建这个 Layer，它在构建阶段就以 `ConfigError` 失败，没有发出任何请求。这正是 Layer 把配置错误前移的价值。

## 结构化输出与 Tool：失败同样有类型

`generateObject` 会把 provider 返回的 JSON 按 schema 解码。我给替身喂了一个 `sentiment: "meh"` 和一段根本不是 JSON 的文本，两种情况得到的都是 `AiError`，reason 是 `StructuredOutputError`，`isRetryable` 为 `true`，错误信息里带着具体字段路径。schema 设计上我的建议是保守：枚举代替开放字符串，列表要有上界，因为 schema 越松，模型越容易「合法地」给你垃圾。

Tool 的思路相同：参数、成功值、失败值都是 Schema，handler 是普通 Effect，可以依赖其他服务。

```ts
// tools.test.ts
import { it, expect } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit, type Response } from "effect/ai"

const GetWeather = Tool.make("GetWeather", {
  description: "Current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ celsius: Schema.Number }),
  failure: Schema.Struct({ _tag: Schema.tag("CityNotFound"), city: Schema.String })
})

const Weather = Toolkit.make(GetWeather)

const WeatherLive = Weather.toLayer(
  Effect.succeed(
    Weather.of({
      GetWeather: ({ city }) =>
        city === "Atlantis"
          ? Effect.fail({ _tag: "CityNotFound" as const, city })
          : Effect.succeed({ celsius: 21 })
    })
  )
)

const toolCall = (city: string): Array<Response.PartEncoded> => [
  { type: "tool-call", id: "c1", name: "GetWeather", params: { city } },
  {
    type: "finish",
    reason: "tool-calls",
    usage: {
      inputTokens: { uncached: 1, total: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 }
    }
  }
]

const modelCalling = (city: string) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed(toolCall(city)),
      streamText: () => Stream.empty
    })
  )

it.effect("工具成功：结果带类型", () =>
  Effect.gen(function* () {
    const toolkit = yield* Weather
    const response = yield* LanguageModel.generateText({ prompt: "weather?", toolkit })
    expect(response.toolResults.map((r) => r.result)).toEqual([{ celsius: 21 }])
  }).pipe(Effect.provide(modelCalling("Oslo")), Effect.provide(WeatherLive))
)

it.effect("工具失败：默认进入错误通道", () =>
  Effect.gen(function* () {
    const toolkit = yield* Weather
    const error = yield* LanguageModel.generateText({ prompt: "weather?", toolkit }).pipe(Effect.flip)
    expect(error).toEqual({ _tag: "CityNotFound", city: "Atlantis" })
  }).pipe(Effect.provide(modelCalling("Atlantis")), Effect.provide(WeatherLive))
)
```

注意第二个测试：handler 的失败默认会出现在 `generateText` 的错误通道里，类型也跟着变宽，所以你能 `catchTag("CityNotFound")`。`Tool.make` 有 `failureMode`，设成 `"return"` 则把失败当作工具结果交还给模型，让它自己重试，这是 agent 场景常用的选择。另外要小心：`ToolNotFoundError`、`ToolParameterValidationError` 的 `isRetryable` 也是 `true`（模型下一轮有机会自己纠正），所以带 toolkit 的调用，要给重试次数和 agent 循环的步数都设上界。

## 小结

核心就是一句话：**把 LLM 调用当成有类型的、可组合的 Effect，而不是一个会抛异常的 SDK 调用。**

- 业务函数只依赖 `LanguageModel`，错误通道是你自己的领域错误；`AiError` 的十八种 `reason` 用没有 `default` 的 `switch` 映射，新增 reason 时编译期报错。
- 可不可以重试由库的 `isRetryable` 回答，延迟用 `retryAfter` 做下限；`timeout` 放在 `retry` 里面是每次尝试的预算，放外面是总预算。
- span 是自带的，只要调用方有 span 就会串成一条 trace；换 provider 或加回退用 `ExecutionPlan`，业务代码不动。
- 测试靠 `LanguageModel.make` 写替身，配合 `TestClock`，一次真实请求都不用发。

最后是一个工程上的提醒：「业务代码不得直接 import openai 或 anthropic 的 SDK」这种约定，靠自觉维持不了多久，应该交给机器检查，这是下一篇 [把 Effect 约定变成机器可检查的规则](/articles/effect-rules-as-contracts) 要讲的事。
