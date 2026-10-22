---
title: "并发组合子：all、forEach、race，并发度与失败传播"
description: 讲清 Effect.all、Effect.forEach、Effect.race 的语义：默认顺序执行、concurrency 选项如何限制并发度、一个任务失败时其余任务会怎样，以及如何收集全部结果而不是遇错即停。
date: 2026-10-13
tags: [effect, tutorial, concurrency, all, race]
category: effect
series: effect-tutorial
seriesOrder: 14
---

上一章讲了 fiber 与结构化并发：子任务属于父任务，父任务结束子任务被中断。但在实际代码里，你很少需要亲手 `forkChild` 再 `join`。绝大多数并发需求可以归为两类：**同时做多件事，等全部做完**；**同时做多件事，谁先好就用谁**。Effect 给这两类各提供了现成的组合子。这一章的重点是它们的**语义**：默认行为是什么，并发度怎么控制，失败时会发生什么。

## 要解决的问题

用 Promise 写并发，最常见的是 `Promise.all`：

```ts
const [user, orders] = await Promise.all([fetchUser(id), fetchOrders(id)])
```

看起来简洁，但至少有三件事它没有说清楚：

- **并发度。** 对一千个元素 `Promise.all(items.map(fetchOne))`，会立刻发出一千个请求。想限流，得自己引入队列或第三方库。
- **失败时的善后。** 其中一个 reject，`Promise.all` 立刻 reject，但另外那些已经发出去的请求**并没有被取消**，它们继续跑，只是结果没人要了。
- **并发的起点。** 因为 Promise 创建即执行，在你写 `items.map(fetchOne)` 的那一刻，所有任务已经启动，`Promise.all` 只是在「等」，并没有「控制」。

## Effect 的做法：并发是调用时的选项

第 2 章讲过，Effect 是惰性的描述，没有被运行就没有副作用。这带来一个关键的变化：**把一组 Effect 放进数组时什么都还没发生，启动的时机和并发度，由组合子来决定**。

### Effect.all 与 Effect.forEach

- `Effect.all`：输入是一组已有的 Effect（数组或对象），输出是它们结果的数组（或对象），保持原有形状和顺序。
- `Effect.forEach`：输入是一组普通数据加一个返回 Effect 的函数，对每个元素执行并收集结果。

两者的并发语义由同一个选项控制，也就是 `concurrency`：

- 不写，默认是**顺序执行**，一个做完再做下一个。这是和 `Promise.all` 最大的区别：Effect 默认保守。
- 写数字，比如 `{ concurrency: 5 }`，表示同时最多跑 5 个。
- 写 `"unbounded"`，不设上限。
- 写 `"inherit"`，沿用外层设定的并发度。

```ts
import { Effect } from "effect"

declare const fetchOne: (id: string) => Effect.Effect<string, Error>
declare const ids: ReadonlyArray<string>

// 一千个 id，同一时刻最多 10 个请求在途
const all = Effect.forEach(ids, fetchOne, { concurrency: 10 })

// 异构的两件事并行，结果保持元组形状
declare const fetchUser: Effect.Effect<{ name: string }, Error>
declare const fetchOrders: Effect.Effect<ReadonlyArray<string>, Error>
const both = Effect.all([fetchUser, fetchOrders], { concurrency: 2 })
```

这里有一条设计经验：**对「数量由数据决定」的集合，永远写明数字**。`"unbounded"` 只适合数量固定且很小的场景，比如上面那两件异构的事。对来自用户输入或数据库的列表使用 `"unbounded"`，等于把限流责任交给下游服务去崩溃。

如果你不关心结果，只关心副作用，加上 `discard: true`，不再收集结果数组，省掉不必要的内存。

### 失败时发生了什么

这是本章最重要的一点。用结构化并发的语言说：`Effect.all` 或 `Effect.forEach` 在并发模式下，内部为每个任务开一个子 fiber，父 fiber 是这个组合子本身。因此：

1. 任何一个任务**失败**，整个组合子立即以该失败结束。
2. 其余仍在运行的任务会被**中断**，它们的清理逻辑会跑，而不是被放任不管。

这正好对应前面 `Promise.all` 的缺陷。在 Effect 里，「一个失败，其余一起停」是默认且有保证的行为。

可是有时你恰恰想要的是另一种语义：每个任务独立，失败了也别影响别人，最后告诉我谁成谁败。思路是把失败变成数据：`Effect.result` 把一个 Effect 的失败具象化成 `Result` 值（`Success` 或 `Failure`），自己不再失败。`Effect.forEach` 里给每个元素套一层它；`Effect.all` 则直接支持 `mode: "result"`：

