---
title: "为什么需要 Effect：async/await 看不见的三件事"
description: 教程第 1 章。从一个普通的 async 函数出发，说明签名里看不见的三件事：会怎样失败、依赖了什么、能不能被取消，以及 Effect 如何把它们写进类型。
date: 2026-10-22
tags: [effect, tutorial, motivation, typescript]
category: effect
series: effect-tutorial
seriesOrder: 1
---

这是《Effect 教程：由浅入深》的第 1 章。整个系列是概念教程：讲清楚每个概念要解决什么问题、心智模型是什么、有什么取舍和误区。代码以示意为主，但用到的 API 名称都以 effect 4.0.5 为准。

第一章不教任何 API，只回答一个问题：我已经有 async/await 了，为什么还要学另一套东西？

## 一个看起来没问题的函数

先看一段再普通不过的代码：

```ts
async function getUser(id: string): Promise<User> {
  const row = await db.query("select * from users where id = ?", [id])
  if (!row) throw new Error("not found")
  const profile = await fetch(`${AVATAR_URL}/${id}`)
  return { ...row, avatar: await profile.text() }
}
```

签名写着 `Promise<User>`，意思是「给我一个 id，我会（异步地）给你一个 User」。但读完函数体你会发现，这个签名只说了成功的那一半。调用者要安全地使用它，还需要知道三件事，而 TypeScript 一件都没告诉他。

## 看不见的第一件事：它会怎么失败

函数里至少有三种失败方式：数据库连接出错、用户不存在、头像服务返回异常。它们都变成了 `throw`，调用者在 `catch` 里拿到的是 `unknown`。

```ts
try {
  const user = await getUser("42")
} catch (e) {
  // e: unknown —— 是查无此人？网络超时？还是我自己的 bug？
}
```

这里有两个问题。第一，**可预期的失败**（用户不存在）和**不可预期的缺陷**（空指针）被混在同一个通道里，处理代码只能靠 `instanceof` 或者字符串匹配去猜。第二，编译器不会提醒你漏掉了某种失败：新增一种失败方式，所有调用点都照样编译通过。

类比一下：这像是一份没有列出过敏原的菜单。菜单上只写了菜名，能不能吃要靠你吃过之后才知道。

## 看不见的第二件事：它依赖什么

`getUser` 里用到了 `db` 和 `AVATAR_URL`。它们是模块级的全局变量，或者被 import 进来的单例。签名里没有任何痕迹。

后果很具体：想测试这个函数，你得 mock 整个模块，或者启动一个真的数据库；想在两个环境里用不同的实现，只能靠环境变量和条件分支；想知道某个函数间接依赖了哪些外部资源，只能把调用链读一遍。

常见的补救办法是依赖注入：把依赖作为参数传进来。这是对的方向，但手动传参在调用链变深之后会变得很累，每一层都要转手一遍自己并不使用的依赖。许多 DI 容器靠装饰器和运行时反射解决这个问题，代价是依赖关系重新变得不可见，漏配置要到运行时才报错。

## 看不见的第三件事：它能不能被取消

用户切换了页面，请求已经没人关心了；或者一个并发任务里的兄弟任务已经失败，其余的也该停了。这时候你希望「正在进行的 `getUser`」立刻停下来，释放连接。

`Promise` 本身没有取消的概念。社区的办法是 `AbortController`：

```ts
async function getUser(id: string, signal?: AbortSignal): Promise<User> {
  const res = await fetch(url, { signal })
  signal?.throwIfAborted()
  // ...每一步都要记得检查和传递
}
```

这能用，但它是**约定**而不是**机制**：每个函数都得记得多收一个参数，每个下游调用都得记得往下传，漏一处，取消就在那一处失效。更麻烦的是资源清理：取消发生在两个 `await` 之间时，已经打开的连接、已经开始的事务由谁来关？靠 `try/finally`，而且要写对。

## 共同的根源

三件事看起来互不相关，但根源相同：**`Promise<User>` 只描述了成功值，其余信息都在函数体里，不在类型里。**

- 失败方式藏在 `throw` 里
- 依赖藏在全局变量和 import 里
- 取消藏在一个需要人工传递的参数里

Effect 的出发点就是把这三样东西提到类型上，让编译器能看到、能检查、能推导。

## Effect 的做法：三个槽位

Effect 用一个类型承载这三件事：

```ts
Effect.Effect<Success, Error, Requirements>
```

通常简写成 `Effect<A, E, R>`：

- `A`：成功时产出的值，对应 `Promise<A>` 里的 `A`
- `E`：可预期的失败的类型，是联合类型，例如 `NotFound | NetworkError`
- `R`：运行它还需要提供什么，也就是依赖，例如 `Database`

上面的函数用 Effect 的方式写，签名会变成这样（示意）：

```ts
declare const getUser: (id: string) =>
  Effect.Effect<User, NotFound | NetworkError, Database>
```

读这一行就够了：成功得到 `User`；可能因为查无此人或网络错误失败，不会有别的可预期失败；运行前必须提供 `Database`。**签名从「成功的那一半」变成了「完整的合同」。**

如果某处新增了一种失败，`E` 会自动变宽，所有没处理它的调用点都会得到类型提示。如果某处新增了依赖，`R` 会自动变宽，直到你提供它，程序都无法被运行。这些检查不靠自觉，靠类型推导。

至于第三件事，取消：Effect 的运行单位叫 fiber（后面第 13 章展开），**中断是 fiber 的内置能力，不需要手动传 signal**。一个 Effect 被中断时，它已经注册的清理动作会被运行，嵌套的子任务会被一起中断。资源安全的细节放在第 15 章。这里只需要记住：取消从「约定」变成了「机制」。

## 它不是免费的

诚实地说，这套东西有成本：

- **学习曲线**：你要接受一个新的编程模型，包括 `Effect.gen`、Layer、Schema 等一整套词汇。本系列正是为了降低这个曲线。
- **代码形状不同**：团队里不是所有人都想读这种代码，招人和协作的成本要算进去。
- **小脚本不划算**：一个二十行的脚本，三件事都不重要，用 async/await 更合适。

我的立场是：**当程序有多种失败方式、有多个外部依赖、有并发和资源管理时，Effect 的收益才明显超过成本。** 如果你的代码只是「调一个接口然后打印」，不必为了用而用。

## 常见误区

- **「Effect 就是更花哨的 Promise」**。Promise 是已经开始运行的计算的结果占位符，Effect 是对计算的描述，两者的差别是下一章的主题。
- **「用了 Effect 就不会出错了」**。Effect 不消除错误，只是让错误变得可见、可分类。缺陷（bug）依然存在，它们不在 `E` 里，第 5 章会专门区分。
- **「必须全盘改写」**。Effect 可以从一个模块、一条边缘链路开始，和现有的 async 代码共存。第 4 章会讲怎么把已有的世界包进来。

## 小结

async/await 的签名只说了成功，失败、依赖、取消三件事都在类型之外。Effect 用 `Effect<A, E, R>` 把前两件写进类型，把第三件变成运行时机制。

下一章我们看这个类型的另一个关键性质：**Effect 是一个值**，创建它不会执行任何事情。理解了这一点，后面的组合方式才说得通。

## 延伸阅读

- [为什么我用 Effect：从 Effect<A, E, R> 到 Effect.gen](/articles/effect-why-and-basics)
- [类型化错误](/articles/effect-typed-errors)
