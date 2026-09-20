# Airline Desk · 航旅服务助手

基于三家虚构航司的政策 PDF，帮助旅客查政策、查自己的客票，并在看到费用后明确确认改签或取消/退款。模型理解需求、选择工具；金额、资格、权限和实际提交由后端规则控制。

**本地作业演示：** 客票、库存、航班和资金均为模拟；注册账号真实保存在本机 SQLite 文件。没有真实航司、支付或人工审批接入。

计划、代码与交付材料索引见 [READ_FIRST.md](READ_FIRST.md)，公开发布范围见 [PUBLICATION.md](PUBLICATION.md)。

## 启动

**面试官一键启动：** macOS双击 [Start.command](Start.command)，或在macOS/Linux终端运行 `bash start.sh`。需要Python3.10+和npm；脚本会准备Node24、安装依赖、构建、打开网页，默认开启服务试用。重复启动保留数据；Ctrl+C停止。原作业模式可用 `bash start.sh --classic`。**此公开仓库不含 API Key。** 使用聊天前，复制 [.env.example](.env.example) 为 `.env.rightcodes.local`，填入你自己的 Right Codes Key，并设置权限 `0600`。也可以先启动体验页面和本地模拟流程。详见 [简短交付说明](docs/DELIVERY_REPORT.md)。

以下为手动启动方式：

需要 **Node.js 24.x、Python 3.10+、macOS/Linux**。在项目根目录运行：

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm run build
npm run seed
npm start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。第一次初始化创建未来的样例航班；重启保留账号、客票和处理记录。

自然语言助手使用 Right Codes 的 `gpt-5.6-sol`，BaseURL 为 `https://www.rightapi.ai/codex/v1`。本公开仓库不附带凭据；如需配置或更换模型 Key，复制 [.env.example](.env.example) 为 `.env.rightcodes.local`，填写Key并设置权限 `0600`。未配置模型时网页和规则/接口测试仍可用，聊天明确提示不可用。`npm run doctor` 可检查环境与配置，不调用收费模型。

## 先体验这三个任务

| 任务 | 操作 | 应看到什么 |
|---|---|---|
| 政策与连续追问 | 游客问“行李能带多少？”，补充“Bluehaven，Basic”，再问“一件15kg、三边合计140cm的托运行李呢？” | 先补必要条件，再核对每人每段40美元并给来源；超出已公布范围时不猜费用 |
| 改签 | 首页“体验改签流程” → 明确选择虚构旅客林怡 → 发送准备好的问题 → 选客票和新航班 | 对比选项，看到手续费、差价和税费，点击具体确认后才变更 |
| 取消与退款 | 右上角“体验示例” → 林怡 → 请求取消 `CANCEL-NSA-A`，先看方案 | 初始样例：旅行额度60美元、原路退税20美元，另有不退部分；确认后在“处理记录”查看 |

新注册账号没有样例客票；可从空状态按钮明确切换到虚构身份。不要在已办理的同一客票上假定它还是初始状态。固定数据与十个完整复现案例见 [演示指南](docs/DEMO.md)。

可选服务试用：用 `AIRLINE_SERVICE_TRIAL=1 npm start` 开启“我的服务中心”和“模拟客服工作台”，体验注册用户申请样例客票、接单与补充说明、退款进度、预算/到达时间比较和航变提醒。`npm start` 默认保持原作业模式，一键启动默认开启服务试用；具体步骤和模拟边界见 [服务试用指南](docs/SERVICE_TRIAL.md)。

## 为什么这样做

优先完成政策咨询、授权查票和退改闭环。这三类任务同时体现规则差异、信息不足、明确确认和有状态操作。三份 PDF 使用本地全文检索；规则使用确定性金额算法和 UTC 时间；SQLite 保证本地事务、防重与恢复。未知金额进入待核定状态，不能当成零元或已批准。

设计取舍、优先场景和实际投入见 [提交说明](docs/SUBMISSION.md)。详细架构见 [设计](docs/DESIGN.md)；真实业务的后续缺口见 [业务分析](docs/BUSINESS_GAPS.md)。

## 如何核对结果

```sh
npm test
npx playwright install chromium --only-shell
npm run test:browser
.venv/bin/python scripts/validate_m1.py
# 以下调用收费模型；需要自己的有效凭据
npm run acceptance
npm run acceptance -- --suite=dialogue
# 可选服务试用的真实模型查询场景
npm run acceptance -- --suite=service
```

[当前验证结果](docs/VALIDATION.md)区分规则测试、使用模型替身的浏览器测试和真实模型场景；[一段执行轨迹](docs/EXAMPLE_TRACE.md)展示政策来源、工具、操作与结果，不含隐藏推理。收费调用不预估或伪报实际账单。

## 范围与提交说明

- 仅支持给定三份政策及模拟订单，USD 结算到分，单服务实例/本地磁盘；不支持真实支付、出票、人工审批、额度兑换或行李销售。
- 当前附带账户和明确的演示入口；不能把注册、姓名或付款人自述当成客票授权。
- 原题要求最多6小时。本项目经历多轮开发和验证，**不声称符合六小时上限**。记录横跨9月18日至20日，未记录可追溯的精确人工工时；不以日历跨度或自动化等待倒推工时。
- 模型有延迟且自由表达覆盖有限；关键金额和办理结果始终以经核验的业务卡为准。

端口、独立演示库、冻结时钟、维护操作与历史记录见 [配置参考](docs/SETUP_REFERENCE.md)。
