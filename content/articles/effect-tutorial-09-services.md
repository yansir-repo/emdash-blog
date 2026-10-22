---
title: "服务：接口与实现分离，Context.Service"
description: "Effect 教程第 9 章：为什么依赖应该写进类型而不是藏在 import 里，Context.Service 如何把「能力的接口」与「能力的实现」拆开，R 参数怎样自动汇总依赖，以及服务设计里常见的几种误用。"
date: 2026-10-08
tags: [effect, tutorial, service, context, dependency-injection]
category: effect
series: effect-tutorial
seriesOrder: 9
---

前八章我们处理的是「一段计算做什么、可能怎么失败、数据长什么样」。从这一章开始换一个问题：这段计算**依赖什么**。发邮件、读数据库、拿当前时间、调用支付网关，这些都不是计算本身，而是计算所处的环境。环境怎么表达，决定了代码好不好测、好不好换、好不好读。

## 要解决的问题

看一段典型的 TypeScript：

```ts
import { mailer } from "./infra/mailer"
import { db } from "./infra/db"

export async function signup(email: string) {
  await db.users.insert({ email })
  await mailer.send(email, "welcome")
}
```

`signup` 的签名是 `(email: string) => Promise<void>`，它说了「我要一个邮箱」，却没说「我要一个数据库和一个邮件客户端」。依赖藏在 import 语句里，是模块级单例。这种写法的代价在三个场景里会同时出现：

- 测试时只能 mock 整个模块，替换的粒度是文件而不是能力。
- 想在某个调用链里临时换一个实现（比如演练模式下不真发邮件），要么改全局，要么到处加开关参数。
- 读签名读不出依赖，读者必须翻完函数体才知道它碰了哪些外部系统。

## 朴素做法为什么不够

常见的第一个改进是手动传参：`signup(db, mailer, email)`。依赖显式了，但调用链一深，中间函数就要替下游转发自己根本不用的参数。第二个改进是引入 DI 容器加装饰器，参数不用传了，但依赖关系变成运行时反射，缺了一个 provider 要等到启动甚至首次调用才报错。

两者其实在解决同一件事：**让依赖可见，同时不让它污染每一层的参数列表**。手动传参牺牲了后者，容器牺牲了前者的静态检查。

## Effect 的做法：依赖是类型的一部分

回忆第 2 章：`Effect<A, E, R>` 的第三个参数 `R`，就是「运行这个 Effect 需要从环境里拿到什么」。服务（service）就是 `R` 的取值单位：一个服务代表一种**能力**，用接口描述，实现留到别处提供。

定义一个服务只需要写接口：

```ts
import { Context, Data, Effect } from "effect"

class EmailError extends Data.TaggedError("EmailError")<{
  readonly reason: string
}> {}

class Mailer extends Context.Service<Mailer, {
  readonly send: (to: string, body: string) => Effect.Effect<void, EmailError>
}>()("app/Mailer") {}
```

`Context.Service<Self, Shape>()("key")` 给了你三样东西：类型 `Mailer`（代表接口）、一个运行时 key（字符串 `"app/Mailer"`）、以及一个可以被 `yield*` 的值。接口里方法返回的是 `Effect`，所以失败也在类型里；接口只描述「能做什么」，不涉及「怎么做」。

业务代码取用服务的方式，就是 `yield*` 它：

```ts
const signup = (email: string) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer
    yield* mailer.send(email, "welcome")
    return email
  })
// Effect<string, EmailError, Mailer>
```

我没有给 `signup` 写返回类型，`R` 是推导出来的：`yield* Mailer` 这一行既取到了实例，又把 `Mailer` 记进了 `R`。多个服务在组合时自动取并集，中间函数什么都不用转发。如果你忘了提供实现就想运行，把它交给 `Effect.runPromise` 会得到编译错误，并且错误信息会直接点名缺的是 `Mailer`。这是 DI 容器做不到的：缺依赖变成了编译期问题。

### 心智模型：函数签名里的「插座」

一个类比：`R` 像一个电器背面的电源规格标签。它不负责发电，只声明「我需要 220V 插座」。服务就是插座的规格，Layer（下一章）是真正接到墙上的电源。同一台电器，插到家里的电源是真实运行，插到测试台的稳压器就是测试，电器本身不改一个字。

