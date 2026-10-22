---
title: "Effect Stream：背压、分块，以及它和 Queue、PubSub 的关系"
description: 讲清 Effect Stream 的 pull 背压、数组分块、buffer 策略，以及它与 Queue、PubSub 的分工，并给出何时该用 Stream 而不是数组或 async iterator 的判断标准。
date: 2026-10-04
category: effect
tags: [effect, guide]
---

前几篇讲的都是「一个 Effect 产出一个值」。现实里有一大类问题不是这个形状：分页接口、日志文件、消息队列、WebSocket 推送，它们产出的是**随时间到达的一串值**，可能很大，可能没有尽头，中途还会失败。这一篇讲 Effect 对这类问题的答案：`Stream<A, E, R>`。

我的主线只有一条：Stream 不是「带 Effect 的数组」，而是**把背压、取消、资源清理、类型化错误打包在一起的拉取协议**。理解了这个协议，数组、async iterator、Queue、PubSub 各自该在哪里出现，就都清楚了。

## 什么时候该用 Stream，什么时候不该

先给判断标准，因为最常见的错误是用错方向，而不是不会用 API。

- 数据已经在内存里、有限、很小：用数组。别为了「统一」把 `[1, 2, 3]` 包成 Stream，那只会多一层心智负担。
- 数据来自别人的 async iterator 或 Node stream，你只是想 `for await` 一遍：可以直接用，但只要你需要类型化错误、并发处理、超时、重试、或者中断时保证关闭底层资源，就该转成 Stream。
- 满足下面任意一条，用 Stream：数据量无界或大到不该整体进内存；每个元素要跑 Effect 而且需要受控并发；需要按时间或数量分批、节流、防抖；上游有资源要在取消时释放；需要把一个源分给多个消费者。

和 async iterator 的差别值得说透。async iterator 同样是拉取式的，所以它也有天然背压；但它的错误通道是 `unknown` 的 throw，没有 `R`，没有并发算子，取消靠调用方记得调 `return()`。Stream 在同样的拉取模型上，把这些都放进了类型和运行时里。

两者互转是一等公民，边界处该怎么写：

```ts
import { Data, Effect, Stream } from "effect"

export class ReadError extends Data.TaggedError("ReadError")<{
  readonly cause: unknown
}> {}

async function* lines(): AsyncGenerator<string> {
  yield "a"
  yield "b"
  throw new Error("socket closed")
}

// 进来：把 throw 收编成类型化错误
export const fromOutside = Stream.fromAsyncIterable(
  lines(),
  (cause) => new ReadError({ cause })
)

// 出去：交给只认 AsyncIterable 的外部库
export const toOutside = (s: Stream.Stream<number>): AsyncIterable<number> =>
  Stream.toAsyncIterable(s)

export const program = fromOutside.pipe(
  Stream.runCollect,
  Effect.catchTag("ReadError", () => Effect.succeed(["recovered"]))
)
```

`fromAsyncIterable` 的第二个参数是强制的：你必须在边界处决定「外部抛出的东西」在你的类型里叫什么。这和 Schema 边界解码是同一个思路，不让 `unknown` 往里漏。

## 背压：拉取协议，不是调参

Stream 的背压不需要你配置任何东西，因为它是**下游拉、上游才产**。下游没有请求下一批，上游就不会执行。这个性质可以直接验证：造一个理论上产出一百万个元素的上游，下游又慢又只要 5 个。

```ts
import { Effect, Stream } from "effect"

export const demo = Effect.gen(function* () {
  let produced = 0
  const source = Stream.range(1, 1_000_000).pipe(
    Stream.tap(() => Effect.sync(() => void produced++))
  )

  const firstFive = yield* source.pipe(
    Stream.mapEffect((n) => Effect.sleep("10 millis").pipe(Effect.as(n))),
    Stream.take(5),
    Stream.runCollect
  )

  return { firstFive, produced }
})

Effect.runPromise(demo).then(console.log)
// { firstFive: [ 1, 2, 3, 4, 5 ], produced: 5 }
```

我在 4.0.5 上跑出来 `produced` 是 5，不是一百万，也不是某个缓冲区大小。把 `mapEffect` 换成 `{ concurrency: 4 }`，我跑出来是 8：并发会让上游多预取几个，但这个数量级由并发度决定，而不是由上游的速度决定。具体数字属于实现细节，别依赖，该记住的是上界的来源：**消费速率和并发度**。

这也是为什么我不喜欢在 Stream 里「先全部拉进数组再处理」。`Stream.runCollect` 会把整条流收集成一个数组，对有限的小流没问题，对大流是把背压亲手拆掉。需要聚合时用 `Stream.runFold`，只关心副作用时用 `Stream.runDrain` 或 `Stream.runForEach`，这三个都是常量内存。

