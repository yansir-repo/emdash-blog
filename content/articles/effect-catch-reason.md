---
title: "Effect catchReason：处理「父错误 + 嵌套 reason」的两级错误"
description: 用 catchReason、catchReasons、unwrapReason 处理 AiError、HttpClientError 这类带嵌套 reason 的错误，对比手写二级 switch 与 catchTags，并讲清残余类型的坑。
date: 2026-10-22
tags: [effect, effect-advanced, error-handling, catch-reason]
category: effect
---

[Effect 类型化错误](/articles/effect-typed-errors)那一篇讲过，`catchTag` 按 `_tag` 精确恢复。但 v4 里一个越来越常见的错误形状，`catchTag` 只能做到一半：外层是一个稳定的「父错误」，里面的 `reason` 字段才是真正的、可枚举的失败原因。

`effect/ai` 的 `AiError` 把 `RateLimitError`、`QuotaExhaustedError`、`ContentPolicyError` 等收进 `reason`；`effect/http` 的 `HttpClientError` 把 `TransportError`、`StatusCodeError`、`DecodeError` 等收进 `reason`。这两个模块在 4.0.5 里都标注为 `@stability unstable`，细节可能变，但「父错误 + tagged reason」这个模式本身，已经有一组 stable 的 Effect 组合子来处理。

这一篇讲这组组合子：`Effect.catchReason`、`Effect.catchReasons`、`Effect.unwrapReason`，以及它们和手写二级 switch、`catchTags` 的取舍。下文代码基于 `effect@4.0.5` 验证。

## 为什么需要它：catchTag 只下到第一层

先定义一个典型的两级错误。父错误 `AiError` 带一个 `reason`，reason 是三个带 `_tag` 的变体之一：

```ts
import { Data, Effect } from "effect"

export class RateLimited extends Data.TaggedError("RateLimited")<{ readonly retryAfter: number }> {}
export class QuotaExceeded extends Data.TaggedError("QuotaExceeded")<{ readonly limit: number }> {}
export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{ readonly detail: string }> {}

export class AiError extends Data.TaggedError("AiError")<{
  readonly reason: RateLimited | QuotaExceeded | InvalidRequest
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{ readonly cause: unknown }> {}

export declare const callModel: Effect.Effect<string, AiError | NetworkError>
```

只想处理限流时，用 `catchTag` 只能抓到整个 `AiError`，然后手写第二层分支：

```ts
import { Effect } from "effect"
import { callModel } from "./model.ts"

export const manual = callModel.pipe(
  Effect.catchTag("AiError", (e) => {
    switch (e.reason._tag) {
      case "RateLimited":
        return Effect.succeed(`retry after ${e.reason.retryAfter}s`)
      case "QuotaExceeded":
        return Effect.succeed(`quota ${e.reason.limit}`)
      default:
        return Effect.fail(e)
    }
  })
)
```

这段代码能跑，我实际执行过：限流和配额返回字符串，`InvalidRequest` 原样重新失败。问题不在功能，在结构：

- 每个调用点都重复「抓父错误、switch reason、default 重抛」这套样板。
- `default: Effect.fail(e)` 之后，结果类型里还是完整的 `AiError`，编译器不知道你已经处理了哪几个 reason。
- 将来 `reason` 联合里加了新变体，这个 switch 不会报错，只会悄悄落进 `default`。

这三点的共同根源是：「第一层靠 `_tag` 路由，第二层靠手写分支」是两套机制，却描述同一件事。`catchReason` 的价值就是把它合成一个概念。

## catchReason：精确抓一个 reason

```ts
import { Effect } from "effect"
import { callModel } from "./model.ts"

export const one = callModel.pipe(
  Effect.catchReason("AiError", "RateLimited", (r) =>
    Effect.succeed(`retry after ${r.retryAfter}s`)
  )
)
```

参数依次是：父错误的 `_tag`、reason 的 `_tag`、处理器。处理器拿到的已经是收窄后的 reason（这里是 `RateLimited`，所以能直接读 `retryAfter`）。

几条我验证过的行为：

- 命中时返回处理器的结果；`InvalidRequest`、`QuotaExceeded` 等未命中的 reason，以及 `NetworkError` 这类压根没有 reason 的错误，都原样保持失败。
- 未命中时错误类型保持为 `AiError | NetworkError`，没有被收窄。父错误仍在 E 里，因为它可能还装着别的 reason。
- 父 tag 写错、或者父错误根本没有 tagged reason（比如把 `"NetworkError"` 当父），是编译错误，不是运行时才发现。reason tag 写错同理。

