# 本地修正说明（fork: WanchengWildMan/dsh-claude）

基线是上游 tag `v0.1.64`，与 DSH profile 里原先安装的 npm 版本一致。
这个 fork 比上游多两处修正，两处都在 `src/`（源码）和 `lib/`（发布产物）里各改了一份。

## 1. 自动压缩：`autoCompactEnabled` + `autoCompactWindow`

**症状**：DSH 里的 claude 会话上下文一路涨到模型的硬上限（1,048,576 token），
之后所有请求都被网关以 400 拒绝——包括手动 `/compact`，因为压缩本身要把整个
超长上下文发给模型做摘要。会话就此既不能继续、也不能 resume。

**原因**：Claude Code 在 Agent SDK 这条路径下把自动压缩默认关掉（交互式 CLI 默认开）。
插件没有显式打开，于是压缩永远不会触发。

**改法**（`src/supervisor.ts` 构造 SDK options 处）：

```ts
settings: {
  teammateMode: 'in-process',
  autoCompactEnabled: true,
  autoCompactWindow: autoCompactWindow(),
  ...
}
```

窗口默认 180000，低于网关硬上限，保证压缩请求本身能成功。
可用环境变量 `DSH_CLAUDE_AUTOCOMPACT_WINDOW`（100000–1000000）覆盖。

注意：这个键只在**项目级** settings 里被 Claude Code 采纳。
写进 `~/.claude/settings.json`（用户级）实测无效，所以必须由插件注入。

## 2. 提问：`ask` → `askTimed`（带截止时间）

DSH 0.2.x 的 `UserQuestionService` 暴露 `askTimed(请求, toolUseID, 超时)`：
前端按 tool-use id 认领答案，无人回答时到点释放 Claude 的回合。
旧式 `ask()` 没有 callId，提问会永远挂住。

**改法**（`src/user-question.ts`）：优先用 `askTimed`，宿主没有该方法时回退 `ask`，
拿到 `null`/`undefined`/`pending` 就返回 deny。

## 关于 `lib/`

`lib/` 是上游的发布构建产物（上游仓库里被 `.gitignore` 忽略），
这里用 `git add -f` 强制纳入，并对同一个文件手工应用了上面两处同样的修改。

没有走 `pnpm build` 的原因：构建需要 `@deepseek-ai/*@0.1.7-rc.2` 的**类型**，
而本机 DSH 是 0.2.x；`askTimed` 只存在于 0.2.x，用 0.1.7-rc.2 的类型
`tsc`/`tsdown` 会直接报错。因此源码与产物各维护一份，改动点一一对应：

| 源码 | 产物 |
| --- | --- |
| `src/supervisor.ts` 的 `autoCompactWindow()` / settings | `lib/index.mjs` 的 `DEFAULT_AUTO_COMPACT_WINDOW` / `autoCompactWindow()` / settings |
| `src/user-question.ts` 的 askTimed 回退 | `lib/index.mjs` 的同一段回退逻辑 |

**升级上游版本时**：以新版 `lib/` 为基线，用 `diff` 对照本 fork 的 `lib/`，
把这两处改动重放一遍，再同步 `src/`。
