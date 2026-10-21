---
title: 把 Effect 约定变成机器可检查的规则：language service 与 effect-scan
description: 约定写在文档里会过期。用 @effect/language-service 查类型层，用 effect-scan 与 rules.json 查语法层：一个规则一个 owner、合同与生成物分离、信号与阻断分开。
date: 2026-10-22
tags: [effect, tooling, lint, language-service, contracts]
category: effect
---

写 Effect 久了，会积累一批约定：不要在业务代码里写 `try/catch`，`Effect.run*` 只出现在入口，不要直接读 `process.env`，每个 Effect 都要被 `yield*` 或返回。这些约定一开始都写在文档里，然后慢慢变成「大家应该知道」，再然后在某次重构里被悄悄违反。

我的判断标准很简单：**一条约定如果不能被机器反驳，它就只是愿望。**上一篇迁移实录里我已经发现，连我自己沉淀的规则库里都有一批 v3 写法，文档是会过期的，而过期不会报错。所以这一篇讲的是另一半工作：怎么把约定变成可以失败的检查。

分两层。类型层交给 `@effect/language-service`，它能看到类型，所以能回答「这个 Effect 有没有被消费」。语法与边界层交给我开源的 [@yansircc/effect-scan](https://github.com/yansircc/effect-ecosystem)（npm 包名就是 `@yansircc/effect-scan`），它回答「这个文件有没有写 `try/catch`」「这个 `run*` 是不是在声明过的入口」。两层各有证明不了的东西，下面都会讲到。

本文的命令和输出都是真实跑出来的：`typescript@7.0.2`、`@effect/tsgo@0.45.0`、`effect@4.0.5`、`@yansircc/effect-scan@0.1.21`。

## language service：补上类型检查看不见的那一块

`tsc` 对 Effect 有一个盲区。下面这段代码是完全合法的 TypeScript：

```ts
// floating.ts
import { Effect } from "effect"

export const program = Effect.gen(function* () {
  Effect.log("starting")
  yield* Effect.succeed(1)
})
```

`Effect.log("starting")` 构造了一个 Effect，却既没有 `yield*` 也没有赋值，日志永远不会打印。Effect 只是描述，没人执行它就什么都不会发生，类型系统对此没有意见。这就是 `floatingEffect` 诊断存在的理由，它几乎总是一个真 bug。

安装方式是 patch 一份原生的 TypeScript 7，让 Effect 的诊断在同一次编译事务里返回：

```bash
npm install -D -E typescript@7.0.2 @effect/tsgo@0.45.0
npx effect-tsgo patch
```

然后在 `tsconfig.json` 里配置严重度。我把几条最有价值的升成 `error`：

```json
{
  "compilerOptions": {
    "strict": true,
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnosticSeverity": {
          "floatingEffect": "error",
          "missingEffectError": "error",
          "outdatedApi": "error",
          "globalErrorInEffectFailure": "warning"
        },
        "ignoreEffectWarningsInTscExitCode": true
      }
    ]
  }
}
```

对上面那份文件跑 `tsc`，得到：

```bash
$ npx tsc -p .
src/a.ts(4,3): error TS377001: This Effect value is neither yielded nor used in an assignment. effect(floatingEffect)
```

这是标准的 TypeScript 诊断，所以编辑器、CI、`tsc` 的退出码都天然支持。严重度与退出码的关系我也验证过：`error` 让 `tsc` 退出码为 1；降成 `warning` 后默认仍然是 1，要加上 `ignoreEffectWarningsInTscExitCode` 才会变成 0。也就是说，「提示」与「阻断」是可以用配置精确切开的，这个区分后面还会反复出现。

另外三条诊断我觉得值得开：

- `outdatedApi`：检测 v3 才有的 API 并给出改名提示，迁移期的利器，见上一篇。
- `globalErrorInEffectFailure`：`Effect.fail(new Error("boom"))` 会让所有无标签错误在错误通道里合并成一个类型，诊断建议改用带标签的错误。
- `missingEffectError`：检测没有被处理的错误类型。

它的边界也要说清楚：它只看类型和语法形状，不知道你的架构。「这个 `Effect.runPromise` 该不该在这里」，language service 没法回答。

## effect-scan：把「不许」变成会失败的命令

effect-scan 是一个独立的扫描器。最简单的用法是对着一个目录扫描。我故意写了一个反面文件：

```ts
// a.ts
export async function load(id: string) {
  try {
    const r = await fetch(`https://example.com/${id}`)
    return r.json()
  } catch (e) {
    throw new Error("failed")
  }
}
export const key = process.env.API_KEY
```

```bash
$ npx effect-scan . --output human
[FAIL] Effect mechanical gate failed
errors=6 warnings=0 signals=0

