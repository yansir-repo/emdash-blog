---
title: "Layer：构建依赖图、生命周期与组合"
description: "Effect 教程第 10 章：服务的实现从哪里来。讲清 Layer 的三个参数、provide、provideMerge 与 mergeAll 的区别，资源如何建立与释放，以及依赖图只构建一次的含义。"
date: 2026-10-09
category: effect
chapter: 10
tags: [effect, tutorial]
---

上一章我们把依赖写进了类型：业务代码声明「我需要 `Mailer`」，实现留给别人。这一章回答「别人」是谁：实现从哪来，实现自己又依赖别的东西时怎么办，数据库连接这类需要关闭的资源该怎么管。

## 要解决的问题

真实程序里的依赖不是一个平面，而是一张图。`UserRepo` 需要 `Pool`，`Pool` 需要 `Config`，`Mailer` 需要 `HttpClient`，`HttpClient` 也需要 `Config`。要把它们装配成可运行的程序，必须回答三个问题：

- 谁先构建、谁后构建？构建顺序应该由依赖关系决定，而不是由人记在脑子里。
- 同一个依赖（比如 `Config`）被多个下游使用时，是构建一份还是多份？
- 资源怎么释放？连接池在启动时打开，在退出时关闭，中途任何一步失败，已经打开的也要关掉。

## 朴素做法为什么不够

最直接的写法是写一个 `main()`，自己按顺序 new 对象：

```ts
const config = loadConfig()
const pool = await createPool(config)
const repo = new UserRepo(pool)
const mailer = new Mailer(config)
// ... 退出时手动 pool.close()
```

这在小程序里没问题，规模一大就有三个毛病。构建顺序是手写的，加一个依赖要找准插入位置；清理逻辑散落在各处，中途 `createPool` 之后某一步抛错，`pool` 往往就泄漏了；测试想换掉其中一环，只能复制一份 `main`。

## Effect 的做法：Layer 是「构建一个服务的配方」

`Layer<ROut, E, RIn>` 是一个值，描述了「如何构建出 `ROut`，构建可能以 `E` 失败，构建本身需要 `RIn`」。三个参数的读法和 `Effect<A, E, R>` 对应：`ROut` 像 `A`，`E` 和 `RIn` 同样是 `E` 和 `R`。区别在于 Layer 的产物是**服务**，而且产物的生命周期由 Layer 管理。

它和 Effect 一样是惰性的：定义一个 Layer 不会构建任何东西，直到它被提供给某个程序，或者被整体启动。

### 三种构造方式

最简单的是 `Layer.succeed`，用一个现成的值提供服务，适合没有副作用、没有依赖的实现。

需要依赖别的服务，或者构造过程有副作用时，用 `Layer.effect`，构造体是一个 Effect，可以在里面 `yield*` 其他服务：

```ts
import { Context, Effect, Layer } from "effect"

class Config extends Context.Service<Config, { readonly url: string }>()("app/Config") {
  static readonly layer = Layer.succeed(Config, { url: "db://x" })
}

class Pool extends Context.Service<Pool, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("app/Pool") {
  static readonly layer: Layer.Layer<Pool, never, Config> = Layer.effect(
    Pool,
    Effect.gen(function* () {
      const cfg = yield* Config
      yield* Effect.log("open pool " + cfg.url)
      yield* Effect.addFinalizer(() => Effect.log("close pool"))
      return { query: (sql) => Effect.succeed("rows:" + sql) }
    })
  )
}
```

两点值得停一下。第一，`Pool.layer` 的类型里 `RIn` 是 `Config`：Layer 把「我构建时需要什么」也写进了类型，所以依赖图是被类型检查的。第二，构造体里的 `Effect.addFinalizer` 登记了一个清理动作，它挂在这个 Layer 的生命周期上。（`Effect.acquireRelease` 是更常用的「获取与释放配对」写法，第 15 章专门讲 Scope 与 finalizer，这里只需要知道：Layer 构造体里登记的清理动作，会在 Layer 被释放时执行。）

我给导出的 Layer 都显式标了类型。这是个值得养成的习惯：类型不符时，错误出现在 Layer 定义处，而不是在入口文件里冒出一长串推导结果。

### 三个组合子，对应三种关系

依赖图的边只有三种形态：

- `Layer.mergeAll`（两个时是 `Layer.merge`）：**并列**，互不依赖，输出是两边输出的并集。
- `Layer.provide`：把一个 Layer 的输出喂给另一个，消掉它的 `RIn`，**输出里不再暴露**被喂入的那个服务。
- `Layer.provideMerge`：同样喂入，但输出里**保留**被喂入的服务。

