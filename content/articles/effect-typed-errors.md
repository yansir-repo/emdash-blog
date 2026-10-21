---
title: Effect 类型化错误：TaggedError、catchTag 与 failure/defect 之分
description: 用 Data.TaggedError 把错误写进 Effect 的 E 参数，用 catchTag 精确恢复，再分清预期失败与缺陷 defect。代码均已通过 tsc strict 编译验证。
date: 2026-09-24
tags: [effect, typescript, error-handling]
category: effect
---

上一篇说过，`Effect<A, E, R>` 的第二个参数 `E` 是预期内的失败类型。这一篇把 `E` 讲透：怎么定义错误、怎么在类型里看着它传播和收窄、以及 Effect 为什么坚持把「失败」和「缺陷」分成两条通道。

## 先说一个观点：错误应该是值

`try/catch` 把错误当控制流，`throw` 出去的东西没有类型，`catch` 到的只有 `unknown`。Effect 的立场是：**预期内的错误是一种返回值，应该像成功值一样被类型描述**。

这不是形式主义。当错误是类型的一部分，「这个函数会怎么失败」就从文档和约定变成了编译器能检查的事实。

## 用 Data.TaggedError 定义错误

```ts
import { Data } from "effect"

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly resource: string
  readonly id: string
}> {}

export class Forbidden extends Data.TaggedError("Forbidden")<{
  readonly reason: string
}> {}
```

`Data.TaggedError("NotFound")` 做了三件事：

1. 给实例注入只读字段 `_tag: "NotFound"`，这是后面 `catchTag` 做判别的依据。
2. 把泛型参数里的字段变成构造函数参数，`new NotFound({ resource: "user", id: "1" })`。
3. 实例本身是 `Error`（带 stack），并且可以直接被 `yield*`，等价于 `Effect.fail(error)`。

我的约定：错误类以名词命名，字段全部 `readonly`，只放恢复和展示所需的数据。包装底层异常时用 `cause: unknown` 字段保留原始错误。

为什么要用 `_tag` 而不是 `instanceof`？因为带字面量 tag 的对象构成**可判别联合**（discriminated union），TypeScript 能对它做穷尽性检查和类型收窄。`instanceof` 依赖运行时的类原型，跨模块、跨包或者序列化之后就容易失效；字符串 tag 不受这些影响，也更容易写进日志。

## 错误在类型里传播

先写两个会失败的函数：

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class Forbidden extends Data.TaggedError("Forbidden")<{ readonly reason: string }> {}

type User = { readonly id: string; readonly name: string; readonly admin: boolean }

const findUser = (id: string): Effect.Effect<User, NotFound> =>
  id === "1"
    ? Effect.succeed({ id, name: "Ada", admin: true })
    : Effect.fail(new NotFound({ id }))

const requireAdmin = (user: User): Effect.Effect<User, Forbidden> =>
  user.admin ? Effect.succeed(user) : Effect.fail(new Forbidden({ reason: "not admin" }))

// 在 Effect.gen 里组合：E 自动变成并集
const loadAdmin = (id: string): Effect.Effect<User, NotFound | Forbidden> =>
  Effect.gen(function* () {
    const user = yield* findUser(id)
    return yield* requireAdmin(user)
  })
```

`loadAdmin` 里我没有手写 `E`，上面的返回类型标注只是为了展示。去掉标注，编译器推导出来的也是 `NotFound | Forbidden`。

这是和 `throw` 最本质的区别：在 Promise 世界里，函数 A 调用函数 B，B 新增一种失败，A 的签名纹丝不动。在 Effect 里，B 的 `E` 多一个成员，A 的 `E` 随之变化，**所有没处理它的调用方都会在编译期被点名**。

## catchTag：精确恢复，类型随之收窄

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class Forbidden extends Data.TaggedError("Forbidden")<{ readonly reason: string }> {}

declare const loadAdmin: (id: string) => Effect.Effect<string, NotFound | Forbidden>

// 只处理 NotFound：E 里剩下 Forbidden
const step1: Effect.Effect<string, Forbidden> = loadAdmin("2").pipe(
  Effect.catchTag("NotFound", (e) => Effect.succeed(`guest-${e.id}`))
)

// 一次处理多个 tag：E 被清空
const step2: Effect.Effect<string, never> = loadAdmin("2").pipe(
  Effect.catchTags({
    NotFound: (e) => Effect.succeed(`guest-${e.id}`),
    Forbidden: (e) => Effect.succeed(`denied: ${e.reason}`)
  })
)
```

