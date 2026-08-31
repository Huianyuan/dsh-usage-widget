# DSH 订阅用量挂件（DSH Usage Widget）

DSH（DeepSeek Harness）Web 界面右下角的**订阅用量卡片**：5 小时滚动窗口 / 本周 / 本月三档用量百分比 + 官网同款重置倒计时 + 提供商图标。订阅源以**代码模块**注册（`SOURCES[]`），新增订阅源时**前端与路由零改动**；内置 **OpenCode Go** 订阅为第一个开箱即用的默认源。

## 项目来源

本项目诞生于一个真实需求：订阅 OpenCode Go（opencode.ai 官方订阅）后，想随时在 DSH Web 界面看到自己的用量——**5 小时滚动窗口用量、每周用量、每月用量**。

实现路径：

1. 调研 opencode 官方仓库 [`sst/opencode`](https://github.com/sst/opencode) 源码，定位到公开用量接口 `GET https://opencode.ai/zen/go/v1/usage`（`Authorization: Bearer <key>`），并用真实账号实测确认响应结构（`{usage:{rolling,weekly,monthly:{status,percent,resetsAt}}}`，`rolling` 即 5 小时滚动窗口）；
2. 参考 DeepSeek-Balance-Whale-Widget 的 **DSH bundle 插件**架构，写成**通用订阅用量仪表盘**：订阅源注册表（`SOURCES[]` 代码模块）+ 归一化数据 + 通用前端渲染。未来新增订阅源 = 在注册表里加一个模块，互不影响，无需改前端。

## 参考项目

- **[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)** —— 架构同源，本项目沿用了它已验证的方案：
  - DSH bundle 插件挂载方式（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 插入）
  - 宿主插件导出形态（`{name, inject:['webServer','credentials'], apply(ctx)}`）与生命周期清理（`ctx.effect` 收集 disposer，HMR 安全）
  - 拉取健壮性策略：超时、5xx 重试、内存缓存 + in-flight 去重、瞬时失败回退最近数据并标记 stale
  - 开发期热更思路（`watchUserPatches` 实时生效，无需重启）

## 功能特性

- 📊 **三档用量**：5小时 / 本周 / 本月，百分比 + 官网同款重置倒计时（`6 天 9 小时后重置` / `57 分钟后重置`）
- 🎨 **提供商图标**：浅色卡片用官方品牌 logo；加载失败自动降级为首字母圆标
- 🚦 **状态色**：`ok` 绿色进度条；`rate-limited` 红色 +「已限流」角标
- 🔄 **自动/手动刷新**：60 秒自动刷新 + 点击卡片手动刷新，带按压回弹动效
- 🔑 **key 多级解析**：DSH 凭据优先 → 本地配置文件回退，**零配置开箱即用**
- 🧩 **订阅源注册表**：代码模块注册，自动发现（无 key 的源自动隐藏）、每源独立缓存与错误隔离

## 内置订阅源

| id | 名称 | 数据来源 | key 解析 |
|---|---|---|---|
| `opencode-go` | OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | DSH 凭据 `OPENCODE_GO_KEY` → `~/.local/share/opencode/auth.json`(`opencode-go.key`) → `~/.config/opencode/opencode.json`(`provider.opencodego.options.apiKey`) |

前三处都找不到 key 时，该订阅源卡片自动隐藏（不影响其他源）。

## 安装

### 方式 A：直接从 GitHub 安装（推荐）

```powershell
dsh plugin --profile web add github:Huianyuan/dsh-usage-widget
```

说明：

- 装完后插件出现在 DSH 的**插件管理页面**，之后可以直接在页面里更新，无需手动执行命令
- 网络需要代理时，先设置代理环境变量再执行：
  ```powershell
  $env:http_proxy="http://<ip>:<port>"; $env:https_proxy="http://<ip>:<port>"; $env:all_proxy="socks5://<ip>:<port>"; dsh plugin --profile web add github:Huianyuan/dsh-usage-widget
  ```
- 安装完成后**重启 `dsh web`**，再 **F5 刷新浏览器**

### 方式 B：本地链接安装（开发用）

在**仓库根目录**（`package.json` 所在目录）执行：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>
```

> ⚠️ 仓库根目录就是插件包，不要写成带子目录的路径。安装后重启 `dsh web` + F5。

### 卸载

```powershell
dsh plugin --profile web remove dsh-usage-widget
```

## 验证

```powershell
curl http://127.0.0.1:3080/usage/dashboard.json                  # 200 JSON，各源三档用量
curl http://127.0.0.1:3080/usage/widget.js                       # 200 JS
curl http://127.0.0.1:3080/usage/icon/opencode-go.svg            # 200 image/svg+xml
```

浏览器 F5 后右下角出现卡片；点击卡片可手动刷新。

## 数据来源与精度说明（内置源 opencode-go）

- 公开接口：`GET https://opencode.ai/zen/go/v1/usage`，头 `Authorization: Bearer <key>`
- 响应三档 `rolling / weekly / monthly`：`{ status, percent, resetsAt }`
  - `rolling` = **5 小时滚动窗口**（服务端 5h 内用量/限额）
  - `weekly` = 自然周（UTC 周一 0 点重置）
  - `monthly` = 月度订阅周期（续费日重置）
- `percent` 为**整数**（服务端向下取整）；官方控制台显示的小数（如 9.6%）来自其服务端内部数据库，公开接口不提供——本插件展示公开接口能拿到的最精确值
- 倒计时 `resetsAt` 与官网一致（`X 天 Y 小时后重置` 官网同款措辞）

## 如何接入新订阅源（扩展）

订阅源是 `lib/index.js` 中 `SOURCES[]` 数组里的代码模块——每个源独立：key 解析链、接口拉取与归一化互不影响，可随时叠加。

1. 编辑 `lib/index.js` 的 `SOURCES` 数组，新增条目：

   ```js
   {
     id: 'some-service',                    // 稳定 ID（决定图标路由）
     name: 'Some Service',                  // 展示名
     metric: 'percent-windows',             // 指标类型
     keyResolvers: [                        // key 解析链（按序取第一个非空）
       credentialResolver('SOME_KEY'),      // DSH 凭据
       { label: 'config', resolve: () => readConfigJsonKey(os.homedir(), 'provider.xxx.options.apiKey') },
     ],
     async fetchUsage(key) {
       // 调对端接口，返回归一化数据：
       return {
         metric: 'percent-windows',
         windows: [
           { id: 'rolling', label: '5小时', percent: 6, status: 'ok', resetsAt: '2026-08-31T15:46:50Z' },
           { id: 'weekly', label: '本周', percent: 2, status: 'ok', resetsAt: '2026-09-07T00:00:00Z' },
           { id: 'monthly', label: '本月', percent: 13, status: 'ok', resetsAt: '2026-09-27T12:18:37Z' },
         ],
       }
     },
   }
   ```

2. （可选）放图标 `assets/icons/<id>.svg`；缺失时前端自动用首字母圆标兜底
3. 重启/热更后生效：前端按 `/usage/dashboard.json` 自动渲染新卡片，**不需要改前端和路由**

未来指标类型扩展（如余额金额、token 用量）：`metric` 新增枚举 + `windows[]` 条目扩展字段（`unit` / `used` / `limit`），前端对未知 `metric` 降级显示原始数字，不崩溃。

## 后续规划（未实现，仅记录方向）

- **更多订阅源**：按个人需要以代码模块形式继续叠加（兼容切换，不影响已有源）
- **按当前会话模型自动切换**：监听会话事件（如 `assistant/message` 携带的 provider/model），自动识别当前使用的模型所属订阅源，高亮/切换对应卡片
- **声明式订阅配置**（评估中）：若订阅形态趋同，可考虑把代码模块下沉为配置项（URL + key 来源 + 字段映射）

## 开发

```powershell
# 单元测试（core / fetch / plugin / widget-format，共 17 例）
node test/core.test.mjs
node test/fetch.test.mjs
node test/plugin.test.mjs
node test/widget-format.test.mjs

# 开发期热更：lib/index.js 复制到 profile 并编辑 ~/.dsh/profiles/web/cordis.patch.yml，
# watchUserPatches 实时生效，无需重启 dsh web（正式用请按「安装」章节）
```

目录结构：

```text
dsh-usage-widget/
├── package.json          # DSH bundle 插件元数据（dsh.bundle.patch）
├── cordis.patch.yml      # 插件挂载声明
├── lib/
│   └── index.js          # 宿主插件本体：订阅源注册表 + 路由 + 前端脚本
├── assets/
│   └── icons/
│       └── opencode-go.svg   # 内置源 opencode-go 的官方提供商图标
├── test/                 # node:test 单元测试
└── README.md
```

## 许可证

基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。