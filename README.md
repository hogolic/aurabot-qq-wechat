# aurabot-QQ/Wechat

让大肥鱼在 QQ 和微信聊天的 DeepSeek Harness 插件。两个平台共用人格、模型和主人长期记忆，新会话都进入 `dafeiyu` 工作区，标题保留平台名。可以只绑定其中一个平台。

QQ 适配基于 aureth-labs 的 Aurabot QQ 插件，沿用 MIT 许可。微信通过 thisnick 的 Agent WeChat 网关接入。 [Aurabot QQ 上游](https://github.com/aureth-labs/dsh-aurabot-qq) · [Agent WeChat](https://github.com/thisnick/agent-wechat)

## 安装

先安装桌面 DSH 并配置一个能正常对话的模型。用发布的 `.tgz` 安装，或在源码目录运行 `npm pack` 打包。以下是在安装包所在目录运行的 PowerShell 命令。[下载最新版安装包](https://github.com/hogolic/aurabot-qq-wechat/releases/latest)

```powershell
$packagePath = (Resolve-Path '.\dsh-aurabot-unified-0.2.1.tgz').Path -replace '\\', '/'
dsh plugin --profile desktop add "file:$packagePath"
```

如果 PowerShell 找不到 `dsh`，可以用 DSH 安装目录中的 `resources/runtime/cli/bin/dsh.cmd` 完整路径，前面加 `&`。重开 DSH，在侧栏进入「Aurabot · QQ / 微信」。首次安装默认关闭，试运行默认开启。

## 绑定微信

1. 选「微信」，点「一键启动绑定」。插件按系统和架构获取 Agent WeChat 1.5.1，校验文件后启动本机服务。如果自动下载受阻，点面板上标明的文件名，保留原名下载到系统的 Downloads 文件夹，再点一次按钮。
2. 用机器人微信扫二维码，在手机上确认登录。用另一个微信添加机器人并发私聊。
3. 点「自动识别主人 ID」。用主人微信把页面给出的验证码发给机器人，等主人 ID 自动填入，再点「完成绑定」。
4. 打开总开关。先保持试运行，确认日志能收到主人私聊，再关闭试运行。

已有 Agent WeChat 的用户可以在「手动连接已有网关」里填本机 HTTP 地址、档案 ID 和 `api-token` 文件的绝对路径。档案 ID 可用 `wx accounts list` 查看。[Agent WeChat 使用文档](https://thisnick.github.io/agent-wechat/setup/connect/)

## 绑定 QQ

1. 选「QQ」，在设置向导里填不同的机器人 QQ 号和主人 QQ 号。
2. 已有 OneBot v11 网关时，选「接我已有的 OneBot 机器人」，填正向 WebSocket 地址。网关配置了访问令牌时同时填写。HTTP 接口可选。
3. 使用 SnowLuma 时，从官方发布页手动下载 Windows 完整版，解压后把能看到 `index.mjs` 的目录填到向导。按向导启动服务、阅读协议，用 QQ 客户端登录机器人号并接入。[SnowLuma 发布页](https://github.com/SnowLuma/SnowLuma/releases/latest)
4. 连接后核对登录的机器人号，完成向导时选「先试运行」。确认收到主人私聊后再正式上线。

从旧插件迁移时，先关掉旧插件对应平台的总开关，避免重复回复。

## 共享记忆

两边都绑定后，在面板顶部确认两个账号属于同一主人。插件会把已有的合格主人私聊记忆和会话梗概放入共享库。群聊、其他联系人的记忆、原始聊天记录各自保留。模型、人格、语音、翻唱和生图等设置共用。初次读取已有配置时，以微信版的值为准，并补入 QQ 已配置的翻唱目录。登录网关、主人 ID、白名单和定时发送目标按平台配置。

工作区默认使用 `~/Aurabot/dafeiyu`。两个平台的连接页都可设置同一个自定义目录。设置和记忆保存在 `~/.dsh/plugins-data/aurabot-unified`。

关联主人账号并启用短期记忆后，微信主人私聊可接续合并版 QQ 最近的主人私聊。每轮最多补入 6 条近期消息，时间范围沿用短期记忆设置，上限 24 小时。长期主人记忆仍由两个平台共用。

## 微信后台语音

后台语音需要 FFmpeg 和 FFprobe。把两者加入网关进程的 PATH，或在翻唱页指定本机工具后，到「微信 → 连接」点击「修复后台语音编码」。手动启动的网关由你在启动环境中配置这两个工具。[Agent WeChat 的媒体依赖](https://thisnick.github.io/agent-wechat/setup/requirements/)

网关若标记「投递结果待核对」，在微信里确认送达情况。[Agent WeChat 的发送回执](https://thisnick.github.io/agent-wechat/how-it-works/sends/)

## 开发

`npm test` 跑回归测试，`npm run build` 生成 DSH 客户端入口和预设，`npm pack` 生成安装包。
