---
title: "Effect.fn 进阶：span 选项、后处理参数，以及 fnUntraced 与 fnUntracedEager"
description: 拆开 Effect.fn 的三种形态：span 的 attributes 与 kind、Effect.fn.Return、后处理参数为何取代 .pipe，以及库代码和热路径怎么选 fnUntraced 与 fnUntracedEager。
date: 2026-10-22
tags: [effect, effect-advanced, effect-fn, tracing]
category: effect
---

`Effect.fn` 在基础篇里通常只出现一次：`Effect.fn("name")(function* () {...})`，当作「带名字的 `Effect.gen` 函数」。但它其实有三个互相独立的能力：给函数体生成 span、在失败时补充调用点栈信息、接收一串后处理函数。把这三件事分清楚，你才知道什么时候该用 `Effect.fn`，什么时候该换成 `Effect.fnUntraced`。

这篇的所有输出都在 effect 4.0.5 上实际跑过。三个函数都属于 stable API。入门用法见 [Effect 基础](/articles/effect-why-and-basics)，span 的导出与 tracer 配置见 [可观测性](/articles/effect-observability)，这里只讲函数本身。

## 三种形态到底差在哪

先用一段代码把差别摊开。`spanInfo` 读取当前 span，没有 span 时返回字符串：

```ts
import { Effect } from "effect"

const spanInfo = Effect.currentSpan.pipe(
  Effect.map((s) => ({ name: s.name, kind: s.kind, attrs: Object.fromEntries(s.attributes) })),
  Effect.orElseSucceed(() => "no span")
)

const traced = Effect.fn("User.load", { attributes: { "db.system": "sqlite" }, kind: "client" })(
  function*(id: number) {
    return { id, span: yield* spanInfo }
  }
)
const unnamed = Effect.fn(function*(id: number) {
  return { id, span: yield* spanInfo }
})
const untraced = Effect.fnUntraced(function*(id: number) {
  return { id, span: yield* spanInfo }
})

console.log(await Effect.runPromise(traced(1)))
console.log(await Effect.runPromise(unnamed(2)))
console.log(await Effect.runPromise(untraced(3)))
```

输出是：

```text
{ id: 1, span: { name: 'User.load', kind: 'client', attrs: { 'db.system': 'sqlite' } } }
{ id: 2, span: 'no span' }
{ id: 3, span: 'no span' }
```

- `Effect.fn("name", options?)`：创建 span，并带栈帧边界。
- `Effect.fn(body)`（不传名字）：不创建 span，但仍然记录栈帧边界。
- `Effect.fnUntraced(body)`：既不创建 span，也不记录栈帧边界，只复用生成器函数体。

第二种很容易被忽略：它是「只要栈信息、不要 span」的折中，适合不值得出现在 trace 里、但出错时想知道从哪调进来的函数。

## span 选项：attributes 与 kind

`Effect.fn` 的第二个参数是 `SpanOptionsNoTrace`，包含 `attributes`、`kind`、`links`、`parent`、`root`、`annotations`、`sampled`、`level`。常用的是前两个：

- `attributes` 是一个**静态**对象，不能根据调用参数计算。输出里 `db.system` 在每次调用都一样。
- `kind` 默认是 `internal`，对外部系统的调用写 `client`，处理入站请求写 `server`，这样后端（Jaeger、Tempo 之类）才能正确画出服务拓扑。

要放入随参数变化的属性，在函数体里调用 `Effect.annotateCurrentSpan`。下一节的示例里会用到。

## Effect.fn.Return 与后处理参数

生成器函数的返回类型推断在涉及错误通道时容易模糊。`Effect.fn.Return<A, E, R>` 是官方给生成器函数体的返回类型标注，参数和 `Effect<A, E, R>` 一致，让错误类型显式落在签名上。

后处理参数是 `Effect.fn` 真正少见的部分：函数体之后可以继续传入多个函数，每个接收「上一步的结果」和「原始调用参数」，行为像 `pipe`，但能读到参数：

```ts
import { Data, Effect } from "effect"

class NotFound extends Data.TaggedError("NotFound")<{ readonly id: number }> {}

export const load = Effect.fn("User.load", { attributes: { "db.system": "sqlite" }, kind: "client" })(
  function*(id: number): Effect.fn.Return<string, NotFound> {
    yield* Effect.annotateCurrentSpan("user.id", id)
    if (id < 0) return yield* new NotFound({ id })
    return `user-${id}`
  },
  (eff, id) =>
    eff.pipe(
      Effect.catchTag("NotFound", (e) => Effect.succeed(`missing-${e.id}`)),
      Effect.tap(() => Effect.annotateCurrentSpan("post", `handled ${id}`)),
      Effect.flatMap((v) =>
        Effect.currentSpan.pipe(
          Effect.map((s) => `${v} ${JSON.stringify(Object.fromEntries(s.attributes))} kind=${s.kind}`)
        )
      )
    )
)

console.log(await Effect.runPromise(load(1)))
console.log(await Effect.runPromise(load(-2)))
```

