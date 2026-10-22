---
title: "流：Stream 与背压，以及什么时候不该用"
description: 数据不是一次到齐，而是一批批流过来。本章讲 Stream 是什么、惰性拉取与背压怎样让内存保持有界，常用的构造、变换与消费方式，以及哪些场景用数组或 forEach 更合适。
date: 2026-10-16
tags: [effect, tutorial, stream, backpressure]
category: effect
series: effect-tutorial
seriesOrder: 17
---

到目前为止，每个 Effect 都恰好产出一个值（或失败）。但现实里很多数据不是「一个值」：分页接口一页接一页，大文件一行接一行，消息队列一条接一条。这一章讲 Effect 怎么描述「零到多个值」，以及为什么这里的关键词是**背压**。

## 朴素做法为什么不够

处理多个值，朴素做法大致三种：

- **整个读进数组再处理**。小数据没问题；数据量大或没有终点（消息订阅）时，内存直接成为上限，甚至根本不会结束。
- **手写 `while` 循环拉分页**。能控制内存，但「拉一页、处理、判断是否有下一页、出错怎么办、被取消怎么办」全部要自己织在循环里。
- **`AsyncIterable` / `for await`**。形态接近了，但它不携带类型化的错误通道，不携带依赖，取消和资源释放全靠调用方自觉。

三种做法共同缺的是同一件东西：一个能同时表达「多个值、会失败、需要依赖、可被中断」的描述。

## Effect 的做法：Stream 是多值的 Effect

`Stream<A, E, R>` 和 `Effect<A, E, R>` 三个参数含义一致，区别只在「成功」的形态：Effect 恰好产出一个 `A`，Stream 产出零到多个 `A`。它同样是**惰性的描述**：构造一个 Stream 什么都不会发生，直到某个「消费」操作（`run*`）才真正启动，而且每次运行都会重新执行源头。这点和第 2 章的 Effect 完全一致，所以你可以安全地定义一个 Stream 常量，再在不同地方各运行一次。

Stream 的真正价值在拉取式的运行模型。下游消费者向上游要数据，上游才产生；下游处理得慢，上游自然就慢下来，不会无限堆积。这叫**背压**（backpressure）。可以把它想成一条传送带：工人（消费者）拿走一件，传送带才前进一格，而不是工厂不管不顾地往仓库里倒货。

结果是：不管源头有一百万行还是永远没有尽头，只要每个阶段的处理是有界的，内存占用就是有界的。

## 三步心智模型：构造、变换、消费

用 Stream 写程序，几乎总是这三步。

构造：把一个数据源描述成 Stream。

- `Stream.fromIterable`：从数组等同步集合。
- `Stream.paginate(初始游标, 取一页)`：分页接口。回调返回「本页元素数组」和「下一个游标的 `Option`」，`Option.none()` 表示结束。
- `Stream.fromQueue`、`Stream.fromPubSub`：把第 18 章的队列接成流。
- `Stream.fromAsyncIterable(iterable, onError)`：包装已有的异步迭代器，同时要求你说明错误怎么翻译成类型化失败。
- `Stream.callback`：桥接回调式的事件源。

变换：像处理数组一样处理元素，只是它是惰性的。`Stream.map`、`Stream.filter`、`Stream.take`，以及最重要的 `Stream.mapEffect`：每个元素做一次有副作用的操作，可通过 `concurrency` 选项控制同时处理几个（并发度的取舍第 14 章已讲，这里同一套道理）。`Stream.groupedWithin(n, duration)` 按「满 n 个或到时间」成批，适合批量写入。

消费：用一个 `run*` 把 Stream 变回 Effect。

- `Stream.runDrain`：只要副作用，丢弃元素。
- `Stream.runForEach`：对每个元素执行动作。
- `Stream.runFold`：折叠成一个结果。
- `Stream.runCollect`：收集成数组（v4 里返回的是普通数组）。

## 一个小例子：把分页接口变成一条流

