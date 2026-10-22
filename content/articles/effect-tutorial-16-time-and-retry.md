---
title: "时间与重试：Schedule、退避与超时"
description: 外部调用既会慢也会偶发失败。本章讲清 Schedule 为什么是一个可组合的策略值，退避、上限与抖动怎么拼，哪些失败值得重试，以及 timeout 和 retry 谁包着谁。
date: 2026-10-15
tags: [effect, tutorial, schedule, retry, timeout]
category: effect
series: effect-tutorial
seriesOrder: 16
---

前面 15 章基本都在讲「正确的时候怎么写」。这一章讲「慢和偶发失败的时候怎么办」，也就是时间维度上的问题。外部世界有两种最常见的不确定：一次调用可能很久都不回来，一次调用可能这次失败、下次就好了。前者要回答「最多等多久」，后者要回答「要不要再来一次、隔多久、来几次」。

## 朴素做法为什么不够

重试最常见的手写形态是一个 `for` 循环加 `setTimeout`，超时则是 `Promise.race([请求, 定时器])`。它们能跑，但有一串结构性问题：

- 重试的次数、间隔、判断条件混在循环体里，改一个参数要读完整个循环。
- 对所有错误一视同仁：参数校验失败也重试三次，只是白白多等几秒。
- `Promise.race` 的输家并没有被取消。超时之后，那个请求依然在后台跑，占着连接和内存。
- 时间是真实的。想测「第三次重试之前等了多久」，只能真的等，或者到处注入假定时器。

这几条的根源是同一个：**策略（什么时候再来）和动作（要做的事）被写在了一起**。

## Effect 的做法：策略是一个值

Effect 把「什么时候再来一次」抽成一个独立的值，叫 `Schedule`。它不执行任何事情，只回答一个问题：

> 给定这是第 n 次，我还要不要继续？要的话，先等多久？

`Effect.retry`、`Effect.repeat` 是这个值的消费方：它们负责执行动作，向 Schedule 询问是否继续。心智模型是一份「节拍说明书」：说明书本身可以单独写、单独组合、单独检查，再贴到任意一个 Effect 上。这和第 2 章讲的「Effect 是描述而不是执行」同构：Schedule 是对「时间」的描述。

最基本的几个原语：

- `Schedule.recurs(n)`：最多再来 n 次，不等待。
- `Schedule.spaced(d)`：每次间隔固定的 d。
- `Schedule.exponential(base)`：指数退避，间隔按 base、2 倍、4 倍……增长。
- `Schedule.jittered`：给已有策略加随机扰动（每次延迟乘以 0.8 到 1.2 之间的随机系数），避免一批调用方在同一时刻一起重试。

注意 `retry` 的计数：源 Effect 总是先执行一次，Schedule 只管「之后」。所以 `Effect.retry({ times: 3 })` 最多执行四次，而不是三次。

## 组合：把上限、退避、阶段拼起来

单个原语很少够用。生产里想要的通常是「指数退避，但最多五次，并且单次别等太久」。Schedule 的组合子在 v4 里只有几个，语义要记准：

- `Schedule.max([a, b])`：所有子策略都还想继续才继续，延迟取最慢的。适合「退避 AND 次数上限」。
- `Schedule.min([a, b])`：任意一个还想继续就继续，延迟取最快的。适合给延迟封顶：指数退避和 `spaced("10 seconds")` 取 min，等待就不会超过 10 秒。
- `Schedule.concat(a, b)`：先把 a 跑完，再跑 b。适合「前几次快速重试，之后慢下来」。
- `Schedule.upTo({ times, duration })`：给任意策略加次数或总时长的上限，任一到达即停。

下面这段把它们放在一起。用 `Schedule.toStep` 单步驱动可以看到：`exponential("100 millis")` 的前几次延迟是 100、200、400、800 毫秒；和 `recurs(3)` 做 `max` 后，只剩前三次延迟，第四次直接结束。

```ts
import { Effect, Schedule } from "effect"

interface PaymentError { readonly _tag: "PaymentError" }
declare const callPayment: Effect.Effect<string, PaymentError>

export const policy = Schedule.max([
  Schedule.exponential("200 millis"),
  Schedule.recurs(4)
]).pipe(Schedule.jittered)

export const program = callPayment.pipe(Effect.retry({ schedule: policy }))
```

这里没有手写任何循环。想把次数从 4 改到 6，只改一个数字；想换成固定间隔，换一个原语。

## 先分类，再重试

重试不是越多越好。**重试只对「再试一次可能不同」的失败有意义**：网络抖动、限流、下游暂时不可用。对「输入不合法」「资源不存在」「没有权限」重试，只会放大延迟和下游压力。这一点第 6 章讲「重试前先分类」时已经立过立场，这里是它的落地：`Effect.retry` 接受 `while` 或 `until`，在失败的 `E` 上判断。

