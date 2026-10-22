---
title: "请求生命周期：fetch、ctx.waitUntil，以及 CPU 时间与墙钟时间"
description: 讲清 Workers 的 handler 种类、响应返回之后能做什么与 ctx.waitUntil 的真实语义、CPU 时间和墙钟时间的区别与限额口径，以及 request.signal 的取消与超时处理。
date: 2026-10-22
tags: [cloudflare, tutorial, workers]
category: cloudflare
chapter: 2
---

> 限额与行为以 2026-10 官方文档为准，会变化。标注「来自官方文档，未实测」的内容没有在本地复现；标注「本地实测」的内容在 wrangler dev（workerd，wrangler 4.151.3）上跑过。本地不会执行 CPU 限额，也不模拟线上的驱逐与取消时机。

## 问题：响应发出去之后，代码还活着吗

典型场景：接口处理完业务，要顺手写一条分析日志、刷新缓存、发个 webhook。朴素做法一是在响应前 `await` 完，用户为无关紧要的工作多等；做法二是不 `await`，让 Promise 在后台跑，像常驻 Node 进程那样。

做法二在 Workers 上不安全。没有常驻进程（见 [Workers 到底是什么](/articles/cloudflare-workers-model)），调用结束后运行时可以不再给你的代码执行机会。要回答两个问题：这次调用何时算「结束」，结束之前能占多少资源。

## Handler：入口集合

ES module Worker 默认导出一个对象，不同触发源对应不同 handler。官方 Handlers 页列出 fetch、scheduled、queue、email、tail、alarm、connect 等（来自官方文档，未实测）。最常用的三个：

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("ok");
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(controller.cron, new Date(controller.scheduledTime).toISOString());
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) msg.ack();
  },
} satisfies ExportedHandler<Env>;
```

形状都是 `(事件, env, ctx)`，`env` 是绑定（见 [wrangler 与绑定](/articles/cloudflare-wrangler-and-bindings)）。区别在「何时结束」的判定（来自官方文档，未实测）：

- **fetch**：返回 `Response` 后请求完成，响应体流式发送期间调用保持存活。
- **scheduled**：运行时等待返回的 Promise，最长 15 分钟；第一个失败的 `waitUntil` 会记为这次 Cron 的状态。
- **queue**：默认情况下，`queue()` 返回、其 Promise 与所有 `waitUntil` 的 Promise 都解析后，整批消息才被确认；`queue()` 抛错或其中任一 Promise 被拒绝，整批按消费者重试设置重试。这是 [Queues](/articles/cloudflare-queues) 的语义基础，单条消息的 `ack()`/`retry()` 细节见那篇。

本地调试 scheduled：官方 scheduled handler 页的脚本化路径是向本地开发服务器的 `/cdn-cgi/local/scheduled` 发 HTTP 请求（加 `?format=json` 返回结构化结果），`wrangler dev --test-scheduled` 的参数说明也是暴露这条 `/cdn-cgi/local/scheduled` 路由，用 `cron` 查询参数模拟不同表达式（来自官方文档）；该页还介绍了经 Local Explorer 触发。本地实测（wrangler 4.151.3，`--test-scheduled`，配置了 `* * * * *`）：`/cdn-cgi/local/scheduled?cron=*+*+*+*+*` 返回 `ok` 且 handler 收到该 cron；旧路径 `/cdn-cgi/handler/scheduled` 也仍返回 `ok`（不带 `cron` 时 `controller.cron` 为空字符串）。新代码和文档里一律用官方的 `/cdn-cgi/local/scheduled`，旧路径只当兼容行为。

## ctx.waitUntil：响应之后的工作

`ctx.waitUntil(promise)` 让运行时在响应发出后继续等这个 Promise：

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(logAnalytics(request, env)); // 响应返回后继续执行
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
```

官方要点（来自官方文档，未实测）：可多次调用，一个拒绝不影响其他；没被 `await` 也没交给 `waitUntil` 的异步工作，调用结束时**可能被取消**（客户端仍在接收响应，包括流式响应体时，调用本身会保持存活，不需要 `waitUntil`）；对 HTTP 触发的 Worker，`waitUntil` 可在响应发出或客户端断开后继续**最多 30 秒**，该时间由同一请求的所有 `waitUntil` 共享，超时未完成的 Promise 被取消并记录警告；更长的工作官方建议发到 Queues。

本地实测：`/wu` 返回响应后，`waitUntil` 内 `sleep(1500)` 之后的日志照常打印；`/nowu` 里同样的 `sleep(1500)` 没交给 `waitUntil`，等 2.5 秒日志从未出现。裸 Promise 在 handler 返回后没有执行完，线上取消时机由平台决定，别依赖偶尔跑完。

### 取舍：waitUntil、Queues、Workflows

- `waitUntil`：尽力而为、远短于 30 秒、丢了可接受的工作，如分析打点、缓存回填。
- [Queues](/articles/cloudflare-queues)：要重试、削峰、与请求解耦的后台任务。`waitUntil` 失败没有重试。
- [Workflows](/articles/cloudflare-workflows)：多步骤、要持久化进度、可能很久的流程。
- 仍要在响应前 `await`：用户要看到结果或结果影响响应的操作（扣款、写主库）。把关键写入放进 `waitUntil` 是典型误用，你无法把失败告诉客户端。

### 另一个容易误用的 ctx 方法

`ctx.passThroughOnException()` 让 Worker「失败放行」：未捕获异常时把请求转给源站，而不是返回错误。官方文档特别说明（来自官方文档，未实测）：如果请求体已经被消费，就无法再次发送；它也不覆盖 CPU 或内存超限。对反向代理场景，更稳妥的做法是自己捕获源站 fetch 的错误并返回明确的 5xx，而不是把兜底交给这个方法。

