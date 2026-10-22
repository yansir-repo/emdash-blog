---
title: "Effect 是一个值：描述与执行、惰性、Effect<A, E, R> 怎么读"
description: 教程第 2 章。理解 Effect 的核心心智模型：它是对计算的描述而不是计算本身，创建不会执行，只有被运行才会产生副作用，并学会流畅地读 Effect<A, E, R> 三个参数。
date: 2026-10-01
tags: [effect, tutorial, laziness, type-parameters]
category: effect
series: effect-tutorial
seriesOrder: 2
---

上一章说 Effect 把失败、依赖、取消写进了类型。这一章回答一个更根本的问题：Effect 到底是什么东西？答案很短：**它是一个值，一份「要做什么」的描述，而不是「正在做」的过程。**

这一句话是整个系列的地基。后面几乎所有的组合子、重试、并发、资源管理，都建立在它之上。

## 先对比 Promise

看这两段代码：

```ts
const p = fetch("https://api.example.com/users/1")
```

```ts
const e = Effect.tryPromise(() => fetch("https://api.example.com/users/1"))
```

第一行执行完，请求**已经发出去了**。`p` 是一个未来结果的占位符，你无法再决定「要不要发」「发几次」「失败了怎么办」，因为事情已经在发生。

第二行执行完，**什么都没有发生**。`e` 只是一个值，里面记录了「当被运行时，去调用这个函数并处理它的结果」。它可以被保存、传递、组合、重复使用，直到有人说「现在运行它」。

打个比方：Promise 像一份已经下了单的外卖订单，Effect 像一张菜谱。菜谱可以抄十份、可以改、可以交给别人做，而订单一旦下了就在路上了。

## 惰性带来的第一个好处：可以重复使用

```ts
const hello = Effect.sync(() => {
  console.log("hello")
})

const twice = Effect.gen(function* () {
  yield* hello
  yield* hello
})
```

`hello` 定义时不会打印。运行 `twice` 会打印两次，因为同一份描述被执行了两次。如果换成 `const p = Promise.resolve(console.log("hello"))`，打印发生在这一行，再 `await p` 多少次都不会再来。

这种「一份描述，多次执行」是重试的基础。对一个已经开始的 Promise 无法重试，你只能重新调用创建它的函数；对 Effect 则可以直接说「把这个再跑一遍」：

```ts
const resilient = hello.pipe(
  Effect.retry({ times: 3 }),
  Effect.timeout("1 second")
)
```

重试和超时都是**包在描述外面的另一层描述**，仍然什么都没有执行。这也是为什么 Effect 的组合子可以这么丰富：它们操作的是值，而值可以被任意变换。重试的细节在第 16 章展开。

## 惰性带来的第二个好处：描述可以被检查

既然是值，Effect 就携带了类型信息。运行之前，编译器已经知道它会产出什么、可能怎么失败、需要什么依赖。这正是上一章那三个槽位的来源。

## 怎么读 `Effect<A, E, R>`

先记住读法：**「需要 R，可能以 E 失败，成功时给出 A」。** 从右往左读也行。下面几个例子都是真实可写的类型：

```ts
const e1: Effect.Effect<number> = Effect.succeed(1)
const e2: Effect.Effect<never, NotFound> = Effect.fail(new NotFound({ id: "1" }))
const e3: Effect.Effect<never> = Effect.die(new Error("bug"))
```

- `Effect<number>` 等于 `Effect<number, never, never>`：成功给出数字，没有可预期失败，不需要任何依赖。末尾两个参数有默认值 `never`。
- `Effect<never, NotFound>`：永远不会成功（`never`），只会以 `NotFound` 失败。
- `Effect<never>`：既不会成功也没有可预期失败。`Effect.die` 表示一个**缺陷**，它不进入类型里，这是下一部分才展开的区分（第 5 章）。

### `never` 在这里是「没有」

`never` 是 TypeScript 里的空集。`E = never` 表示「没有可预期的失败」，`R = never` 表示「没有未满足的依赖」。**当 `R` 变成 `never` 时，程序才是自给自足的，才可以被运行。** 反过来，只要 `R` 里还有东西，类型系统就在提醒你：还差某个依赖没提供。

```ts
// R = Database：还差一个依赖，不能直接运行
declare const getUser: (id: string) =>
  Effect.Effect<User, NotFound, Database>

// 提供之后，R 里的 Database 被消掉了
const ready = getUser("1").pipe(
  Effect.provideService(Database, { findUser: (id) => Effect.succeed({ id, name: "a" }) })
)
```