`catchTag` 的价值在于它的类型签名：处理函数里的 `e` 已经被收窄成 `NotFound`，返回的 Effect 里 `E` 排除了 `NotFound`。你不会写出「捕获了但其实不会发生」的死代码，因为 tag 名字不在 `E` 里的话，根本编译不过：

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

declare const find: Effect.Effect<string, NotFound>

const typo = find.pipe(
  // @ts-expect-error "NotFond" 不是 E 里的 tag，编译期报错
  Effect.catchTag("NotFond", () => Effect.succeed("x"))
)
```

如果想处理全部失败，不关心具体类型，v4 里用的是 `Effect.catch`。

**v3 到 v4 的差异**：v3 的 `Effect.catchAll` 在 v4 里改名为 `Effect.catch`，`catchAllCause` 改名为 `Effect.catchCause`，`Effect.either` 对应的是 `Effect.result`（返回 `Result` 而不是 `Either`）。网上的 v3 教程里这些名字都会编译失败。

```ts
import { Effect } from "effect"

declare const risky: Effect.Effect<number, "boom">

// 把失败物化成值：Result 的 _tag 是 "Success" 或 "Failure"
const safe = Effect.gen(function* () {
  const r = yield* Effect.result(risky)
  return r._tag === "Success" ? r.success : -1
})
```

换个角度看，`catchTag` 让「处理错误」这件事有了进度条：`E` 里还剩哪些成员，就是还有哪些错误没人管。当它变成 `never`，说明这条路径上的预期失败都处理完了，这是编译器给出的完成度证明。

## failure 与 defect：两条通道

这是 Effect 错误模型里最容易被误解的部分。

- **failure（失败）**：预期内、可恢复、属于业务语义的错误。它在类型的 `E` 里，用 `Effect.fail` 或 `yield* new XxxError()` 产生。
- **defect（缺陷）**：未预期的错误，通常是 bug 或不变量被破坏。它**不在 `E` 里**，用 `Effect.die` 产生，或者在 `Effect.sync` 里直接 `throw` 就会变成 defect。

判断标准很简单：**调用方有没有可能、有没有必要针对它做不同的处理**。用户不存在，调用方可以返回 404，这是 failure。`JSON.parse` 一个我们自己刚序列化出来的字符串居然炸了，调用方什么也做不了，这是 defect。

```ts
import { Cause, Data, Effect, Exit } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}

const failing = Effect.fail(new NotFound({ id: "7" }))
const dying = Effect.sync(() => JSON.parse("{bad"))

const inspect = async () => {
  const a = await Effect.runPromiseExit(failing)
  if (Exit.isFailure(a)) {
    console.log(Cause.hasFails(a.cause), Cause.hasDies(a.cause)) // true false
  }

  const b = await Effect.runPromiseExit(dying)
  if (Exit.isFailure(b)) {
    console.log(Cause.hasFails(b.cause), Cause.hasDies(b.cause)) // false true
    console.log(Cause.pretty(b.cause))
  }
}

inspect()
```

`Effect.runPromiseExit` 不会 reject，而是把结果装进 `Exit`。失败的 `Exit` 里带一个 `Cause`，`Cause` 能区分这次失败是 fail、die 还是被中断。

我实测的行为：对 `dying` 使用 `Effect.catch`，**抓不到**这个 defect，Effect 仍然以失败退出。要处理 defect 必须显式用 `Effect.catchDefect` 或 `Effect.catchCause`：

```ts
import { Cause, Effect } from "effect"

declare const mayDie: Effect.Effect<string, never>

// 只处理 defect
const recovered = mayDie.pipe(
  Effect.catchDefect((defect) => Effect.succeed(`defect: ${String(defect)}`))
)

