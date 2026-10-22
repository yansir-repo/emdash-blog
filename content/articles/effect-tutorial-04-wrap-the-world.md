---
title: "包装已有的世界：sync、promise、tryPromise、回调与同步/异步的统一"
description: 教程第 4 章。梳理把同步函数、Promise、会抛异常的代码和回调式 API 包装成 Effect 的构造函数，学会在 sync、try、promise、tryPromise、callback 中做选择。
date: 2026-10-03
tags: [effect, tutorial, interop, tryPromise, callback]
category: effect
series: effect-tutorial
seriesOrder: 4
---

前面我们用 `Effect.succeed` 和 `Effect.fail` 搭了积木。但现实里的代码大多是别人的：`fetch`、`fs`、JSON 解析、第三方 SDK。这一章回答：怎么把已有的世界安全地接进 Effect。

本章只引入一类新概念：**构造函数**，也就是各种「从外部世界创建 Effect」的入口。

## 要解决的问题

外部世界有四种常见形状：

- 同步且不会抛异常的函数，例如 `Date.now()`
- 同步但可能抛异常的函数，例如 `JSON.parse`
- 返回 Promise 的函数，可能 reject，例如 `fetch`
- 基于回调的 API，例如 Node 的 `fs.readFile(path, cb)`

它们在 TypeScript 里的失败信息都不准确：`JSON.parse` 的签名不说它会抛，`Promise` 的 rejection 是 `unknown`，回调的 `err` 是 `Error | null`。把它们变成 Effect 的时候，必须做一个决定：**这个失败，是我预期的（进 `E`），还是我认为不应该发生的（缺陷）？** 每个构造函数的差别，本质上就是在回答这个问题。

## 朴素做法为什么不够

最偷懒的包法：

```ts
const bad = Effect.sync(() => JSON.parse(input))
```

如果 `input` 不是合法 JSON，`JSON.parse` 抛出的异常发生在 Effect 内部，它既不在 `E` 里也无法被预期地处理，会被当作缺陷。类型签名说「不会失败」，运行时却失败了，这又回到了第 1 章的老问题：签名撒了谎。

## 选择的标准：四个构造函数

### 1. `Effect.sync`：不会抛的同步代码

```ts
const now = Effect.sync(() => Date.now())
```

用于你确信不会抛异常、只是有副作用或者需要延迟求值的同步函数。第 2 章提到的惰性就是靠它：把调用包进函数里，推迟到运行时。

### 2. `Effect.try`：可能抛的同步代码

```ts
const parse = (s: string) =>
  Effect.try({
    try: () => JSON.parse(s) as unknown,
    catch: (e) => new ParseFailed({ cause: e })
  })
```

`try` 里写会抛的代码，`catch` 把任何抛出的值翻译成你自己的错误类型。结果是 `Effect<unknown, ParseFailed>`，失败进入了 `E`。

### 3. `Effect.promise`：不会 reject 的 Promise

```ts
const delayed = Effect.promise(() => Promise.resolve(1))
```

只在你确信这个 Promise 不会 reject 时使用。如果它 reject 了，会被当作缺陷，而不是失败。这类场景比想象中少，大多数 I/O 都可能失败。

### 4. `Effect.tryPromise`：可能 reject 的 Promise

```ts
// 简写：失败类型是 Cause.UnknownError
const w3 = Effect.tryPromise(() => fetch("https://api.example.com"))

// 完整写法：自己翻译错误
const w4 = Effect.tryPromise({
  try: (signal) => fetch("https://api.example.com", { signal }),
  catch: (cause) => new NetworkError({ cause })
})
```

这是包装 Promise 最常用的一个。注意两点：

- 传一个函数的简写形式，失败类型会是 `Cause.UnknownError`（4.0.5 里的行为），它只是装下了原始异常，没有任何语义。**在应用代码里更推荐写完整形式，把失败翻译成自己的错误类型**，这样调用者才能按类型处理。为什么是「翻译」而不是「透传」，第 6 章会展开。
- `try` 函数接收一个 `signal`，这是 `AbortSignal`。**当这个 Effect 被中断时，signal 会被 abort。** 把它传给 `fetch`，就把第 1 章说的取消「接上」了。反过来，如果你不传，Effect 被中断时底层请求还会继续跑，只是结果被丢弃。

### 用一张思考路径选

```text
同步？
├─ 不会抛 → Effect.sync
└─ 可能抛 → Effect.try
异步（Promise）？
├─ 绝不 reject → Effect.promise
└─ 可能 reject → Effect.tryPromise
回调式 API → Effect.callback
```

遇到犹豫的情况，**默认选「可能失败」的那个**：多写一个 `catch` 的成本远低于把一个真实的失败降级成缺陷。

## 回调式 API：Effect.callback

对没有 Promise 化的 API，用 `Effect.callback`：

```ts
const readText = (path: string) =>
  Effect.callback<string, FileError>((resume) => {
    readFile(path, "utf8", (err, data) => {
      if (err) resume(Effect.fail(new FileError({ cause: err })))
      else resume(Effect.succeed(data))
    })
  })
```