### 第四个参数：兜底其余 reason

`catchReason` 可以带第四个参数，处理「同一个父错误下其余所有 reason」：

```ts
import { Effect } from "effect"
import { callModel, type NetworkError, type QuotaExceeded, type InvalidRequest } from "./model.ts"

export const withElse = callModel.pipe(
  Effect.catchReason(
    "AiError",
    "RateLimited",
    (r) => Effect.succeed(`retry after ${r.retryAfter}s`),
    (rest) => Effect.fail(rest)
  )
)

export const typed: Effect.Effect<string, QuotaExceeded | InvalidRequest | NetworkError> = withElse
```

注意类型：带兜底之后，`AiError` 从 E 里消失了，取而代之的是兜底处理器失败出来的东西。这里我把剩下的 reason 直接 `Effect.fail` 出去，于是 E 变成 `QuotaExceeded | InvalidRequest | NetworkError`，父错误被「拆开」了。

官方示例里还有一个很实用的写法：只想把一个 reason 提升成顶层错误，其余都当缺陷。

```ts
import { Effect } from "effect"
import { callModel } from "./model.ts"

export const promote = callModel.pipe(
  Effect.catchReason("AiError", "InvalidRequest", Effect.fail, Effect.die)
)
```

`Effect.fail` 把 `InvalidRequest` 提升为顶层预期错误，`Effect.die` 把其余 reason 变成 defect。我跑过：限流与配额变成 `Die`，`InvalidRequest` 保持 `Fail`，`NetworkError` 不受影响。这种「我只关心一种，其余视为 bug」的边界在 HTTP handler 里很常见，ai-docs 的 HTTP server 示例就是这么用的。

## catchReasons：一次处理多个 reason

处理两个以上 reason 时，用对象形式：

```ts
import { Effect } from "effect"
import { callModel } from "./model.ts"

export const many = callModel.pipe(
  Effect.catchReasons("AiError", {
    RateLimited: (r) => Effect.succeed(`retry after ${r.retryAfter}s`),
    QuotaExceeded: (r) => Effect.succeed(`quota ${r.limit}`)
  })
)
```

对象的键是 reason 的 `_tag`，键可以缺省，没写的 reason 保持失败。和 `catchTags` 的形状一致，只是多了一个父 tag 参数。

这里有个我在编译器里亲眼确认的坑：**不带兜底的 `catchReasons`，即使你把所有 reason 都写全了，结果类型里仍然保留 `AiError`**。我给三个 reason 全部提供了处理器，把结果赋给 `Effect<string, NetworkError>` 依然是类型错误，必须写成 `Effect<string, AiError | NetworkError>`。类型系统不会因为你「覆盖了联合的全部成员」就去掉父错误。

想让父错误真正消失，有两条路：给 `catchReasons` 加兜底处理器作为第三个参数，或者改用下面的 `unwrapReason`。

```ts
import { Effect } from "effect"
import { callModel, NetworkError } from "./model.ts"

export const closed = callModel.pipe(
  Effect.catchReasons(
    "AiError",
    { RateLimited: (r) => Effect.succeed(`retry after ${r.retryAfter}s`) },
    (rest) => Effect.fail(new NetworkError({ cause: rest }))
  )
)

export const closedT: Effect.Effect<string, NetworkError> = closed
```

兜底处理器拿到的是「去掉已处理 reason 之后」的剩余 reason，类型随之收窄。上面例子里我把剩余 reason 折叠成一个 `NetworkError`，E 就只剩 `NetworkError`。

## unwrapReason：把 reason 提升到错误通道

如果你的恢复逻辑更像 `catchTags` 那种「按错误种类分派」，可以先把 reason 拆出来：

```ts
import { Effect } from "effect"
import { callModel } from "./model.ts"

export const unwrapped = callModel.pipe(
  Effect.unwrapReason("AiError"),
  Effect.catchTags({
    RateLimited: (r) => Effect.succeed(`retry after ${r.retryAfter}s`),
    QuotaExceeded: (r) => Effect.succeed(`quota ${r.limit}`)
  })
)
```

