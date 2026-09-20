# 本次最终交付检查

2026-09-20。本次新增一键启动与简短报告，按用户授权提供私下评审用Key；不改应用业务逻辑。

- 已测版本的97份代码/测试/配置/知识文件指纹全部一致；本次再次运行129项业务测试通过。见[source-verification.json](source-verification.json)、[business-tests.log](business-tests.log)。浏览器16例、真实模型核心10/自由表达8/服务查询3及知识36+10沿用同代码版本已验证批次，不声称本次又全部重跑。
- 将实际压缩包解压到含空格的新目录；没有预置node_modules、.venv或用户数据库。启动脚本从系统Node22环境自动准备固定Node24、安装依赖、构建并监听本机。macOS环境实测，Linux脚本兼容但未另建Linux环境验收。
- 重复启动被目录锁拒绝；Ctrl+C停止自己启动的子服务；重新启动复用依赖并保留已注册账号；原作业模式移走Key后仍可启动和登录，模型明确unconfigured。端口非法值/被占用拒绝，关闭后的端口可重用。见[launcher-check.json](launcher-check.json)与三份启动日志。
- 首轮用包内Key完成一次真实gpt-5.6-sol咨询：Bluehaven Basic、一件15kg、三边合计140cm托运，COMPLETED、40美元、PDF来源正确；没有资金操作。见[launcher-first-pass.json](launcher-first-pass.json)。后续只调整端口重用检查并重新完成全套启动验证，未重复收费咨询。启动本身不调用收费模型，Key剩余额度及实际账单未知。
- 会话183条、7个历史段、2张截图；逐条核对来源位置、角色、可见阶段和截止时间，4处密钥替换。只导出用户可见对话，见[session-review.json](session-review.json)。
- 简短报告两页，均已渲染目视检查，中文可提取，正文在页面范围内，见[pdf-review.json](pdf-review.json)。

初次解压检查将macOS的/var与/private/var当成不同目录而拒绝，修正验证脚本路径归一化后通过；业务代码未受影响。首轮测试发现关闭端口的TIME_WAIT会导致新端口递增，启动脚本补充端口重用检测后重新通过。早期检查结果保留，最终状态以launcher-check.json为准。

最终包必须包含且仅在.env.rightcodes.local中出现用户授权Key；不含运行数据库、依赖目录或原始Codex日志。逐文件指纹在DELIVERY_FILES.json，最终整包核对结果放在压缩包旁的verification.json，避免递归写入自身哈希。包内旧的handoff/service-trial等报告用于追溯，并非本次脚本的新测试。