```ts
import { Effect, Option, Stream } from "effect"

interface Page {
  readonly items: ReadonlyArray<string>
  readonly next: string | null
}

declare const fetchPage: (cursor: string | null) => Effect.Effect<Page, FetchError>
declare const saveBatch: (rows: ReadonlyArray<string>) => Effect.Effect<void, DbError>

interface FetchError { readonly _tag: "FetchError" }
interface DbError { readonly _tag: "DbError" }

const allItems = Stream.paginate(null as string | null, (cursor) =>
  fetchPage(cursor).pipe(
    Effect.map((page) => [
      page.items,
      page.next === null ? Option.none() : Option.some(page.next)
    ] as const)
  )
)

export const importAll = allItems.pipe(
  Stream.groupedWithin(100, "2 seconds"),
  Stream.mapEffect(saveBatch, { concurrency: 2 }),
  Stream.runDrain
)
```

读这段代码，注意三件事。第一，没有任何地方持有「全部数据」，一页进来、成批写出，内存只与批大小和并发度有关。第二，错误通道是类型化的：`importAll` 的 `E` 是 `FetchError | DbError`，拉页失败和写库失败都会让整条流失败。第三，如果外层把它 `Effect.timeout` 或中断了，拉页和写库会一起被中断，不需要手动清理循环。

## buffer：给两端解耦，但不是免费的

默认的拉取是紧耦合的：下游没要，上游就不动。有时你希望生产者能提前跑一点，抹平速度的小抖动，这时用 `Stream.buffer({ capacity })`。缓冲区满了怎么办是一个取舍，对应三种策略：

- 默认的 `suspend`：满了就让上游等，仍然是背压，数据不会丢。
- `dropping`：满了丢新来的。
- `sliding`：满了丢最旧的。

后两种是明确地**用丢数据换不阻塞**，适合「只关心最新状态」的场景（比如实时指标），不适合订单、支付这类不能丢的数据。选哪一种是业务决定，不是性能调优。

## 什么时候不该用 Stream

Stream 是有成本的：多一层抽象、多一套 API。以下情形，更简单的工具更合适：

- **数据量小且有限**。几十条记录，直接用数组加 `Effect.forEach` 即可，需要并发就加 `concurrency`（第 14 章）。为十条数据引入 Stream 是过度设计。
- **只是一次请求、一次响应**。一个值就是一个 Effect。
- **你需要的是共享或广播，而不是流水线**。多个消费者要看到同一份事件，这是 PubSub 的问题，不是 Stream 的问题（下一章）。Stream 每次运行都是独立的一次执行，不是一份被共享的「热」数据。
- **你需要按元素精确地协调状态**。这更像状态管理，用 Ref、Queue 等原语更直接。

一个简单的判断：如果你的代码里出现了「循环里不断取下一批」「不知道会有多少条」「处理速度可能跟不上产生速度」，考虑 Stream；否则先用数组。

## 常见误区

- **对无界流用 `runCollect`**。它会等到流结束再返回数组，无界的流永远不会结束，内存先爆。无界流用 `runDrain`、`runForEach`，或先 `take` 限制个数。
- **把 Stream 当数组重复消费**。每次 `run*` 都会重新执行源头：如果源头是分页接口，就会重新发起一遍请求。需要复用结果，先收集，不要期望流「记住」。
- **`mapEffect` 默认顺序执行**。不指定 `concurrency` 时是一个接一个，想并发必须显式写，并且要有上限。
- **把 buffer 当性能开关**。buffer 只是移动了等待发生的位置；如果消费者持续慢于生产者，缓冲区终究会满，要么阻塞要么丢数据。
- **在流里吞掉错误**。流中任何一步失败都会终止整条流。需要「单条失败不影响其他」时，要在每个元素内部把失败转成值（例如用第 14 章的 `Effect.result` 把失败变成 `Result` 值），而不是在最外层兜底。

## 小结

Stream 是「多值的 Effect」：惰性、类型化、可中断，并且靠拉取式运行获得背压，让内存与吞吐的关系变得可控。用的时候就是构造、变换、消费三步；不该用的时候，数组加 `forEach` 往往更好。下一章讲当多个 fiber 要共同持有状态、互相传递数据时，Ref、Queue、PubSub、Semaphore 各自解决什么问题，怎么选。

## 延伸阅读

- [Effect Stream：背压、分页、扇出与常驻消费者](/articles/effect-streams)
- [Effect 并发与资源安全](/articles/effect-concurrency-and-resources)
- [Effect 重试与 Schedule](/articles/effect-retry-and-schedule)
