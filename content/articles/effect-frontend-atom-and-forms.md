---
title: "Effect 前端实践：用 Atom 管理状态，让表单只有一个所有者"
description: 前端状态混乱，往往因为同一个事实被多处持有。本文用 effect/reactivity 与 @effect/atom-react 讲 Atom 数据流、Layer 注入与持久化，以及 Schema 与表单库的边界，代码已实测。
date: 2026-10-14
category: effect
tags: [effect, guide]
---

前面几篇讲的都是服务端风格的问题：错误、依赖、并发、运行时边界。这一篇换到浏览器里，问题其实是同一个：**每一个事实应该只有一个所有者**。

前端的混乱几乎都来自违反这条。同一份服务端数据，一份在 `useState`，一份在请求库的缓存，还有一份在表单里；同一次提交，按钮的 loading 是一个布尔值，表单的 submitting 是另一个。状态一旦有两份，同步它们的代码就成了 bug 的来源。

这一篇用三件事把所有权讲清楚：Atom 持有应用状态与异步数据，Schema 持有校验规则，表单库持有输入过程。代码使用 `effect@4.0.5` 与 `@effect/atom-react@4.0.5`，在 React 19 里实际渲染、点击、提交过，类型在 strict 模式下通过。

## 先把包的事实说清楚

我自己的旧资料里写的是 `@effect-atom/atom-react`，那是社区在 v3 时代的包。我查了 npm：它的最新版是 0.7.0，peer 依赖是 `effect ^3.22.1`，所以它面向 v3，**不是** v4 的答案。我没有在 4.0.5 上验证它，也就不在文章里使用它。

v4 的做法是把 Atom 收进核心包，作为 `effect/reactivity` 子路径导出；React 绑定是独立的 `@effect/atom-react`，版本号与核心同步，peer 依赖是 React 19 和 `effect ^4.0.5`。

```bash
npm install effect@4.0.5 @effect/atom-react@4.0.5 react@19
```

另外有几处 v3 写法在这里已经不存在：

- 异步状态类型叫 `AsyncResult`，不再是 `Result`。`Result` 在 v4 是 `Either` 的新名字，和 UI 状态是两回事。
- 带写入副作用的 atom 用 `Atom.fn`，没有 `Atom.writable(effectRead, effectWrite)` 这种用法。
- `Atom.runtime(layer)` 返回的运行时上有 `.atom`、`.fn`，依赖从 Layer 注入。
- `Atom.kvs` 的 `defaultValue` 是一个返回默认值的函数，不是裸值。

## Atom 的心智模型

Atom 是一个响应式状态容器。最基础的形态有三种：可写的原始状态、从其他 atom 派生的状态、按参数缓存的一族 atom。

```ts
// atoms.ts
import { Atom } from "effect/reactivity"

export const count = Atom.make(0)
export const doubled = Atom.make((get) => get(count) * 2)
export const userLabel = Atom.family((id: string) => Atom.make(`user:${id}`))
export const sticky = Atom.keepAlive(Atom.make(0))
```

我在一个独立的 `AtomRegistry` 里跑过这几个 atom，得到几条值得记住的事实：

- `userLabel("a") === userLabel("a")` 为 true，同一个参数永远得到同一个 atom；不同参数得到不同的 atom。
- 派生 atom 即使没人订阅，也能直接读出当前值：`count` 设为 5 之后，读 `doubled` 得到 10。
- **没人订阅的 atom 会被回收，状态回到初始值。** 我把空闲 TTL 调短后验证：`count` 设为 5，等待之后再读，已经回到 0。
- 用 `Atom.keepAlive` 包裹的 atom 不会被回收，`sticky` 设为 3 之后仍然是 3。

最后一条是新手最容易踩的坑：把「需要跨页面保留的状态」写成普通 atom，切走页面后它就悄悄重置了。判断标准是这份状态的生命周期是否长于使用它的组件。长于，就 `keepAlive`；需要跨刷新存活，就走持久化（下面会讲）。

## 异步数据：Layer 注入，AsyncResult 表达三态

Effect 驱动的 atom 不返回裸值，而是 `AsyncResult<A, E>`，三种形态：`Initial`、`Success`、`Failure`，并带一个 `waiting` 标志位表示正在重新请求。

依赖怎么进来？不是在 atom 里写 `fetch`，而是和服务端一样：用 `Context.Service` 定义能力，用 Layer 提供实现，再用 `Atom.runtime(layer)` 把 Layer 绑成运行时。

