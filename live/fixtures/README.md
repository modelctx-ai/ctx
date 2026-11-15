# 夹具

`node live/smoke.ts --record` 录下来的真实响应，每个文件是一个目标的一个场景：目标的配置（密钥、账号已换成 `REDACTED`）、HTTP 往来（不含请求头）、当时看到的结果。`live/replay.test.ts` 在 PR 的 CI 里重放它们。

现在这里是空的：还没有人带着密钥跑过 `--record`。
