---
title: "Effect 可观测性：Effect.fn 命名、Metric 基数与错误上报的边界"
description: 可观测性不是多打点，而是决定哪些事实进 span、哪些进日志、哪些进 Metric。本文讲 Effect.fn 命名约定、Metric 的基数纪律、OTLP 导出与 ErrorReporter，并给出可运行的 span 断言写法。
date: 2026-10-12
tags: [effect, observability, tracing, metrics]
category: effect
---

上一篇[运行时边界与测试](/articles/effect-runtime-boundaries-and-testing)里，我只用几行代码介绍了 `Effect.withSpan` 和 `Effect.annotateLogs`，证明 tracing 是内置的。这一篇回答更难的问题：**打什么、不打什么、放在哪一层**。

API 已经够用，真正的难点是纪律。打点打多了，是噪音加成本；打错了地方，是高基数把指标后端拖垮；该上报的没上报，是出事后才发现没有证据。

下面所有代码都在 strict 与 `exactOptionalPropertyTypes` 下编译通过，涉及运行时行为的结论也都实际跑过。

## 不变量：一个事实只属于一种信号

我把三种信号的分工压成一句话：

- **span** 回答「这一次请求里发生了什么」，可以带高基数属性（订单号、用户 id）。
- **Metric** 回答「整体上有多少、多快」，标签必须低基数。
- **log** 回答「这个时刻发生了一件值得记住的离散事件」，是 span 的补充，不是 span 的替代。

违反这条分工，症状很固定：把 `user_id` 做成 Metric 标签，指标序列数随用户数线性增长；把每一次循环迭代都 `Effect.log`，真正的告警被淹没；只有日志没有 span，排查一个跨服务请求只能靠 grep 时间戳。

判断一个事实该进哪里，只问两个问题：它的取值集合有界吗？有界才可能进 Metric。它需要和一次具体请求关联吗？需要就进 span。

## Effect.fn：让命名成为函数的一部分

span 的价值首先来自名字。靠手写 `Effect.withSpan("...")` 贴在调用点，名字会和函数脱节，改了函数忘了改名字。`Effect.fn("name")` 把名字和函数定义绑在一起：

```ts
// charge.ts
import { Effect } from "effect"

class ChargeError extends Error {
  readonly _tag = "ChargeError"
}

export const charge = Effect.fn("Billing.charge")(function* (orderId: string, cents: number) {
  yield* Effect.annotateCurrentSpan({ "order.id": orderId })
  yield* Effect.annotateCurrentSpan("order.amount_cents", cents)
  yield* Effect.sleep("1 millis")
  if (cents > 1000) return yield* Effect.fail(new ChargeError("too big"))
  return cents
})
```

我的约定是 `模块.动作`，比如 `Billing.charge`、`Orders.place`。名字是低基数的稳定标识，会成为 trace 后端里聚合和告警的 key，所以绝不能把 id 拼进名字。变化的部分放属性。

有一个细节要纠正。我沉淀的旧资料里写着 `Effect.fn` 会自动把参数作为 attribute，我在 4.0.5 上实际记录 span 后确认**并没有**：上面的 span 只有我手动 `annotateCurrentSpan` 的两个属性。这是好事，自动记录参数会把请求体、令牌之类的敏感数据悄悄送进 trace 后端。属性必须是显式的、经过挑选的。

`Effect.fn` 还接受第二个参数，直接声明 span 选项：

```ts
import { Effect } from "effect"

export const place = Effect.fn("Orders.place", {
  attributes: { "app.feature": "checkout" },
  kind: "server"
})(function* (orderId: string) {
  yield* Effect.annotateCurrentSpan("order.id", orderId)
})
```

`Effect.fnUntraced` 是不创建 span 的版本。我的规则是：**公共边界一律 `Effect.fn`，只有外层已经有 span 的热路径内部 helper 才用 `fnUntraced`**。把它当默认选择，等于在最需要可见性的边界上主动关灯。

### span 会如实记录失败

我用一个自定义 Tracer 记录 span，验证结论而不是凭印象：

