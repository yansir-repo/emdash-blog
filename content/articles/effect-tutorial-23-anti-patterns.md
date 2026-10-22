---
title: "反模式合集：Effect 用歪的十一种方式"
description: 把前面各章的结论倒过来看：十一种典型的 Effect 误用，从到处 run、悬空 Effect 到吞掉失败、无界并发、盲目重试和万物皆 Effect，每种都说明丢掉了什么保证。
date: 2026-10-22
category: effect
chapter: 23
tags: [effect, tutorial]
---

最后一章换个角度。前 22 章讲「应该怎么写」，这一章把它们倒过来：看看 Effect 用歪的十一种典型方式，每一种都能编译、能跑、甚至能通过演示，但都悄悄丢掉了 Effect 本该给你的某个保证。

这不是清单式的「禁止事项」。我更想让你养成一个习惯：每次觉得「这里这样写也行」的时候，问一句，这样写之后，类型还在替我保证什么，又不再保证什么。以下每一条都按同一格式：症状、为什么歪、正确的方向。代码都是示意。

## 1. 到处调用 run

```ts
const getUser = (id: string) =>
  Effect.runPromise(userRepo.find(id)) // 业务函数内部直接执行
```

症状是业务函数返回 Promise，里面藏着 `Effect.runPromise`。歪在哪里：执行意味着依赖必须在这里就绪、错误必须在这里变成异常、取消信号在这里断开。你把 Effect 最有价值的三件事（错误、依赖、取消，第 1 章）在函数内部全部消耗掉了，调用者拿到的只是一个普通 Promise。

正确方向：业务代码返回 Effect，让 run 只发生在进程、请求、任务的边缘（第 3 章、第 19 章）。需要从框架回调里进来的，用统一的运行时入口，而不是各处自己 run。

## 2. 悬空的 Effect

```ts
const program = Effect.gen(function* () {
  Effect.log("starting")      // 构造了，但没人执行
  yield* doWork()
})
```

Effect 只是描述（第 2 章）。构造一个值却不 `yield*` 也不返回，什么都不会发生。TypeScript 对此没有意见，这是它的盲区。症状往往是「日志没打」「写库没生效」，却没有任何错误。

正确方向：开启 language service 的 floating Effect 诊断并设为 error，把「忘了 `yield*`」变成编译期问题（上一章）。

## 3. 用 Effect.promise 包会 reject 的代码

```ts
// 歪：fetch 失败会被当成缺陷
const getJson = (url: string) =>
  Effect.promise(() => fetch(url).then((r) => r.json()))

// 正：把可预期的失败放进 E
const getJson2 = (url: string) =>
  Effect.tryPromise({
    try: () => fetch(url).then((r) => r.json()),
    catch: (cause) => new FetchError({ url, cause })
  })
```

`Effect.promise` 的约定是「这个 Promise 不会 reject」。一旦 reject，它变成缺陷（defect），不在类型里，也不会被 `catchTag` 捕获（第 4、5 章）。网络请求失败是最可预期的失败，却被当成了不可预期的。

正确方向：凡是可能失败的外部调用，一律 `tryPromise`，并在 `catch` 里就把原始异常翻译成你自己的带标签错误。

## 4. 错误全是 Error，或全是 unknown

```ts
Effect.fail(new Error("user not found"))   // E 变成 Error
Effect.tryPromise(() => query())           // 不写 catch 时，E 是笼统的 UnknownError
```

当所有错误都是同一个类型，调用者无法区分「用户不存在」和「数据库挂了」，只能全部当作同一种处理，要么全吞要么全抛。你付出了写 Effect 的成本，却把错误通道退化成了 try/catch。

正确方向：每种可预期的失败一个带标签的错误（第 5 章），在边界处翻译（第 6 章）。这样 `catchTag` 才能精确地只处理你要处理的那一种，其余自动保留在类型里。

## 5. 吞掉失败

```ts
program.pipe(Effect.catch(() => Effect.succeed(null)))
program.pipe(Effect.ignore)
```

「先让它不报错」是最诱人的写法。`Effect.catch` 不区分错误种类地全部接住，`Effect.ignore` 干脆连值都丢了。错误通道变成 `never`，类型对你说「这里不会失败」，而事实正相反。

正确方向：能处理的用 `catchTag` 精确处理；确实决定忽略的，让代码里能看出这是一个有意识的决定（写出忽略的是哪种错误、为什么）；否则让它继续向上传。反过来的极端是 `Effect.orDie`：把本应处理的失败升级成缺陷，同样是在回避设计，只在你确信它「绝不应该发生」时使用。

## 6. 用类型断言代替解码

```ts
const body = (await req.json()) as CreateUserInput // 假装它是对的
```

TypeScript 的类型在运行时不存在（第 7 章）。断言没有验证任何东西，只是让编译器闭嘴。数据一旦偏离，错误会在远离源头的地方爆出来。

正确方向：边界上用 Schema 解码，`Schema.decodeUnknownEffect(CreateUserInput)(body)`，解码失败是一个类型化的失败，而不是之后某处的 `undefined is not a function`。

## 7. 把依赖藏在全局里

```ts
const key = process.env.API_KEY            // 隐藏的输入
const now = Date.now()                     // 隐藏的输入
const send = (msg: string) => realMailer.send(msg) // 模块级单例
```

这些写法让函数的类型对它的真实输入撒了谎：函数依赖环境变量、系统时间、一个具体实现，签名里却一个也看不出来。后果是测试要靠 mock 模块、打补丁、改全局状态，而且依赖关系只存在于读代码的人脑子里。