// 在边界处兜底整个 Cause：failure、defect、interrupt 都会进来
const logged = mayDie.pipe(
  Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause)))
)
```

这个设计是故意的。如果 `catch` 默认吞掉 defect，一个空指针会被当成「预期失败」悄悄处理掉，bug 就藏起来了。分成两条通道后，业务恢复逻辑只看得到业务错误。

## 在 failure 与 defect 之间转换

两个方向都有对应的组合子。

**failure 升级成 defect**：`Effect.orDie`。当某个错误在你的上下文里「不可能发生」或「发生了就该崩」，把它从 `E` 里去掉：

```ts
import { Data, Effect } from "effect"

class ConfigError extends Data.TaggedError("ConfigError")<{ readonly key: string }> {}

declare const loadConfig: Effect.Effect<{ readonly port: number }, ConfigError>

// 启动期配置缺失就该直接失败，没必要让每个调用方都处理
const bootConfig: Effect.Effect<{ readonly port: number }, never> =
  loadConfig.pipe(Effect.orDie)
```

我只在启动期和不变量检查里用 `orDie`。业务错误一律保留在 `E`，否则就等于把类型系统关掉了。

**把外部异常收编成 failure**：`Effect.try` 与 `Effect.tryPromise` 的 `catch` 回调，把「别人库里可能 throw」变成带名字的错误：

```ts
import { Data, Effect } from "effect"

class ParseError extends Data.TaggedError("ParseError")<{ readonly cause: unknown }> {}

const parseJson = (text: string): Effect.Effect<unknown, ParseError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new ParseError({ cause })
  })
```

同样是 `JSON.parse`，上一节里它在 `Effect.sync` 中是 defect，这里是 failure。区别不在函数本身，而在**你声明了这类错误对调用方是有意义的**。

实践里我会按层次划分：领域层的函数保持窄而具体的错误类型，让编译器充分发挥作用；到了应用层或接口层，再统一翻译和收敛。不要一开始就把所有错误都塞进一个 `AppError`，那样 `E` 里的信息量又退回到了 `unknown`。

## 边界处：mapError 与 match

模块边界的做法是把内部错误翻译成对外的抽象，避免上游实现细节泄漏：

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {}
class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}
class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly cause: NotFound | DbError
}> {}

declare const query: (id: string) => Effect.Effect<string, NotFound | DbError>

export const findName = (id: string): Effect.Effect<string, RepositoryError> =>
  query(id).pipe(Effect.mapError((cause) => new RepositoryError({ cause })))

// 最外层：把成功和失败都收敛成响应，E 变成 never
export const handler = (id: string): Effect.Effect<{ readonly status: number; readonly body: string }> =>
  findName(id).pipe(
    Effect.match({
      onFailure: (e) => ({ status: e.cause._tag === "NotFound" ? 404 : 500, body: e._tag }),
      onSuccess: (body) => ({ status: 200, body })
    })
  )
```

`mapError` 只改失败的类型，不会让失败变成成功。`catchTag` 才是恢复。`Effect.match` 则同时处理两侧，把 `E` 清空，适合放在 HTTP handler 这样的最外层。

最外层之外，还应该有一层 `catchCause` 兜底记录 defect。逻辑是：failure 被业务代码逐一处理，剩下没人管的才是真正的意外，要被记录下来。

最后补一条使用习惯：不要为了「让类型好看」把 defect 转成 failure，也不要为了「省事」把 failure 全部 `orDie`。两条通道的价值正在于它们的语义是干净的，一旦混用，日志告警、重试策略、对外状态码都会失去依据。

## 小结

- 预期错误用 `Data.TaggedError` 建模，它带 `_tag`，可以直接 `yield*`。
- 错误沿着 `Effect.gen` 自动汇入 `E` 的联合类型，`catchTag` / `catchTags` 精确收窄并移除它们。
- failure 在 `E` 里、可恢复；defect 不在 `E` 里、代表 bug。`Effect.catch` 不会吞 defect，要用 `catchDefect` 或 `catchCause`。
- `orDie` 把 failure 升级成 defect，`Effect.try` 的 `catch` 回调把外部异常收编成 failure。
- v3 到 v4 的改名：`catchAll` 变 `catch`，`catchAllCause` 变 `catchCause`，`either` 变 `result`。

下一篇《Effect 服务与 Layer：把依赖写进类型里》：怎么把 `R` 这个参数落到真实的服务组装上。
