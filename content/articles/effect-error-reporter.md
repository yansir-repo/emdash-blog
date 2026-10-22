---
title: "Effect ErrorReporter：统一上报 Cause，用标注控制 ignore、severity 与 attributes"
description: 讲解 ErrorReporter 与 withErrorReporting：用 ignore、severity、attributes 标注错误统一上报 Cause，defectsOnly 的真实语义与默认 Info 陷阱，unstable。
date: 2026-10-22
tags: [effect, effect-advanced, error-handling, error-reporter]
category: effect
---

错误上报在大多数项目里是一堆散落的 `catch`：每个边界各写一遍 `logger.error`，各自决定哪些错误不用报，各自拼上下文。Effect 4 给了一个集中的答案：`ErrorReporter`。它把「怎么上报」放进环境里，把「这个错误要不要报、多严重、带什么上下文」放在错误类型自己身上。

先把风险说在前面：`ErrorReporter` 模块以及 `Effect.withErrorReporting` 在 4.0.5 的 JSDoc 里都是 `@stability unstable`。下文的行为我都在 `effect@4.0.5` 上实际跑过，但 API 形状在后续版本可能调整，用在生产前要自己锁版本、读 changelog。

## 三个角色

- 上报器（reporter）：一个收到 `Cause` 后把它送去日志、Sentry 之类外部系统的回调，用 `ErrorReporter.make` 创建。
- 触发点：`Effect.withErrorReporting`、手动的 `ErrorReporter.report(cause)`，以及内置的 HTTP、RPC 服务端边界。
- 错误标注：错误对象上的三个特殊属性，`ErrorReporter.ignore`、`ErrorReporter.severity`、`ErrorReporter.attributes`。

`make` 返回的上报器替你做了几件事：对同一个 cause、同一个错误对象去重；跳过 interrupt；解析标注后才调用你的回调。你的回调拿到的是已经整理好的 `error`（统一成 `Error`）、`severity`、`attributes`，以及原始的 `cause`、`fiber` 和 `timestamp`。

## 最小示例：标注加上报

先定义三类错误：一个预期内不必上报的，一个要标成 Warn 并带订单号的，再加一个普通的 defect：

```ts
import { Data, Effect, ErrorReporter } from "effect"

export class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {
  readonly [ErrorReporter.ignore] = true
}

export class PaymentDeclined extends Data.TaggedError("PaymentDeclined")<{ readonly orderId: string }> {
  readonly [ErrorReporter.severity] = "Warn" as const
  readonly [ErrorReporter.attributes] = { orderId: this.orderId }
  get message() {
    return `payment declined for ${this.orderId}`
  }
}

export const lines: Array<string> = []

export const reporter = ErrorReporter.make(({ error, severity, attributes }) => {
  lines.push(`${severity} ${error.name}: ${error.message} ${JSON.stringify(attributes)}`)
})

export const ReporterLayer = ErrorReporter.layer([reporter])

const program = Effect.gen(function*() {
  yield* Effect.fail(new NotFound({ id: "u1" })).pipe(Effect.withErrorReporting, Effect.exit)
  yield* Effect.fail(new PaymentDeclined({ orderId: "o1" })).pipe(Effect.withErrorReporting, Effect.exit)
  yield* Effect.die(new Error("bug")).pipe(Effect.withErrorReporting, Effect.exit)
}).pipe(Effect.provide(ReporterLayer))

await Effect.runPromise(program)
console.log(lines)
```

我跑出来的输出是两行：`Warn PaymentDeclined: payment declined for o1 {"orderId":"o1"}`，以及 `Info Error: bug {}`。`NotFound` 因为标了 `ignore` 完全没有出现。

几点值得注意：

- 标注是错误对象上的**属性**，键是 `ErrorReporter.ignore` 这类常量。`Reportable` 接口被合并进了全局 `Error` 接口，所以写在 `Data.TaggedError`、`Schema.TaggedError` 的子类字段上，类型都能通过。我对两种基类都验证过标注能被正确读取。
- `Effect.withErrorReporting` 的语义是「这个 effect 失败时，把 cause 交给当前所有上报器」，它不改变成功值与错误类型，错误继续向外传播，只是顺带上报。
- 没有 reporter 时它是静默空操作：我不提供 `ErrorReporter.layer` 直接运行，effect 照常失败，没有任何副作用，也不会报错。所以不要指望忘了装上报器时有提示。

### 一个小坑：TaggedError 的 message 默认是空串

在上面的输出里能看到我给 `PaymentDeclined` 定义了 `message` getter。不定义会怎样？`Data.TaggedError` 的 `message` 默认是空字符串，上报器收到的 `error.message` 就是空的，监控面板里只能看到 `error.name`。我测过，空消息是真实现象。给需要上报的错误类补一个 `message` getter，成本很低。

