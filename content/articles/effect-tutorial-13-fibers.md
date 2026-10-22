---
title: "Fiber 心智模型：结构化并发"
description: 用 async/await 的视角理解 fiber：它是什么、为什么子任务必须属于父任务，以及 forkChild、join、interrupt 各自表达的语义。讲清「中断不是失败」与结构化并发的价值。
date: 2026-10-12
category: effect
chapter: 13
tags: [effect, tutorial, concurrency]
---

前面 12 章，我们写的程序基本是「一条线走到底」：一步接一步，每步要么成功要么失败。从这一章开始进入并发。先说好，这一章不讲怎么并发得更快，那是下一章的事。这一章只回答一个更根本的问题：**一个正在运行的 Effect，是什么东西，它归谁管？**

## 要解决的问题

用 async/await 写过并发的人，大概都碰到过这几种情形：

- 发起了一个请求，用户已经离开页面，请求还在跑，结果回来后写进一个早已不存在的状态里。
- 在函数里 `fetch` 了两个东西，其中一个失败，另一个还在继续，没有人负责把它停掉。
- 在一个函数里偷偷起了一个后台任务，不 `await`，函数返回了，这个任务成了「孤儿」：谁也不知道它还在跑，出错了也没人看见。

这三种情形有同一个根源：`Promise` 一旦创建就开始执行，而且**它不属于任何人**。没有父子关系，没有生命周期，没有「停下」的把手。第 1 章说过的「取消」看不见，根子就在这里。

## 朴素做法为什么不够

常见的补救是 `AbortController`：手动创建，手动传给每个异步调用，手动在合适的时机 `abort()`。这能用，但有两个问题。

第一，它是**约定**而不是**结构**。每个函数都得记得接收 signal、转交 signal；漏一处，那一处就成了取消不掉的洞。第二，它只解决「怎么发出取消信号」，没解决「谁该在什么时候发」。后台任务该跟着谁一起结束？这个归属关系，仍然靠人脑维护。

## Effect 的做法：fiber 与结构化并发

在 Effect 里，一个 Effect 被运行起来之后，就对应一个 **fiber**。可以把 fiber 理解成「一条轻量的虚拟执行线」：它不是操作系统线程，也不是新的事件循环，只是 Effect 运行时调度的一个执行单元，创建成本很低，开成千上万个也是常态。

类比一下：`Promise` 像是一个没有名字的外包，派出去就不管了；fiber 则像是公司里有汇报关系的员工，每个人都有直属上级，上级离职时，下属的工作一并交接或终止。

这个汇报关系，就是**结构化并发**（structured concurrency）的核心：

> 子 fiber 的生命周期被包含在父 fiber 之内。

具体有三条规则：

1. 父 fiber 通过 fork 创建子 fiber，子 fiber 属于父。
2. 父 fiber 结束（成功、失败或被中断）时，还没结束的子 fiber 会被自动中断。
3. 父 fiber 被中断时，中断会向下传递给所有子 fiber。

于是上一节那三种情形都有了结构上的答案：用户离开页面，最外层 fiber 被中断，中断一路向下传，所有在途请求一起停；一个子任务失败，父任务感知到失败后结束，其余兄弟自然被中断；想在函数里起后台任务，必须选一种归属，不存在「无主」这个选项（`forkDetach` 是显式地选择脱离归属，下面会说）。

### 三个基本动作

最常用的操作只有三个：

- `Effect.forkChild`：在当前 fiber 之下启动一个子 fiber，立刻拿到 `Fiber` 句柄，当前 fiber 不被阻塞。
- `Fiber.join`：等待子 fiber 结束，成功就拿到结果，失败就把同样的失败重新抛出。
- `Fiber.interrupt`：请求中断子 fiber，并等它真正停下（包括它的清理逻辑跑完）。

还有一个 `Fiber.await`，它不重新抛出失败，而是把结局包成 `Exit` 值交给你。区别很实用：`join` 像 `await promise`（失败就抛），`await` 像「给我看看它最后怎么样了」。

## 一个小例子

下面是一个示意：主流程启动一个后台心跳，做完自己的事，然后结束。

```ts
import { Effect, Fiber } from "effect"

declare const sendHeartbeat: Effect.Effect<void>
declare const doRealWork: Effect.Effect<string>

const heartbeat = sendHeartbeat.pipe(
  Effect.andThen(Effect.sleep("1 second")),
  Effect.forever
)

const program = Effect.gen(function*() {
  // 子 fiber：属于 program 这个父 fiber
  const hb = yield* Effect.forkChild(heartbeat)

  const result = yield* doRealWork

  // 主动停掉也可以；即使忘了，program 结束时它也会被中断
  yield* Fiber.interrupt(hb)
  return result
})
```

