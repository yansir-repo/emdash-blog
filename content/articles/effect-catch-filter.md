---
title: "Effect catchFilter 与 Filter：可组合的错误匹配与提取"
description: 讲清 Effect.catchFilter 与 Filter 模块：用可组合的 Filter 同时完成匹配与提取，保留未命中错误，并对比 catchTag、catchIf，附带 fromPredicate 收窄类型与实际不符的坑。
date: 2026-10-22
tags: [effect, effect-advanced, error-handling, filter]
category: effect
---

上一篇讲了 [catchReason](/articles/effect-catch-reason)，它解决的是「父错误加嵌套 reason」这一种固定形状。这一篇讲更一般的工具：`Effect.catchFilter` 与 `Filter` 模块。

`catchTag` 只认 `_tag`，`catchIf` 只认布尔。现实里的错误匹配常常是「状态码是 5xx，或者是超时」「`reason` 是限流，并且把 `retryAfter` 取出来」，既要判断，又要提取。`Filter` 把「判断加提取」做成一个可以组合、可以复用、可以传给别的 API 的值。下文代码基于 `effect@4.0.5` 验证，`Filter` 与 `catchFilter` 在 JSDoc 里都是 `@stability stable`。

## Filter 是什么

`Filter<Input, Pass, Fail>` 就是一个函数 `(input: Input) => Result<Pass, Fail>`。成功表示「通过」，成功值可以是变换后的结果；失败表示「被过滤掉」，失败值是留给下游的「剩余」。

```ts
import { Filter, Result } from "effect"

export const evenHalf = Filter.make((n: number) =>
  n % 2 === 0 ? Result.succeed(n / 2) : Result.fail(n)
)

export const results = [evenHalf(4), evenHalf(3)]
```

`evenHalf(4)` 是 `Result.succeed(2)`，`evenHalf(3)` 是 `Result.fail(3)`。对比普通谓词，它多做了两件事：通过时可以顺便变换值（这里是折半），没通过时把值原样交还。`Filter.toPredicate`、`Filter.toOption`、`Filter.toResult` 可以把它降级成谓词、Option 或 Result，我验证过 `Filter.toOption(...)` 通过时是 `Some`。

内置构造器覆盖了常见场景：

- `Filter.fromPredicate`：从谓词或类型守卫构造，通过时值不变。
- `Filter.fromPredicateOption`：从返回 Option 的函数构造。
- `Filter.tagged`：按 `_tag` 保留联合中的某个成员。
- `Filter.reason`：从带 tagged reason 的错误里抽出某个 reason。
- `Filter.equals`、`Filter.string`、`Filter.number`、`Filter.instanceOf` 等针对值本身的过滤器。

组合器有 `Filter.or`、`Filter.compose`、`Filter.composePassthrough`、`Filter.zip`、`Filter.mapFail` 等。

## catchFilter：用 Filter 恢复错误

语义：`Effect.catchFilter(filter, handler, orElse?)`。filter 在 Effect 的**预期错误**（Fail 通道里的值）上运行；通过时，把 filter 的成功值交给 `handler`；没通过时，如果给了 `orElse` 就交给它，没给就让原错误继续失败。

先定义本文用的错误：

```ts
import { Data, Effect } from "effect"

export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number
  readonly body: string
}> {}
export class Timeout extends Data.TaggedError("Timeout")<{ readonly ms: number }> {}
export class Decode extends Data.TaggedError("Decode")<{ readonly path: string }> {}

export type Err = HttpError | Timeout | Decode

export declare const call: Effect.Effect<string, Err>
```

现在写一个「只处理 404，并把响应体提取出来」的 filter：

```ts
import { Effect, Filter, Result } from "effect"
import { call, type Err } from "./errors.ts"

export const notFound = Filter.make((e: Err) =>
  e._tag === "HttpError" && e.status === 404 ? Result.succeed(e.body) : Result.fail(e)
)

export const program = call.pipe(
  Effect.catchFilter(notFound, (body) => Effect.succeed(`not found: ${body}`))
)
```

我对 `HttpError(404)`、`HttpError(503)`、`Timeout`、`Decode`、一个 defect 和成功值分别跑了一遍：只有 404 被恢复，其余两个错误和 defect 原样失败。关键点是处理器收到的不是错误，而是 filter 提取出来的值（这里是 `body: string`）。判断和提取只写了一次，不用在处理器里再做一次类型收窄。