## defectsOnly：只在有 defect 时上报

`Effect.withErrorReporting({ defectsOnly: true })` 用来表达「预期内的失败别报，只报 bug」。先说我验证出的真实语义：它是 **cause 级** 的开关，而不是逐条过滤。

```ts
import { Cause, Data, Effect, ErrorReporter } from "effect"

class Typed extends Data.TaggedError("Typed")<{ readonly code: number }> {
  get message() {
    return `code ${this.code}`
  }
}

const collect = async (options: { readonly defectsOnly: boolean }, effect: Effect.Effect<never, unknown>) => {
  const seen: Array<string> = []
  const reporter = ErrorReporter.make(({ error }) => { seen.push(error.message) })
  await Effect.runPromiseExit(
    effect.pipe(Effect.withErrorReporting(options), Effect.provide(ErrorReporter.layer([reporter])))
  )
  return seen
}

const failOnly = Effect.fail(new Typed({ code: 1 }))
const dieOnly = Effect.die(new Error("bug"))
const mixed = Effect.failCause(Cause.combine(Cause.fail(new Typed({ code: 1 })), Cause.die(new Error("bug"))))

console.log("fail", await collect({ defectsOnly: true }, failOnly))
console.log("die", await collect({ defectsOnly: true }, dieOnly))
console.log("mixed", await collect({ defectsOnly: true }, mixed))
```

输出：纯失败上报 `[]`，纯 defect 上报 `['bug']`，混合 cause 上报 `['code 1', 'bug']`。

最后一行是要点：只要 cause 里**含有任何一个 defect**，整条 cause 的所有原因都会上报，包括里面那个本来「预期内」的 `Typed` 失败。`defectsOnly` 的判断条件是「这条 cause 有没有 defect」，不是「逐个原因是不是 defect」。并发场景里一条 cause 常常混着多个原因，别把它理解成精确过滤。

想精确地让某类错误永远不报，用 `ErrorReporter.ignore` 标注，它是逐个错误对象生效的。

## 内置边界也会走它

重点是：你不用在每个 handler 里手写 `withErrorReporting`，服务端边界已经替你接好了。官方 JSDoc 写明 HTTP 与 RPC 服务端模块会触发上报。我实际验证了 HTTP 这一侧：

```ts
import { Effect, ErrorReporter, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

const seen: Array<string> = []
const reporter = ErrorReporter.make(({ error, severity }) => {
  seen.push(`${severity} ${error.message}`)
})
const Reporters = ErrorReporter.layer([reporter])

const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/ok", Effect.succeed(HttpServerResponse.text("ok"))),
  HttpRouter.add("GET", "/boom", Effect.die(new Error("db exploded")))
)

const probe = async (label: string, app: Layer.Layer<never, never, HttpRouter.HttpRouter>) => {
  const { handler, dispose } = HttpRouter.toWebHandler(app)
  for (const path of ["/ok", "/boom", "/missing"]) {
    seen.length = 0
    const res = await handler(new Request(`http://localhost${path}`))
    console.log(label, path, res.status, seen)
  }
  await dispose()
}

// 与路由并列合并：请求纤程能读到 reporter
await probe("merge", Layer.merge(Routes, Reporters))
// 用 provide 喂给路由：reporter 没有进入请求纤程
await probe("provide", Routes.pipe(Layer.provide(Reporters)))
```

输出里有三个结论：

- `/ok` 不上报；`/boom` 返回 500，同时上报一条 `Info db exploded`；`/missing` 返回 404，不上报。404 不上报是因为路由未命中的错误自带 `ignore` 标注，我在源码里看到它，行为也跑出来了。
- `effect/http-api` 里内置的 `HttpApiError.NotFound`、`BadRequest`、`Unauthorized`、`Forbidden`、`Conflict` 等在源码里都标了 `ignore`，而 `InternalServerError` 没有。我用 `ErrorReporter.isIgnored` 实际检查了 `NotFound` 和 `InternalServerError`，结果分别是 `true` 和 `false`，其余几个只读了源码。这就是官方给的示范：预期的 4xx 不上报，真正的服务端错误才上报。
- 同一个 reporter layer，用 `Layer.merge` 和路由并列时能收到上报，用 `Layer.provide` 喂给路由时却一条都没有。我没有深挖内部机制，只确认了这个现象：reporter 需要出现在 HTTP 服务最终装配的 layer 输出里。排查「上报没生效」时先看这里。

RPC 服务端的上报在源码里同样走了内部的 `reportCauseUnsafe`（在一次响应失败、响应编码失败时触发），但我没有写 RPC 的运行验证，这一点只是读源码得出的，请当作未验证。

## 默认 severity 陷阱：defect 也是 Info

这是我认为最容易踩到的一点。`ErrorReporter.make` 解析 severity 的规则：错误对象有合法的 `[ErrorReporter.severity]` 就用它，否则一律是 `"Info"`。**没有「defect 默认更严重」这回事。**

我跑过：`Effect.die(new Error("bug"))`、`Effect.die(new Boom())`、`Effect.fail(new Error("x"))` 的 severity 全是 `Info`。更糟的是，如果失败值或 defect 是字符串之类的非对象，它既不能被标注，severity 也恒为 `Info`、attributes 恒为空。

后果很直接：把回调里的 severity 原样转成日志级别，数据库连接炸了的 500 会以 info 级别出现，淹没在日常日志里。

最小修复放在上报器里，用 cause 自己判断。这是我的取舍，不是官方推荐写法：

```ts
import { Cause, Effect, ErrorReporter } from "effect"

