---
title: "Effect 服务与 Layer：把依赖写进类型里"
description: "用 Effect v4 的 Context.Service 与 Layer 做依赖注入：如何定义服务、构造与组合 Layer、写测试替身，以及为什么 Effect<A, E, R> 里的 R 参数是一个值得喜欢的设计。"
date: 2026-09-26
tags: [effect, typescript, dependency-injection]
category: effect
---

大多数 TypeScript 项目做依赖注入，要么靠模块级单例（`import { db } from "./db"`），要么靠 DI 容器加装饰器。前者在测试时只能 mock 模块，后者把依赖关系藏在运行时反射里，写错了要到启动才知道。

Effect 的做法是第三条路：**依赖是类型的一部分**。`Effect<A, E, R>` 的第三个参数 `R` 就是"运行这段代码需要什么"。这篇文章基于 Effect v4，讲服务怎么定义、Layer 怎么组合、测试怎么换实现。

## 先说 v3 到 v4 的变化

如果你读过 v3 时代的文章，下面几个写法在 v4 里已经不存在了，我逐个在安装的包里确认过：

- `Context.Tag("id")<Self, Shape>()` 被 `Context.Service<Self, Shape>()("id")` 取代。
- `Effect.Service` 这个会自动生成 `.Default` Layer 的 class 已经没有了，Layer 需要你自己写，这反而更直白。
- `Layer.scoped` 不再单独存在，`Layer.effect` 里直接可以用需要 Scope 的资源（见下文 `acquireRelease` 的例子）。

以下所有代码都是真实编译过的，不是示意。

## 定义服务：只写接口，不写实现

```ts
import { Context, Data, Effect, Layer, Ref } from "effect"

interface User {
  readonly id: number
  readonly name: string
}

class UserNotFound extends Data.TaggedError("UserNotFound")<{
  readonly id: number
}> {}

class UserRepo extends Context.Service<UserRepo, {
  readonly findById: (id: number) => Effect.Effect<User, UserNotFound>
}>()("app/UserRepo") {}

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, body: string) => Effect.Effect<void>
}>()("app/Mailer") {}
```

`Context.Service<Self, Shape>()("key")` 同时给了你三样东西：一个类型（`UserRepo` 代表服务的接口）、一个运行时的 key（字符串 `"app/UserRepo"`）、以及一个可以被 `yield*` 的值。注意 key 字符串就是运行时身份，不同服务重名会占同一个槽位，所以我习惯用 `包名/服务名` 的格式。

这里的服务接口里，方法返回的是 `Effect`，错误也写在类型里（`UserNotFound`）。接口只描述能力，不涉及"怎么连数据库"。

## 业务代码：R 自动推导

```ts
const welcome = (id: number) =>
  Effect.gen(function* () {
    const repo = yield* UserRepo
    const mailer = yield* Mailer
    const user = yield* repo.findById(id)
    yield* mailer.send(user.name, `welcome, ${user.name}`)
    return user
  })

const _check: Effect.Effect<User, UserNotFound, UserRepo | Mailer> = welcome(1)
```

我没有给 `welcome` 写任何返回类型，编译器推导出 `Effect<User, UserNotFound, UserRepo | Mailer>`。`yield* UserRepo` 这一行既取到了实例，又把 `UserRepo` 记进了 `R`。

如果你忘了提供依赖就想运行，会发生什么？把 `welcome(1)` 直接交给 `Effect.runPromise`，tsc 报的是：

```text
Argument of type 'Effect<User, UserNotFound, Mailer | UserRepo>' is not assignable to parameter of type 'Effect<User, UserNotFound, never>'.
  Type 'Mailer | UserRepo' is not assignable to type 'never'.
    Type 'Mailer' is not assignable to type 'never'.
```

缺依赖是**编译期错误**，而且报错直接点名缺的是 `Mailer` 和 `UserRepo`。传统 DI 容器里这种错误是运行时的 "No provider for Mailer"。

## 为什么 R 是好设计

