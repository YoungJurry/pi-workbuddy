# pi-workbuddy

面向 **WorkBuddy AI 国际版** 的轻量 Pi 原生 Provider。由 Pi 直接访问 `https://www.workbuddy.ai`，不运行 WorkBuddy CLI，不启动本地代理。

> 非官方、实验性集成。兼容代码改编自 [lutfi238/pi-workbuddy@0.2.4](https://github.com/lutfi238/pi-workbuddy/tree/55b3baafce9099aed3aa98d1a1714c467e741b60)，保留其账号头、gzip 和 SSE 修正。0.1.1 起，客户端身份头改为官方 WorkBuddy AI 5.8.4 安装包中静态确认的桌面网关配置，不再发送插件名称作为使用端。来源及修改范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [身份字段核对记录](docs/client-identity.md)。
>
> 自动化测试均使用离线模拟响应，不读取真实账号或消耗额度；不代表所有模型或账号等级都经过真实服务验证。工具、图片和长期 token 刷新的真实服务兼容性仍需由使用者验证。

## 安装

需要 Node.js ≥ 22.19，以及支持完整 Provider 接口的 Pi；已在 **Pi 1.4.0** 上做过离线宿主集成测试。

```sh
pi install git:github.com/YoungJurry/pi-workbuddy
```

已有安装更新到最新代码：

```sh
pi update git:github.com/YoungJurry/pi-workbuddy
```

重启 Pi 或执行 `/reload`，然后：

1. `/login`，选择 **WorkBuddy AI**，在浏览器完成国际版账号登录。
2. `/workbuddy refresh`，拉取账号模型目录。
3. `/model`，选择 `workbuddy/<模型 ID>`。

每次 `session_start` 都会尝试刷新已配置账号的 WorkBuddy 目录。**交互模式先使用缓存／回退目录进入会话，模型列表在后台更新，不再阻塞启动**；无头模式仍等待刷新完成。未登录时不请求网络。不要与其他注册同名 `workbuddy` Provider 的扩展同时启用。本仓库不发布到 npm，`npm:pi-workbuddy` 指的是上游项目，不是本仓库。

不需要安装或运行 WorkBuddy 桌面版／CLI，也不读取其凭据。浏览器登录过程中不监听本地回调端口。

## 轻量化边界

全局事件仅订阅 **`session_start`** 和 **`session_shutdown`**，分别用于启动目录刷新和取消未完成的刷新。初始化工厂本身不联网。

- 无 `message_end`、`agent_end`、`model_select`、`context`、请求或流事件钩子。
- 其他模型的每轮／每 token 请求不会进入本插件；不是进入回调再做一次来源判断。
- 不包装 `globalThis.fetch`、`node:http/https` 或全局 API 注册表。
- 无定时轮询、文件监听、常驻任务、子进程、本地监听端口、积分查询或 Pendant 适配。交互启动只发起一次后台目录刷新，请求仍有 15 秒超时；退出、切换会话或重载时取消，不等待网络返回。
- 不注册工具、不增加工具声明／提示词、不修改 Pi 全局设置。
- 没有额外运行时 npm 依赖。Pi 包只声明为 peers，由宿主提供。
- WorkBuddy 自身请求才创建专属 fetch 适配器、生成 ID、gzip 压缩并整理 SSE。

**“不用时零开销”指一次性启动刷新结束后，无插件自设的逐轮回调或常驻后台任务。** 模块、模型目录仍占少量内存，启动加载也有成本；不能宣称零内存或绝对零 CPU。Pi 为列举模型、检查认证或用户操作而调用 Provider 的正常管理逻辑仍存在，如同内置 Provider。显式刷新时，Pi 也可能为已过期凭据刷新 token。

目录刷新使用 Pi 原生 `refreshModels` 契约。普通非强制目录刷新只恢复缓存，不请求 `/v3/config`；启动钩子和手动命令用 `force: true` 拉取目录，交互启动不等待其完成；手动 `/workbuddy refresh` 仍等待并报告结果。后台刷新不会覆盖用户在等待期间选中的其他模型，也不会在活动回合中切换模型。其他宿主主动发起的强制刷新也遵循同一契约，不冒充后台零操作。

`PI_OFFLINE`（Pi 的 `--offline` 设置）下，启动和手动目录刷新仅使用缓存；它不是“禁止已选模型发送推理请求”的开关。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/login` → WorkBuddy AI | 浏览器登录，凭据由 Pi 保存 |
| `/logout` → WorkBuddy AI | 删除 Pi 中的登录凭据，不代替服务端撤销账号会话 |
| `/workbuddy`、`/workbuddy status`、`/workbuddy doctor` | 本地状态，不查询积分，不请求模型 |
| `/workbuddy refresh` | 刷新模型目录，不发推理请求 |
| `/model` | 由 Pi 选择模型 |

状态输出显示是否已配置、目录来源、模型数、当前模型，以及最近一次目录刷新失败的具体报错。不主动输出本地凭据或账号资料。

## 官方报错透传（0.1.3 起）

不再把 WorkBuddy 的报错正文替换成笼统的“请求失败”：

- HTTP 错误保留完整响应正文，包括 `code`、`msg`、`displayMsg`、`displayTips`、`requestId`、`actions` 及其他字段；纯文本／HTML 报错也保留。
- SSE 流内错误保留错误帧的完整 `data` 内容；HTTP 200 返回 JSON 业务错误时也会报告失败，而不是当作成功或只提示“不是 SSE”。
- 登录、token 刷新、目录刷新和状态中的刷新错误同样显示官方正文。
- 保留 HTTP 失败状态、重试响应头和原始业务码，`context_length_exceeded` 不再覆盖原始错误说明。

例如 `11158` 响应中的“当前账号类型暂不支持该模型”、`14003` 中的“模型繁忙，请换模型或稍后重试”会到达 Pi 的最终错误消息，不用再单独抓请求。

为了让 Pi 的 OpenAI SDK 不丢弃 WorkBuddy 特有字段，HTTP 错误正文作为完整文本放入兼容错误的 `message`。Pi 可能添加状态前缀或 JSON 转义；插件不翻译、删字段或摘要化正文。原有资源上限仍保留（HTTP 正文 2 MiB，单个 SSE 帧 1 MiB），超限或读取失败会明确报告，不会静默截断并冒充完整报错。

**注意：错误正文不再脱敏。** 如果服务端回显了账号信息、token 或请求片段，这些内容也可能进入 Pi 的错误显示和会话记录；分享日志前请自行检查。插件不额外附加请求头、请求正文、本地凭据或成功的登录响应。可信地址校验、拒绝重定向、账号绑定、gzip、超时、取消和输出预算保护不变。

## 原生接入

```text
Pi 的工具／会话／压缩／权限
          ↓
完整原生 Provider（workbuddy）
          ↓
Pi 自带 OpenAI Chat Completions 转换与流处理
          ↓
本次 WorkBuddy 请求专用的客户端兼容适配
          ↓
https://www.workbuddy.ai/v2/chat/completions
```

Pi 保留 Agent 控制权。登录交互、凭据保存、token 刷新锁、模型存储、消息／工具转换、用量、取消及流事件都沿用宿主契约；不复制一套 Agent 引擎。

调用方的 `onPayload`、`onResponse`、`onProviderStreamEvent` 和取消信号继续传递。压缩等无工具请求仍走相同 Provider，不伪造可执行工具。

第三方扩展的嵌套请求应使用 `ctx.modelRegistry.streamSimple()` 等原生接口。若绕开 Provider、直接调用裸 `pi-ai/compat`，无法获得这个服务的专属传输；本插件不会为覆盖这种旁路而修改全局传输。

## 保留的客户端兼容逻辑

- `User-Agent: WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0`，来自已核对的官方桌面网关 UA 构造格式及其捆绑版本；重复的 WorkBuddy 段是该构造格式的一部分。
- `X-IDE-Type: WorkBuddy`、`X-IDE-Name: WorkBuddy`、`X-IDE-Version: 5.8.4`；登录、目录、刷新及推理共用同一配置。
- 插件自己的版本仅用于本地包／状态显示，不写入客户端身份头或 UA；不会因此改动 Pi 系统提示词、任务和工具内容。
- `Authorization`、`X-User-Id`、`X-Domain` 和企业／租户相关账号头。
- 会话关联及逐请求／消息 ID。
- gzip 请求、SSE 响应、重复／缺失工具调用 ID 的整理、UTF-8 边界处理、usage 尾帧。
- `system` 角色、`max_tokens` 等上游适配，以及 Pi 剩余上下文／输出上限保护。
- 登录、目录、刷新及推理请求固定可信 HTTPS origin，拒绝重定向、外部模型 URL、远程 API Key 和协议注入。

版本标识与私有接口可能随上游更新失效，尤其是客户端校验的业务错误 `12403`。这是已核对源码的身份头配置，不是完整客户端抓包重放，也不保证服务端无法识别第三方调用或判定为奖励活动合格客户端。认证、账号权限、地域、限流及额度限制不变。

更新只影响之后发出的请求；服务端历史用量记录中的 `pi-workbuddy` 不会被改写。

## 模型目录与限制

模型从账号 `/v3/config` 动态发现；公开元数据通过 Pi 模型存储持久化，并按账号域／用户／租户的哈希隔离。token 不写入目录缓存。失败时保留上次有效目录。

沿用上游对禁用、不支持工具、自定义端点模型及 DeepSeek `-sg` 变体的过滤。模型选择器出现某个模型，不代表账号必然有权使用。

上下文、输出、图片和推理档位保留上游目录投影及其供应商补充表。**补充表是乐观能力描述，不证明 WorkBuddy 网关实现了供应商全部能力。** 调用方可以限制输出；插件不做收费探测、不自动更换模型、不将限额错误冒充上下文溢出。

显示费用为零是因为不知道 WorkBuddy 的美元单价，**不是承诺免费**；实际消费以 WorkBuddy 账号计费为准。插件不获取积分余额。

## 测试

无需安装依赖：

```sh
npm test
npm run check
```

测试预加载的网络防火墙拒绝真实全局 fetch 和 Socket 连接。登录、目录、推理响应及凭据均为合成数据；不读取真实 `auth.json`，不创建 Pi 会话。

若本机已有 Pi，可另外启用真实宿主模块的离线集成测试：

```sh
PI_AI_TEST_PATH=/path/to/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist npm test
```

默认会跳过需要宿主的测试；设置上述路径后，检查实际扩展加载器、原生 Provider 派发、token 刷新锁、工具往返、图片、思考、用量、取消及请求钩子。全程仍使用假网络。

测试也验证只订阅会话生命周期事件、启动刷新不阻塞、取消与模型选择竞态、手动／无头刷新仍等待、其他 Provider 多轮调用不触发 WorkBuddy 认证／目录／传输，以及离线恢复、缓存隔离和官方报错透传（含 Pi 最终错误消息）。

## 安全与许可

凭据只由 Pi 正常存入自己的 profile。不要提交或分享 `auth.json`、token、登录链接或敏感调试记录。不会自动读取桌面凭据、签到、充值、领取奖励或切换账号。

只使用你有权访问的账号和服务，遵守服务条款。服务商可能拒绝第三方客户端。本项目与腾讯、WorkBuddy 或 Pi 均无官方隶属关系；源码可以公开审查，但实验性集成没有稳定性承诺。

MIT；保留原项目版权声明，详见 [LICENSE](LICENSE)。
