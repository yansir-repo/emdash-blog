---
title: 为什么我用 Effect：从 Effect<A, E, R> 到 Effect.gen
description: 用 async/await 写 TypeScript 时，错误和依赖都藏在类型之外。本文从 Effect<A, E, R> 三个类型参数和 Effect.gen 讲起，说明 Effect v4 到底改变了什么。
date: 2026-10-16
tags: [effect, typescript]
category: effect
---

这是「Effect v4 实战」系列的第一篇。我很喜欢 Effect，但我不打算在这里推销它，只想说清楚一件事：它解决的是 TypeScript 里一个长期被忽视的问题，也就是**函数签名撒了谎**。

本系列代码基于 effect 4.0.5 验证（`tsc --strict` 编译通过）。v4 和 v3 的 API 有不少差异，我会在遇到的地方标出来。

## async/await 的签名里缺了什么

先看一个再普通不过的函数：

```ts
type User = { readonly id: string; readonly name: string }

async function getUser(id: string): Promise<User> {
  try {
    const res = await fetch(`https://api.example.com/users/${id}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as User
  } catch (e) {
    // e 是 unknown：网络失败、HTTP 错误、JSON 解析失败，全混在一起
    throw e
  }
}
```

它的类型是 `(id: string) => Promise<User>`。这个签名只告诉你成功时拿到什么，其余信息一概没有：

- 它会失败吗？会，但类型里看不到。
- 失败有几种？不知道。`catch` 里的 `e` 是 `unknown`，要靠 `instanceof` 和字符串匹配去猜。
- 它依赖什么？这里依赖全局 `fetch`，换成数据库连接或配置，依赖就藏在模块级变量里。

换句话说，Promise 只有一个类型参数 `T`，代表成功值。错误和依赖这两个同样重要的维度，在类型系统里是不存在的。这不是写法问题，是 `Promise<T>` 这个类型表达能力不够。

这些问题在小项目里不明显，项目大了才会集中爆发：谁也说不清某个接口到底可能抛出哪些错误，每个调用点都只能「先 catch 一下再说」，要么吞掉，要么原样重抛。久而久之，错误处理变成了一种仪式，而不是设计。

## Effect<A, E, R>：把三件事都写进类型

Effect 的核心类型有三个参数：

- **A**：成功时产出的值。
- **E**：预期内的失败（failure）类型，可以是联合类型。
- **R**：运行所需的环境（requirements），也就是依赖的服务。

`Effect<User, HttpError, never>` 读作：成功得到 `User`，可能以 `HttpError` 失败，不需要任何依赖。后两个参数有默认值，所以 `Effect.Effect<number>` 就是 `Effect<number, never, never>`。

另外一个关键性质：**Effect 是惰性的描述，不是已经启动的计算**。`Promise` 一创建就开始执行，`Effect` 只有交给 runtime 才会跑。

```ts
import { Effect } from "effect"

// 只是一段描述，创建时什么都不会打印
const hello = Effect.sync(() => console.log("hello"))

// 同一个描述可以被运行多次
const twice = Effect.gen(function* () {
  yield* hello
  yield* hello
})

Effect.runPromise(twice)
```

惰性带来的好处是：重试、超时、并发、资源释放这些「围绕计算本身」的能力，都可以作为组合子套在描述外面，而不是手写一堆控制流。

## 用 Effect.gen 重写 getUser

`Effect.gen` 接受一个 generator 函数，`yield*` 的作用和 `await` 对应：取出成功值，失败则直接短路。

```ts
import { Data, Effect } from "effect"

type User = { readonly id: string; readonly name: string }

class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly cause: unknown
}> {}

class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number
}> {}

class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly cause: unknown
}> {}

export const getUser = (
  id: string
): Effect.Effect<User, NetworkError | HttpError | DecodeError> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) => fetch(`https://api.example.com/users/${id}`, { signal }),
      catch: (cause) => new NetworkError({ cause })
    })
    if (!res.ok) {
      return yield* new HttpError({ status: res.status })
    }
    return yield* Effect.tryPromise({
      try: () => res.json() as Promise<User>,
      catch: (cause) => new DecodeError({ cause })
    })
  })
```

几个要点：

1. `Effect.tryPromise` 把会 reject 的 Promise 转成 Effect，`catch` 回调决定失败值的类型。这里每一类失败都有自己的名字。
2. `Data.TaggedError` 定义的错误可以直接 `yield*`，等价于 `Effect.fail`。这是 v4 里很顺手的写法。
3. `try` 回调拿到一个 `AbortSignal`，Effect 被中断时会自动 abort 底层请求。用 async/await 要做到同样的事，得自己接线。
4. 返回类型的 `E` 是一个联合类型。调用方看签名就知道要处理哪三种失败。

> 如果 `tryPromise` 不写 `catch`，失败类型默认是 `Cause.UnknownError`。

这个函数和前面的 async 版本做的事一样，区别是**类型里多了诚实的信息**。下一篇会专门讲怎么处理这些错误。

## 第三个参数 R：依赖是类型的一部分

依赖注入在 Effect 里不需要框架，它就是类型参数 `R`。在 v4 里，服务用 `Context.Service` 声明：

```ts
import { Context, Effect, Layer } from "effect"

