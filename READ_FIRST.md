# Airline Desk · 公开交付源码

这是本地面试作业与服务试用项目。代码、原题和三份政策 PDF、讨论后的计划、测试证据、一键启动脚本及脱敏会话均已保留。

**启动：** macOS 双击 `Start.command`；macOS/Linux 终端执行 `bash start.sh`。需要 Python 3.10+ 和 npm，首次联网准备依赖后自动打开网页。默认开启服务试用；`bash start.sh --classic` 可查看原作业模式。Ctrl+C 停止，再次启动保留账号和客票。

**模型配置：** 公开仓库不含 API Key。复制 `.env.example` 为 `.env.rightcodes.local`，填入自己的 Right Codes Key，设置权限 `0600` 后启动。模型为 `gpt-5.6-sol`；未配置时仍可体验页面及本地规则，聊天会明确提示不可用。启动检查不调用收费模型。

- [交付说明](docs/DELIVERY_REPORT.md)：功能、已有验证、启动方式及边界。
- [计划与代码索引](docs/DELIVERY_BASELINE.md)：总计划、共同契约、M1–M9 及跨模块复核。
- [脱敏会话](session/README.md)：183 条可见消息、7 个历史段、2 张截图，提供 HTML、Markdown 和 JSONL。
- [验证结果](docs/VALIDATION.md)：业务、浏览器、知识库和真实模型的不同验证范围。
- [启动验证记录](evals/launch-handoff/SUMMARY.md)：此前私下交付包的安装、重启及模型检查。
- [演示步骤](README.md)：行李咨询、取消退款、多人改签。
- [公开发布说明](PUBLICATION.md)：公开版本与此前私下交付包的区别。

本项目的航司、客票、航班和资金均为模拟。真实航司、银行、生产身份认证及真人客服尚未接入；不声称符合原题六小时上限。历史 PDF 报告、会话和验证日志中提及的“附带 Key”只描述此前私下交付包，不代表公开仓库附有凭据。

不包含原始会话日志、隐藏推理、运行中的用户/会话/资金数据库、依赖安装目录或含 Key 的私下交付压缩包。`data/knowledge` 中的 SQLite 文件仅为给定政策的检索索引。