src/a.ts
      1: [ERR  EFF002] 禁用 async function。改写为 Effect.gen(function* () { ... }) + yield*
      2: [ERR  EFF001] 禁用原生 try/catch。改用 Effect.try / Effect.tryPromise 包裹副作用,失败通道用 Data.TaggedError
      3: [ERR  EFF004] 禁用 await。Effect 内部用 yield*; 在边界用 Effect.runPromise / NodeRuntime.runMain
      6: [ERR  EFF024] 禁止 new Error。所有领域错误用 Data.TaggedError class 声明
      6: [ERR  EFF025] 禁用 throw。失败用 yield* new MyTaggedError({ ... }) 或 Effect.fail
      9: [ERR  EFF027] 禁止直读 process.env。改用 Config.string / Config.redacted + Layer 注入
```

退出码是 1。九行代码，六条违规，每条都带着「改成什么」。注意最后一条的提示里写的是 `Config.redacted`，在 4.0.5 里这个名字已经叫 `Config.Redacted` 了。这恰好说明规则的文案也会过期，我下面会讲为什么这件事应该只改一个地方。

`--strict` 模式则要求一个 `.effect-skill.json` 清单，声明项目的形态（`shape`）和「可执行边缘」（`executableEdges`）：哪些文件被允许调用 `Effect.run*`，以及它属于哪种生命周期。

```json
{
  "shape": ["library"],
  "executableEdges": [
    {
      "path": "src/main.ts",
      "owner": "@runtime",
      "reason": "process entry",
      "execution": { "lifecycle": "process-main", "runner": "NodeRuntime.runMain" }
    }
  ]
}
```

在 `src/a.ts` 里随手写一句 `Effect.runPromise(program)`，`--strict` 会报 `EFF400`：`Effect.run*` is only allowed in manifest executableEdges。而在声明过的 `src/main.ts` 里用 `NodeRuntime.runMain`，扫描通过。这就是[运行时边界那篇](/articles/effect-runtime-boundaries-and-testing)里「run 只在入口」这条不变量，从一句话变成了一个会红的检查。

`--strict` 还会把 language service 的诊断收进来：同一个 floating 文件，扫描器报的是 `EFF500`（floating-effect），来源是上面那个 patch 过的编译器，不会再起第二个诊断进程。

## 设计一：一个规则，一个 owner

扫描器里有 58 条规则，全部活在一个文件 `contracts/rules.json` 里。一条规则的完整定义大概长这样：

```json
{
  "id": "EFF027",
  "name": "process-env",
  "severity": "error",
  "profiles": ["node"],
  "family": "source",
  "message": "禁止直读 process.env。改用 Config.string / Config.redacted + Layer 注入",
  "scanner": { "kind": "line-regex", "pattern": "\\bprocess\\.env\\." },
  "facts": ["source.code"]
}
```

规则的编号、严重度、适用的 profile、检查手段（正则、AST 选择器、依赖清单投影）、给人看的文案、引用的参考章节，全在这一处。运行时的规则注册、自动生成的文档，都从它派生，没有第二份手写的规则表。检查脚本会校验 ID 不重复；被淘汰的规则编号放进 `retiredRuleIds`，注册表会拒绝一个编号既是活跃规则又是已淘汰规则，所以编号不会被悄悄复用成另一种含义。

同样的原则延伸到每一种会增长的枚举：清单的语法由一份 JSON Schema 独占，信号的种类由 `signals.schema.json` 独占，支持的 Effect 版本范围、TypeScript 与 provider 的版本由 `effect-capabilities.json` 独占。代码里不再有一份「手写的平行形状」。

提交历史里有一个很典型的例子。版本范围检查（EFF908）原本用一个正则去复刻合同里的范围，结果这个正则只认识 `4.0.0`、`4.0.0-beta.N` 和 minor 大于等于 1 的版本，于是所有稳定的 4.0.x 补丁版本（4.0.1 到 4.0.5）都被报告为「不支持」。修法不是再补一个正则分支，而是让范围只存在于合同里：声明的范围必须是合同范围的子集，已安装的版本被当作一个单点范围。同一个事实，一个位置。

我给自己的判断标准是：**如果同一个事实出现在两处，迟早会有一处过期。**上面的 `Config.redacted` 文案也是一样，它只存在于 `rules.json` 的一条 message 里，修一处，所有派生物重新生成即可。

## 设计二：合同与生成物分离

仓库里有三类东西，我刻意让它们不混在一起。

- 合同：`contracts/*.json` 与清单的 Schema，是唯一手写的事实来源。
- 生成物：`references/generated/` 下的规则摘要、交付清单、profile 路由，由脚本从合同生成，带 `--check` 模式，过期就让验证失败。
- 入口：`SKILL.md` 只是执行入口，不是规则的 owner。验证脚本会检查它不超过一百二十行，并且**不允许**包含手写的规则文案（比如把「禁用 zod」抄一遍进去会直接失败）。

发布出去的产物是只读的。使用者不应该去改投影出来的副本，而是回到生成器仓库修改 owner，再整体重新发布。这条规则看起来很严，但它消灭的是一整类问题：「文档说 A，规则说 B，代码做 C」。当文档是规则的机械投影时，前两者不可能不一致。

对应的还有「快速失败，不要兜底」。比如 `--strict` 要求项目本地安装精确版本的 TypeScript 与 provider，缺了就报 `EFF901`、`EFF902`，而不是退回到某个旧的语言服务。提交历史里也有代价的记录：合同里钉着的 provider 版本落后于项目实际使用的版本，结果在任何一条规则运行之前，扫描就因为工具链检查失败了。修法是更新合同，而不是在扫描器里加一个版本兼容分支。同样，清单的语法是「硬切」：旧格式的条目直接判为无效，而不是靠猜测兼容。历史里还有一次对 v3 的支持尝试，加进去之后又被整体撤回；现在的策略写得很直白：库必须发布 Effect v4，不接受双轨清单。

## 设计三：信号与阻断是两种东西

扫描器有三种输出，权威性完全不同：

- findings：机械可证伪的事实。`error` 是阻断（BLOCK），决定退出码；`warning` 只报告（REPORT）。
- profile：解析出来的路由状态，告诉评审者该读哪些参考章节，它不是判决。
- signals：原子化的观察，交给人或 agent 去复核（REVIEW），永远不阻断。

用 `--output gate-json` 可以看到这个分层。对前面修好的那份代码（`yield*` 之后），扫描通过，但仍然带着两个信号：

```json
{
  "tiers": {
    "block": [],
    "report": [],
    "review": {
      "signals": {
        "blocking": false,
        "byKind": {
          "library-exported-effect-file": 1,
          "library-exported-effect-package": 1
        }
      }
    }
  }
}
```

这两个信号的含义是：一个库导出了 Effect，而其中没有任何 `withSpan`。是不是问题？取决于上下文，所以它只是一个「请看一下」，并且在 `requiredReferences` 里指向可观测性那一节，而不是红灯。

判断一条检查该做成规则还是信号，我用这个标准：**能被 AST 或类型机械证伪的，做成规则，该阻断就阻断；需要语境才能判断的，做成信号；连信号都做不出来的，才写进文档。**

最后，扫描器对自己的能力边界很诚实。通过 `--strict` 只表示机械层没有发现违规，不表示语义评审完成。gate 输出里有一个固定的 `notProven` 列表，默认写明三类没有被证明的东西：超出 language service 的类型层性质、运行时行为、架构边界。产品自己的不变量，应该由使用方在清单里追加，而不是写进扫描器代码。

用 `--evidence` 可以把一次扫描固化成产物：

```bash
npx effect-scan . --strict --output gate-json --evidence .effect-evidence
```

目录里会得到 `gate-summary.json`、`scan-result.json`、`scan-evidence.json` 以及对应的哈希文件。交付时只需要引用 `gate-summary.json` 这一份，原始结果当作文件路径保留，不必贴进任务记录。

## 小结

把约定变成机器可检查的规则，我只坚持几条：

- 先分层：类型层交给 `@effect/language-service`（`floatingEffect`、`outdatedApi`），语法与边界层交给 effect-scan（`try/catch`、`run*` 只在声明过的入口）。
- 一个规则一个 owner：规则、清单语法、信号、版本能力，各自只有一份合同，其余全部派生。
- 合同与生成物分离：手写的只有合同，文档、清单、摘要都由脚本生成并带过期检查，发布物只读。
- 信号与阻断分开：能机械证伪的才阻断，需要语境的只提示，并且老实标出「没有被证明」的部分。
- 快速失败，不加兜底分支；规则本身也要跟着版本走，这就是把它放在一个位置的原因。

这套东西里最重要的不是 58 条规则，而是这些规则每一条都有来历：它们几乎都是某次踩过的坑，被压缩成一行可以失败的检查。如果你只想从中拿走一件事，我建议是：下一次在 code review 里写下「以后别这样写」的时候，先问自己能不能把它写成一条会红的检查。
