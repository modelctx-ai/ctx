# 决策记录

- [ADR 0001：用 TypeScript 写 ctx 和 yoyo](0001-typescript.md) - 为什么 ctx 和 yoyo 用 TypeScript；工具链和编译选项
- [ADR 0002：包的拆分、命名、版本和发布](0002-packages.md) - 包怎么拆、怎么命名，源码条件，版本，发布，使用方式
- [ADR 0003：只追加的上下文日志加投影](0003-context-model.md) - 只追加的日志加投影、摘要检查点、幂等导入、事实不进日志、延后记录
- [ADR 0004：协议层与实现层分开，组件不绑定托管形态](0004-protocol-and-implementation.md) - 协议层和实现层分开，七个组件各一个协议，组件不绑定托管形态，`thread` 改 `session`
- [ADR 0005：会话位置、并发写入、消息格式版本、AgentSpec 上下文配置](0005-session-position-writes-format.md) - 位置只用 `seq`，写入前提条件 `expectSeq`，ctx 自己的带版本的 JSON 消息格式，`AgentSpec.context`，会话分页和 `kinds` 过滤
- [ADR 0006：记忆作为第八个组件，只读日志、夜里改写、System One 做判断](0006-memory.md) - 记忆作为第八个组件：只读日志、夜里改写、事实不 UPDATE、证据必填、System One 模型做判断、遗忘是公式、只用已有扩展点接入