注册函数收到一个 `resume`，在回调触发时调用它，传入「最终应该变成什么 Effect」。有三个要点：

- `resume` 只有第一次调用有效，后续调用会被忽略
- 注册函数还会收到 `AbortSignal` 作为第二个参数
- 注册函数可以**返回一个清理 Effect**，当这个 Effect 被中断时运行

```ts
const sleep1s = Effect.callback<void>((resume) => {
  const t = setTimeout(() => resume(Effect.void), 1000)
  return Effect.sync(() => clearTimeout(t)) // 被中断时清掉定时器
})
```

最后那个返回值就是回调世界里的资源安全：被中断时，定时器被清除，不会在后台泄漏。v3 里这个构造函数叫 `Effect.async`，在 4.0.5 里已经不存在，对应的名字是 `Effect.callback`。

## 惰性再强调：suspend 与 fromNullishOr

两个小而有用的构造函数：

```ts
const fresh = Effect.suspend(() => Effect.succeed(Date.now()))
const home = Effect.fromNullishOr(process.env.HOME)
```

`Effect.suspend` 把「创建 Effect 的过程」本身推迟到运行时，适合需要在每次运行时重新决定返回哪个 Effect 的场景。`Effect.fromNullishOr` 把 `null`/`undefined` 变成失败，把可空值接入类型化的世界。

## 同步和异步的统一

回头看这几个构造函数：`Effect.sync` 与 `Effect.promise` 的结果类型都是 `Effect<A>`。**Effect 的类型不区分同步和异步。** 一个 `Effect<number>` 可能是立刻算出来的，也可能等了一个网络请求。

这带来一个很大的好处：你可以在不改变调用者的前提下，把同步实现换成异步实现。想象一个 `lookup` 函数最初从内存 Map 读取，后来改成查数据库。用 Promise 的话，所有同步调用者都要加上 `await`、签名改成 `async`，这个「颜色」会沿着调用链一路传染。Effect 里签名都是 `Effect<A, E, R>`，调用者通过 `yield*` 使用，没有感知。

代价是前面提过的：`Effect.runSync` 无法运行异步的 Effect，对包着 Promise 的 Effect 调用它会抛出 `AsyncFiberError`。这是个运行时错误，而不是类型错误，所以**需要同步运行的入口要自己保证内部没有异步**；绝大多数情况直接用 `runPromise` 就不会碰到。

## 一个小例子：把三种世界拼起来

下面这个函数读取一个文件、解析 JSON、再把结果发给远程服务。三步分别来自回调、同步抛异常和 Promise，包装之后就能用第 3 章的 `gen` 无缝拼接：

```ts
const syncConfig = (path: string) =>
  Effect.gen(function* () {
    const text = yield* readText(path)   // callback
    const json = yield* parse(text)      // try
    yield* upload(json)                  // tryPromise
  })
```

它的 `E` 是 `FileError | ParseFailed | NetworkError` 的联合，由编译器自动推出。调用者读签名就知道会怎么失败，没有任何一步需要写 `try/catch`。

## 常见误区

- **「`Effect.promise` 比 `Effect.tryPromise` 省事，先用着」**。它把所有 reject 变成缺陷，真实的失败从此无法被类型化处理。除非确定不会 reject，否则用 `tryPromise`。
- **「`tryPromise` 简写就够了」**。简写给你的是 `UnknownError`，调用者无法据此分辨具体问题。写在边缘处的包装，应该写 `catch` 翻译。
- **「`catch` 里抛出自己的错误」**。`catch` 应当 `return` 错误值，而不是 `throw`。如果它抛出，抛出的值会被当作缺陷。
- **「传了 signal 就等于取消了」**。signal 被 abort 之后，底层操作是否真的停下，取决于它有没有认真观察这个 signal。`fetch` 会，很多第三方 SDK 不会。
- **「把 Promise 当参数传进 Effect」**。`Effect.succeed(fetch(url))` 在构造时就把请求发出去了，是惰性的反面。始终用 `() => ...` 的形式。

## 小结

包装外部世界的核心是回答一个问题：失败是预期的还是缺陷？`sync`、`promise` 是「不会失败」，`try`、`tryPromise` 是「可能失败，进入 `E`」，`callback` 处理回调式 API 并支持中断时清理。同步和异步在类型里没有区别，调用者无需关心。

这一章结束，Part 1 就完成了：你已经能写出一个 Effect，组合它，包装外部世界，并在边缘运行。接下来进入 Part 2「错误与数据」，第 5 章我们认真对待 `E`：什么是失败，什么是缺陷，怎么用 `TaggedError` 和 `catchTag` 精确处理。

## 延伸阅读

- [为什么我用 Effect：从 Effect<A, E, R> 到 Effect.gen](/articles/effect-why-and-basics)
- [Effect 类型化错误](/articles/effect-typed-errors)
- [Effect v3 到 v4 迁移](/articles/effect-v3-to-v4-migration)