```ts
// todos.ts
import { Context, Data, Effect, Layer } from "effect"
import { Atom } from "effect/reactivity"

export class TodoError extends Data.TaggedError("TodoError")<{ readonly reason: string }> {}

export interface Todo {
  readonly id: number
  readonly title: string
}

export class TodoApi extends Context.Service<TodoApi, {
  readonly list: Effect.Effect<ReadonlyArray<Todo>, TodoError>
  readonly add: (title: string) => Effect.Effect<Todo, TodoError>
}>()("app/TodoApi") {
  static readonly memory = Layer.sync(TodoApi, () => {
    const items: Array<Todo> = []
    return {
      list: Effect.sync(() => [...items]),
      add: (title: string) =>
        title.trim() === ""
          ? Effect.fail(new TodoError({ reason: "empty title" }))
          : Effect.sync(() => {
              const todo = { id: items.length + 1, title }
              items.push(todo)
              return todo
            })
    }
  })
}

export const runtime = Atom.runtime(TodoApi.memory)

export const todosAtom = runtime.atom(TodoApi.use((api) => api.list)).pipe(
  Atom.runtime.withReactivity(["todos"])
)

export const addTodo = runtime.fn<string>()(
  (title) => TodoApi.use((api) => api.add(title)),
  { reactivityKeys: ["todos"] }
)
```

读与写之间靠 **reactivity key** 连接。`todosAtom` 声明自己依赖 `"todos"` 这个 key，`addTodo` 声明自己成功后失效 `"todos"`。我实测的行为是：调用 `addTodo` 之后，已挂载的 `todosAtom` 自动重新拉取，列表从空变成包含新条目；调用 `addTodo` 传入空标题则落到 `Failure`，错误值是 `TodoError`，列表保持原样不被破坏。

这就是「写入后失效重拉」的完整机制，没有手写的 `refetch()`，也没有在 mutation 回调里去改缓存。数据只有一个来源，就是服务，atom 只是它的投影。

### 组件里怎么用

组件只负责把 `AsyncResult` 映射成界面。我推荐用 `matchWithError`，因为它把失败拆成「预期错误」和「defect」两条，和 typed errors 那一篇的区分完全对应：

```ts
// app.tsx
import { AsyncResult } from "effect/reactivity"
import { RegistryProvider, useAtomSet, useAtomValue } from "@effect/atom-react"
import { addTodo, todosAtom } from "./todos.ts"

export function TodoList() {
  const result = useAtomValue(todosAtom)
  return AsyncResult.matchWithError(result, {
    onInitial: () => <p>loading</p>,
    onError: (e) => <p role="alert">failed: {e.reason}</p>,
    onDefect: () => <p role="alert">unexpected error</p>,
    onSuccess: (s) => (
      <ul>
        {s.value.map((t) => <li key={t.id}>{t.title}</li>)}
        {s.waiting ? <li>refreshing</li> : null}
      </ul>
    )
  })
}

export function AddButton() {
  const add = useAtomSet(addTodo)
  return <button onClick={() => add("from button")}>add</button>
}

export const App = () => (
  <RegistryProvider>
    <TodoList />
    <AddButton />
  </RegistryProvider>
)
```

我在 jsdom 里渲染了这棵树：首次渲染得到空列表，点击按钮后，列表里出现 `from button`，中间没有任何手写的刷新调用。

`onError` 的参数类型是 `TodoError`，所以 `e.reason` 有类型保护，不需要 `as`。如果后端再加一个错误类型，这里的联合类型会逼你处理它。这是前面「错误是类型」的红利延伸到了 UI。

两个提醒：`RegistryProvider` 是每棵应用树一个 registry，atom 的状态存在 registry 里，不在 atom 自己身上；`useAtomValue` 订阅的粒度就是重渲染的粒度，所以按用途拆 atom、拆组件，不要在顶层组件里读一个巨大的 atom。

## 测试：换 Layer，不碰组件

Layer 注入的真正回报在测试。`runtime.layer` 本身是一个 atom，所以可以通过 registry 的 `initialValues` 把它替换成测试用的 Layer，业务 atom 与组件一行都不用改：

```ts
// todos-swap.ts
import { Effect, Layer } from "effect"
import { AsyncResult, AtomRegistry } from "effect/reactivity"
import { runtime, TodoApi, TodoError, todosAtom } from "./todos.ts"

const Broken = Layer.succeed(TodoApi, {
  list: Effect.fail(new TodoError({ reason: "backend down" })),
  add: () => Effect.fail(new TodoError({ reason: "backend down" }))
})

const registry = AtomRegistry.make({ initialValues: [[runtime.layer, Broken]] })
registry.mount(todosAtom)
await new Promise((r) => setTimeout(r, 30))

console.log(
  AsyncResult.matchWithError(registry.get(todosAtom), {
    onInitial: () => "initial",
    onError: (e) => `error: ${e.reason}`,
    onDefect: () => "defect",
    onSuccess: () => "success"
  })
)
```