「提供」的动作是 `Effect.provide`。提供之后，对应的服务从 `R` 里消失：

```ts
import { Layer } from "effect"

const MailerLive = Layer.succeed(Mailer, {
  send: (to, body) => Effect.log(`send ${to}: ${body}`)
})

const runnable = signup("a@b.c").pipe(Effect.provide(MailerLive))
// Effect<string, EmailError, never>
```

这里的 `Layer.succeed` 是最简单的一种提供方式，Layer 本身是下一章的主题，现在只需要知道「它是一份实现的配方」。换一份实现，只需要换这一个值：

```ts
const MailerFake = Layer.succeed(Mailer, { send: () => Effect.void })
```

`signup` 的代码完全不动。这就是接口与实现分离在 Effect 里的具体形态：**接口属于业务代码的词汇表，实现属于程序入口（或测试）的装配决定**。

## 什么算一个好服务

服务的设计比语法更重要，下面是几条取舍。

第一，**接口按能力划分，而不是按技术划分**。`Mailer.send`、`Clock.currentTimeMillis`、`PaymentGateway.charge` 是能力；`HttpClient`、`PostgresClient` 是技术。业务代码最好依赖前者，后者留给实现去依赖。这样把数据库从 Postgres 换成别的，业务代码一行不改。

第二，**接口里的方法不应该再带 `R`**。如果 `Mailer.send` 返回的是 `Effect<void, EmailError, HttpClient>`，那么每个使用 `Mailer` 的地方都得同时处理 `HttpClient`，实现细节泄漏到了接口。方法的 `R` 应当是 `never`，实现需要的东西，在构造这个服务的时候就取好（第 10 章）。

第三，**接口里的错误只暴露调用方能处理的**。把底层的 `SqlError` 原样写进接口，等于把存储实现焊死在业务层。第 6 章讲过：错误要在边界上翻译成领域语言，服务接口就是那条边界。

第四，**key 字符串是运行时身份**。两个服务用了同一个 key，它们会占同一个槽位。惯例是写成 `包名/服务名`，比如 `"app/Mailer"`，避免撞车。

第五，**时间、随机数这类环境量也可以是服务**。Effect 自带的 `Clock`、`Random` 就是这样：你不直接调 `Date.now()`，而是通过服务取时间，测试时才能换成可控的时钟。这一点第 12 章会用到。

## 常见误区

- **把服务当成「全局单例的新写法」**。服务不是用来存全局可变状态的。有状态的服务，状态应当在构造时创建、封装在实现里，而不是在模块顶层放一个 `let`。
- **每个函数都做成服务**。`formatPrice` 这样的纯函数不需要服务。判断标准：这个东西有没有「换一个实现」的合理场景（测试替身、不同环境、不同供应商）。没有，就是普通函数。
- **服务接口过大**。一个 `AppContext` 塞进二十个方法，等于又退回了全局对象。拆成小而专一的服务，`R` 里的联合类型才有信息量。
- **在 `yield*` 之后到处传服务实例**。取一次、闭包里用，不要把实例当参数一路往下传，否则又回到了手动传参。
- **以为 `R` 是运行时注入**。`R` 只存在于类型层面，它保证的是「运行前必须提供」；真正的提供发生在 `Effect.provide` 那一刻。

## 小结

- 依赖是类型的一部分：`R` 记录需要什么，`Effect.provide` 把它消掉。
- `Context.Service` 定义能力的接口，接口不含实现、方法不带 `R`、错误只含调用方能处理的。
- 业务代码 `yield*` 服务，换实现只需要换提供的那个值，业务代码不动。

服务只是「接口」。真正的实现从哪来、怎么用别的服务构造、资源什么时候建立和释放，是下一章 Layer 的内容：[Layer：构建依赖图、生命周期与组合](/articles/effect-tutorial-10-layers)。

## 延伸阅读

- [Effect 服务与 Layer：把依赖写进类型里](/articles/effect-services-and-layers)
- [Context.Reference：带默认值的服务，取代 FiberRef](/articles/effect-context-reference)
- [把 Effect 约定变成机器可检查的规则：language service 与 effect-scan](/articles/effect-rules-as-contracts)
