---
title: "错误是类型：failure 与 defect、TaggedError、catchTag"
description: 把错误写进 Effect 的 E 参数：区分可预期的失败（failure）与不可预期的缺陷（defect），用 TaggedError 定义领域错误，再用 catchTag 精确恢复并让类型随之收窄。
date: 2026-10-04
category: effect
chapter: 5
tags: [effect, tutorial, errors]
---

前四章我们已经知道：`Effect<A, E, R>` 里的 `E` 描述「这段计算可能怎样失败」。这一章把 `E` 讲透。核心只有一句话：**可预期的错误是一种返回值，应当像成功值一样被类型描述；不可预期的错误则不属于类型，应当走另一条通道。**

## 要解决的问题：函数签名在撒谎

看一个普通的 TypeScript 函数：

```ts
async function getUser(id: string): Promise<User> {
  const res = await fetch(`/users/${id}`)
  if (res.status === 404) throw new Error("not found")
  return res.json()
}
```

签名说「给我 `id`，还你一个 `User`」。但它实际上还可能抛出「用户不存在」「网络断了」「JSON 不合法」，这些信息一个都不在类型里。调用方想处理，只能 `try/catch`，而 `catch (e)` 里的 `e` 是 `unknown`，你得靠 `instanceof` 或字符串匹配去猜它是什么。

更糟的是，这套机制对「预期内的情况」和「真正的 bug」一视同仁：用户不存在和空指针异常都是 `throw`，都落进同一个 `catch`。要么两者一起处理，要么一起漏掉。

## Effect 的做法：两条通道

Effect 把「出错」拆成两种性质不同的东西：

- **失败（failure）**：可预期的、业务上有意义的错误，例如用户不存在、参数不合法、下游超时。它出现在 `E` 里，编译器会追踪它。
- **缺陷（defect）**：不可预期的错误，本质是 bug，例如不该为空的值为空、违反了不变量。它**不出现在类型里**，沿着另一条通道向上传播，直到被最外层看到。

一个判断标准：**调用方能不能、该不该针对这个错误做出不同的业务决策？** 能，就是失败；不能，只能「放弃并报告」，就是缺陷。

用 `Effect.fail` 产生失败，用 `Effect.die` 产生缺陷：

```ts
import { Effect } from "effect"

const failing = Effect.fail("用户不存在")   // Effect<never, string>
const dying = Effect.die(new Error("bug"))   // Effect<never, never>
```

注意 `dying` 的 `E` 是 `never`：类型层面它「不会失败」，但运行时它会终止。同样的事情也会在你无意间发生：在 `Effect.sync` 里直接 `throw`，抛出的东西会被当成缺陷，**不会**进入 `E`。所以包装可能抛错的代码要用 `Effect.try` / `Effect.tryPromise`（第 4 章的 `tryPromise` 就是干这个的），让你显式决定「这个错误是失败还是缺陷」。

## 给失败一个身份：TaggedError

失败可以是任何值，字符串也行，但字符串没法精确区分。更好的做法是给每种失败一个类，并带上一个 `_tag` 字段作为判别标签。Effect 提供了 `Data.TaggedError`：

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{
  readonly id: string
}> {}

class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly reason: string
}> {}

const getUser = (id: string): Effect.Effect<User, NotFound | Unauthorized> =>
  id === "" ? Effect.fail(new NotFound({ id })) : Effect.succeed(someUser)
