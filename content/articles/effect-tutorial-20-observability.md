---
title: "可观测性：日志、span、指标，先想清楚观测什么"
description: Effect 把日志、tracing 和指标都做成内置能力，函数加一层包装就能产生 span。但工具不会替你决定该看什么。本章先讲三种信号各自回答什么问题，再讲怎么在代码里挂上去、怎么导出，以及常见的滥用方式。
date: 2026-10-19
category: effect
chapter: 20
tags: [effect, tutorial, observability]
---

上一章把程序放进了宿主。程序现在在线上跑，你看不见它。这一章讨论怎么让它可见。但我想先把顺序摆正：可观测性的难点不在「怎么接入」，而在「观测什么」。

## 要解决的问题

线上出了问题，你需要回答的问题大致是这几类：

- 发生了什么？某个订单为什么没有被处理？
- 慢在哪里？一次请求耗时两秒，时间花在了哪一步？
- 整体情况怎样？错误率是不是在上升？队列积压了多少？

注意这是三种不同的问题，需要三种不同的信号。把它们混在一起，是可观测性做不好的最常见原因。

## 朴素做法为什么不够

朴素做法是 `console.log`。它能回答第一类问题，但有几个结构性缺陷。

- **没有结构**。一行字符串，你只能用 grep 去找，没法按订单号、租户筛选。
- **没有关系**。两行日志之间是不是同一次请求？谁调用了谁？只能靠人眼拼接。并发一多，日志交错，基本无法还原。
- **没有时长**。想知道一步花了多久，得手写 `Date.now()` 相减，写得到处都是，还容易在异常路径上漏掉。
- **没有聚合**。「过去五分钟错误率」不是从日志里 grep 出来的，它是一个数。

另一个朴素做法是「反正都打上」：每个函数入口出口都打日志，每个值都记指标。结果是噪音淹没信号，成本上去了，真正出事时反而更难找。

## Effect 的做法与心智模型

Effect 把三种信号都做成运行时的一等能力，而且它们沿着 fiber 的上下文自动传播。我用一个类比来区分它们：

- **日志**像一本流水账：某个时刻发生了一件事。回答「发生了什么」。
- **span**像一张带计时的调用树：一个操作从开始到结束，里面嵌套着子操作。回答「慢在哪、谁调用了谁」。
- **指标**像仪表盘上的读数：把许多次事件聚合成数字。回答「整体怎样」。

三者互补，不是互相替代。

### 日志：事件加上下文

`Effect.log` 系列函数记录事件，按级别区分：`Effect.logDebug`、`Effect.log`（INFO）、`Effect.logWarning`、`Effect.logError`。关键的是上下文：`Effect.annotateLogs` 给一段 Effect 内部所有日志统一附上键值。因为上下文跟着 fiber 走，你在入口处标注一次租户或请求 id，里面不管调用多深的日志都会带上。

```ts
import { Effect } from "effect"

declare const handleOrder: (id: string) => Effect.Effect<void>

export const processOrder = (orderId: string, tenant: string) =>
  handleOrder(orderId).pipe(
    Effect.annotateLogs({ tenant, orderId })
  )
```

日志写给「事件」。如果你发现自己在日志里写「开始……」「结束……耗时……」，那其实是在手工做 span。

### span：操作的边界和时长

`Effect.withSpan("名字")` 把一段 Effect 包成一个 span：记录开始、结束、耗时，如果里面还有 span，会自动成为它的子 span。第 13 章讲过 fiber 的父子结构，span 的父子关系跟着同一套结构走，所以并发里的子任务也能正确挂在父 span 下。

更常用的方式是 `Effect.fn`。它是定义 effectful 函数的写法，给它一个名字，函数就自带一个同名 span：

```ts
import { Effect } from "effect"

declare const loadOrder: (id: string) => Effect.Effect<{ readonly customerId: string }>
declare const charge: (customerId: string) => Effect.Effect<void>

export const processOrder = Effect.fn("order.process")(function* (orderId: string) {
  const order = yield* loadOrder(orderId)
  yield* Effect.annotateCurrentSpan("order.id", orderId)
  yield* charge(order.customerId)
})
```

这里有两个值得记住的习惯。其一，span 名字是**稳定的、低基数的**，比如 `order.process`，而不是 `order.process.o_12345`；会变化的东西（订单号）放进 attribute，用 `Effect.annotateCurrentSpan` 或 `withSpan` 的 `attributes` 选项。名字被拿去分组，变化的名字等于无法分组。其二，span 应该打在**有意义的边界**上：service 的方法、请求入口、一次外部调用，而不是每个小函数。

### 指标：聚合的数字

`Metric` 提供几类基本形态：`Metric.counter`（只增的计数）、`Metric.gauge`（当前值）、`Metric.histogram`（分布，比如延迟）。v4 里统一用 `Metric.update(metric, value)` 去更新：counter 累加，gauge 覆盖，histogram 记入对应的桶。