```ts
import { Effect, Exit, Tracer } from "effect"
import { charge } from "./charge.ts"

const recorded: Array<Tracer.NativeSpan> = []
const recordingTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    recorded.push(span)
    return span
  }
})

const run = Effect.gen(function* () {
  yield* charge("o1", 10)
  yield* Effect.exit(charge("o2", 5000))
}).pipe(Effect.withTracer(recordingTracer))

await Effect.runPromise(run)

for (const span of recorded) {
  const outcome = span.status._tag === "Ended" && Exit.isFailure(span.status.exit) ? "failed" : "ok"
  console.log(span.name, Object.fromEntries(span.attributes), outcome)
}
```

运行结果里，第一个 span 是成功，第二个 span 的 exit 是 `Fail`，原因也被保留在 span 上。也就是说，你不需要为了「让 trace 里看到失败」而在 `catchTag` 里再手动打日志；failure 会随 span 的 exit 自然带出，这是前面讲 typed errors 时那条「错误是值」的直接红利。

这段代码同时就是**断言 span 的测试写法**。旧资料里的 `TestServices.spans` 在 4.0.5 里并不存在，正确做法就是用 `Tracer.make` 自己造一个记录型 Tracer，再用 `Effect.withTracer` 注入。它不依赖任何导出包，测试里零成本。

## 日志：只记离散事件，结构化优先

日志要克制。我对日志的判断标准是：**去掉它，事后能不能从 span 和 Metric 还原出来**。能还原的就不该打。

日志的三个工具是 `Effect.log*`、`Effect.annotateLogs` 和 `Effect.withLogSpan`。注解对整段 effect 内的所有日志生效，所以请求级字段在入口加一次：

```ts
import { Effect, Logger, References } from "effect"

const lines: Array<unknown> = []
const capture = Logger.make<unknown, void>((options) => {
  lines.push({
    level: options.logLevel,
    message: options.message,
    annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    spans: options.fiber.getRef(References.CurrentLogSpans).map((s) => s[0])
  })
})

const handler = Effect.fn("Orders.handle")(function* (id: string) {
  yield* Effect.logInfo("start", { id })
  yield* Effect.logDebug("not emitted at the default Info level")
  return id
})

await Effect.runPromise(
  handler("o1").pipe(
    Effect.annotateLogs({ tenant: "acme" }),
    Effect.withLogSpan("handle"),
    Effect.provide(Logger.layer([capture]))
  )
)
console.log(JSON.stringify(lines))
```

输出只有一条 Info 日志，注解里带着 `tenant`，log span 里带着 `handle`，Debug 那条被默认的最低级别过滤掉。这里有两处和 v3 不同：自定义 logger 用 `Logger.layer([...])` 安装，不再是 `Logger.replace(Logger.defaultLogger, ...)`；最低级别用 `References.MinimumLogLevel` 控制，生产里提到 `Warn` 只需要 `Layer.succeed(References.MinimumLogLevel, "Warn")`。

输出格式的选择很实在：开发环境用默认的可读格式，生产用 `Logger.consoleJson`，一行一条 JSON，让日志平台按字段检索，而不是用正则去解析一句话。

## Metric：基数是第一约束

v4 的 Metric 有 `counter`、`gauge`、`histogram`、`timer`、`frequency`、`summary`。先看一个最常见的组合，请求计数加耗时分布：

```ts
import { Effect, Metric } from "effect"

const latency = Metric.timer("checkout_latency")
const failures = Metric.counter("checkout_failures_total", { incremental: true })

export const instrument = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.trackDuration(latency),
    Effect.trackErrors(Metric.withConstantInput(failures, 1))
  )

const place = instrument(Effect.fail("nope"))
await Effect.runPromise(Effect.exit(place))
console.log((await Effect.runPromise(Metric.value(latency))).count)
console.log(await Effect.runPromise(Metric.value(failures)))
```

这里有几个我实际踩验证出来的点：

- 失败的执行**也会**被 `trackDuration` 记录，计数是 1。如果换成手写的 `Effect.timed` 再 `tap` 去更新 histogram，失败路径会被直接跳过，延迟分布只剩成功样本，p99 会好看得失真。优先用 `trackDuration`。
- `trackErrors` 会把错误值本身当作 Metric 的输入，所以直接传一个 `Counter<number>` 类型不通过。用 `Metric.withConstantInput(failures, 1)` 把输入固定为 1。
- v3 的 `Metric.increment` 和 `Metric.boundaries.exponential` 在 4.0.5 里都不存在，对应的是 `Metric.update` 和 `Metric.exponentialBoundaries`。