```

`_tag` 自动注入，值就是你传入的字符串。在 `Effect.gen` 里还可以直接 `return yield* new NotFound({ id })`，因为这类错误本身可被 `yield*`，等价于 `Effect.fail`。

还有一个孪生选项 `Schema.TaggedError`：它多了「字段由 Schema 描述、可编码解码」的能力，适合错误要跨进程、跨网络传输的场景。Schema 在第 7、8 章展开（跨网络的例子见第 21 章），现在只需记住本书的口径：错误只在进程内流动时用 `Data.TaggedError`，足够轻；需要跨进程编码解码时再换 `Schema.TaggedError`。两者的 `_tag` 机制一致，`catchTag` 都能用，第 9、12 章的示例用的是前者。

## 在类型里看着错误传播，用 catchTag 精确恢复

现在 `E` 是一个联合类型 `NotFound | Unauthorized`。组合多个 Effect 时，联合会自动累积；处理时，用 `Effect.catchTag` 按标签捕获其中一种，**类型随之收窄**：

```ts
const program = getUser("42").pipe(
  Effect.catchTag("NotFound", (e) => Effect.succeed(guestUser(e.id)))
)
// Effect<User, Unauthorized>  —— NotFound 已从 E 中消失
```

处理完 `NotFound`，类型里就真的不再有它。如果之后你给 `getUser` 新增了一种失败 `RateLimited`，所有调用点的 `E` 会立刻多出这一项，编译器会逼着你决定怎么办。这就是「错误是类型」的回报：**错误清单由编译器维护，而不是靠文档和记忆。**

多种错误一次处理用 `Effect.catchTags`：

```ts
const handled = getUser("42").pipe(
  Effect.catchTags({
    NotFound: (e) => Effect.succeed(guestUser(e.id)),
    Unauthorized: () => Effect.succeed(anonymous)
  })
)
// Effect<User, never>
```

想不分类型一把兜住所有失败，用 `Effect.catch`。但要警惕：它会把你将来新增的失败也一并吞掉，类型清单的好处就被浪费了。

## 缺陷：不要在业务里捕获它

关键的一点：`Effect.catch`、`catchTag` 只处理失败，**碰不到缺陷**。`Effect.die(...)` 或 `Effect.sync` 里抛出的异常，会直接穿过这些处理器。这是有意为之：缺陷代表程序已处于未预期的状态，业务逻辑不应假装能恢复。

那缺陷谁来看？有三个典型位置：

- 程序最外层（第 3 章说的「边缘」）：统一记录日志、返回 500、让进程退出。
- `Effect.exit`：把结果（成功、失败、缺陷）整体具象化成一个 `Exit` 值，用于测试或需要完整观察的地方。
- `Effect.catchCause` / `Effect.catchDefect`：在少数边界上拦截缺陷，通常只为记录后继续向外传播。

与 `Effect.exit` 相近的还有 `Effect.result`：它只把**失败**具象化成一个 `Result` 值（`Success` 或 `Failure`），自己不再失败，缺陷仍然照常向外传播。第 14 章会用它让批量任务各自独立。

还有一个反向转换：`Effect.orDie` 把失败升级为缺陷。当你确信某个失败在此处「不可能发生」或「发生即 bug」时使用，E 因此变成 `never`：

```ts
const mustExist = getUser("root").pipe(Effect.orDie)
// Effect<User, never>：若 root 不存在，视为缺陷
```

`orDie` 是一个有分量的决定：你在对编译器说「这里我负责，别再让我处理它」。请只在你真的负责的时候说。

## 第三种结局：中断

除了失败和缺陷，一个 Effect 还有第三种结局：**中断**（interrupt）。它既不是业务上的出错，也不是 bug，而是「有人不再需要这个结果了」，比如用户离开页面、超时、`race` 的输家。中断不出现在 `E` 里，`catchTag` 和 `Effect.catch` 也接不住它。这里只需要记住三种结局各走各的通道，中断的机制在第 13 章（fiber）和第 15 章（资源）展开。

## 常见误区

- **把 `E` 写成 `Error` 或 `unknown`。** 这等于把 `catch (e: unknown)` 搬进了类型系统，失去了所有收益。失败应当是一个具名的、可区分的联合。
- **用字符串当失败。** 能跑，但无法 `catchTag`，也带不了上下文字段。需要区分时就上 TaggedError。
- **什么都当失败。** 把真正的 bug 放进 `E`，会让调用方被迫处理他们不可能处理的东西，`E` 变得又长又没有意义。
- **什么都当缺陷。** 反过来，把业务上可恢复的情况 `die` 掉，调用方就无法在类型层面看到它。
- **`_tag` 重名。** 两个不同的错误类用了同一个标签，`catchTag` 会同时命中。标签在项目内应当唯一，必要时带上模块前缀。
- **指望 `Effect.catch` 能接住所有东西。** 它接不住缺陷，这不是缺陷（bug），是设计。

## 小结

这一章建立了两个概念：失败在 `E` 里，由类型追踪、由 `catchTag` 精确恢复；缺陷不在类型里，留给最外层统一处理。判断标准是「调用方能否做出不同的业务决策」。

下一章回答一个更具体的工程问题：既然错误都有类型了，**由谁来处理、在哪里把底层错误翻译成领域错误、重试之前该先做什么**，见 [第 6 章](/articles/effect-tutorial-06-error-design)。

## 延伸阅读

- [Effect 类型化错误：TaggedError、catchTag 与 failure/defect 之分](/articles/effect-typed-errors)
- [catchReason：处理嵌套的错误原因](/articles/effect-catch-reason)
- [catchFilter：按条件挑选要处理的错误](/articles/effect-catch-filter)
- [Effect 的 ErrorReporter](/articles/effect-error-reporter)