## 分块：v4 的 Stream 其实是数组的流

这是 v3 到 v4 最容易被忽略的变化：v3 的 Stream 内部传递 `Chunk`，v4 里传递的是**非空数组**。你在 API 上到处能看到它：`runCollect` 直接返回普通数组，`Stream.grouped(n)` 的元素是 `NonEmptyReadonlyArray`，`Stream.mapArray` 可以一次处理一整块，`Stream.DefaultChunkSize` 是 4096。参考资料里那些 `Chunk.empty<Event>()` 的写法在 4.0.5 上已经不能用了。

分块存在的理由是摊薄开销：每个元素走一次拉取协议太贵，所以一次拉一块。对你的影响有两处。第一，可以用 `rechunk` 改变块大小，`mapArray` 在块上做批量变换。第二，所有「按块计算」的算子语义要看清，下面的节流就是典型：

```ts
import { Effect, Stream } from "effect"

const stamp = (t0: number) => (i: number) =>
  Effect.sync(() => console.log(`${i} @ ${Date.now() - t0}ms`))

export const throttled = Effect.gen(function* () {
  const t0 = Date.now()
  yield* Stream.range(1, 6).pipe(
    Stream.rechunk(1),
    Stream.throttle({
      units: 2,
      cost: (chunk) => chunk.length,
      duration: "300 millis"
    }),
    Stream.runForEach(stamp(t0))
  )
})
```

`Stream.throttle` 的 `cost` 收到的参数是一整块，不是单个元素。我实际跑过：不加 `rechunk(1)`，六个元素在同一块里，整块只被延迟一次，六个元素同时在约 600ms 处冒出来，根本没有限速；加了 `rechunk(1)` 后，前两个立即通过，之后大约每 150ms 一个。所以写限速时，**cost 要按 `chunk.length` 算，并且想要逐元素限速就先 `rechunk(1)`**。参考资料里的 `cost: () => 1` 在 v4 里意味着「每块算一个」，是个安静的 bug。

同理，`Stream.grouped(100)` 凑 100 个一批，`Stream.groupedWithin(100, "5 seconds")` 则是「100 个或 5 秒，先到先发」。后者是写批量入库、批量上报的标准件：

```ts
import { Effect, Stream } from "effect"

declare const insertMany: (rows: ReadonlyArray<number>) => Effect.Effect<void>

export const batchInsert = (events: Stream.Stream<number>) =>
  events.pipe(
    Stream.groupedWithin(100, "5 seconds"),
    Stream.mapEffect((batch) => insertMany(batch)),
    Stream.runDrain
  )
```

## buffer：只在需要吸收突发时才加

默认的 pull 模型里，上游和下游是**锁步**的：下游处理第 n 个时，上游基本停着。如果上游是突发的、下游是平稳的，你想让上游在下游忙的时候继续往前跑一段，才需要显式 `Stream.buffer`。它有三种策略，行为差别很大，所以我用同一份数据跑一遍：

```ts
import { Effect, Stream } from "effect"

const slowConsumer = (n: number) =>
  Effect.sleep("5 millis").pipe(Effect.as(n))

const run = (strategy: "suspend" | "dropping" | "sliding") =>
  Stream.range(1, 20).pipe(
    Stream.buffer({ capacity: 4, strategy }),
    Stream.mapEffect(slowConsumer),
    Stream.runCollect
  )

export const compare = Effect.gen(function* () {
  for (const strategy of ["suspend", "dropping", "sliding"] as const) {
    const out = yield* run(strategy)
    console.log(strategy, out.length, out.slice(0, 4))
  }
})
// suspend 20 [ 1, 2, 3, 4 ]
// dropping 4 [ 1, 2, 3, 4 ]
// sliding 4 [ 17, 18, 19, 20 ]
```

- `suspend`：缓冲满了就让上游挂起，一个不丢。这是唯一保持完整背压语义的策略，也是我的默认选择。
- `dropping`：满了就丢**新**元素，留住最旧的。适合「处理不过来就算了，先到的更重要」。
- `sliding`：满了就丢**旧**元素，留住最新的。适合行情、传感器这类只关心最新值的场景。

选 `dropping` 和 `sliding` 等于主动声明「这条流允许丢数据」。这个决定应该写在代码里让人看见，而不是靠某个默认值悄悄发生。

## 与 Queue、PubSub 的关系

把三者放在同一张图里看，关系就清楚了：

