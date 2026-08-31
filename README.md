# opencode-go-widget

DSH Web 右下角的 **OpenCode Go 订阅用量卡片**：5 小时滚动 / 本周 / 本月三档用量百分比 + 重置倒计时，官方提供商图标，多订阅源可扩展（前端零改动）。

## 安装

```powershell
dsh plugin --profile web add link:F:\ALL_AI\小助理\opencode-go-widget
# 重启 dsh web，浏览器 F5
```

## API key 来源（优先级）

1. DSH 凭据 `OPENCODE_GO_KEY`（可选，`~/.dsh/.credentials.yaml` 或凭据界面）
2. `~/.local/share/opencode/auth.json` 的 `opencode-go.key`
3. `~/.config/opencode/opencode.json` 的 `provider.opencodego.options.apiKey`

前两者都没有时卡片不显示（自动隐藏该源）。

## 验证

```powershell
curl http://127.0.0.1:3080/usage/dashboard.json   # 200 JSON，三档用量
curl http://127.0.0.1:3080/usage/widget.js        # 200 JS
curl http://127.0.0.1:3080/usage/icon/opencode-go.svg  # 200 image/svg+xml
```

## 卸载

```powershell
dsh plugin --profile web remove opencode-go-widget
```

## 数据来源

`GET https://opencode.ai/zen/go/v1/usage`（`Authorization: Bearer <your key>`），返回 `usage.rolling/weekly/monthly`，每档 `{status, percent, resetsAt}`；rolling 即 5 小时滚动窗口。接口不返回金额，只给百分比。

## 如何接入新订阅源

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
           { id: 'rolling', label: '5小时', percent: 6, status: 'ok', resetsAt: '...' },
           { id: 'weekly', label: '本周', percent: 2, status: 'ok', resetsAt: '...' },
           { id: 'monthly', label: '本月', percent: 13, status: 'ok', resetsAt: '...' },
         ],
       }
     },
   }
   ```

2. （可选）放图标 `assets/icons/<id>.svg`；缺失时前端自动用首字母圆标兜底
3. 重启/热更后生效：前端按 `dashboard.json` 自动渲染新卡片，**不需要改前端和路由**

## 明确不做

拖拽/吸附/动画/音效、桌面通知、余额金额模式（`percent-windows` 之外仅预留 schema 扩展位）。