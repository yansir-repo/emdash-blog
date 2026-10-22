---
title: "错误处理的设计：谁处理、在哪翻译、重试前先分类"
description: 有了类型化错误之后，真正的问题是设计：错误该由哪一层处理，底层错误在哪里翻译成领域错误，以及为什么重试之前必须先给错误分类。
date: 2026-10-05
tags: [effect, tutorial, errors, design]
category: effect
series: effect-tutorial
seriesOrder: 6
---

上一章教了工具：`fail`、`TaggedError`、`catchTag`。工具到手之后，新的问题出现了：**错误应该由谁处理？在哪里翻译？每个函数都写一个错误类吗？失败了就重试行不行？** 这些不是语法问题，是设计问题。这一章给出一套判断方法。

## 朴素做法为什么不够

拿到 `catchTag` 之后，最常见的两种走偏方向是对称的。

一种是「到处捕获」：每一层函数都急着 `Effect.catch` 一下，要么吞掉，要么打个日志再原样抛。结果是错误在到达真正能决策的地方之前就已经丢失了信息，同一个错误还被记录了好几遍。

另一种是「到处透传」：底层是 SQL 驱动的错误、再往上是 HTTP 客户端的错误，全部原样沿着 `E` 一路冒到最上层。最外层的 `E` 变成一长串基础设施错误的并集，页面层要知道 `SqlError`、`ConnectionReset` 才能写代码。换一个数据库，整条调用链的类型都要改。

这两种问题的根源相同：**没有想清楚「这个错误的归属在哪一层」。**

## 心智模型：错误由「有足够上下文做决定的那一层」处理

一个错误应该在**第一个知道该怎么办的地方**被处理，不早也不晚。

- 底层模块（数据库、HTTP 客户端）只知道「出错了、是什么错」，不知道业务上这意味着什么，所以它们**报告**，不决策。
- 业务层知道「查不到用户意味着返回 404 还是创建默认用户」，所以它**决策**。
- 最外层（路由、命令行入口）知道「怎样呈现给人」，所以它**呈现**。

也就是说，捕获不是越早越好。中间层只在两种情况下插手：恢复（真的有办法继续），或翻译（换成上层能理解的语言）。其余时候让它流过去。

## 在边界处翻译，而不是一路泄漏

所谓「翻译」，是在模块边界上用 `Effect.mapError` 把底层错误换成本层的领域错误，同时**把原始错误作为 `cause` 保留下来**：

```ts
import { Data, Effect } from "effect"

class UserRepoError extends Data.TaggedError("UserRepoError")<{
  readonly op: string
  readonly cause: unknown
}> {}

const findUser = (id: string) =>
  rawSqlQuery(id).pipe(               // E: SqlError | ConnectionError
    Effect.mapError((cause) => new UserRepoError({ op: "findUser", cause }))
  )
// E: UserRepoError，上层不必知道底层是什么数据库
```

翻译有两个目的：隔离（底层换实现，上层类型不动），以及补充语义（`op` 告诉你是哪个操作失败）。保留 `cause` 则保证排查时不丢信息。

翻译粒度怎么定？一个实用的原则：**按「调用方会如何不同地处理」来划分，而不是按「错误从哪里来」来划分。** 如果上层对「连接失败」和「SQL 语法错误」的处理方式完全相同（都是报告并放弃），那就不需要两个类，一个 `UserRepoError` 带 `cause` 足够。如果上层要对「用户不存在」返回 404，那 `NotFound` 就必须独立成类。每个函数一个错误类，通常是过度设计；整个服务只有一个 `AppError`，又是设计不足。

## 选择性恢复

处理一部分、放行其余，是最常见的模式。`catchTag` 之后用普通的条件分支决定是恢复还是继续失败：

```ts
const user = findUser(id).pipe(
  Effect.catchTag("UserRepoError", (e) =>
    isTransient(e.cause)
      ? Effect.succeed(cachedUser)   // 能降级就降级
      : Effect.fail(e)               // 否则原样继续向上
  )
)
```

