# 轨迹与余额（agent-trace）

一个 Cindy 插件，在任务侧边栏里放两个页签：

- **轨迹**：读取当前任务（Claude Code / Pi 引擎）的会话记录，按轮展示输入、输出、缓存命中率、生成速率和上下文占用；可一键复制 `/compact` 压缩上下文。
- **余额**：粘贴 CC Switch 的用量查询脚本（或选内置预设：通用 / New API / Sub2API），一键查询各供应商余额；支持页签栏芯片、近期消耗、每 10 分钟自动刷新（插件后台计时，只在你看得到状态栏或面板时才查）。密钥只存入 Cindy 系统保险库，界面和插件都读不回。
- **状态栏**（输入框下方）：显示余额金额，点一下立即刷新；查询失败或超过 60 分钟没更新时金额后加「↺」。伙伴聊天里另显示当前对话的上下文占用「上下文 N%」，窗口大小在插件设置里改（默认 1000000 tokens）。

当前版本 **0.3.1**，需要 Cindy ≥ 0.1.136。

## 安装

```bash
git clone https://github.com/Flouax/agent-trace.git
```

然后在 Cindy 里让伙伴调用 `ghost_forge_install`，`dir` 指向克隆下来的 `agent-trace/agent-trace` 目录（含 `ghost.json` 的那一层），按弹出的权限卡确认即可。

## 目录

```
agent-trace/
  ghost.json         插件清单
  main.js            主脑（工具、面板入口、状态栏按钮与余额定时刷新）
  settings.html/js   设置页
  panel/             面板：轨迹、余额、外壳、图标、样式
  node/              随包 Node 服务：引擎适配（cc / pi）、余额抓取、脚本沙箱
  assets/icon.png    图标
```

## 说明

- 余额查询脚本在沙箱里执行，请只粘贴来源可信的脚本。
- 本仓库只含插件源码；测试、夹具、设计稿和打包产物留在作者本地。