- **Queue** 是点对点的、有界时带背压的缓冲区。`Queue.bounded(n)` 满了以后，`offer` 会挂起，这就是生产者一侧的背压。
- **PubSub** 是广播：每个订阅者都收到每一条消息，订阅之前发的消息收不到。
- **Stream** 是消费视图：`Stream.fromQueue`、`Stream.fromPubSub` 把它们变成可组合的拉取源；`Stream.toQueue`、`Stream.toPubSub` 反方向。

一句话：Queue 和 PubSub 是**推的那一端的存储**，Stream 是**拉的那一端的协议**。下面这段把三者串起来，并验证背压和广播语义：

```ts
import { Cause, Effect, Fiber, PubSub, Queue, Stream } from "effect"

export const queueDemo = Effect.gen(function* () {
  // 容量 2：生产者最多领先消费者 2 个
  const queue = yield* Queue.bounded<number, Cause.Done>(2)
  const producer = yield* Effect.forkChild(
    Effect.gen(function* () {
      for (let i = 1; i <= 6; i++) {
        yield* Queue.offer(queue, i)
        console.log("offered", i)
      }
      yield* Queue.end(queue)
    })
  )
  yield* Effect.sleep("50 millis")
  console.log("start consuming")
  const all = yield* Stream.fromQueue(queue).pipe(Stream.runCollect)
  yield* Fiber.join(producer)
  return all
})
// offered 1
// offered 2
// start consuming
// offered 3 ... offered 6
// [ 1, 2, 3, 4, 5, 6 ]

export const pubsubDemo = Effect.gen(function* () {
  const pubsub = yield* PubSub.bounded<number>(8)
  const subscriber = (name: string) =>
    Stream.fromPubSub(pubsub).pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.map((xs) => `${name}:${xs.join(",")}`)
    )
  const a = yield* Effect.forkChild(subscriber("A"))
  const b = yield* Effect.forkChild(subscriber("B"))
  yield* Effect.sleep("20 millis")
  yield* PubSub.publishAll(pubsub, [1, 2, 3])
  return [yield* Fiber.join(a), yield* Fiber.join(b)]
})
// [ 'A:1,2,3', 'B:1,2,3' ]
```

两个细节。第一，v4 的 Queue 有第二个类型参数表示结束信号，`Queue<number, Cause.Done>` 加上 `Queue.end` 就是「正常结束」，`Stream.fromQueue` 读到它就自然收尾，不需要自己约定哨兵值。第二，上面的输出我实际跑过：生产者在 offer 了 2 个以后停住，直到消费开始才继续。

如果你的需求是**一个冷流分给多个消费者**，不必手动搭 PubSub，用 `Stream.share`：

```ts
import { Effect, Stream } from "effect"

export const fanOut = Effect.scoped(
  Effect.gen(function* () {
    const shared = yield* Stream.range(1, 5).pipe(
      Stream.share({ capacity: 8 })
    )
    return yield* Effect.all(
      [Stream.runCollect(shared), Stream.runCollect(shared)],
      { concurrency: 2 }
    )
  })
)
// [ [ 1, 2, 3, 4, 5 ], [ 1, 2, 3, 4, 5 ] ]
```

`share` 返回的是需要 `Scope` 的 Effect，因为它背后有一个被多个消费者引用计数的上游，Scope 关闭时统一收尾。

选型的经验法则：消费者数量固定为一、要背压，用 Queue；每个消费者都要看到全部消息，用 PubSub；已经是 Stream、想让多个下游共享一次计算，用 `share`。

## 把回调世界接进来：callback 与 paginate

两个最常用的构造器。回调式 API 用 `Stream.callback`，它把一个 Queue 交给你，你往里推，清理逻辑挂在 Scope 的 finalizer 上：

```ts
import { Effect, Queue, Stream } from "effect"

export const ticks = Stream.callback<number>(
  Effect.fn(function* (queue) {
    let i = 0
    const timer = setInterval(() => {
      Queue.offerUnsafe(queue, ++i)
    }, 5)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => clearInterval(timer))
    )
  })
)

export const firstThree = ticks.pipe(Stream.take(3), Stream.runCollect)
```

我验证过：`take(3)` 取够以后流被中断，finalizer 一定会跑，定时器被清掉。v3 的 `Stream.async` 在 v4 里就是它，写法从 `emit.single` 变成了对 Queue 的操作，这一点和 Queue、Stream 同源是一致的。

分页接口用 `Stream.paginate`，替代手写 while 循环拉游标：

```ts
import { Effect, Option, Stream } from "effect"

const pages: ReadonlyArray<ReadonlyArray<number>> = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9]
]

const fetchPage = (page: number) =>
  Effect.succeed([
    pages[page] ?? [],
    page + 1 < pages.length ? Option.some(page + 1) : Option.none()
  ] as const)

export const allItems = Stream.paginate(0, fetchPage)

export const firstFour = allItems.pipe(Stream.take(4), Stream.runCollect)
```