### 标签的纪律

`Metric.withAttributes` 给指标加维度，**每一种取值组合都是一条独立序列**：

```ts
import { Effect, Metric } from "effect"

const requests = Metric.counter("orders_requests_total", { incremental: true })

const okRequests = Metric.withAttributes(requests, { route: "POST /orders", outcome: "ok" })

await Effect.runPromise(
  Effect.gen(function* () {
    yield* Metric.update(okRequests, 1)
    yield* Metric.update(requests, 1)
    const snapshot = yield* Metric.snapshot
    console.log(snapshot.map((m) => `${m.id}${JSON.stringify(m.attributes ?? {})}`))
  })
)
```

快照里带标签的序列和不带标签的序列是**两条**，互不累加：上面对 `okRequests` 的更新不会出现在 `requests` 的计数里。这是排查「为什么总数对不上」时的第一个怀疑对象。

我的标签准入标准：取值来自编译期可枚举的集合。`route` 用路由模板而不是实际 URL，`outcome` 用 `ok`、`error` 这类有限枚举，错误类型用 `_tag`。订单号、用户 id、租户 id 一律不进 Metric，放 span 属性。

至于 `gauge`，它表示「当前值」，每次 `update` 会替换而不是累加。把它用来统计在途请求数时，增减必须成对出现在 `acquireRelease` 或 `ensuring` 里，否则一次中断就会让读数永久漂移。

## 导出：核心包够用，@effect/opentelemetry 是桥

没有外部 sink 的应用，什么都不需要装，日志和 span 已经在运行。需要导出时有两条路。

第一条是核心包自带的 OTLP 模块 `effect/observability`，不引入任何 OpenTelemetry SDK：

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"