这里 `heartbeat` 是一个永不结束的循环。如果换成 Promise 的写法，忘了清理它，进程里就多了一个永远转下去的定时器。而在这里，就算你删掉 `Fiber.interrupt(hb)` 那一行，`program` 一结束，`hb` 也会被运行时中断。**这一条保证来自结构，不依赖你记得**。

### 中断不是失败

这里要建立一个重要的区分。第 5 章讲过，失败是 E 里的可预期错误，缺陷是类型之外的意外，并在结尾点到了**中断是第三种结局**：它既不是业务上的出错，也不是 bug，而是「有人不再需要这个结果了」。

因此中断在 `Exit` 里有自己的表示，不会混进 `catch` 能捕获的失败里。一个被中断的 fiber，你用 `Fiber.await` 能看到它的 `Exit` 带有中断的信息，可以用 `Exit.hasInterrupts` 判断。实践中的含义是：**不要把「被取消」当成错误去重试、去上报**。用户关掉页面不是故障。

### 中断是协作式的

fiber 不是线程，运行时不会强行「杀」它。中断的生效点是 fiber 让出控制的地方，比如 `sleep`、等待 I/O、`yield*` 之间的调度点。一段纯同步的死循环，没有让出点，就没法被打断；这和 JavaScript 本身的单线程特性一致。好消息是，正常写出来的 Effect 程序里到处都是让出点，所以中断通常很及时。

还有一点：`Fiber.interrupt` 会**等待**目标 fiber 完成清理再返回。清理逻辑（第 15 章会讲）是中断语义的一部分，不是「发完信号就走」。

### 想脱离父子关系时

有些任务本来就不该跟着当前请求一起死，比如一次触发后要跑完的后台同步。这时用 `Effect.forkDetach`：子 fiber 挂在全局，不随父结束，需要你自己负责它的生命周期。还有 `Effect.forkScoped` 和 `Effect.forkIn`，把子 fiber 挂在某个 `Scope` 上，Scope 关闭时中断，这个会在第 15 章讲清楚。原则上，**默认用 `forkChild`，脱离归属必须是有意识的决定**。

fork 家族的细节，比如 fork 返回时子 fiber 还没真正开始执行带来的竞态，在 [fork 家族](/articles/effect-fork-options) 里有专门的展开，这里只需要记住入门结论：fork 之后的瞬间，不要假设子 fiber 已经在跑。

## 常见误区

- **把 fiber 当线程。** fiber 之间没有并行计算，JavaScript 依旧单线程；fiber 带来的是并发（交错执行）和可管理的生命周期，而不是多核算力。
- **fork 了不管。** `forkChild` 之后既不 `join` 也不 `await`，子 fiber 的失败就不会被任何人看到。父 fiber 结束时它会被中断，但在此之前它的失败是「静悄悄」的。fork 出去的东西，要么有人 `join`，要么有明确的归属说明。
- **手动到处 fork。** 大多数并发场景，下一章的 `Effect.all`、`Effect.forEach`、`Effect.race` 已经够用，它们内部帮你管好了 fork、join 和中断。直接操作 fiber 是低层手段，用得越少越好。
- **把中断当失败处理。** 在 `catch` 里重试被中断的任务，或者把取消当错误打日志，都是概念混淆。
- **忘了进程入口的 fiber。** `Effect.runFork` 返回的就是最外层 fiber。让它不被中断地跑下去、什么时候中断它，是运行时边界的事，第 19 章会展开。

## 小结

- fiber 是运行中的 Effect，是轻量的虚拟执行线，不是线程。
- 结构化并发：子 fiber 的生命周期被父 fiber 包含，父结束或被中断，子一并被中断。
- `forkChild` / `Fiber.join` / `Fiber.interrupt` 是三个基本动作；`Fiber.await` 给你 `Exit`。
- 中断是独立于失败和缺陷的第三种结局，应当区别对待。
- 默认挂在父之下，脱离归属要显式写 `forkDetach` 或绑定到 `Scope`。

下一章我们不再手动操作 fiber，而是看 Effect 把「同时跑多个任务」封装成了哪几个组合子，以及并发度与失败传播怎么选，见 [第 14 章：并发组合子](/articles/effect-tutorial-14-concurrency)。

## 延伸阅读

- [Effect fork 家族：forkChild、forkDetach、forkScoped、forkIn 与 startImmediately](/articles/effect-fork-options)
- [Effect 并发与资源](/articles/effect-concurrency-and-resources)