输出：

```text
user-1 {"db.system":"sqlite","user.id":1,"post":"handled 1"} kind=client
missing--2 {"db.system":"sqlite","user.id":-2,"post":"handled -2"} kind=client
```

这里有两个值得记的点。第一，`NotFound` 在后处理里被 `catchTag` 消化，返回类型里就没有这个错误了。第二，后处理函数是在 span **内部**执行的：我在后处理里读到了 `User.load` 这个 span，并往里追加了 `post` 属性。所以重试、超时、日志注解这类「横切逻辑」放进后处理参数，会被同一个 span 覆盖，不需要再单独包一层 `Effect.withSpan`。

## 为什么不要对 Effect.fn 用 .pipe

官方示例里有一句明确的注释：不要对 `Effect.fn` 使用 `.pipe`。原因很具体：`Effect.fn(...)(body)` 返回的是一个**函数**，不是 Effect，函数上没有 `pipe` 方法。

```ts
import { Effect } from "effect"

const f = Effect.fn("x")(function*() {
  return 1
})

// @ts-expect-error Effect.fn 返回函数，不是 Effect，没有 .pipe
export const g = f.pipe(Effect.map((n) => n + 1))
```

这个块在 strict 下能编译，说明编译器确实报了错（`Property 'pipe' does not exist on type '() => Effect<number>'`）；运行时 `typeof f.pipe` 也是 `undefined`。

即使你写成 `(...args) => f(...args).pipe(...)` 绕开它，也有代价：额外的包装在 span **外面**，丢掉了「后处理在 span 内」的语义，调用方还要自己转发参数。后处理参数把这两件事一次解决，所以当你想给一个函数批量加重试、超时、错误转换时，直接把它们写进 `Effect.fn` 的后面。

## 栈追踪：fn 与 fnUntraced 的实际差异

span 和栈信息是两条线。下面构造一个必定失败的内层调用，再用四种方式包一层，打印 `Cause.pretty`：

```ts
import { Cause, Effect } from "effect"

const inner = Effect.fnUntraced(function*() {
  yield* Effect.sleep(1)
  return yield* Effect.fail(new Error("boom"))
})

const viaFn = Effect.fn("viaFn")(function*() {
  yield* inner()
})
const viaUnnamed = Effect.fn(function*() {
  yield* inner()
})
const viaUntraced = Effect.fnUntraced(function*() {
  yield* inner()
})
const viaGen = () =>
  Effect.gen(function*() {
    yield* inner()
  })

for (const [name, run] of [["fn(name)", viaFn], ["fn()", viaUnnamed], ["fnUntraced", viaUntraced], ["gen", viaGen]] as const) {
  const exit = await Effect.runPromiseExit(run())
  console.log(`--- ${name}`)
  if (exit._tag === "Failure") console.log(Cause.pretty(exit.cause))
}
```

在我的环境里输出（路径做了简化）：

```text
--- fn(name)
Error: boom
    at <anonymous> (fn3.ts:5:29)
    at viaFn (fn3.ts:23:44)
    at viaFn (definition) (fn3.ts:8:22)
--- fn()
Error: boom
    at <anonymous> (fn3.ts:5:29)
    at Effect.fn (fn3.ts:23:44)
    at Effect.fn (definition) (fn3.ts:11:27)
--- fnUntraced
Error: boom
    at <anonymous> (fn3.ts:5:29)
--- gen
Error: boom
    at <anonymous> (fn3.ts:5:29)
```

三个观察：

- `Effect.fn` 在错误栈里追加了**两帧**：一个是函数被调用的位置（`run()` 那一行），一个是函数定义的位置（`(definition)`）。这是跨 `yield*` 异步边界仍然可读的 Effect 栈帧。
- 命名版用你给的名字，不命名则显示 `Effect.fn`。命名既带来 span，也让栈更好认。
- `fnUntraced` 和裸 `Effect.gen` 一样，只有错误原本的栈，没有调用点与定义点。

所以选择标准不是「要不要日志」，而是「这个函数出错时，值不值得知道是谁调的」。应用层的用例函数值得；库内部的小工具函数，不值得。

## fnUntraced 与 fnUntracedEager：库代码与热路径