这里的 `Database` 是第 9 章才展开的「服务」，现在你只需要看到一件事：**提供依赖是把 `R` 往 `never` 方向消除的过程。** 一个 Effect 在组合的过程中，它的 `E` 和 `R` 会逐步汇聚成联合类型，在边缘再一次性处理。

## 描述与执行：运行发生在哪里

既然 Effect 只是描述，就需要一个「运行器」把描述变成真正的副作用。它们都以 `Effect.run` 开头：

- `Effect.runPromise`：运行并返回 `Promise`
- `Effect.runPromiseExit`：运行并返回 `Exit`，不抛异常，成功与失败都是值
- `Effect.runSync`：同步运行，要求整个 Effect 是同步的
- `Effect.runFork`：在后台启动并返回 fiber

```ts
const result = await Effect.runPromise(Effect.succeed(1)) // 1
```

运行器只接受 `R = never` 的 Effect，这正是上面「依赖必须提供完」的编译期保证。至于运行器应该放在哪里，答案是**尽量放在程序最外层**，第 3 章会讲。

有一个细节值得提前知道：`runSync` 遇到异步 Effect 会失败。在 effect 4.0.5 里，对一个包着 Promise 的 Effect 调用 `Effect.runSync`，会抛出 `AsyncFiberError`。同步还是异步，是在运行时由具体的 Effect 决定的，类型上并不区分，这一点第 4 章再谈。

## 一个小例子：把「做什么」和「怎么做」分开

```ts
const fetchUser = (id: string) =>
  Effect.tryPromise(() => fetch(`/api/users/${id}`).then((r) => r.json()))

const program = fetchUser("1").pipe(
  Effect.map((json) => json.name),
  Effect.timeout("2 seconds")
)
```

读 `program`：它是一个描述，内容是「取用户、取出名字、2 秒内必须完成」。到这一步没有任何网络请求发出。直到某个地方写下 `Effect.runPromise(program)`，才会真的发请求。你可以把 `program` 当成普通的值传给另一个函数、放进数组、导出成模块常量。

## 为什么说「值」这个词很重要

把计算变成值，意味着我们可以用普通数据的手法来处理它，而不是靠语言特性。想给一段逻辑加上重试，Promise 世界里要自己写循环和计数器；想给它加超时，要自己写 `Promise.race`；想把它们放到一个列表里统一调度，要先把每个调用包成函数以免它们提前启动。这些「先包成函数」的动作，本质上就是在手工制造惰性。

Effect 把这一步前置了：**所有的计算从一开始就是函数的描述，横切行为是对描述的函数式变换。** 所以你会看到 Effect 的 API 几乎都是「接受一个 Effect，返回另一个 Effect」的形状，学会这个形状，就学会了一半的库。

## 常见误区

- **「在 `Effect.gen` 外面写副作用也没关系」**。副作用必须放在 `Effect.sync`、`Effect.tryPromise` 这类构造函数里，这样才是惰性的。比如 `Effect.succeed(Date.now())` 里的 `Date.now()` 在构造时就已经被求值了，之后每次运行拿到的都是同一个时间戳。需要每次运行都重新计算，要写成 `Effect.sync(() => Date.now())`。
- **「`Effect.succeed(f())` 和 `Effect.sync(f)` 一样」**。前者立即调用 `f`，后者推迟到运行时。区别就是上一条。
- **「把 Effect 保存起来再用会重复执行副作用，这是 bug」**。这是特性。同一个 Effect 每次运行都会重新执行；想要「只算一次」需要显式的缓存，那是别的章节的话题。
- **「Effect 和 Promise 一样可以直接 await」**。不能。Effect 不是 thenable，你需要先把它交给运行器，或者在 `Effect.gen` 里用 `yield*` 展开它。

## 小结

Effect 是一个值：它描述一段计算，创建时不执行，被运行时才执行，可以被重复运行。`Effect<A, E, R>` 读作「需要 R，可能以 E 失败，成功给 A」，`never` 表示「没有」。

下一章我们开始真正写程序：用 `Effect.gen` 和 `pipe` 把小的描述拼成大的描述，并确认运行器应该放在哪里。

## 延伸阅读

- [为什么我用 Effect：从 Effect<A, E, R> 到 Effect.gen](/articles/effect-why-and-basics)
- [Effect v3 到 v4 迁移](/articles/effect-v3-to-v4-migration)