class Logger extends Context.Service<Logger, {
  readonly info: (message: string) => Effect.Effect<void>
}>()("app/Logger") {}

// R = Logger：类型上就写明了「没有 Logger 就跑不起来」
const program: Effect.Effect<number, never, Logger> = Effect.gen(function* () {
  const logger = yield* Logger
  yield* logger.info("computing")
  return 42
})

const LoggerLive = Layer.succeed(Logger, {
  info: (message) => Effect.sync(() => console.log(`[info] ${message}`))
})

// 提供依赖后 R 变成 never，才能交给 runtime
const runnable: Effect.Effect<number> = program.pipe(Effect.provide(LoggerLive))

Effect.runPromise(runnable).then(console.log)
```

这里有两个值得注意的地方。

第一，`yield* Logger` 取出的是服务实例，同时 `R` 里自动出现了 `Logger`。你不需要手写这个类型，它由 `Effect.gen` 内部用到了什么推导出来。

第二，`Effect.runPromise` 只接受 `R = never` 的 Effect（v4 的签名是 `Effect<A, E>`）。忘了提供依赖，编译就报错，而不是运行时某个调用栈深处抛 `undefined is not a function`。

**v3 到 v4 的差异**：v3 的 `Context.Tag("id")<Self, Shape>()` 在 v4 里换成了 `Context.Service<Self, Shape>()("id")`，字符串 id 的位置也变了。照着旧博客抄会编译不过。

## 组合：在描述外面套能力

因为 Effect 是描述，超时和重试可以直接管道式叠加：

```ts
import { Effect } from "effect"

declare const fetchProfile: Effect.Effect<string, Error>

const resilient = fetchProfile.pipe(
  Effect.timeout("2 seconds"),
  Effect.retry({ times: 2 })
)
```

`Effect.timeout` 会在失败类型里加上 `TimeoutError`，类型会如实反映这一点。你得到的不是一个「看起来能重试」的函数，而是一个类型已经更新过的新 Effect。

## 并排对比：同一件事，两种说法

把前面的内容压缩成一个对照，每一条都是我在日常写代码时真正在意的点：

- **失败的可见性**：async 函数的失败只能靠阅读实现或文档得知；Effect 的失败写在 `E` 里，改了实现签名就变，调用方立刻能感知。
- **失败的区分**：`catch (e)` 里 `e` 是 `unknown`，要靠 `instanceof` 或者读 `message` 字符串；Effect 里每种失败有自己的 `_tag`，可以用 `catchTag` 精确处理。
- **依赖的显式程度**：async 函数通过模块级 import 或闭包拿依赖，测试时要么 mock 模块，要么改全局；Effect 的依赖在 `R` 里，测试时换一份实现提供进去即可。
- **取消与超时**：Promise 本身不可取消，需要手动传 `AbortController`；Effect 的中断是内建语义，`tryPromise` 回调拿到的 `signal` 会在中断时被触发。
- **执行时机**：Promise 创建即执行，难以复用和重试；Effect 是惰性描述，同一个值可以安全地运行多次。

这五条里，我认为最重要的是前两条。它们决定了你在重构时是靠编译器还是靠记忆。

## 它不是银弹

说点不那么讨好的观点。

- **学习成本是真的**。`yield*`、`pipe`、`Layer` 都要时间消化。如果项目只是几个脚本，async/await 完全够用。
- **边界要划清**。Effect 擅长的是有失败、有依赖、有并发的业务逻辑；纯函数没必要包成 Effect。我的习惯是核心逻辑保持纯函数，副作用留在外层的 Effect 里。
- **团队要有共识**。半个项目用 Effect、半个项目 try/catch，维护成本比统一一种风格更高。

还有一点要诚实地说：Effect 的类型提示有时比较长，初学时读报错需要适应。我的经验是给对外暴露的函数写显式返回类型，错误就会出现在离问题最近的地方，而不是传播到调用链顶端。

我选择 Effect 的理由很朴素：当错误和依赖都进了类型，重构时编译器能替我检查的东西变多了。

## 小结

- `Promise<T>` 只描述成功值，`Effect<A, E, R>` 同时描述成功、预期失败和依赖。
- `Effect.gen` + `yield*` 的写法和 async/await 几乎一一对应，但错误和依赖不会丢。
- Effect 是惰性的描述，超时、重试这类能力可以直接组合。
- v4 的服务用 `Context.Service` 声明，和 v3 的 `Context.Tag` 写法不同。

下一篇《Effect 类型化错误：TaggedError、catchTag 与 failure/defect 之分》：用 `Data.TaggedError` 建模失败，用 `catchTag` 精确恢复，并区分 failure 与 defect。