输出是 `error: backend down`，说明替换生效了。React 侧对应的是 `RegistryProvider` 的 `initialValues` 属性，机制相同。这样「接口挂了界面怎么显示」可以在没有网络、没有 mock 服务器的情况下被稳定测试。

## 持久化：Atom.kvs，而不是裸 localStorage

需要跨刷新存活的偏好，用 `Atom.kvs`：它通过 `KeyValueStore` 服务读写，并用 Schema 做编解码。

```ts
// theme.ts
import { Schema } from "effect"
import { Atom } from "effect/reactivity"
import { BrowserKeyValueStore } from "@effect/platform-browser"

const runtime = Atom.runtime(BrowserKeyValueStore.layerLocalStorage)

export const themeAtom = Atom.kvs({
  runtime,
  key: "ui.theme",
  schema: Schema.Literals(["light", "dark"]),
  defaultValue: () => "light" as const
})
```

这需要再装一个 `@effect/platform-browser@4.0.5`。我在 jsdom 的 localStorage 上验证：首次读取是默认值 `light`，设置为 `dark` 之后，存储里的原始字符串是 `"dark"`，读回也是 `dark`。

价值不在于少写几行，而在于边界：存储里读出来的是不可信的外部数据，Schema 保证读回来的一定是 `light` 或 `dark`，被手工改坏的值不会渗进应用。存储后端也变成了可替换的 Layer，换成 `sessionStorage` 或 IndexedDB 只改一行。

## 表单：一条单向路径

表单是最容易出现多个所有者的地方。我先给出所有权的划分：

- **表单库**持有输入过程：原始字段值、touched、是否正在提交、重置语义。
- **Schema** 持有领域校验：什么算合法的邮箱，密码至少几位。只在一个地方定义。
- **Effect** 持有提交之后的应用逻辑：调接口、取消、并发、依赖。
- **React 事件回调**只是适配器，不拥有任何业务逻辑，也不该在回调里构造运行时。

数据流只有一个方向：UI 事件，进入表单状态机，经过 Schema 解码，进入应用 Effect。校验失败是留在表单投影里的数据，不是异常。

我不为所有前端指定表单库，这里用 TanStack Form 做示例，是因为它支持 Standard Schema。先定义 Schema，并用 `Schema.toStandardSchemaV1` 导出给表单库用：

```ts
// signup-schema.ts
import { Schema } from "effect"

export const Signup = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/, { message: "invalid email" })),
  password: Schema.String.check(Schema.isMinLength(8, { message: "at least 8 characters" })),
  age: Schema.NumberFromString.check(Schema.isBetween({ minimum: 18, maximum: 120 }, { message: "18-120" }))
})
export type Signup = typeof Signup.Type

export const SignupStandard = Schema.toStandardSchemaV1(Signup)
```

注意 `age` 的设计：表单里的输入永远是字符串，`NumberFromString` 负责把它解码成数字。这就是 Schema 的 Encoded 与 Type 之分：表单处理的是 Encoded 一侧，应用拿到的是 Type 一侧。我直接调用 `["~standard"].validate` 验证过：输入 `{ email: "x", password: "123", age: "12" }` 得到三条问题，路径分别是 `email`、`password`、`age`；合法输入则返回 `age` 已经是数字 30 的值。

提交的 Effect 在同一个错误通道里同时处理「解码失败」和「接口失败」：

```ts
// signup-flow.ts
import { Context, Data, Effect, Layer, Schema } from "effect"
import { Atom } from "effect/reactivity"
import { Signup } from "./signup-schema.ts"

export class EmailTaken extends Data.TaggedError("EmailTaken")<{ readonly email: string }> {}

export class AccountApi extends Context.Service<AccountApi, {
  readonly register: (input: Signup) => Effect.Effect<{ readonly id: string }, EmailTaken>
}>()("app/AccountApi") {
  static readonly fake = Layer.succeed(AccountApi, {
    register: (input) =>
      Effect.sleep("30 millis").pipe(
        Effect.andThen(
          input.email === "taken@example.com"
            ? Effect.fail(new EmailTaken({ email: input.email }))
            : Effect.succeed({ id: `u_${input.age}` })
        )
      )
  })
}

const runtime = Atom.runtime(AccountApi.fake)

export const submitSignup = runtime.fn<unknown>()((raw) =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(Signup)(raw)
    const api = yield* AccountApi
    return yield* api.register(input)
  })
)
```

