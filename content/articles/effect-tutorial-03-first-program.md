---
title: "写出第一段 Effect：gen、pipe、map/flatMap，以及运行只发生在边缘"
description: 教程第 3 章。学会用 Effect.gen 写顺序逻辑，用 pipe 与 map、flatMap、tap 做变换，理解 E 和 R 如何在组合中自动累积，以及为什么 run 只应出现在程序入口。
date: 2026-10-02
tags: [effect, tutorial, gen, pipe, composition]
category: effect
series: effect-tutorial
seriesOrder: 3
---

前两章讲了为什么和是什么。这一章动手：怎么把小的 Effect 拼成大的 Effect，以及拼好之后在哪里运行它。

本章只引入一类新概念：**组合**。构造外部世界的 Effect（包装 Promise、回调等）留到第 4 章，这里用最简单的 `Effect.succeed` 和 `Effect.fail` 做零件。

## 要解决的问题

真实的逻辑几乎都是「先做 A，用 A 的结果做 B，再用 B 的结果做 C」。async/await 给了我们一种顺手的写法：

```ts
async function main() {
  const a = await stepA()
  const b = await stepB(a)
  return stepC(b)
}
```

我们希望对 Effect 也有同样顺手的写法，同时保留它的类型信息：任何一步失败，整体就失败；任何一步需要依赖，整体就需要依赖。

## 朴素做法：手动展开

Effect 是值，不能 `await`。最直接的方式是用 `flatMap` 一层一层嵌套：

```ts
const program = stepA().pipe(
  Effect.flatMap((a) =>
    stepB(a).pipe(Effect.flatMap((b) => stepC(b)))
  )
)
```

能工作，但一旦步骤变多、需要同时用到前面几步的结果，缩进就会失控，这就是所谓的回调地狱，只是换成了 `flatMap`。

## Effect.gen：像写 async 一样写 Effect

```ts
const program = Effect.gen(function* () {
  const a = yield* stepA()
  const b = yield* stepB(a)
  return yield* stepC(b)
})
```

对照一下：`function*` 对应 `async function`，`yield*` 对应 `await`。**`yield*` 的意思是「运行这个 Effect，拿到它的成功值；如果它失败，整个 gen 就以同样的失败提前结束」。**

这里有两点需要建立直觉：

1. `Effect.gen` 的返回值本身仍然是一个 Effect，是惰性的。函数体在被运行之前一行都不会执行。
2. 每一个被 `yield*` 的 Effect 的 `E` 和 `R` 会**自动合并**到整体上。

```ts
// stepA: Effect<number, ErrA, Database>
// stepB: (n: number) => Effect<string, ErrB, Logger>

const program = Effect.gen(function* () {
  const a = yield* stepA()
  return yield* stepB(a)
})
// program: Effect<string, ErrA | ErrB, Database | Logger>
```

不需要手写任何类型标注，编译器把所有步骤的失败和依赖取了并集。这就是第 1 章承诺的「签名是完整合同」在写代码时的样子。

### 失败在 gen 里怎么传播

和 `await` 遇到抛出异常类似，`yield*` 一个失败的 Effect 会终止后续代码。区别是它不是靠抛异常，也不会被 `try/catch` 吞掉：

```ts
const prog = Effect.gen(function* () {
  yield* Effect.log("start")
  yield* Effect.fail(new NotFound({ id: "1" })) // 这里整体以 NotFound 失败
  yield* Effect.log("never reached")
})
```

不要在 `Effect.gen` 里用 `try/catch` 去捕获 Effect 的失败，那样捕获不到。恢复失败有专门的组合子，第 5 章讲。

## pipe：一元变换的流水线

`Effect.gen` 适合顺序、有中间变量的逻辑。另一类需求是：对一个 Effect 做一连串小变换。这时用 `pipe`：

```ts
const piped = Effect.succeed(2).pipe(
  Effect.map((n) => n * 2),
  Effect.flatMap((n) => Effect.succeed(String(n))),
  Effect.tap((s) => Effect.log(s)),
  Effect.andThen((s) => Effect.succeed(s.length))
)
```

它们的分工是：

- `map`：变换成功值，函数返回普通值
- `flatMap`：变换成功值，函数返回**另一个 Effect**（需要再运行一步）
- `tap`：做一个副作用（日志、指标），但保留原来的成功值
- `andThen`：对「接下来做什么」的宽松写法，既接受返回值的函数，也接受返回 Effect 的函数

有一条经验可以记：**函数返回普通值就用 `map`，返回 Effect 就用 `flatMap`。** 用错了不会静默通过，因为你会得到一个「Effect 里套着 Effect」的类型，一眼就能看出来。

`pipe` 在 v4 里是 Effect 值上的方法，所以写成 `value.pipe(f, g, h)` 就是依次把 value 交给 f、g、h。它也可以用于任何其他值。

### gen 与 pipe 怎么选