我认为 `R` 好在三点。

第一，**依赖不可能被遗漏，也不可能被隐藏**。函数签名就是依赖清单，不需要翻实现，也不需要约定"这个函数内部会用全局 logger"。

第二，**依赖不需要逐层传参**。对比手动传参：`welcome(repo, mailer, id)`，调用链越深，中间函数越要透传自己根本不用的参数。`R` 在组合时自动取并集，中间函数什么都不用写。

第三，**提供依赖的位置由你决定**。可以在程序入口一次性提供，也可以在某个子树里局部替换。这一点在写测试时非常关键，下面会看到。

代价也要诚实说：类型会变长，初学者面对 `R` 的联合类型会有点陌生。但这个代价换来的是编译器帮你做依赖检查，我觉得值。

## 一个常见的误解

有人会觉得，把依赖写进类型，不就是换了种方式的"参数传递"吗？区别在于谁来做传递。手动传参时，每一层函数都要显式接收并转发；而 `R` 是编译器替你汇总的，你只需要在某一层选择"在这里提供"。不提供，它就继续向上冒泡；提供了，它就从类型里消失。这是一个可以被类型检查的、有明确作用域的机制，而不是约定。

## 构造 Layer

服务只是接口，实现通过 `Layer` 提供。最简单的是 `Layer.succeed`：

```ts
const UserRepoLive = Layer.succeed(UserRepo, {
  findById: (id) =>
    id === 1
      ? Effect.succeed({ id, name: "Ada" })
      : Effect.fail(new UserNotFound({ id })),
})

const MailerLive = Layer.succeed(Mailer, {
  send: (to, body) => Effect.log(`mail to ${to}: ${body}`),
})

const AppLayer: Layer.Layer<UserRepo | Mailer> = Layer.mergeAll(UserRepoLive, MailerLive)
```

`Layer.Layer<ROut, E, RIn>` 有三个参数：提供什么、构造可能失败什么、构造需要什么。`AppLayer` 没有后两项，所以只写一个参数。我建议给导出的 Layer 显式标注类型，这样类型错误会在 Layer 定义处暴露，而不是在入口文件顶部爆出一长串推导结果。

如果某个服务本身依赖别的服务，就用 `Layer.effect`，在构造时 `yield*` 它们：

```ts
class Notifier extends Context.Service<Notifier, {
  readonly welcome: (id: number) => Effect.Effect<void, UserNotFound>
}>()("app/Notifier", {
  make: Effect.gen(function* () {
    const repo = yield* UserRepo
    const mailer = yield* Mailer
    return {
      welcome: (id: number) =>
        repo.findById(id).pipe(
          Effect.flatMap((u) => mailer.send(u.name, "welcome"))
        ),
    }
  }),
}) {
  static readonly layer: Layer.Layer<Notifier, never, UserRepo | Mailer> =
    Layer.effect(Notifier, Notifier.make)
}
```

v4 允许在 `Context.Service` 的第二个参数里放一个 `make`，它是一个构造服务实例的 Effect。我把 `layer` 作为静态属性挂在类上，用起来是 `Notifier.layer`，这是我偏好的约定，不是框架强制。

## 组合 Layer：merge、provide、provideMerge

三个组合子，分别对应三种关系：

- `Layer.mergeAll`：并列，互不依赖。
- `Layer.provide`：把一个 Layer 的输出喂给另一个，**消掉**它的输入，输出里不再暴露被喂的那个。
- `Layer.provideMerge`：同样喂入，但输出里**保留**被喂的服务。

```ts
const NotifierLive: Layer.Layer<Notifier> =
  Notifier.layer.pipe(Layer.provide(AppLayer))

const NotifierStack: Layer.Layer<Notifier | UserRepo | Mailer> =
  Notifier.layer.pipe(Layer.provideMerge(AppLayer))
```

选择标准很简单：下游代码还要不要直接用 `UserRepo` 和 `Mailer`？不要就用 `provide`，要就用 `provideMerge`。