条件更复杂时，还有 `Effect.catchIf`，按谓词决定是否接住。这种写法的好处是：放行的路径仍然保留类型，没有被你悄悄吞掉。

## 记录日志：在一个地方，只记一次

错误被层层捕获再重抛的一个副作用是重复日志：每层都 `tapError(log)`，一次失败产生五条日志。简单的规则：**要么处理，要么向上抛，别两者都做并且都记录。** 日志放在最终决策的那个点，也就是最外层或恢复处。中间层若确实需要观察，用 `Effect.tapError` 做不改变结果的旁路动作，并克制频率。

## 重试之前先分类

「失败了就重试」是另一个看起来天经地义、实则危险的默认。重试的前提是：**这个错误是暂时性的，再试一次有可能成功。**

- 网络抖动、下游 503、数据库死锁：暂时性，值得重试。
- 参数校验失败、用户不存在、权限不足：确定性错误，重试一万次结果一样，只会放大负载、拖慢响应。
- 缺陷：不该重试，它是 bug。

所以顺序必须是：**先分类，再重试**。类型化错误让这件事变得直接，因为你本来就在 `E` 里区分了不同的错误：

```ts
const resilient = callDownstream.pipe(
  Effect.retry({
    times: 3,
    while: (e) => e._tag === "Network" || (e._tag === "Http" && e.status >= 500)
  })
)
```

`while` 里的谓词就是「分类」本身。更丰富的重试策略——退避、抖动、上限、超时——属于 `Schedule`，后面第 16 章展开。这里只需带走一个判断：**没有分类的重试，是在给确定性错误添堵。**

## 兜底边界：最后一道门

不管内部设计得多好，最外层总要有一个终点，把剩下的失败和缺陷转成对外的形态：HTTP 状态码、退出码、一条用户可读的提示。`Effect.match` 适合成功与失败都要折叠成一个值的场合：

```ts
const response = handler.pipe(
  Effect.match({
    onFailure: (e) => ({ status: e._tag === "NotFound" ? 404 : 500 }),
    onSuccess: (data) => ({ status: 200, data })
  })
)
// E 已变为 never
```

这里集中写「错误到呈现」的映射，内部各层就可以只关心自己的语义。缺陷不在 `onFailure` 里，它们由程序入口的统一机制处理，这和上一章的结论一致。

## 常见误区

- **吞掉错误。** `Effect.catch(() => Effect.succeed(默认值))` 不加区分地使用，会把本该被看见的问题藏起来。要吞，也只吞明确知道的那一种。
- **翻译时丢掉 `cause`。** 换了一个漂亮的领域错误，却把底层信息抹掉，线上排查时只剩一句「失败了」。
- **每个函数都新建一个错误类。** 类的数量应当与「不同的处理方式」的数量对应，而不是与函数数量对应。
- **所有错误都重试。** 重试策略的第一行永远是「哪些错误值得重试」。
- **在中间层记录又抛出。** 一个失败多条日志，真正的根因被淹没。

## 小结

错误设计的三个判断：由有足够上下文的那一层处理；在模块边界用 `mapError` 翻译并保留 `cause`；重试之前先分类。类型化错误让这些判断落在代码里，而不是落在口头约定里。

至此我们有了描述「怎样失败」的方式。但还有一类失败来自数据本身：外部送进来的东西根本不是你以为的样子。下一章进入 Part 2 的另一半，见 [第 7 章](/articles/effect-tutorial-07-schema-basics)。

## 延伸阅读

- [Effect 类型化错误：TaggedError、catchTag 与 failure/defect 之分](/articles/effect-typed-errors)
- [Effect 的重试与 Schedule](/articles/effect-retry-and-schedule)
- [Effect ErrorReporter](/articles/effect-error-reporter)
- [Effect 规则即契约：哪些该机械检查](/articles/effect-rules-as-contracts)