```ts
class Repo extends Context.Service<Repo, { readonly all: Effect.Effect<string> }>()("app/Repo") {
  static readonly layer: Layer.Layer<Repo, never, Pool> = Layer.effect(
    Repo,
    Effect.gen(function* () {
      const pool = yield* Pool
      return { all: pool.query("select") }
    })
  )
}

const PoolLive = Pool.layer.pipe(Layer.provide(Config.layer))
const RepoLive: Layer.Layer<Repo> = Repo.layer.pipe(Layer.provide(PoolLive))
const RepoAndPool: Layer.Layer<Repo | Pool> = Repo.layer.pipe(Layer.provideMerge(PoolLive))
```

`RepoLive` 的输出只有 `Repo`：`Pool` 是它内部的实现细节，外面看不见。`RepoAndPool` 把 `Pool` 也留在输出里，适合入口处还有别的程序要直接用连接池的情形。选哪个，取决于你想不想让这个服务成为外部可见的接口的一部分。

一个类比：Layer 像一张工序卡。`provide` 是「这道工序的半成品交给下一道工序，之后不再出现在成品清单里」；`provideMerge` 是「半成品交给下一道工序，同时也留一份进成品清单」；`mergeAll` 是两条互不相干的流水线并排。

### 生命周期：先建后用，反序释放

把这些接起来跑一遍，输出的顺序就是生命周期的样子：

```ts
const program = Effect.gen(function* () {
  const repo = yield* Repo
  yield* Effect.log(yield* repo.all)
})

Effect.runPromise(program.pipe(Effect.provide(RepoLive)))
```

```text
INFO: open pool db://x
INFO: rows:select
INFO: close pool
```

构建发生在程序开始使用之前，释放发生在程序结束之后，并且释放顺序与构建顺序相反（后构建的先释放，因为它可能还依赖先构建的）。中途任何一步构建失败，已经构建成功的部分会被释放。这些都由 Layer 保证，你不用自己写 try/finally。

对于长期运行的应用，可以用 `Layer.launch` 把整个 Layer 当作程序本体启动，它会一直运行直到被中断，中断时 Layer 的释放逻辑随之执行。进程信号与运行时边界的细节放到第 19 章。

### 同一个 Layer 只构建一次

当同一个 Layer 值在**同一次组合**里被多处依赖时（比如 `Config.layer` 同时被 `Pool` 和 `Mailer` 依赖），它只会被构建一次，大家拿到的是同一个实例。这是 Layer 与「函数调用」最大的差别：Layer 是依赖图里的节点，节点按值去重。

这个特性有一个重要的推论：**把依赖图组合好，只提供一次**。如果你对同一个程序的不同部分分别 `Effect.provide` 同一个 Layer，并列的两次提供各自构建各自的实例（实测：两个并列的 provide 构建了两次，组合后只 provide 一次则只构建一次）。想要共享一个连接池，就应该在最外层组合出完整的 Layer，一次 provide。更细的复用规则（嵌套 provide、`Layer.fresh`）见延伸阅读里的记忆化一篇。

## 常见误区

- **在 Layer 里用 `Layer.succeed` 提供带副作用的资源**。`Layer.succeed` 接收的是现成的值，它不能表达「打开连接」「关闭连接」。有资源的服务应当用 `Layer.effect` 加 finalizer。
- **把 `Layer.provide` 和 `Layer.provideMerge` 搞反**。症状是编译器说某个服务找不到：用了 `provide`，但外面还想用被喂入的那个服务。
- **服务的方法里再引入依赖**。构造时取好依赖（`yield*` 在 Layer 的构造体里），方法保持 `R = never`，否则上一章说的接口泄漏就出现了。
- **循环依赖**。A 要 B、B 要 A，类型会推导不出来。拆出第三个更小的服务，或者重新划分职责。
- **在多处各自 provide 同一个 Layer，却期望共享实例**。见上一节。
- **在 Layer 构造体里 `Effect.runPromise`**。这会把惰性的构建提前执行，丢掉失败类型与释放保证。构造体始终是 Effect，别在里面启动新的运行。

## 小结

- Layer 是服务的构建配方，`Layer<ROut, E, RIn>` 同时写明产物、构建失败和构建所需。
- `mergeAll` 并列，`provide` 喂入并隐藏，`provideMerge` 喂入并保留。
- Layer 管理生命周期：先建后用、反序释放、失败时回收已建部分；同一次组合里同一个 Layer 只构建一次。

依赖图里有一类特殊的叶子节点：配置与密钥。它们既是依赖，又会因环境而变，还可能不能出现在日志里。下一章专门讲：[配置与密钥：Config、Redacted 与环境差异](/articles/effect-tutorial-11-config)。

## 延伸阅读

- [Effect 服务与 Layer：把依赖写进类型里](/articles/effect-services-and-layers)
- [Effect Layer 记忆化：v4 里嵌套 provide、fresh 与 local 到底各构建几次](/articles/effect-layer-memoization)
- [Effect 资源类 API：LayerMap、RcMap、Pool、LayerRef 与 Resource 怎么选](/articles/effect-layermap-rcmap-pool)