官方文档的建议是：库实现和热路径用 `Effect.fnUntraced`。它相比「返回 `Effect.gen` 的普通函数」少分配一层生成器闭包，也没有栈帧与 span 的开销。`fnUntracedEager` 更进一步：调用时就**立刻同步执行函数体**，直到遇到第一个异步 effect 才交还给运行时。

先看语义差别，这决定了它不是 `fnUntraced` 的无脑替代：

```ts
import { Effect } from "effect"

const log: Array<string> = []
const lazy = Effect.fnUntraced(function*(n: number) {
  log.push(`lazy body ${n}`)
  yield* Effect.sync(() => log.push("lazy step"))
  return n
})
const eager = Effect.fnUntracedEager(function*(n: number) {
  log.push(`eager body ${n}`)
  yield* Effect.sync(() => log.push("eager step"))
  return n
})

const l = lazy(1)
log.push("after lazy call")
const e = eager(1)
log.push("after eager call")
Effect.runSync(l)
Effect.runSync(e)
console.log(log)
```

输出：

```text
[
  'after lazy call',
  'eager body 1',
  'after eager call',
  'lazy body 1',
  'lazy step',
  'eager step'
]
```

`lazy` 的函数体在 `runSync` 之后才开始，符合「Effect 是描述」；`eager` 的函数体在**调用**那一刻就开始执行了，哪怕这个 effect 之后永远不运行，函数体的前缀副作用也已经发生。官方 JSDoc 对它的描述是「全部 yield 的 effect 都是同步的才会完全 eager」。所以我的规则很窄：

- 只用在函数体前缀**纯计算、无副作用**的热路径上，比如参数归一化、缓存命中的快路径。
- 前缀里有日志、写入、读取可变状态这类副作用时，一律用 `fnUntraced`。
- 一旦函数体里出现异步 effect（如 `Effect.sleep`），eager 只会执行到那一步之前。我实测 `sync part` 先于 `after call`，`after async` 在运行之后。

至于快多少，我用一个最简函数在 `runSync` 里循环三十万次测了一下：

```ts
import { Effect } from "effect"

const N = 300_000
const f1 = Effect.fn("t")(function*(n: number) {
  return n + 1
})
const f2 = Effect.fnUntraced(function*(n: number) {
  return n + 1
})
const f3 = Effect.fnUntracedEager(function*(n: number) {
  return n + 1
})
const f4 = (n: number) =>
  Effect.gen(function*() {
    return n + 1
  })

for (const [name, f] of [["fn", f1], ["fnUntraced", f2], ["fnUntracedEager", f3], ["gen wrapper", f4]] as const) {
  const t = performance.now()
  for (let i = 0; i < N; i++) Effect.runSync(f(i))
  console.log(name.padEnd(16), ((performance.now() - t) / N * 1000).toFixed(2), "us/call")
}
```

我这台机器上的结果量级是：`fn` 约 3.5 微秒、`gen wrapper` 约 0.8、`fnUntraced` 约 0.4、`fnUntracedEager` 约 0.06。这是空函数体、同步、带 `runSync` 开销的微基准，只说明量级关系：**带 span 的 `Effect.fn` 比 `fnUntraced` 贵近十倍**，所以几微秒的差距对 I/O 型函数无关紧要，但对被调用百万次的纯 CPU 小函数很显著。绝对数字请在你的环境重测。

## 怎么选

1. 应用层用例、服务方法、对外调用：`Effect.fn("Service.method")`，命名要和函数名对应；外部调用加 `kind: "client"`。
2. 想要出错调用点，但不想进 trace：`Effect.fn(body)` 不传名字。
3. 库内部的小函数、热路径：`Effect.fnUntraced`。
4. 极热路径且前缀纯、无副作用：再考虑 `Effect.fnUntracedEager`。
5. 需要重试、超时、错误转换：放进后处理参数，不要用 `.pipe`。

## 小结

- `Effect.fn` 有三个独立能力：span、栈帧边界、后处理参数。不传名字就只剩后两个。
- span 选项里 `attributes` 是静态的，随参数变化的属性用 `Effect.annotateCurrentSpan`；外部调用记得设置 `kind`。
- 它返回函数而不是 Effect，所以没有 `.pipe`；后处理参数在 span 内执行，并且能读取调用参数。
- `fnUntraced` 没有 span 也没有栈帧，更省；`fnUntracedEager` 会在调用时就执行函数体前缀，副作用要小心。
- 栈追踪和 span 是两件事：`fn` 追加调用点与定义点两帧，`fnUntraced` 与裸 `gen` 都不追加。
