# pi-workbuddy

面向 **WorkBuddy AI 国际区和中国区** 的轻量 Pi 原生双 Provider。由 Pi 直接访问各区固定的官方 HTTPS origin，不运行 WorkBuddy CLI，不启动本地代理。

> 非官方、实验性集成。兼容代码改编自 [lutfi238/pi-workbuddy@0.2.4](https://github.com/lutfi238/pi-workbuddy/tree/55b3baafce9099aed3aa98d1a1714c467e741b60)，保留其账号头、gzip 和 SSE 修正。国际区自 0.1.1 起使用官方 WorkBuddy AI 5.8.4 安装包中静态确认的桌面网关身份配置，不再发送插件名称作为使用端；中国区按官方 WorkBuddy AI CN 5.8.3 材料静态核对。来源及修改范围见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[国际区身份字段核对记录](docs/client-identity.md) 和 [中国区协议核对记录](docs/cn-protocol.md)。
>
> 自动化测试均使用离线模拟响应，不读取真实账号或消耗额度；离线通过不代表任一区真实服务可用。中国区协议已按官方 5.8.3 静态核对，但**尚未经过真实中国区服务验证**；工具、图片、长期 token 刷新及各账号等级的真实服务兼容性仍需由使用者验证。

## 安装

需要 Node.js ≥ 22.19，以及支持完整 Provider 接口的 Pi；已在 **Pi 1.4.0** 上做过离线宿主集成测试。

```sh
pi install git:github.com/YoungJurry/pi-workbuddy
```

已有安装更新到最新代码：

```sh
pi update git:github.com/YoungJurry/pi-workbuddy
```

重启 Pi 或执行 `/reload`，按所需区域登录并选模：

| 区域 | `/login` 选择 | 手动刷新目录 | `/model` 模型前缀 |
| --- | --- | --- | --- |
| 国际区 | **WorkBuddy AI** | `/workbuddy refresh` | `workbuddy/<模型 ID>` |
| 中国区 | **WorkBuddy AI CN** | `/workbuddy-cn refresh` | `workbuddy-cn/<模型 ID>` |

`/login` 需分别选择对应区域，在浏览器完成该区账号登录。国际区保留原有 `workbuddy` Provider、显示名、命令和默认行为；从 0.1.x 升级时，已保存的国际区凭据和模型选择不做迁移，无需重新登录，升级也不会把任何国际区数据复制给中国区；0.2.1 的旧目录缓存失效及首次刷新要求见后文“模型目录与限制”。两区凭据及目录缓存隔离；中国区必须单独登录，不复制或迁移国际区凭据、缓存或模型设置，也不自动切换已有的国际区模型。

中国区实现以官方 WorkBuddy AI CN 5.8.3 材料的静态协议核对和离线模拟为依据，**尚未经过真实中国区服务验证**；登录、目录、推理能否实际可用以使用者自测为准。

每次 `session_start` 都会**并行刷新已配置账号的各区目录**。**交互模式先使用缓存／回退目录进入会话，模型列表在后台更新，不再阻塞启动**；无头模式仍等待刷新完成。未登录某区时不请求该区：仅登录国际区不会访问中国区，均未登录时不请求网络。不要与其他注册同名 `workbuddy` 或 `workbuddy-cn` Provider 的扩展同时启用。本仓库不发布到 npm，`npm:pi-workbuddy` 指的是上游项目，不是本仓库。

不需要安装或运行 WorkBuddy 桌面版／CLI，也不读取其凭据。浏览器登录过程中不监听本地回调端口。

## 轻量化边界

两个 Provider **共同只订阅一对 `session_start` 和 `session_shutdown` 钩子**，分别用于启动目录刷新和取消未完成的刷新，不按区域重复订阅。初始化工厂本身不联网。两区均不引入代理、CLI、常驻任务或工具。

- 无 `message_end`、`agent_end`、`model_select`、`context`、请求或流事件钩子。
- 其他模型的每轮／每 token 请求不会进入本插件；不是进入回调再做一次来源判断。
- 不包装 `globalThis.fetch`、`node:http/https` 或全局 API 注册表。
- 无定时轮询、文件监听、常驻任务、子进程、本地监听端口、积分查询或 Pendant 适配。交互启动只发起一批后台目录刷新，已配置的各区并行，请求仍有 15 秒超时；退出、切换会话或重载时取消，不等待网络返回。
- 不注册工具、不增加工具声明／提示词、不修改 Pi 全局设置。
- 没有额外运行时 npm 依赖。Pi 包只声明为 peers，由宿主提供。
- WorkBuddy 自身请求才创建专属 fetch 适配器、生成 ID、gzip 压缩并整理 SSE。

**“不用时零开销”指一次性启动刷新结束后，无插件自设的逐轮回调或常驻后台任务。** 模块、模型目录仍占少量内存，启动加载也有成本；不能宣称零内存或绝对零 CPU。Pi 为列举模型、检查认证或用户操作而调用 Provider 的正常管理逻辑仍存在，如同内置 Provider。显式刷新时，Pi 也可能为已过期凭据刷新 token。

两区目录刷新均使用 Pi 原生 `refreshModels` 契约。0.2.2 起，每个 Provider 实例在当前账号首次成功联网加载目录之前，只要宿主允许联网，即使没有 `force` 也会拉取远端目录；磁盘缓存仍先恢复，但不算本次加载的联网成功。这样 Pi 随后的全局普通刷新即使取消启动钩子的强制刷新，也能接手完成，不会只剩回退模型。成功发布远端目录后，后续普通非强制刷新复用内存目录，不反复请求 `/v3/config`；账号变化或扩展重新加载后重新判断。

启动钩子和手动命令仍用 `force: true` 拉取对应区域目录，交互启动不等待其完成；手动 `/workbuddy refresh` 或 `/workbuddy-cn refresh` 仍等待并报告结果。只保留原有的一对 `session_start`／`session_shutdown` 钩子，不增加延时、轮询、自动重试循环或常驻任务。被取消的旧请求不会覆盖新请求的模型目录或错误状态。后台刷新不会覆盖用户在等待期间选中的其他模型，也不会在活动回合中切换模型。其他宿主主动发起的强制刷新也遵循同一契约，不冒充后台零操作。

`PI_OFFLINE`（Pi 的 `--offline` 设置）下，启动和手动目录刷新仅使用缓存；它不是“禁止已选模型发送推理请求”的开关。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/login` → WorkBuddy AI / WorkBuddy AI CN | 分别登录国际区／中国区，凭据由 Pi 按 Provider 保存 |
| `/logout` → WorkBuddy AI / WorkBuddy AI CN | 删除对应区域在 Pi 中的登录凭据，不代替服务端撤销账号会话 |
| `/workbuddy [status\|doctor]` | 国际区本地状态，不查询积分，不请求模型；省略参数即 `status` |
| `/workbuddy-cn [status\|doctor]` | 中国区本地状态，不查询积分，不请求模型；省略参数即 `status` |
| `/workbuddy refresh` | 刷新国际区模型目录，不发推理请求 |
| `/workbuddy-cn refresh` | 刷新中国区模型目录，不发推理请求 |
| `/model` | 由 Pi 选择 `workbuddy/…` 或 `workbuddy-cn/…` 模型 |

完整命令格式分别为 `/workbuddy [status|doctor|refresh]`、`/workbuddy-cn [status|doctor|refresh]`。状态输出显示对应区域是否已配置、目录来源、模型数、当前模型，以及最近一次目录刷新失败的具体报错。命令只作用于自身区域，不会附带刷新另一区。不主动输出本地凭据或账号资料。

## 官方报错透传（国际区 0.1.3 起；中国区 0.2.0 起）

不再把 WorkBuddy 的报错正文替换成笼统的“请求失败”（两区行为一致）：

- HTTP 错误保留完整响应正文，包括 `code`、`msg`、`displayMsg`、`displayTips`、`requestId`、`actions` 及其他字段；纯文本／HTML 报错也保留。
- SSE 流内错误保留错误帧的完整 `data` 内容；HTTP 200 返回 JSON 业务错误时也会报告失败，而不是当作成功或只提示“不是 SSE”。
- 登录、token 刷新、目录刷新和状态中的刷新错误同样显示官方正文。
- 保留 HTTP 失败状态、重试响应头和原始业务码，`context_length_exceeded` 不再覆盖原始错误说明。

国际区例如 `11158` 响应中的“当前账号类型暂不支持该模型”、`14003` 中的“模型繁忙，请换模型或稍后重试”会到达 Pi 的最终错误消息，不用再单独抓请求。

为了让 Pi 的 OpenAI SDK 不丢弃 WorkBuddy 特有字段，HTTP 错误正文作为完整文本放入兼容错误的 `message`。Pi 可能添加状态前缀或 JSON 转义；插件不翻译、删字段或摘要化正文。原有资源上限仍保留（HTTP 正文 2 MiB，单个 SSE 帧 1 MiB），超限或读取失败会明确报告，不会静默截断并冒充完整报错。

**注意：错误正文不再脱敏。** 如果服务端回显了账号信息、token 或请求片段，这些内容也可能进入 Pi 的错误显示和会话记录；分享日志前请自行检查。插件不额外附加请求头、请求正文、本地凭据或成功的登录响应。可信地址校验、拒绝重定向、账号绑定、gzip、超时、取消和输出预算保护不变。

## 原生接入

```text
Pi 的工具／会话／压缩／权限
          ↓
完整原生 Provider（workbuddy / workbuddy-cn）
          ↓
Pi 自带 OpenAI Chat Completions 转换与流处理
          ↓
本次 WorkBuddy 请求专用的客户端兼容适配
          ↓
各区固定的官方聊天 endpoint（不跨区）
```

Pi 保留 Agent 控制权。登录交互、凭据保存、token 刷新锁、模型存储、消息／工具转换、用量、取消及流事件都沿用宿主契约；不复制一套 Agent 引擎。

调用方的 `onPayload`、`onResponse`、`onProviderStreamEvent` 和取消信号继续传递。压缩等无工具请求仍走相同 Provider，不伪造可执行工具。

第三方扩展的嵌套请求应使用 `ctx.modelRegistry.streamSimple()` 等原生接口。若绕开 Provider、直接调用裸 `pi-ai/compat`，无法获得这两个区域 Provider 的专属传输；本插件不会为覆盖这种旁路而修改全局传输。

## 区域与信任边界

国际区与中国区使用独立的地域 profile，分别固定可信 HTTPS origin、账号域和聊天 endpoint；凭据必须绑定所属区域及账号，缓存同时按区域和账号隔离。拒绝跨区凭据、跨区账号域或聊天 endpoint，不自动跨区回退，也不把一侧的 token 发给另一侧。

| 项目 | 国际区 | 中国区 |
| --- | --- | --- |
| origin | `https://www.workbuddy.ai` | `https://www.workbuddy.cn` |
| 聊天 endpoint | `/v2/chat/completions` | `/v2/chat/completions` |
| 目录 endpoint | `/v3/config` | `/v3/config` |
| 登录 `platform` | `workbuddy-ai` | `workbuddy` |
| 登录后账号查询 | `/v2/plugin/login/account?state=…` | `/v2/plugin/account`（账号作用域流程） |
| `User-Agent` | `WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0` | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` |
| `X-IDE-Version` | `5.8.4` | `5.8.3` |

中国区范围限定为官方生产 SaaS 常规账号：只使用 `https://www.workbuddy.cn` 及其官方登录域名，不自动切换到其他 origin 作备用，不包含 staging、自建部署或通配符 SSO。国际区配置保持 5.8.4 不变。两区协议来源及核对过程见 [中国区协议核对记录](docs/cn-protocol.md) 与 [国际区身份字段核对记录](docs/client-identity.md)。静态核对和离线模拟不是对真实服务可用性的保证。

## 保留的客户端兼容逻辑

- 国际区保持 `User-Agent: WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0`，来自已核对的官方桌面网关 UA 构造格式及其捆绑版本；重复的 WorkBuddy 段是该构造格式的一部分。中国区保持官方 5.8.3 对应的 `User-Agent: WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`，构造格式相同。
- 国际区保持 `X-IDE-Type: WorkBuddy`、`X-IDE-Name: WorkBuddy`、`X-IDE-Version: 5.8.4`；中国区保持官方 5.8.3 对应的 `X-IDE-Type: WorkBuddy`、`X-IDE-Name: WorkBuddy`、`X-IDE-Version: 5.8.3`。两区的登录、目录、刷新及推理分别使用各自地域 profile 的身份配置。
- 插件自己的版本仅用于本地包／状态显示，不写入客户端身份头或 UA；不会因此改动 Pi 系统提示词、任务和工具内容。
- `Authorization`、`X-User-Id`、`X-Domain` 和企业／租户相关账号头。
- 会话关联及逐请求／消息 ID。
- gzip 请求、SSE 响应、重复／缺失工具调用 ID 的整理、UTF-8 边界处理、usage 尾帧。
- `system` 角色、`max_tokens` 等上游适配，以及 Pi 剩余上下文／输出上限保护。
- 登录、目录、刷新及推理请求固定可信 HTTPS origin，拒绝重定向、外部模型 URL、远程 API Key 和协议注入。

两区的版本标识与私有接口可能随上游更新失效，尤其是客户端校验的业务错误 `12403`。这些是已核对源码的身份头配置，不是完整客户端抓包重放，也不保证服务端无法识别第三方调用或判定为奖励活动合格客户端。认证、账号权限、地域、限流及额度限制不变。

更新只影响之后发出的请求；服务端历史用量记录中的 `pi-workbuddy` 不会被改写。

## 模型目录与限制

模型从各区账号的官方 `/v3/config` 接口动态发现。`models` 是完整定义库，不直接等同于聊天模型列表；存在 `agents` 时，按官方 CLI 规则选择默认 CLI Agent，以其 `models` 数组按顺序解析模型 ID／名称／别名，再补充官方标记为 `chat`／`custom` 的模型，并应用 `availableModels`（若有）和现有安全过滤。不按 `modelTags: ["craft"]` 扩展到所有同标签模型；已核对的官方 CLI 2.161.0 不这样生成选择列表。没有 `agents` 的旧版目录兼容原有投影规则；存在但无有效 CLI Agent／模型数组的目录不会退回全量模型库。

模型 ID 不写死在扩展里；官方增删 Agent 的模型列表后，下一次启动刷新或 `/workbuddy-cn refresh`（国际区为 `/workbuddy refresh`）即可同步，无需为模型增删更新扩展。模型列表是官方声明的候选范围，不是权限或推理可用性探测。

公开元数据通过 Pi 模型存储持久化，并按区域及账号域／用户／租户的哈希隔离。token 不写入目录缓存。0.2.1 起使用新的投影版本标记：旧版未按 Agent 筛选的缓存不再恢复，首次更新需联网刷新；离线时仅显示回退模型，直到新目录缓存建立。失败时保留该区上次通过新版投影的有效目录，不恢复旧版全量缓存。

两区保留对禁用、明确声明不支持工具及自定义端点模型的过滤，并排除标记为图片／视频生成的模型。国际区继续沿用上游的 DeepSeek `-sg` 变体过滤及原有默认行为；`-sg` 排除是国际区的显式集成策略而非协议要求，中国区作为区域策略不继承该过滤，账号目录返回的合格模型（包括 `-sg` 结尾的 ID）照常投影，推理档位仍按目录与能力补充表确定。模型选择器出现某个模型，不代表账号必然有权使用。

上下文、输出、图片和推理档位保留上游目录投影及其供应商补充表。**补充表是乐观能力描述，不证明 WorkBuddy 网关实现了供应商全部能力。** 调用方可以限制输出；插件不做收费探测、不自动更换模型、不将限额错误冒充上下文溢出。

显示费用为零是因为不知道 WorkBuddy 各区域的计价信息，**不是承诺免费**；实际消费以对应 WorkBuddy 账号计费为准。插件不获取积分余额。

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

测试也验证双 Provider 共用一对会话生命周期钩子、已配置区域并行刷新、未登录区域不发请求、交互启动刷新不阻塞、取消与模型选择竞态、手动／无头刷新仍等待、其他 Provider 多轮调用不触发 WorkBuddy 认证／目录／传输，以及双区路由、凭据／缓存隔离、离线恢复和官方报错透传（含 Pi 最终错误消息）。这些测试均不连接真实中国区或国际区服务。

## 安全与许可

凭据只由 Pi 正常存入自己的 profile，国际区与中国区使用不同 Provider 的凭据项，不迁移或复用国际区凭据与模型设置。不要提交或分享 `auth.json`、token、登录链接或敏感调试记录。不会自动读取桌面凭据、签到、充值、领取奖励或切换账号。

只使用你有权访问的账号和服务，遵守服务条款。服务商可能拒绝第三方客户端。本项目与腾讯、WorkBuddy 或 Pi 均无官方隶属关系；源码可以公开审查，但实验性集成没有稳定性承诺。

MIT；保留原项目版权声明，详见 [LICENSE](LICENSE)。