## 组合：把条件当值来拼

重试策略、降级策略、日志策略往往共享同一类条件，比如「瞬时故障」。把它写成一个 Filter，之后可以复用：

```ts
import { Effect, Filter } from "effect"
import { call, type Err, type HttpError } from "./errors.ts"

export const serverError = Filter.fromPredicate(
  (e: Err): e is HttpError => e._tag === "HttpError" && e.status >= 500
)
export const timeout = Filter.tagged<Err>()("Timeout")

export const transient = Filter.or(serverError, timeout)

export const program = call.pipe(
  Effect.catchFilter(transient, (e) => Effect.succeed(`transient: ${e._tag}`))
)
```

运行结果：503 与 `Timeout` 被恢复，404 和 `Decode` 保持失败。`Filter.or` 的成功值是两个 filter 成功类型的并集，所以处理器里 `e` 的类型是 `HttpError | Timeout`。

需要先过滤再提取时用 `Filter.compose`，它把前一个 filter 的成功值喂给后一个：

```ts
import { Effect, Filter, Result } from "effect"
import { call, type Err, type HttpError } from "./errors.ts"

const retryableStatus = Filter.make((e: HttpError) =>
  e.status === 429 || e.status >= 500 ? Result.succeed(e.status) : Result.fail(e)
)

export const retryable = Filter.compose(Filter.tagged<Err>()("HttpError"), retryableStatus)

export const program = call.pipe(
  Effect.catchFilter(retryable, (status) => Effect.succeed(`status ${status}`))
)
```

503 得到 `status 503`，404 与其它错误原样失败。`Filter.composePassthrough` 和 `compose` 的区别是：任一环节失败时，失败值都是**最初的输入**，而不是中间结果，适合你想让下游永远看到完整原始错误的场景。

### 带 orElse：同时处理命中与未命中

第三个参数处理「没通过」的那一支，此时 E 里不再保留未命中类型，而是由 `orElse` 的失败类型决定：

```ts
import { Effect, Filter } from "effect"
import { call, type Err } from "./errors.ts"

export const program = call.pipe(
  Effect.catchFilter(
    Filter.tagged<Err>()("Timeout"),
    (e) => Effect.succeed(`timeout after ${e.ms}ms`),
    (rest) => Effect.fail(new Error(`unhandled: ${rest._tag}`))
  )
)

export const typed: Effect.Effect<string, Error> = program
```

`rest` 的类型是 `HttpError | Decode`，已经去掉了 `Timeout`。

## 类型：残余错误取决于 Filter 的 Fail 类型

这是用 `catchFilter` 最该弄清的一点。结果 Effect 的 E 是「`orElse` 的失败类型，或者没给 `orElse` 时 filter 的 Fail 类型」。所以残余错误精确不精确，完全看你选的 Filter。我逐个用类型注解验证了：

- `Filter.tagged`：精确。`Filter.tagged<Err>()("Timeout")` 之后，E 是 `HttpError | Decode`，赋值给 `Effect<string, never>` 会报错。
- `Filter.make` 自己写，并且未命中分支返回 `Result.fail(e)`：Fail 类型是整个输入类型。上面的 `notFound` 之后 E 仍是 `Err`，不会被收窄成「除 404 以外」，这是诚实的，因为 TypeScript 无法表达「不是 404 的 HttpError」。
- `Filter.or(a, b)`：Fail 类型只取第二个 filter 的 Fail。`Filter.or(tagged("Timeout"), tagged("Decode"))` 之后，E 是 `HttpError | Timeout`，`Timeout` 其实运行时已经被抓走了，类型却还留着，偏保守，但不会错放。
- `Filter.reason`：Fail 类型是整个输入，不收窄。

最后是一个会真正误导你的坑：**`Filter.fromPredicate` 配类型守卫，会按守卫类型做 `Exclude`**。

```ts
import { Data, Effect, Filter } from "effect"

class HttpError extends Data.TaggedError("HttpError")<{ readonly status: number }> {}
class Timeout extends Data.TaggedError("Timeout")<{ readonly ms: number }> {}
type Err = HttpError | Timeout

const call: Effect.Effect<string, Err> = Effect.fail(new HttpError({ status: 404 }))

const serverError = Filter.fromPredicate(
  (e: Err): e is HttpError => e._tag === "HttpError" && e.status >= 500
)

export const program = call.pipe(Effect.catchFilter(serverError, () => Effect.succeed("recovered")))

export const lie: Effect.Effect<string, Timeout> = program
```