取向很简单：**多步、有中间变量、有条件分支，用 `gen`；单个 Effect 上叠加横切行为（重试、超时、日志、`provide`），用 `pipe`。** 在实际代码里，两者经常混用：`gen` 写主体逻辑，最后用 `pipe` 在外面包一层超时。

## 给函数命名：Effect.fn

如果一个函数返回 `Effect.gen(...)`，通常写成 `Effect.fn`：

```ts
const loadUser = Effect.fn("loadUser")(function* (id: string) {
  const user = yield* getUser(id)
  return user.name
})
```

和手写一个返回 `Effect.gen` 的箭头函数相比，`Effect.fn` 给这个函数加了名字，以后做可观测性（第 20 章）时它会自动成为一个 trace 的节点，同时保留参数类型。现在你只需要知道：它就是「带名字的、返回 Effect 的函数」。

## 运行只发生在边缘

写出 `program` 之后，什么都还没有发生。要让它真正跑起来，调用运行器：

```ts
async function main() {
  const value = await Effect.runPromise(program)
  console.log(value)
}
```

一个重要的设计原则：**`Effect.run*` 应该只出现在程序最外层的入口**，比如 `main` 函数、HTTP 框架的 handler 适配处、测试的运行器处。业务逻辑内部只构造、组合 Effect，不运行它。

为什么？因为一旦在中间运行，你就把一个本该由外层统一决定的事情提前做了：

- 依赖需要在中途就提供完，外层再也没有机会替换（比如测试里换成假实现）
- 取消和资源释放被切断，内层的 fiber 脱离了外层的管理
- 失败被提前压扁成 Promise 的 rejection，类型信息丢失

可以用「电源插座」来类比：业务代码是电器，只管插上；通电这件事只在配电箱那一处发生。如果每个电器内部自带一个发电机，就没法统一断电和限流了。

### 几个常用的运行器

- `Effect.runPromise`：最常用，异步入口。失败会变成 rejection。
- `Effect.runPromiseExit`：不抛异常，返回 `Exit`，适合需要自己处理成功和失败的边界。
- `Effect.runSync`：同步入口，要求整个 Effect 是同步的。
- `Effect.runFork`：后台运行，返回 fiber。长期运行的服务入口常用它。

其中 `runPromise`、`runPromiseExit`、`runFork` 接受可选的 `{ signal }`，可以把外部的 `AbortSignal` 接到 Effect 的中断上，这是与现有取消机制衔接的做法（`runSync` 没有这个选项）。

### 一个对照：同一段逻辑的两种写法

假设要「取用户、取出名字、记录日志、2 秒超时」。用 `gen` 写主体，用 `pipe` 包外层，各自做擅长的事：

```ts
const showName = (id: string) =>
  Effect.gen(function* () {
    const user = yield* getUser(id)
    yield* Effect.log(`got ${user.name}`)
    return user.name
  }).pipe(Effect.timeout("2 seconds"))
```

主体里有两步和一个中间变量，用 `gen` 读起来最自然；超时是叠加在整体上的横切行为，用 `pipe` 一行搞定。如果硬要全部用 `flatMap` 或全部塞进 `gen`，都能做到，只是可读性会下降。

## 常见误区

- **「在业务函数里到处 `await Effect.runPromise(...)`」**。这是最常见的用歪方式：把 Effect 当成更啰嗦的 Promise 用。判断标准是：如果一个函数既返回 Promise 又在内部运行 Effect，它的 `E` 和 `R` 就都丢了。
- **「`gen` 里忘了 `yield*`」**。只写 `stepA()` 而不 `yield*`，得到的只是一个没有被运行的描述，什么也不会发生，函数也会照常继续往下走。这类 bug 在 Effect 里很典型，值得养成习惯：看到 Effect 类型的表达式出现在语句位置，就应该警觉。语言服务和 lint 规则可以机械地检查它，第 22 章会再回到这里。
- **「用 `map` 里返回 Effect」**。结果是 `Effect<Effect<...>>`，里面那层永远不会被运行。
- **「`gen` 里能用 `try/catch` 处理 Effect 失败」**。不能，失败不是异常。

## 小结

`Effect.gen` 让顺序逻辑读起来像 async/await，`yield*` 同时完成运行和错误传播，`E` 与 `R` 自动累积；`pipe` 配合 `map`、`flatMap`、`tap` 对单个 Effect 做变换；真正的运行只放在入口。

目前我们的零件还只有 `succeed` 和 `fail`。下一章解决最实际的问题：怎么把已有的同步函数、Promise、回调包装成 Effect，让现有的世界接进来。

## 延伸阅读

- [为什么我用 Effect：从 Effect<A, E, R> 到 Effect.gen](/articles/effect-why-and-basics)
- [Effect.fn 进阶](/articles/effect-fn-advanced)
- [运行时边界与测试](/articles/effect-runtime-boundaries-and-testing)