`unwrapReason("AiError")` 之后，E 从 `AiError | NetworkError` 变成 `RateLimited | QuotaExceeded | InvalidRequest | NetworkError`：父错误被替换成它的 reason，其他错误原样透传。接着 `catchTags` 处理哪几个，E 里就剩哪几个，这里剩 `InvalidRequest | NetworkError`，我用类型注解确认过。

代价也要说清：父错误上的上下文，比如 `AiError` 的 `module`、`method`，在 unwrap 之后就拿不到了。恢复逻辑如果需要这些字段，就别 unwrap，用 `catchReason`，它的处理器第二个参数可以拿到父错误。

## 用真实的 HttpClientError

`HttpClientError` 是 effect/http 里的 reason 形状错误，下面用它写一个「404 当作不存在，传输失败当作离线，其余状态码继续失败」的例子。注意它在 4.0.5 里是 `@stability unstable`：

```ts
import { Effect } from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

const request = HttpClientRequest.get("http://localhost/users/1")

const respond = (status: number): Effect.Effect<string, HttpClientError.HttpClientError> =>
  status === 200
    ? Effect.succeed("ok")
    : Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.StatusCodeError({
            request,
            response: HttpClientResponse.fromWeb(request, new Response(null, { status }))
          })
        })
      )

export const program = (status: number) =>
  respond(status).pipe(
    Effect.catchReasons("HttpClientError", {
      StatusCodeError: (r) => (r.response.status === 404 ? Effect.succeed("missing") : Effect.fail(r)),
      TransportError: () => Effect.succeed("offline")
    })
  )
```

我实际跑了 200、404、500 和一个 `TransportError`：分别得到 `ok`、`missing`、`StatusCodeError` 失败、`offline`。

这里有一个细节值得留意：处理器里 `Effect.fail(r)` 失败出去的是 reason（`StatusCodeError`）本身，而不是原来的 `HttpClientError`。也就是说，处理器的失败类型会直接进入结果的 E，和父错误是否保留互不相干。

AI 侧同理。`AiError.AiError` 的 reason 是 `RateLimitError`、`QuotaExhaustedError`、`ContentPolicyError`、`InvalidRequestError`、`NetworkError` 等十几个变体，我用 `AiError.make` 构造了一个限流错误，`catchReason("AiError", "RateLimitError", ...)` 和 `unwrapReason("AiError")` 都能通过 `tsc` 并给出正确的类型。读 `retryAfter` 时要注意它在 reason 上是可选的 `Duration`。

## 怎么选

- 只关心一个 reason，其余原样放行：`catchReason`。
- 同一个父错误下两三个 reason 要分别处理：`catchReasons`。
- 要把父错误彻底消掉：给 `catchReason` 或 `catchReasons` 加兜底，类型才会收窄。
- 恢复逻辑本质是按种类分派，且不需要父错误的上下文：`unwrapReason` 加 `catchTags`。
- reason 不是 tagged（比如只是个字符串字段）：这组组合子不适用，退回手写分支。
- 想按「父错误的某个非 tag 字段」或自定义条件匹配：看下一篇的 `catchFilter`。

我自己的取舍很简单：reason 联合有三个以上成员、且调用点不止一处时，一律不手写二级 switch。手写版的维护成本全部压在「新增 reason 时没人提醒」上，而 `catchReasons` 的对象键带着类型，写错或者写不存在的 reason 会直接编译失败。

## 边界与坑

- 这组组合子只下一层：reason 里再嵌 reason，不会递归。
- 它们属于「预期错误」通道的恢复，defect 和 interrupt 不在其中，和 `catchTag` 一致。
- 兜底之前，父错误始终留在 E 里，即使覆盖了全部 reason。想要「穷尽即消失」，就用兜底或 unwrap。
- 处理器的失败类型会进入结果 E，所以在处理器里 `Effect.fail(r)` 会把类型从父错误换成 reason。
- `AiError` 与 `HttpClientError` 本身是 unstable，字段和 reason 集合在后续版本可能调整；`catchReason` 这一组是 stable。

## 小结

当错误形状是「稳定的父错误 + 可枚举的 tagged reason」，手写二级 switch 把两种机制混在一起，既重复又不会在 reason 新增时提醒你。`catchReason` 抓一个、`catchReasons` 抓多个、`unwrapReason` 把 reason 提升成顶层错误，让第二层和第一层使用同一套 tag 路由。记住两点：未带兜底时父错误永远留在 E 里；unwrap 会丢掉父错误上的上下文。