这段代码**能通过编译**：类型说残余错误只剩 `Timeout`。但我实际运行，`HttpError(404)` 仍然以 `HttpError` 失败。守卫只证明了「通过的是 `HttpError`」，却被当成「所有 `HttpError` 都通过」，于是类型把 `HttpError` 整个排除了。`Effect.catchIf` 配带额外条件的类型守卫是同一个问题，我也跑过，结果一致。

规避办法：别让类型守卫去承担「额外的值条件」。要么用 `Filter.tagged` 只按 tag 匹配，值条件放进处理器并用 `orElse` 重抛；要么像 `notFound` 那样用 `Filter.make`，让 Fail 类型保持完整输入。

## 同一个 Filter，别处也能用

Filter 不止给 `catchFilter` 用。我验证过的复用点：

- `Array.filterMap(array, filter)`：对数组做过滤加变换，`[1,2,3,4]` 配 `evenHalf` 得到 `[1, 2]`。
- `Option.filterMap(option, filter)`：通过时是 `Some`，否则 `None`。
- `Stream.filterMap(filter)`：流上的同一语义。
- `Stream.catchFilter(filter, handler)`：流的错误恢复版本。

要特别小心的是 `Option.filter` 和 `Stream.filter`：它们收的是**布尔谓词**，不是 Filter。我一开始想当然地传 Filter，类型检查会报错；而一旦绕过类型检查，Filter 返回的 `Result` 总是 truthy，会让所有元素「通过」。要把 Filter 用在这两处，先 `Filter.toPredicate` 降级，或者改用 `filterMap`。

## 连 Cause 也能过滤

`catchFilter` 只看预期错误。想按整条 `Cause` 匹配，包括 defect，用 `Effect.catchCauseFilter`，它的 filter 输入是 `Cause<E>`：

```ts
import { Cause, Effect, Filter } from "effect"

const program = Effect.die("boom").pipe(
  Effect.catchCauseFilter(Filter.fromPredicate(Cause.hasDies), () => Effect.succeed("caught a defect"))
)

export const run = () => Effect.runPromise(program)
```

我跑过：普通失败不被抓，defect 被抓，结果是 `caught a defect`。把 defect 吞掉是很重的决定，多数应用只应该在进程边界做；日常恢复仍然只用 `catchFilter`。

## 怎么选

- 只按 `_tag` 恢复：`catchTag` 或 `catchTags`。类型最精确，写法最短。
- 一次条件判断、不需要提取：`catchIf`。但别把值条件塞进类型守卫，见上一节的坑。
- 匹配同时要提取值、条件会在多处复用、或者要拼 `or`、`compose`：`catchFilter`。
- 错误是「父错误加 tagged reason」：`catchReason`、`catchReasons`，不必手写 `Filter.reason`；`Filter.reason` 适合要和别的 filter 组合的场合。
- 需要连 defect 一起处理：`catchCauseFilter`，并且想清楚为什么。

我的取舍：能用 `catchTag` 就不引入 Filter，类型最诚实。条件开始变复杂、或者同一套条件被重试、降级、日志三处引用时，才值得把它提成一个命名的 Filter。

## 边界与坑

- `catchFilter` 只处理 Fail 通道，defect 与 interrupt 原样透传，我对 defect 验证过。
- 没给 `orElse` 时，未命中的错误以原 cause 继续失败，不会丢信息。
- `Filter.tagged` 只检查 `_tag`，不验证其余字段。
- 类型守卫式的 `fromPredicate` 会过度收窄残余类型，见上文。

## 小结

`Filter<Input, Pass, Fail>` 是「判断加提取」的可组合值，`catchFilter` 把它接到 Effect 的错误通道上：命中时把提取值交给处理器，未命中时错误原样保留或交给 `orElse`。它比 `catchTag` 更通用，比 `catchIf` 多一次提取，代价是残余错误类型取决于具体 filter 的 Fail 类型，其中类型守卫式的 `fromPredicate` 会让类型比运行时更乐观，要当心。
