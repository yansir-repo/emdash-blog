---
title: "effect/cli：用类型和 Schema 写命令行工具"
description: 用 effect/cli 的 Command、Flag、Argument 写类型安全的命令行：Schema 校验、父命令共享参数、子命令读取父参数、示例与别名、补全脚本和交互式 Prompt，全部在 4.0.5 下实测，并说明它仍是 unstable。
date: 2026-10-22
category: effect
tags: [effect, advanced]
---

命令行工具的痛点很固定：参数解析、校验、帮助文本、补全脚本、交互兜底，这些代码和业务无关，却占掉大半篇幅。`effect/cli` 把它们收进一个声明式模型：Flag 和 Argument 是「带类型的解析器」，Command 把它们组合成 `Effect` 处理函数，剩下的帮助、版本、补全由框架生成。

我的判断是：如果你的 CLI 本来就跑在 Effect 里（要用 Service、Layer、结构化错误），用它比 commander 加手写校验省事得多；如果只是个十行脚本，不必。

## 先说稳定性

`effect/cli` 下的 12 个模块在 4.0.5 的 `.d.ts` 里全部标注 `@stability unstable`，包括 `Command`、`Flag`、`Argument`、`Prompt`、`Completions`。意思是小版本之间可能有破坏性变更，写 CLI 时我会把它限制在入口文件里，业务逻辑放在普通的 Effect 函数中，入口只做参数到函数调用的映射。稳定性机制见[稳定性标注那篇](/articles/effect-stability-tags)。

另一个事实：v4 的构造器名字是大写开头，`Flag.String`、`Flag.Boolean`、`Flag.Int`、`Argument.String`，不是 v3 的小写 `Options.text`。运行还需要平台服务，这里用 `@effect/platform-node` 的 `NodeServices.layer`。

## 一个最小但完整的 CLI

下面这个例子覆盖了本文要讲的全部特性。我用 `tsx` 实际执行过每个分支。

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/cli"

// 可跨命令复用的 Flag
const workspace = Flag.String("workspace").pipe(
  Flag.withAlias("w"),
  Flag.withDescription("Workspace to operate on"),
  Flag.withDefault("personal")
)

const tasks = Command.make("tasks").pipe(
  Command.withDescription("Track tasks"),
  Command.withSharedFlags({
    workspace,
    verbose: Flag.Boolean("verbose").pipe(Flag.withAlias("v"), Flag.withDefault(false))
  })
)

const Email = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/, { message: "Expected an email address" }))
)

const create = Command.make(
  "create",
  {
    title: Argument.String("title").pipe(Argument.withSchema(Schema.NonEmptyString)),
    limit: Flag.Int("limit").pipe(Flag.withDefault(10)),
    priority: Flag.Literals("priority", ["low", "normal", "high"]).pipe(Flag.withDefault("normal")),
    assignee: Flag.String("assignee").pipe(Flag.withSchema(Email), Flag.optional),
    owner: Flag.String("owner").pipe(
      Flag.withFallbackPrompt(Prompt.String({ message: "Owner" }))
    )
  },
  Effect.fn(function*({ title, limit, priority, assignee, owner }) {
    const root = yield* tasks // 读取父命令的 shared flags
    yield* Console.log(
      `ws=${root.workspace} verbose=${root.verbose} title=${title} limit=${limit} p=${priority} owner=${owner} assignee=${Option.getOrElse(assignee, () => "-")}`
    )
  })
).pipe(
  Command.withExamples([{ command: "tasks create \"Ship\" --priority high", description: "high priority" }])
)

const list = Command.make("list", {}, () => Console.log("listing")).pipe(
  Command.withAlias("ls"),
  Command.withDescription("List tasks")
)