export const TracingLive = OtlpTracer.layer({
  url: "http://localhost:4318/v1/traces",
  resource: { serviceName: "orders-api", serviceVersion: "1.0.0" }
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
)
```

我在本地起了一个只接收 POST 的 HTTP 服务，确认这个 Layer 被释放时会把 span 以 JSON 发往 `/v1/traces`。同一个模块里还有 `OtlpLogger`、`OtlpMetrics` 和 `PrometheusMetrics`。

第二条是 `@effect/opentelemetry`，当你已经有 OpenTelemetry SDK 生态（采样器、自动埋点、现成 exporter）时用它。4.0.5 版本与核心包同号，并且不是单包闭环，需要同时安装 `@opentelemetry/*` 的 peer 依赖。配置对象也和旧资料不同：`resource` 是普通对象而不是 `new Resource(...)`。

```ts
import { NodeSdk } from "@effect/opentelemetry"
import { SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base"

declare const exporter: SpanExporter

export const OtelLive = NodeSdk.layer(() => ({
  resource: {
    serviceName: "orders-api",
    serviceVersion: "1.0.0",
    attributes: { "deployment.environment": "staging" }
  },
  spanProcessor: new SimpleSpanProcessor(exporter)
}))
```

生产环境把 `SimpleSpanProcessor` 换成 `BatchSpanProcessor` 并接 OTLP exporter。我用一个收集型 exporter 跑过：嵌套的两个 `Effect.fn` 在 SDK 里确实形成父子关系，服务名也带上了。

两条路共同的规则是：**导出是 Layer，只在入口装配**。业务代码里不应该出现 `@opentelemetry/api` 的 import，也不应该出现 DSN 或 endpoint。换导出后端只改一个 Layer。

## 少打点：该关的要关

span 有成本，且大部分流量没有排查价值。三个工具：

- `Effect.withTracerEnabled(false)` 对一段 effect 完全不创建 span。我验证过，被包住的 `Effect.fn` 不会出现在 Tracer 收到的 span 列表里。
- span 的 `level` 选项配合 `References.MinimumTraceLevel`：低于最低级别的 span 仍会被创建，但 `sampled` 为 `false`，不会被导出。这适合把调试级的细粒度 span 留在代码里，生产默认不采。
- HTTP 客户端有 `HttpClient.TracerDisabledWhen` 这个 Reference，用谓词按请求排除，比如健康检查：

```ts
import { Layer } from "effect"
import { HttpClient } from "effect/http"

export const NoHealthTrace = Layer.succeed(HttpClient.TracerDisabledWhen)(
  (req) => req.url.endsWith("/healthz")
)
```

另有一个边界：循环体内部不要为每次迭代开 span。一次批处理一个 span，条数、失败数作为属性，而不是 N 个子 span。

## 错误上报：Cause 不是 incident

可观测性最容易搞混的是「出错」和「出事」。typed errors 那一篇已经区分了 failure 与 defect：`Fail` 是预期的控制流，`Die` 才是 bug。上报策略要延续这个区分，而不是把所有 `Effect.fail` 都推给告警平台。

4.0.5 的核心包有 `ErrorReporter`。它在边界处接收 `Cause`，自动去重、跳过中断，并读取错误对象上的三个标注：忽略、严重度、属性。

```ts
import { Data, Effect, ErrorReporter } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: string }> {
  readonly [ErrorReporter.ignore] = true
}

class ChargeFailed extends Data.TaggedError("ChargeFailed")<{ readonly orderId: string }> {
  readonly [ErrorReporter.severity] = "Error" as const
  readonly [ErrorReporter.attributes] = { "order.id": this.orderId }
}

const seen: Array<string> = []
const reporter = ErrorReporter.make(({ error, severity, attributes }) => {
  seen.push(`${error.name}|${severity}|${JSON.stringify(attributes)}`)
})

const run = (e: Effect.Effect<never, unknown>) =>
  Effect.runPromise(
    e.pipe(Effect.withErrorReporting, Effect.provide(ErrorReporter.layer([reporter])), Effect.exit)
  )

await run(Effect.fail(new NotFound({ id: "1" })))
await run(Effect.fail(new ChargeFailed({ orderId: "o1" })))
await run(Effect.die(new Error("bug")))
await run(Effect.interrupt)
console.log(seen)
```

实际输出只有两条：`ChargeFailed` 以 `Error` 级别带着 `order.id` 上报；裸的 `Error("bug")` 作为 defect 上报，但严重度是默认的 `Info`。`NotFound` 因为标注了忽略而被丢弃，中断则被框架自动跳过。

有一个值得警惕的默认值：**没有标注严重度的 defect 并不是 `Error` 级**。如果你的告警规则按严重度过滤，未标注的 defect 会悄悄滑过去。要么在 reporter 回调里对 defect 统一升级，要么给领域错误显式标注。

我对 reporter 的边界要求有四条：

- 指纹用稳定的错误 `_tag` 加操作名，不用 `Cause.pretty` 或带动态内容的 message，否则同一个问题会裂成无数条。
- 投递与业务结果隔离。上报失败、超时都不能让请求失败，所以回调里只做入队，真正的网络调用放到异步批量里。
- 脱敏发生在 reporter 之前或之内：Authorization、cookie、令牌、请求体不进属性。
- 供应商 SDK 只出现在 reporter 的实现里，领域层只看见 `ErrorReporter` 这个抽象。

## 小结

可观测性的设计，核心是让每个事实落在唯一正确的信号里：

- 有界取值的聚合进 Metric，高基数、与请求绑定的进 span 属性，离散事件进结构化日志。
- 公共边界一律 `Effect.fn("模块.动作")`，名字稳定低基数，属性显式挑选；`fnUntraced` 只留给热路径内部。
- 延迟用 `trackDuration`，因为它连失败样本一起记录；Metric 标签必须来自可枚举集合。
- 导出是入口处的 Layer：核心包 OTLP 零依赖，已有 OpenTelemetry 生态再用 `@effect/opentelemetry`。
- 用 `Tracer.make` 造记录型 Tracer 做 span 断言，用 `ErrorReporter` 把 `Cause` 变成可行动的事件，并显式处理 defect 的严重度。

下一步，当一个流程长到要跨进程重启、需要补偿与幂等时，可观测性就要和持久化执行结合起来，这是 Workflow 那一篇的主题。