## CPU 时间与墙钟时间

按官方限额页口径（来自官方文档，未实测）：**CPU time** 是 CPU 真正执行你代码的时间；**wall time** 是一次调用从开始到结束的总经过时间，含等待；等待 `fetch()`、KV 读取、数据库查询**不计入** CPU 时间，但计入 wall time。

一个请求花 2 秒等上游，CPU 时间可能只有几毫秒；反过来，一次同步的大 JSON 解析或加密循环，墙钟很短，CPU 却可能顶到上限。

2026-10 官方限额页的数字（会变化，写代码前请重新核对）：

- HTTP 请求 CPU 时间：Free 10 ms；Paid 默认 30 秒，通过 `limits.cpu_ms` 最多配置到 5 分钟（300000）。
- Cron Trigger CPU 时间：Free 10 ms；Paid 30 秒（间隔小于 1 小时）或 15 分钟（间隔 1 小时及以上）。
- wall-clock：HTTP 请求无限制；Cron、Queue 消费者、DO alarm 为 15 分钟。
- 每 isolate 内存 128 MB；每次调用同时「等待响应头」的外发连接 6 个，第 7 个排队等待其中一个收到响应头；Startup 1 秒；`waitUntil` 响应后最多 30 秒。

超出 CPU 限制时客户端收到 Error 1102（`Worker exceeded resource limits`），分析里对应 `exceededCpu`；Workers Logs 与 Tail/Logpush 可看到每次调用的 CPU 与 wall time（来自官方文档，未实测）。「HTTP 墙钟无限制」不等于连接永远不断，客户端或中间链路可能先断开。

省 CPU 的方向：避免 handler 内大块同步计算；流式处理大响应体而不是整体缓冲再解析；先看 `exceededCpu` 比例，再决定是否提高 `limits.cpu_ms`。

## 超时与取消：request.signal

平台没有替你设「请求总超时」，要自己决定等多久。**对外调用设超时**：

```ts
const res = await fetch("https://api.example.com/slow", {
  signal: AbortSignal.timeout(3000),
});
```

**对内感知客户端断开**用 `request.signal`。官方兼容性标志页的条目是「Enable `Request.signal` for incoming requests」：开启 `enable_request_signal` 后，可以在 `request.signal` 上挂 `abort` 监听，在客户端取消请求时做事；关闭标志是 `disable_request_signal`。该条目没有给出「默认开启」的日期（来自官方文档），所以不要假设它默认就有，显式声明：

```jsonc
{
  "name": "demo",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["enable_request_signal"]
}
```

```ts
export default {
  async fetch(request: Request): Promise<Response> {
    request.signal.addEventListener("abort", () => console.log("client gone"));
    return new Response("ok");
  },
} satisfies ExportedHandler;
```

兼容性标志页另有一个独立条目 `request_signal_passthrough`：设置后，进来的请求的 `AbortSignal` 会在你用 `fetch()` 转发子请求时一并传下去（反向是 `no_request_signal_passthrough`，同样没有标注默认日期）。想让客户端断开时取消上游调用，更直白的做法是自己把 `request.signal` 传给下游 `fetch(url, { signal: request.signal })`。

本地实测（wrangler 4.151.3，`wrangler dev --local`，兼容性日期 2026-10-01，用 `curl -m 1` 在 1 秒后断开）：

- 响应是流式的（`IdentityTransformStream` 持续写出，返回的 `Response` 已经在发送）：加 `enable_request_signal` 时，客户端断开后 `abort` 监听器触发；不加该标志、同一日期，监听器不触发。
- handler 还在 `await sleep` 没有返回 `Response` 时客户端断开：即使加了标志也没有观察到 `abort`，`signal.aborted` 一直是 false，handler 照常跑完。

所以本地能复现的只有「开了标志、响应已经开始发送、客户端断开」这一种情形；线上其他时机（例如响应返回之前）是否触发，官方没有说明，我也无法在本地验证。把 `request.signal` 当作尽力而为的清理钩子，不要让计费或数据一致性依赖它。

## 常见误区

- 把需要可靠完成的工作放进 `waitUntil`：它没有重试，超过 30 秒会被取消。
- 响应快就认为 CPU 够用：CPU 与 wall time 是两个计量。
- 以为 `await fetch()` 的等待消耗 CPU 额度：不消耗，但会拉长 wall time 与客户端等待。
- 在 handler 外悬挂 Promise：本地实测响应返回后没有执行完。
- 以为本地跑通就满足线上限额：本地不执行 CPU 限额。

## 小结

一次调用有明确的结束判定：fetch 看响应与 `waitUntil`，scheduled 与 queue 看返回的 Promise 加 `waitUntil`。响应之后的工作交给 `waitUntil`（短、尽力而为），要可靠就换 Queues 或 Workflows。资源上，CPU 时间只算你的代码在算，I/O 等待算墙钟，具体数字以官方限额页为准。对外设超时，对内把 `request.signal` 当辅助。部署与发布流程见 [部署、版本与回滚](/articles/cloudflare-deploy-and-routing)。

## 延伸阅读

- [Workers 到底是什么：isolate、不是 Node、没有常驻进程](/articles/cloudflare-workers-model)
- [wrangler 与绑定](/articles/cloudflare-wrangler-and-bindings)
- [Queues](/articles/cloudflare-queues)
- [Workflows](/articles/cloudflare-workflows)
