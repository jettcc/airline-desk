# Right Codes 模型接入验证

更新：2026-09-18。用户最新指定 Right Codes、GPT‑5.6 Sol，并授权在所提供 Key 的 5 美元限额内测试。本页不包含密钥。

## 应用接入更新：2026-09-18

应用已接入原 Key 与 `gpt-5.6-sol`，不是独立探测脚本。`www.right.codes` 在 11:06–11:10 UTC 期间出现 TLS 握手连接重置，尚未进入鉴权阶段；未把这些失败记为成功。按 Right Codes 自身文档的 Responses 示例，使用同一供应商的 `https://www.rightapi.ai/codex/v1` 验证成功后更新了本地应用配置；未更换模型、Key 或额度，也未改动 Codex 自身配置。

- 官方地址依据：[Right Codes Curl 示例](https://docs.right.codes/docs/rc_extension/curl)。
- 官方 API 地址下真实网页 A06 取消/退款单例通过：[报告](../evals/acceptance/2026-09-18T11-10-57.645Z/A06.json)。
- 完整真实业务验收已在后续批次 A01–A10 全过：[最终摘要](../evals/acceptance/2026-09-18T11-24-50.022Z/summary.json)。用量和边界见 [VALIDATION](VALIDATION.md)；保留此前失败与单例记录。
- 应用单次模型调用最长 45 秒，最多一次传输/残缺流重试；错误模型、额度错误或无效终态不会放行工具。业务确认从网页进入确定性后端，查询已提交结果不依赖模型。
- 后续发送的内容只含虚构演示数据、必要对话和允许工具结果；密钥不进网页、检索进程、导出或诊断日志。

以下为更早的独立接入探测历史，原地址、时延和当时“业务尚未实现”的说明按当时阶段保留。

## 历史独立探测结论

**渠道调整后，最小接入验证通过。** 已验证鉴权、模型列表、文本及指令遵循、结构化只读工具调用、工具结果续答。成功轮次的三次生成均完整结束，响应 `model` 均为 `gpt-5.6-sol`。

| 配置项 | 当前使用值 |
|---|---|
| Provider | Right Codes |
| BaseURL | `https://www.right.codes/codex/v1` |
| 模型 ID | `gpt-5.6-sol` |
| 协议 | Responses API，流式 SSE，`store=false` |
| 密钥 | 仅本地私有配置，未写入本页或结果记录 |
| 预算 | 用户设置的 Key 总额度上限 5 美元；未更改额度 |

这证明当前端点满足本次最小协议测试，不能独立证明供应商内部模型身份，也不代表航空业务或稳定性已验收。首轮工具流曾提前结束，后续完整复测通过；中断记录保留，不隐去失败。

## 成功证据

[完整复测报告](../evals/provider/rightcodes-2026-09-18T10-11-29.637Z.json)：2026-09-18 10:11:29 UTC 开始，结果 PASS。

| 检查 | 实际结果 |
|---|---|
| 鉴权及模型列表 | 200，包含目标模型 |
| 文本与 instructions | 精确返回要求的 `AIRLINE_CONNECT_OK`，没有遵从相冲突的用户文字 |
| 模型字段与终态 | 三次均为 `gpt-5.6-sol`、`completed` |
| 结构化工具调用 | 一次 `get_probe_status`，严格参数为 `scope=airline` |
| 工具结果续答 | 工具调用后才生成随机回执；模型续答准确返回工具结果中的回执 |
| 用量 | 本次完整成功轮次报告输入 626、输出 166，共 792 tokens |

成功轮次的文本约 1.6 秒、工具请求约 22.2 秒、工具结果续答约 19.3 秒。这只是本轮测量，不是响应时延承诺。只读工具为本地探测函数，没有执行票务业务。

## 本轮失败与恢复过程

| 阶段 | 事实 | 证据 |
|---|---|---|
| 渠道调整前 | 用户域名模型列表返回 403；另一次诊断读取到字符串形式的渠道绑定错误 | [模型列表探测](../evals/provider/rightcodes-2026-09-18T10-06-03.154Z.json) |
| 渠道调整前 | 用户域名直接 Responses 返回 403“API Key 仅允许访问绑定渠道，请使用该渠道对应的 Key” | [用户域名调用](../evals/provider/rightcodes-2026-09-18T10-07-38.846Z.json) |
| 渠道调整前 | 文档域名 `https://rightapi.ai/codex/v1` 也返回同一 403 | [文档域名调用](../evals/provider/rightcodes-2026-09-18T10-07-55.014Z.json) |
| 用户调整渠道并要求重试后 | 同一用户域名鉴权和文本成功；工具请求 HTTP 200，但流未带完整终态即结束，整轮判失败 | [首次放行后测试](../evals/provider/rightcodes-2026-09-18T10-10-00.099Z.json) |
| 补充事件诊断后的完整复测 | 三次生成和工具往返全部通过，没有自动切换模型 | [成功复测](../evals/provider/rightcodes-2026-09-18T10-11-29.637Z.json) |

首次工具流缺少终态的根因尚未定位；后续成功不能证明此问题已消除。探测脚本补充了脱敏的事件类型/数量和字节数诊断，未放宽完成条件，也没有把残缺输出拼成成功结果。后续 M5 必须完整验证终态和工具参数再执行工具；断流明确失败，重试有界，写入仍按业务幂等规则保护。

当前不再缺渠道地址或模型选择，后续可使用已验证配置接入 M5。已有预算授权继续有效；不需要重新请求同一配置/同一上限内的授权。

## 本地配置与复测

复用已有 `.env.rightcodes.local`，确认凭据与本轮用户提供的一致，模型更新为 `gpt-5.6-sol`。文件权限保持 `0600`，`.gitignore` 排除该文件；不要打包进交付件。可共享的 [.env.example](../.env.example) 保留空密钥。

未改动 Codex 应用自身的账号或模型设置。独立探测工具 [probe_rightcodes.mjs](../scripts/probe_rightcodes.mjs) 尚不是 M5 应用适配器。

```sh
node --env-file=.env.rightcodes.local scripts/probe_rightcodes.mjs --run
# 仅在需要独立检查生成权限时，显式跳过模型列表：
node --env-file=.env.rightcodes.local scripts/probe_rightcodes.mjs --run --responses-only
```

每次运行最多三次小生成请求，每次最多 512 输出 tokens、45 秒超时、不自动重试；任一步失败立即停止。跳过列表不跳过生成鉴权、模型一致性、完整终态或工具往返检查。只发送到已校验的 HTTPS 供应商地址，不跟随重定向。

记录请求/响应 ID、状态、模型字段、供应商用量与 SSE 事件类型，不保存密钥、鉴权头或隐藏推理。每次新建证据文件，不覆盖失败或历史记录。

## 费用与验收边界

- 本轮新发出 4 次模型列表/诊断 GET 和 7 次生成 POST：2 次生成被渠道 403 拒绝，1 次流缺终态，4 次完成；脚本没有自动重试。用户调整渠道后和新增诊断后分别作了明确复测。
- 本轮可取得 usage 的 4 次完成响应合计输入 696、输出 182，共 878 tokens；缺终态请求的用量未知。不能将缺失字段计作实际零消耗。
- 接口没有返回实际扣费；Key 的 5 美元限制由用户设置，未独立读取账单或修改配额，不按其他服务商价格估算本服务扣费。
- 没有发送项目 PDF、订单、个人信息或聊天历史；提示仅含最小探测内容。
- 脚本语法、错误解析和真实协议往返已验证。M5 业务编排与 M8 的 A01–A10 尚未实现/运行，不能计为已验收。
- 探测运行环境 Node v22.22.3；主应用计划 Node 24 LTS 的依赖环境仍需实施时验证。

## 保留的更早记录

项目原有三份 `gpt-6-astra` 探测报告记录返回 `gpt-5.6-luna`。这些历史模型字段不一致的结果已保留，不作为当前 GPT‑5.6 Sol 的结论。

- [更早文档域名测试](../evals/provider/rightcodes-2026-09-18T09-46-48.011Z.json)
- [更早用户域名测试](../evals/provider/rightcodes-2026-09-18T09-48-19.250Z.json)
- [更早复测](../evals/provider/rightcodes-2026-09-18T09-58-58.676Z.json)

## 依据

- [Right Codes Curl 示例](https://docs.right.codes/docs/rc_extension/curl)：Responses 路径及鉴权格式；Chat Completions 存在转换/指令兼容差异。
- [Right Codes 配置示例](https://docs.right.codes/docs/rc_cli_config/codex)：示例列出 `gpt-5.6-sol` 与 Responses；实际可用性以上述调用为准。
- [Right Codes 渠道说明](https://docs.right.codes/docs/rc_quick_start/models)：从后台对应渠道复制 BaseURL；本次渠道限制已由用户调整。