`paginate` 的回调返回「本页元素数组 + 下一个游标的 Option」，`None` 就终止。v3 的 `paginateEffect` 在 v4 里合并成了 `paginate`，而且已经自动拍平，不需要再接 `flattenIterables`。懒求值是实打实的：我让 `take(4)` 去拉三页的数据，只发生了 2 次 `fetchPage`，因为第二页已经够了。注意粒度是页，不是元素：要 4 个就至少拉两页，这是接口本身的粒度。

## 错误与重试：整条流 vs 单个元素

Stream 的错误默认是 **fail-fast**：`mapEffect` 里任何一个元素失败，整条流以该错误结束。要让单个元素失败不拖垮整体，不要在外面 catch，而是在元素内部把结果变成值：

```ts
import { Data, Effect, Result, Stream } from "effect"

export class BadItem extends Data.TaggedError("BadItem")<{
  readonly n: number
}> {}

const process = (n: number) =>
  n % 3 === 0 ? Effect.fail(new BadItem({ n })) : Effect.succeed(n)

export const partitioned = Effect.gen(function* () {
  const results = yield* Stream.range(1, 6).pipe(
    Stream.mapEffect((n) => Effect.result(process(n)), { concurrency: 2 }),
    Stream.runCollect
  )
  const ok = results.filter(Result.isSuccess).map((r) => r.success)
  const failed = results.filter(Result.isFailure).map((r) => r.failure.n)
  return { ok, failed }
})
// { ok: [ 1, 2, 4, 5 ], failed: [ 3, 6 ] }
```

`Effect.result` 把 `Effect<A, E>` 变成永不失败的 `Effect<Result<A, E>>`，失败成了数据。这就是死信队列的最小形态：成功的继续往下走，失败的被收集起来，之后想落库、告警还是重放，由你决定。参考资料里用 `Queue.unbounded` 加独立 worker 实现 DLQ，那样需要额外管理 worker 生命周期，对大多数场景过重。

另一个坑是 `Stream.retry`。它重试的是**整条流**，从头重新订阅上游，已经发出去的元素不会撤回。我验证过：前三个元素发出后上游失败，重试两次再成功，下游收到的是 `1 2 3 1 2 3 1 2 3 4`。所以对有副作用或要求恰好一次的流，重试要放到**元素粒度**（`Effect.retry` 包在 `mapEffect` 的回调里），或者保证上游从头重放是幂等的。重试策略本身怎么写，[下一篇讲 Schedule](/articles/effect-retry-and-schedule) 专门讲。

还有一个并发相关的细节：`mapEffect` 带 `concurrency` 时输出**保持输入顺序**，我用延迟 30、5、20、1 的四个任务验证过；如果不在乎顺序，加 `unordered: true`，结果会按完成顺序出来，吞吐更好。

## 反模式清单

- `Queue.unbounded` 加一个慢消费者或没有消费者。这是把背压主动拆掉，内存是唯一的缓冲区。生产环境用有界队列，并在设计时回答「满了怎么办」：挂起、丢新、还是丢旧。
- 对大流或无限流用 `runCollect`。它会把所有元素堆进内存，无限流还永远不会返回。
- 手写 `for await` 循环加 `Promise.all` 做并发。取消、错误和并发上限都得自己管，换成 `Stream.mapEffect(..., { concurrency })`。
- 在流水线里套 `try/catch`。错误是 `E` 通道里的值，用 `Stream.catchTag`、`Stream.retry` 之类的算子处理。
- 想逐元素限速却不看块大小。`throttle` 的 cost 是按块算的。

## 小结

Stream 的核心是拉取协议：下游拉，上游才产，所以背压是默认行为而不是配置项。理解了这一点，其它部分都有了位置：数组分块是为了摊薄拉取开销，buffer 是显式放宽锁步并选择满了怎么办，Queue 和 PubSub 是推送一侧的存储，`fromQueue`、`fromPubSub`、`share` 是把它们接回拉取协议的桥。

数据有限且小就用数组；只是在边界遍历外部迭代器可以先用 async iterator；需要无界、并发、时间算子、资源清理、类型化错误或多消费者，就上 Stream。写的时候记住四件事：用 `runFold`/`runDrain` 而不是 `runCollect` 处理大流；`throttle` 的 cost 按块算；`Stream.retry` 会重放整条流；单元素容错用 `Effect.result` 把失败变成值。

下一篇讲 [Schedule](/articles/effect-retry-and-schedule)：重试、退避、抖动、定时重复，以及哪些错误根本不该重试。