```ts
import { Duration, Effect, Metric } from "effect"

const ordersFailed = Metric.counter("orders.failed", {
  description: "Orders that ended in failure"
})
const orderLatency = Metric.histogram("orders.latency_ms", {
  description: "Order processing latency",
  boundaries: Metric.exponentialBoundaries({ start: 10, factor: 2, count: 10 })
})

declare const run: (id: string) => Effect.Effect<void, Error>

export const instrumented = (id: string) =>
  Effect.gen(function* () {
    const [elapsed] = yield* Effect.timed(run(id))
    yield* Metric.update(orderLatency, Duration.toMillis(elapsed))
  }).pipe(Effect.tapError(() => Metric.update(ordersFailed, 1)))
```

示意代码的重点不在细节，而在选择：我们记录的是「失败了多少次」和「成功请求的耗时分布」，这两个数字能直接画成告警线。指标要小心**基数**：attribute 的取值组合会各自成为一条时间序列。把用户 id、订单号放进指标标签，序列数会爆炸。指标的标签只放取值有限的维度，比如渠道、结果类型。

### 先想清楚观测什么

回到开头那句话。接入工具之前，先回答这几个问题。

1. **谁会看，看了做什么决定？** 没有人会据此做决定的信号，不要采集。
2. **这个问题属于哪类信号？** 事件用日志，时长和调用关系用 span，趋势和告警用指标。
3. **边界在哪？** 请求入口、外部调用（HTTP、数据库，下一章讲）、后台任务的每一轮，通常就是 span 的位置。
4. **什么绝不能进去？** 密钥、令牌、个人敏感信息。第 11 章讲过 `Redacted`，它在被打印时会隐藏内容；但也别指望它兜底，不要把整个请求体当 attribute 塞进去。

按这四问设计出来的观测数据，数量少、可读、有用。

### 信号怎么出去：导出是一个 Layer

代码里的 span、日志、指标，默认只存在于进程内。要送到外部系统，需要提供一个 sink，而它就是普通的 Layer（第 10 章）。`effect/observability` 内置了 OTLP 导出：`OtlpTracer`、`OtlpLogger`、`OtlpMetrics`，它们需要序列化和 HTTP 客户端两个依赖。

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability"

const resource = { serviceName: "checkout", serviceVersion: "1.0.0" }

export const ObservabilityLive = Layer.merge(
  OtlpTracer.layer({ url: "http://collector:4318/v1/traces", resource }),
  OtlpLogger.layer({ url: "http://collector:4318/v1/logs", resource })
).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
)
```

把它合并进你应用的主 Layer 就行。几个事实值得知道：

- 导出是显式的。没有提供这个 Layer，就没有任何东西被导出；业务代码一行都不用改。这正是「观测」和「业务」分离的好处，也让测试可以不接任何 sink。
- 已经有 OpenTelemetry 生态的项目，可以用 `@effect/opentelemetry` 对接现有 SDK；全新项目不一定需要它。
- 自定义日志格式用 `Logger.make` 构造 logger，再用 `Logger.layer` 安装。`Logger.layer` 默认是替换现有 logger，想保留原有的要显式合并。

## 常见误区

- **用日志手写计时**。「开始」「结束」两行日志加手工时间差，本质是一个 span，用 `withSpan` 或 `Effect.fn`。
- **span 名字里带变量**。名字拿来分组，动态值放 attribute。
- **指标标签用高基数值**。用户 id、订单号、URL 全路径，都不该是标签。
- **到处加 span**。每个小函数都加 span，调用树变得巨大且没有信息量。只在有意义的边界加。
- **把 Effect.fnUntraced 当默认**。它是去掉 span 的变体，适合热路径或内部小函数，不要拿它做公共边界函数的默认写法，否则边界的可观测性就没了。
- **把整个对象或密钥丢进日志**。结构化日志让「顺手打印」更容易，也更容易泄漏。
- **指望可观测性代替错误设计**。观测是事后看的，错误是否被正确处理，仍然是第 5、6 章的事。

## 小结

日志回答「发生了什么」，span 回答「慢在哪、谁调用了谁」，指标回答「整体怎样」。Effect 让三者随 fiber 上下文自动传播，让导出成为一个 Layer，业务代码保持不变。真正需要人来做的判断，是选哪些边界、记哪些维度、不记什么。

可观测性最有价值的位置，是程序和外部世界打交道的地方：HTTP 调用、数据库查询、RPC。下一章就讲这些外部调用的共同形状。

## 延伸阅读

- [Effect 可观测性：Effect.fn 命名、Metric 基数与错误上报的边界](/articles/effect-observability)
- [Effect ErrorReporter：统一上报 Cause，用标注控制 ignore、severity 与 attributes](/articles/effect-error-reporter)
- [Effect.fn 进阶：span 选项、后处理参数，以及 fnUntraced 与 fnUntracedEager](/articles/effect-fn-advanced)
