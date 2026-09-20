# 交付基线与讨论后计划索引

日期：2026-09-20。本文是当前交付口径；原计划保留设计约定和历史状态，不能用旧文档中的NOT_RUN、测试数量或“最终”字样推断当前结果。实际实现以本包源码、[VALIDATION](VALIDATION.md)及[交付报告](DELIVERY_REPORT.md)为准。

## 最终目的

围绕项目给定的三家虚构航司政策，用简单网页聊天完成政策咨询、授权查票、改签/取消/适用退款。不能仅固定回复成功：报价与确认分开，确认后有真实的本地状态变化；信息或规则不足时保持未知或待核定。

## 已确认的共同决定

- 先完成模块计划及跨模块复核，再实施。依赖关系决定顺序，不机械按模块编号施工。
- 只围绕给定PDF，本地知识快照、全文检索与来源核对，不引入向量数据库或现实政策。
- 七个Skills组织业务调用；模型理解意图和选择工具，确定性代码计算金额、资格与权限。Skills不是让模型口算费用。
- USD使用Money整单位字符串+nanos、BigInt精确计算，业务结算到分。票价差、税费、手续费、现金退款、额度和不退价值分开，不能任意抵扣。
- UTC毫秒时间戳；报价5分钟；确认时复核权限、客票/库存/政策版本。报价不锁座，不承诺旧资格。
- 游客可咨询，个人客票操作须登录及逐票授权。本地账号保存在SQLite文件中，密码经过scrypt处理，不明文保存。
- 多人统一确认，短事务保证本地全成或全不变；幂等、防重复权益消费、响应丢失恢复和撤权历史限制均为交付要求。
- 可选M9扩展只演示服务责任与跟进，不引入真实身份、客服、支付或航司接入。人工咨询关闭不等于金融例外批准。

## 模块、计划和实际代码

| 模块 | 讨论后计划 | 实际实现入口 | 当前边界与证据 |
|---|---|---|---|
| M1 政策与检索 | [M1](plans/01-policy-knowledge.md) | `src/airline_kb/`；`src/assistant/knowledge.ts` | 三份PDF与不可变快照；36测试、10检索案例；未覆盖主题不猜 |
| M2 规则与金额 | [M2](plans/02-business-rules.md) | `src/domain/rules.ts`、`rules-v1.ts`、`money.ts`、`time.ts` | 确定性算法；复杂/不明分摊保持审核；规则与边界测试 |
| M3 身份与会话 | [M3](plans/03-identity-sessions.md)；[本地账号](LOCAL_ACCOUNTS.md) | `src/server/identity.ts`、`accounts.ts` | 本地登录、逐票动作、过期/撤销；不是生产实名系统 |
| M4 有状态后端 | [M4](plans/04-booking-backend.md) | `src/server/booking.ts`、`db.ts`、`policies.ts` | 客票/库存/账本/额度/权益原子提交；单实例SQLite；schema v3 |
| M5 对话与Skills | [M5](plans/05-dialog-skills.md) | `src/assistant/conversation.ts`、`tools.ts`、`model.ts`；`skills/` | 真实gpt-5.6-sol；受控业务卡和只读服务查询；有限自然语言覆盖 |
| M6 网页体验 | [M6](plans/06-web-chat.md) | `web/main.tsx`、`service.tsx`、`i18n.ts` | 登录、选择、报价、确认、恢复；16浏览器案例；试用面板为中文 |
| M7 审核与记录 | [M7](plans/07-review-traces.md) | `src/server/trace.ts`、`booking.ts`；`scripts/export_trace.ts` | 当前权限视图、连续轨迹、未知金额；原模式仅登记，M9有模拟接手 |
| M8 样例与验收 | [M8](plans/08-validation-delivery.md) | `src/server/seed.ts`；`tests-ts/`、`tests-browser/`、`scripts/acceptance.ts` | A01–A10为原作业核心，D/S为扩展；失败记录保留 |
| M9 本地服务试用 | [M9](SERVICE_TRIAL_PLAN.md)；[试用指南](SERVICE_TRIAL.md) | `src/server/service-desk.ts`、`web/service.tsx` | 样例授权、模拟队列/回执、比较、航变；14组服务端及3组浏览器新增场景 |

全局设计还包括[总计划](PLAN.md)、[共同契约](CONTRACTS.md)、[跨模块复核](PLAN_REVIEW.md)、[实际架构](DESIGN.md)及[真实业务缺口](BUSINESS_GAPS.md)。本包包含整个`docs/plans/`、`docs/knowledge/`和根目录文档，而不是只附一份总计划。

## 与早期计划的演进关系

早期“审核仅记录”适用于默认原作业模式；M9增加模拟角色接单/补充/转办，但仍不批准未知金额的真实退款。schema从v1/v2演进到v3，新增表保留原账户和业务记录。行李输入后来支持托运行李三边合计；客舱箱仍核对单边尺寸。旧执行器固定指纹及已知兼容升级路径已经实现，不能继续按旧复核中的“没有升级路径”理解当前代码。

历史`VALIDATION-*`、`DELIVERY_AUDIT`、`SESSION_FIX`和会话中的中间数字用于追溯，不覆盖当前129业务/16浏览器/21真实模型场景的汇总。M9并未修改政策金额、五分钟报价或原有确认边界。

需求讨论始于2026-09-17，主要开发与复核记录为9月18日至20日；没有可核实的精确人工计时。用户在讨论中取消了本轮六小时约束，但这不等于任务书的限时要求得到出题方豁免。