正确方向：配置用 `Config`，时间用 `Clock`，外部能力用服务（第 9、11、12 章）。依赖出现在 R 里，Layer 提供，测试时换一个替身 Layer。

另一个相关的歪法是在业务函数内部到处 `Effect.provide(...)` 去构造 Layer，每次调用都重建一遍连接和资源。Layer 应该在应用的装配处组合一次（第 10 章）。

## 8. 无界并发与顺序陷阱

```ts
// 歪一：对一万个元素无上限并发
Effect.forEach(ids, fetchOne, { concurrency: "unbounded" })

// 歪二：以为是并发，其实是顺序
Effect.all([taskA, taskB, taskC])
```

两种歪法方向相反。`Effect.all` 与 `Effect.forEach` 默认是顺序执行，不加 `concurrency` 选项时你并没有得到并发。而 `"unbounded"` 把所有任务同时放出去，对下游服务或连接池来说就是一场自己发起的压力测试。

正确方向：显式写出并发度，并且让这个数字有理由（第 14 章）。顺带一提：用 `forkDetach` 把任务丢到后台、再也不管它，会让它脱离父 fiber 的生命周期，失去结构化并发的保护（第 13 章）。除非你真的需要独立生命周期，否则用 `forkChild` 或放进 Scope。

## 9. 盲目重试

```ts
task.pipe(Effect.retry(Schedule.recurs(5)))
```

这段代码会对任何错误重试五次，没有间隔，也不区分错误。对「参数不合法」重试五次只是五次同样的失败；对已经过载的服务立刻重试，只会让它更糟。

正确方向：重试之前先分类（第 6 章），只重试瞬时错误，配上退避和上限（第 16 章）：

```ts
task.pipe(
  Effect.retry({
    schedule: Schedule.exponential("200 millis"),
    times: 4,
    while: (e) => e._tag === "Transient"
  })
)
```

注意重试对象还要幂等：重试一个「扣款」操作之前，先确认它重复执行是安全的。

## 10. 万物皆 Effect

```ts
const add = (a: number, b: number) => Effect.succeed(a + b)
const formatName = (u: User) => Effect.sync(() => `${u.first} ${u.last}`)
```

不是每个函数都需要 Effect。纯函数、确定的计算，包进 Effect 只会让每个调用点多一层 `yield*`，失去普通函数的可组合性和可测试性，什么新保证也没有换来。

正确方向：Effect 用来表达「会失败、需要依赖、有副作用、可被中断」的东西。纯计算保持为普通函数，在 Effect 里直接调用它。判断标准很简单：如果它不涉及 E、R 或副作用，就不需要是 Effect。

## 11. 把 try/catch 带进 Effect.gen

这条放在最后，因为它是前面好几条的根源。

```ts
Effect.gen(function* () {
  try {
    yield* mayFail
  } catch (e) {
    // 你以为这里会接住
  }
})
```

在 4.0.5 里实测：`yield*` 一个失败的 Effect，失败不会作为异常抛进 `catch`，整个 gen 直接以失败结束；`Effect.promise` 里 reject 的 Promise 则变成缺陷，同样不会进入 `catch`。所以在 `Effect.gen` 里写 `try/catch` 既不起作用，又给读者一个「已经处理了」的错觉。处理错误用 `Effect.catch`、`catchTag`、`Effect.result`（第 5、14 章）。

## 常见误区

- **把反模式当成「不准」。**每一条背后都有「什么时候这样做是对的」：`orDie` 用在确信不会发生的失败，`forkDetach` 用在确实需要独立生命周期，`unbounded` 用在任务数量本身就有上限。反模式的实质是「没有意识到自己放弃了什么」。
- **只改症状不改根因。**把 `Effect.promise` 改成 `tryPromise` 但 `catch` 里仍然返回笼统的 Error，等于没改。
- **靠人记住。**大部分条目（1、2、3 的一部分、7 的一部分）是可以机械检查的，交给上一章讲的工具；4、5、8、9、10 需要语境，交给评审。

## 小结

十一种方式的共同点是：每一种都在不知不觉中放弃了 Effect 的一个承诺。到处 run 放弃了边缘执行；悬空和 `try/catch` 放弃了「描述必须被执行」的模型；`promise`、笼统的 Error、吞错放弃了类型化的失败；断言放弃了边界上的真实性；隐藏依赖放弃了 R；无界并发、盲目重试放弃了对资源的节制；万物皆 Effect 则是为不需要的保证付费。

整本教程的主线可以压缩成一句话：把本来藏在代码里的东西（错误、依赖、取消、资源、时间），变成类型和结构里看得见的东西。每次犹豫时，回到这句话判断即可。

接下来可以按兴趣去读那些单点的深挖文章，它们是这条入门路径之后的进阶参考。

## 延伸阅读

- [Effect 的类型化错误](/articles/effect-typed-errors)：失败与缺陷、带标签错误的完整讲法。
- [并发与资源](/articles/effect-concurrency-and-resources)：并发度、中断与 Scope。
- [重试与 Schedule](/articles/effect-retry-and-schedule)：退避、上限与按错误分类重试。
- [边界上的 Schema](/articles/effect-schema-at-the-boundary)：为什么用解码代替断言。
- [运行时边界与测试](/articles/effect-runtime-boundaries-and-testing)：run 放在哪里、替身 Layer 与时间。
- [把约定变成机器可检查的规则](/articles/effect-rules-as-contracts)：本章里可机械检查的那几条怎么落地。