资源型服务（连接池、文件句柄）需要释放，在 `Layer.effect` 里用 `Effect.acquireRelease` 即可，Layer 构造时获取，Layer 作用域结束时释放：

```ts
class Db extends Context.Service<Db, {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<string>>
}>()("app/Db") {}

const DbLive = Layer.effect(
  Db,
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.log("db: connect"),
      () => Effect.log("db: close")
    )
    return { query: (sql: string) => Effect.succeed([sql]) }
  })
)
```

我实际运行过：用 `Effect.provide(DbLive)` 跑完一段程序，日志依次是 `db: connect`、`db: close`。释放逻辑和服务定义写在一起，不会漏。

## 测试替身：换 Layer，不换代码

这是 Layer 设计回报最大的地方。业务函数 `welcome` 一个字都不用改，测试里提供另一个 Layer 就行。下面这个测试替身还顺便记录了发出的邮件：

```ts
const makeTestMailer = Effect.gen(function* () {
  const sent = yield* Ref.make<ReadonlyArray<string>>([])
  const layer = Layer.succeed(Mailer, {
    send: (to, body) => Ref.update(sent, (xs) => [...xs, `${to}:${body}`]),
  })
  return { sent, layer } as const
})

const test = Effect.gen(function* () {
  const { sent, layer } = yield* makeTestMailer
  yield* welcome(1).pipe(
    Effect.provide(Layer.mergeAll(UserRepoLive, layer))
  )
  const out = yield* Ref.get(sent)
  if (out.length !== 1) return yield* Effect.die("expected one mail")
  return out
})
```

没有 mock 框架，没有 `jest.mock("./mailer")`，也没有模块缓存的坑。替身就是一个普通的 Layer，状态用 `Ref` 存，类型检查照常生效：如果 `Mailer` 接口加了新方法，测试替身会立刻编译失败，而不是在运行时才发现缺方法。

## 包装 Layer：装饰一个已有服务

Layer 还能"依赖自己提供的那个服务"，用来装饰原实现。加日志、加缓存、加限流都可以这样做，原实现完全不动：

```ts
const UserRepoLogged = Layer.effect(
  UserRepo,
  Effect.gen(function* () {
    const inner = yield* UserRepo
    return UserRepo.of({
      findById: (id) =>
        Effect.log(`findById ${id}`).pipe(Effect.andThen(inner.findById(id))),
    })
  })
).pipe(Layer.provide(UserRepoLive))
```

`UserRepo.of` 只是一个帮你检查类型的恒等函数。装饰层的输入是 `UserRepo`，输出还是 `UserRepo`，最后用 `Layer.provide(UserRepoLive)` 把真实实现塞进去。

## 入口：只在边缘组装一次

```ts
const main = welcome(1).pipe(
  Effect.catchTag("UserNotFound", (e) => Effect.succeed(`missing ${e.id}`)),
  Effect.provide(UserRepoLogged.pipe(Layer.provideMerge(MailerLive)))
)
```

我的原则是：**业务函数里永远不 `provide`，只在 `main`、HTTP handler 入口和测试里 `provide`**。这样 `R` 才能一路向上冒泡，直到入口才被一次性消掉，依赖图只在一处可见。

## 小结

- 服务用 `Context.Service<Self, Shape>()("key")` 声明，只含接口；v3 的 `Context.Tag` 与 `Effect.Service` 在 v4 里已不再适用。
- 业务代码用 `yield*` 取服务，`R` 自动推导；缺依赖是编译期错误，而不是运行时容器报错。
- Layer 构造用 `Layer.succeed` / `Layer.effect`，组合用 `mergeAll` / `provide` / `provideMerge`，资源释放跟随 Layer 定义。
- 测试替身只是另一个 Layer，没有 mock 框架，类型检查照样生效。
- 装饰（日志、缓存）也是 Layer：输入输出是同一个服务。

下一篇《Effect Schema：在系统边界做解码，一份定义多处使用》：数据进来之前，怎么用 Schema 一次性搞定校验与类型。