const lines: Array<string> = []

// 默认 severity 全是 Info；用 cause 里是否有 defect 自行升级
const reporter = ErrorReporter.make(({ error, severity, cause }) => {
  const effective = severity === "Info" && Cause.hasDies(cause) ? "Error" : severity
  lines.push(`${effective} ${error.message}`)
})

const program = Effect.die(new Error("db exploded")).pipe(
  Effect.withErrorReporting,
  Effect.exit,
  Effect.provide(ErrorReporter.layer([reporter]))
)

await Effect.runPromise(program)
console.log(lines)
```

输出 `[ 'Error db exploded' ]`。这个办法有局限：回调拿到的是整条 cause，混合 cause 里的预期失败也会被一起升级，因为你无法从回调参数里分辨某个 `error` 对应 cause 里的哪一条。如果需要精确，就给自己的预期错误类显式标 `severity`，并让 defect 才走默认值，再按「有标注就信标注，没标注才看 cause」判断。

## 手动上报与去重

「错误恢复了，但仍想让监控看到」时手动上报：

```ts
import { Effect, ErrorReporter } from "effect"

const manual: Array<string> = []
const reporter = ErrorReporter.make(({ error }) => { manual.push(error.message) })

const recovered = Effect.fail(new Error("flaky upstream")).pipe(
  Effect.catchCause((cause) => ErrorReporter.report(cause).pipe(Effect.as("fallback"))),
  Effect.provide(ErrorReporter.layer([reporter]))
)

console.log(await Effect.runPromise(recovered), manual)
```

输出 `fallback [ 'flaky upstream' ]`：成功值是兜底，错误仍被报告过一次。`ErrorReporter.report` 返回 `Effect<void>`，不会让当前纤程失败。

去重行为我也实测了：给同一个 effect 套两层 `withErrorReporting`，上报器只收到一条，因为 `make` 返回的上报器按 cause 与错误对象身份去重。注意这个去重集合挂在**上报器实例**上：同一个错误对象被同一个上报器第二次看到，不会再次触发回调。这在「重试同一个预先创建的错误值」时容易让人困惑。

## layer 的两个细节

- `ErrorReporter.layer([...])` 默认**替换**纤程里已有的上报器集合，传 `{ mergeWithExisting: true }` 才是追加。我试过嵌套两种顺序：内层用追加、外层是基础 reporter 时两者都收到；顺序反过来则只剩内层写入的那一个。多层装配时容易看漏。
- 数组里除了现成的 `ErrorReporter`，也可以放 `Effect<ErrorReporter>`，在 layer 构建时执行，适合需要先初始化客户端的场景。我没有运行验证这一条，只读了类型签名。

## 怎么用才稳

- 把 `ErrorReporter.layer` 放在应用最外层的 layer 里，不要在局部 `provide`，否则内置边界读不到。
- 给「预期内且无需关注」的错误标 `ignore`：404、校验失败、未登录。
- 给「预期内但值得关注」的错误标 `severity` 与 `attributes`：支付失败、第三方限流。
- 给要上报的错误类补 `message` getter。
- 上报器的回调里自己决定 severity 与 defect 的映射，不要直接信默认值。
- 不要用 `defectsOnly` 代替 `ignore`，它按 cause 整体判断。

## 小结

`ErrorReporter` 把「怎么上报」做成环境里的可插拔服务，把「报不报、多严重、带什么上下文」放在错误对象的三个标注上；`Effect.withErrorReporting` 与 HTTP、RPC 边界负责触发。三个必须记住的现实：默认 severity 一律是 `Info`，defect 也不例外；`defectsOnly` 是 cause 级而不是逐条过滤；reporter 要出现在最终装配的 layer 里，边界才读得到。再加上它整体是 unstable，建议封装一层自己的上报器工厂，把版本变化挡在一个文件里。