tasks.pipe(
  Command.withSubcommands([create, list]),
  Command.run({ version: "1.2.3" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

### Flag、Argument 与 withSchema

`Flag.String("workspace")` 解析 `--workspace x`，`Argument.String("title")` 解析位置参数。`withDefault` 提供默认值，`Flag.optional` 把结果变成 `Option`。`Flag.Literals` 把取值限定为字面量联合，帮助里会显示 `(choices: low, normal, high)`。

`withSchema` 是我最喜欢的一点：解析出的字符串再过一遍任意 Schema，校验失败在**解析阶段**就报错，处理函数拿到的永远是合法值。实测：

- `create "" --owner x` 报 `Invalid value for argument <title>: "". Expected: Schema validation failed: Expected a value with a length of at least 1`。
- `--assignee bad` 报 `Invalid value for flag --assignee: "bad". Expected: Schema validation failed: Expected an email address`。
- `--limit 1.5` 报 `Expected an integer`，`--limit abc` 报 `Expected a string representing a finite number`。

这些错误都是退出码 1，并且连同该命令的帮助一起打印。这里的 Schema 用法本身见[Schema 那篇](/articles/effect-schema-at-the-boundary)。

### withSharedFlags 与读取父命令

`Command.withSharedFlags` 把 flag 声明在父命令上，所有子命令都能接受它们，并且位置可以在子命令之前：`tasks -w team -v create Ship --owner me` 输出 `ws=team verbose=true ...`。

子命令里读取父命令输入的方式很干净：`const root = yield* tasks`。父命令本身是一个可 yield 的值，拿到的就是它声明的 shared flags，类型完全推导。这比把配置层层传参，或者塞进全局变量都好。

### 别名、示例、帮助

`Command.withAlias("ls")` 让 `tasks ls` 等价于 `tasks list`，帮助里显示 `list, ls`；`Command.withExamples` 的内容出现在子命令帮助末尾的 EXAMPLES 段；`Flag.withAlias("w")` 是短选项。

有一个我实测到的坑：示例里我给 `--verbose` 加了 `-v`，而内置的 `--version` 在帮助里也显示为 `-v`。我跑了 `tasks -v create ...`，它被当作 verbose；`tasks -v --version` 则打印版本。行为可以工作，但同一个短选项出现在两处会让帮助文本含糊，我建议避开 `-v`、`-h` 这类内置占位。

### 内置全局 Flag 与 Completions

不用写任何代码，每个命令都带有 `--help`、`--version`、`--wizard`、`--completions` 和 `--log-level`。`tasks --version` 输出 `tasks v1.2.3`。`tasks --completions bash` 与 `zsh` 都直接打印可用的补全脚本，脚本头部自带安装说明；支持的 shell 在帮助里列为 bash、zsh、fish、powershell，另外 sh 与 pwsh 作为别名。

注意补全脚本是**静态生成**的（脚本头注释写明了 Static completion script），子命令和 flag 变了要重新生成。

### Prompt：交互式兜底

`Flag.withFallbackPrompt(Prompt.String(...))` 的语义是：命令行没给这个 flag 时才询问。我分别测了两种环境：在 TTY 下它弹出 `Owner` 提问，输入后继续执行；在非 TTY（stdin 为 `/dev/null`）下直接报 `Missing required flag: --owner` 并退出码 1。后者对 CI 很重要：交互兜底不会让流水线挂起。

`Prompt` 也能独立使用，`Prompt.all` 把多个提问组合成一个表单，`Prompt.run` 执行它，需要 Terminal 服务：

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { Prompt } from "effect/cli"

const form = Prompt.all({
  name: Prompt.String({ message: "Name" }),
  env: Prompt.Select({
    message: "Environment",
    choices: [
      { title: "staging", value: "staging" as const },
      { title: "production", value: "production" as const }
    ]
  }),
  confirm: Prompt.Confirm({ message: "Deploy?", initial: true })
})

Prompt.run(form).pipe(
  Effect.flatMap((answers) => Console.log(JSON.stringify(answers))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

我在伪终端里依次输入名字、方向键选择、确认，输出了 `{"name":"bob","env":"production","confirm":true}`。除了 `String`、`Select`、`Confirm`，还有 `Int`、`Number`、`Password`、`Hidden`、`MultiSelect`、`AutoComplete`、`Toggle`、`Date`、`File`、`List` 等。我只验证了上面三个。

## 运行与退出码

先 `npx tsx cli.ts --help` 看帮助，再逐个子命令试：

```bash
npx tsx cli.ts -w team -v create Ship --owner me --limit 5
npx tsx cli.ts ls
npx tsx cli.ts --completions zsh > _tasks
```

未知子命令（`tasks nope`）同样退出码 1 并打印帮助。解析失败不会进入处理函数，因此处理函数里的错误通道只需要关心业务错误。

## 小结

`effect/cli` 的价值在于：Flag 与 Argument 是带类型的解析器，`withSchema` 把校验前移到解析阶段，`yield* parentCommand` 让子命令读取父参数而不用传参，帮助、版本、补全和交互兜底都是免费的。代价是整个模块是 unstable，我的做法是把它关在入口层。选型上，业务单一、Effect 已经在手的命令行工具用它；否则先想想值不值得多引一个 unstable 依赖。