入参是 `unknown`，这一点很关键：提交函数不信任调用者，自己再解码一次。表单库的校验是给用户看的体验层，解码才是进入应用的安全门。两者用同一个 Schema，所以规则不会漂移。

最后是组件：

```ts
// signup-form.tsx
import { useForm } from "@tanstack/react-form"
import { useAtom } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { SignupStandard } from "./signup-schema.ts"
import { submitSignup } from "./signup-flow.ts"

export function SignupForm() {
  const [result, submit] = useAtom(submitSignup, { mode: "promiseExit" })
  const form = useForm({
    defaultValues: { email: "", password: "", age: "" },
    validators: { onChange: SignupStandard },
    onSubmit: async ({ value }) => {
      await submit(value)
    }
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="email">
        {(field) => (
          <div>
            <input
              id="email"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            <span className="err">
              {field.state.meta.errors.map((issue) => issue?.message).join(",")}
            </span>
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(pending) => <button type="submit" disabled={pending}>{pending ? "..." : "sign up"}</button>}
      </form.Subscribe>
      <output>
        {AsyncResult.matchWithError(result, {
          onInitial: () => "idle",
          onError: (e) => (e._tag === "EmailTaken" ? `taken: ${e.email}` : "invalid input"),
          onDefect: () => "unexpected error",
          onSuccess: (s) => `ok ${s.value.id}`
        })}
      </output>
    </form>
  )
}
```

示例里省略了 `password` 和 `age` 两个字段，写法和 `email` 完全相同。我在 jsdom 里补全三个字段后跑了一遍，行为是：

- 输入非法邮箱时，错误信息 `invalid email` 出现，来自 Schema 的 message。
- 字段不全时点击提交，**不会**调用提交 atom，输出仍是 `idle`。
- 提交已占用的邮箱，输出 `taken: taken@example.com`，这是 `EmailTaken` 经过 `matchWithError` 得到的。
- 提交过程中，按钮显示 `...`；换成合法邮箱后，输出 `ok u_30`。

重点是 `mode: "promiseExit"` 这个选项。默认的 setter 是即发即忘的，调用返回 `void`，表单库不知道提交什么时候结束，`isSubmitting` 会立刻变回 false。用 `promiseExit` 后，setter 返回一个 Promise，表单库的 `onSubmit` 可以 `await` 它，于是**「是否正在提交」只有表单一个所有者**，我没有读 atom 的 `waiting`，也没有额外维护 loading 布尔值。而提交的结果（成功、预期错误、defect）属于应用层，由 atom 持有并用 `matchWithError` 渲染。每个事实一个所有者，边界就是这条线。

## 反模式清单

- **在组件里 `useState` + `useEffect` 拉数据。** 这正是 atom 要替换的写法：它既没有取消，也没有依赖注入，还要手工管理 loading 和 error。
- **在组件或回调里直接 `Effect.runPromise`。** 它绕过 registry 与 Layer，副作用既不可测也不可替换；需要触发 Effect，就用 `Atom.fn` 加 `useAtomSet`。
- **把表单状态镜像进 atom 或 `useState`。** 输入过程属于表单库，镜像一份就要写同步代码。
- **在表单回调里重新写一遍校验。** 校验规则只在 Schema 里定义，表单库通过 Standard Schema 消费它。
- **裸 `localStorage`。** 用 `Atom.kvs` 加 Schema，读出的数据才是可信的。
- **把跨页面状态写成普通 atom 而忘记 `keepAlive`。** 无人订阅就会被回收，这是 UI 里偶发「状态丢了」的常见原因。

## 小结

前端的核心纪律仍然是所有权：

- Atom 持有应用状态与异步数据，服务端数据只有一个来源；写入通过 reactivity key 让读自动失效，不手写 refetch。
- 依赖用 `Atom.runtime(layer)` 注入，测试通过 `initialValues` 替换 `runtime.layer`，组件不用改。
- 异步三态用 `AsyncResult`，渲染用 `matchWithError`，把预期错误与 defect 分开处理。
- Schema 定义一次校验规则：表单库经 Standard Schema 消费它，提交的 Effect 再解码一次作为安全门。
- 表单库持有输入与提交过程，用 `promiseExit` 把提交的结束时刻交还给它；应用层结果由 atom 持有。

还有一个范围声明：我只验证了上述 API 与行为，没有验证 `useAtomSuspense`、SSR 水合和 `AtomHttpApi` 等能力，这些我选择不展开，等验证之后再写。