```ts
import { Effect, Schedule } from "effect"

type FetchError =
  | { readonly _tag: "NetworkError" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "NotFound" }

declare const fetchUser: Effect.Effect<string, FetchError>

export const selective = fetchUser.pipe(
  Effect.retry({
    while: (e) => e._tag === "NetworkError" || e._tag === "RateLimited",
    schedule: Schedule.max([Schedule.exponential("200 millis"), Schedule.recurs(4)])
  })
)
```

两个边界要记住。第一，`retry` 只作用于类型里的失败；缺陷（defect）和中断不会被重试，这是 failure 与 defect 区分（第 5 章）的直接收益。第二，**非幂等的操作要谨慎**：重试「扣款」之前，要先确认下游能用幂等键去重，否则重试可能造成重复扣款。这是业务设计问题，不是 Schedule 能替你解决的。

## 超时：把「等太久」变成一个失败

`Effect.timeout(duration)` 让一个 Effect 在限定时间内没结束就以 `TimeoutError` 失败。它是类型里的失败，会出现在 `E` 里，所以可以被 `catchTag`、被 `retry` 的 `while` 判断。更重要的是：超时赢了之后，源 Effect 会被**中断**，而不是被丢在后台。第 15 章讲过的 finalizer 会被执行，这正是它比 `Promise.race` 可靠的地方。

要不要失败？如果「超时」是正常分支而不是错误，用 `Effect.timeoutOption`，它在超时时返回 `Option.none`。

一个容易被忽略的细节：中断能传到哪里，取决于底层能不能被取消。用 `Effect.tryPromise` 包装 fetch 时，回调会收到一个 `AbortSignal`，把它传给 `fetch`，超时中断才能真正取消网络请求；否则 Effect 这一侧停了，底层请求还在跑。

### timeout 和 retry 谁包着谁

位置决定语义，没有对错，只有你想表达什么：

- `effect.pipe(Effect.timeout("2 seconds"), Effect.retry(...))`：timeout 在里面，限制的是**每一次尝试**。三次尝试最长共等六秒多。
- `effect.pipe(Effect.retry(...), Effect.timeout("5 seconds"))`：timeout 在外面，限制的是**总预算**。不管重试几次，五秒一到整体失败。

面向用户的请求通常想要后者（总预算可预期），后台任务常常想要前者。以内层 timeout 加 `retry({ times: 2 })` 为例，一个必然超时的操作会被执行三次，最终以 `TimeoutError` 失败。

## repeat：成功之后的再来一次

`Effect.repeat` 是 retry 的镜像：retry 在失败后再来，repeat 在成功后再来。轮询、心跳、定时任务都是它：

```ts
import { Effect, Schedule } from "effect"

declare const checkJob: Effect.Effect<{ readonly done: boolean }>

export const poll = checkJob.pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (r) => r.done
  })
)
```

同一个 Schedule 值既能喂给 retry 也能喂给 repeat，这就是「策略与动作分离」的回报。后台常驻的轮询通常还要放进某个 Scope 里（第 15 章），随着 Scope 关闭而被中断。

## 常见误区

- **无界重试**。只写 `Schedule.exponential(...)` 而不配 `recurs` 或 `upTo`，在下游长时间故障时会无限重试下去。重试一定要有上限，次数或总时长至少一个。
- **只退避不抖动**。多个调用方同时失败、按同样的节奏重试，会在同一时刻再次冲击下游。面向共享下游或批量任务时，应加 `Schedule.jittered`；本地测试或确实要求精确节拍的场景可以不加。
- **重试一切**。不看错误类型的重试是在掩盖 bug。
- **以为 timeout 总是能取消底层**。见上文，取消是否有效取决于底层是否接了 `AbortSignal`。
- **在测试里真的等**。Schedule 的延迟全部由 Clock 服务决定，第 12 章的 TestClock 可以直接推进虚拟时间，不需要真等。

## 小结

时间是一种需要被「描述」的东西：Schedule 描述节拍，`retry` 和 `repeat` 消费它，`timeout` 给等待加边界。把策略写成值，就能组合、修改、测试它，而不是改循环体。下一章我们换一个维度：数据不是一次到齐，而是源源不断地来，这就是 Stream 的场景。

## 延伸阅读

- [Effect 重试与 Schedule：退避、抖动、repeat、超时与限流](/articles/effect-retry-and-schedule)
- [Effect 限流：RateLimiter](/articles/effect-rate-limiter)
- [Effect 的错误类型](/articles/effect-typed-errors)