```ts
import { Effect } from "effect"

declare const syncOne: (id: string) => Effect.Effect<void, Error>
declare const ids: ReadonlyArray<string>

// forEach 没有 mode 选项：每个元素先 Effect.result，失败变成值
const syncAll = Effect.forEach(ids, (id) => Effect.result(syncOne(id)), {
  concurrency: 5
})
// 结果数组的每一项是 Result，不会因为单个失败而中止其余任务

// all 可以直接用 mode: "result"，输出形状不变，每一项变成 Result
const pair = Effect.all([syncOne("a"), syncOne("b")], {
  concurrency: 2,
  mode: "result"
})
```

第 6 章说过，「谁处理错误」要想清楚。这里就是一个典型的决策点：批处理里，**一项失败要不要拖垮整批**？如果是「全有或全无」的事务性操作，用默认语义；如果是互相独立的批量任务，用 `Effect.result`（或 `Effect.all` 的 `mode: "result"`），然后在最后统一汇总失败。别在每个任务里自己吞掉错误，那样会丢失信息。

### Effect.race：谁先成功用谁

`Effect.race` 接收两个 Effect，同时启动，**先成功的胜出，另一个被中断**。典型用法是对冗余副本发请求，取最快的那个。

要留意它对失败的处理：如果先结束的那个是失败，`race` 并不会马上失败，而是继续等另一个；只有两个都失败时才失败。所以它的语义是「第一个**成功**」。

另外两个相关的名字：

- `Effect.raceFirst`：先**结束**的胜出，不管成功还是失败。适合「我只想要最快的答案，哪怕那个答案是失败」的场景。
- `Effect.raceAll`：对一组 Effect 做 race，语义同 `race`，推广到多个。

```ts
import { Effect } from "effect"

declare const fromPrimary: Effect.Effect<string, Error>
declare const fromReplica: Effect.Effect<string, Error>

// 先成功的赢，输的一方被中断（连接会被释放）
const fastest = Effect.race(fromPrimary, fromReplica)
```

「输的一方被中断」这一点值得停下来想一想：如果它持有一个连接，这个连接会怎么样？这正是下一章要回答的问题。

## 一个判断框架

遇到并发需求时，依次问三个问题：

1. **要全部结果还是要一个结果？** 全部用 `all` / `forEach`，一个用 `race` 家族。
2. **并发度多少？** 数量由数据决定就写数字；默认顺序是安全的起点。
3. **失败怎么算？** 一个失败整体失败（默认），还是各自独立（`Effect.result` / `mode: "result"`）？

只要这三点想清楚，通常不需要手动 fork。

## 常见误区

- **以为默认就是并发。** `Effect.all([a, b])` 不加选项是顺序执行的。如果你发现「并发的代码并没有变快」，先检查有没有写 `concurrency`。
- **滥用 `"unbounded"`。** 它在小而固定的列表上没问题，在由数据决定长度的列表上是隐患。
- **用 `race` 却以为「先结束」。** `race` 是先成功。要先结束请用 `raceFirst`。
- **在任务里吞掉错误来「保证不中断别人」。** 用 `Effect.result` 把失败保留为数据，比在内部 catch 然后返回占位值要诚实得多，也更容易在汇总时处理。
- **在并发任务里改共享变量。** 多个 fiber 交错执行，对同一个可变变量的读改写可能互相覆盖。需要共享状态时请用专门的并发原语，见第 18 章。
- **混淆「并发」和「超时」。** 给一组任务整体加时限是时间维度的话题，第 16 章讲 `Effect.timeout`，这里不展开。

## 小结

- `Effect.all` 和 `Effect.forEach` 的默认是顺序执行，并发度由 `concurrency` 选项显式给出。
- 数量由数据决定的集合，写数字上限；`"unbounded"` 慎用。
- 并发模式下，一个任务失败会导致整体失败并中断其余任务；想要各自独立，用 `Effect.result` 或 `Effect.all` 的 `mode: "result"`。
- `Effect.race` 取先成功者，输家被中断；`Effect.raceFirst` 取先结束者。
- 这些行为之所以有保证，是因为上一章的结构化并发：组合子是父，每个任务是子。

下一章回答上面悬着的问题：任务被中断时，它持有的连接、文件、锁，如何保证一定被释放？见 [第 15 章：中断与资源安全](/articles/effect-tutorial-15-resources)。

## 延伸阅读

- [Effect 并发与资源](/articles/effect-concurrency-and-resources)
- [Effect fork 家族：forkChild、forkDetach、forkScoped、forkIn 与 startImmediately](/articles/effect-fork-options)
- [Effect 限流器](/articles/effect-rate-limiter)
