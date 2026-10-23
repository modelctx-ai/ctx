# ADR 0003：只追加的上下文日志加投影

- 状态：已采纳
- 日期：2026-10-23

## 背景

常见写法是每个会话维护一个可变的 `messages` 数组：超长了就地截断，压缩时用摘要替换旧消息，不是对话的东西要么硬塞成消息、要么丢掉。yoyo 和 dsh-pet 正好碰上这几件事：

- dsh-pet 的右键对话只带最近 `chatMemoryRounds` 轮（缺省 5 轮），更早的对模型不可见。
- 碎碎念、提醒这类不是对话的东西，要不要给模型看、怎么给，会随需求变。
- 桌宠自己的对话记忆要反复并进 yoyo 的上下文，不能重复。
- 碎碎念要先说出口（合成语音、投喂给桌宠）才算数。

## 决定

1. 每个线程是一份只追加的日志。条目分三种：`message`（AI SDK 的 `ModelMessage` 原样保存）、`event`（应用定义的 `kind`、`text`、`data`）、`summary`（压缩点）。写进去就不改。
2. 模型看到的是投影，每次调用从日志现算：最近的摘要固定在最前，消息原样带上，事件按规则渲染，需要时再开窗口裁剪。
3. 压缩追加摘要条目，`covers` 指向它代替到的位置。`covers` 最大的那条生效，新摘要包含旧摘要。
4. 导入外部历史时每条带一个幂等键，存储在同一线程里按键去重。`generate` / `stream` 的 `inputKey` 同理：用户这句在调用模型之前就写进日志，失败后用同一个键重试，不会再记一遍。
5. 事实（来源当场取到的文字）只用于这一次调用，不写日志。
6. 副作用要先成功的生成用 `record: false`，成功以后再追加。

## 为什么不用可变数组

| 方面         | 可变 `messages` 数组 | 只追加日志 + 投影                                                |
| ------------ | -------------------- | ---------------------------------------------------------------- |
| 截断         | 就地删掉，找不回来   | 只影响这一次投影，原条目还在                                     |
| 压缩         | 用摘要替换旧消息     | 追加摘要条目，原条目保留，随时可以重新压                         |
| 应用事件     | 硬塞成消息或者丢掉   | 存成事件；给不给模型看、怎么写由规则决定，改规则对旧事件同样生效 |
| 导入外部记录 | 很难判断导没导过     | 幂等键去重，导入可以反复做                                       |
| 存储接口     | 读写整个数组         | `append`、`list`、`clear`、`threads`，换什么数据库都好实现       |
| 多处同时写   | 读、改、写互相覆盖   | 追加互不覆盖，顺序由 `(at, seq)` 决定                            |

## 摘要检查点

- `compact()` 把最近 `keep` 条之前的历史连同旧摘要交给模型压成一段文字，追加 `{ type: 'summary', text, covers }`。图片、文件在压缩输入里只留占位；被 `maxOutputTokens` 截断的摘要会丢事实，不写入，这次就不压缩。
- 投影时 `covers` 及之前的条目由摘要代替；摘要固定在第一条，不参与窗口裁剪。
- 读视图时只取最近一条摘要和它之后的条目，长线程不用整段读出来。
- 原条目一直留在日志里：可以查、可以换一种方式重新压，也可以给别的投影用。

## 幂等导入

外部系统自己保存的历史（例如 dsh-pet 的对话记忆）每次都整段读回来，要并进 ctx 又不能重复。每条带一个由内容决定的键，`at` 写原来的时间：

```ts
import { assistantEntry, userEntry, type Context, type NewEntry } from '@modelctx-ai/ctx';

interface PetChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly ts: number;
}

export function petChatEntries(messages: readonly PetChatMessage[]): NewEntry[] {
  return messages.map((message) => {
    const options = { at: message.ts, key: `pet:${message.ts}:${message.role}:${message.content}`, source: 'dsh-pet' };
    return message.role === 'user' ? userEntry(message.content, options) : assistantEntry(message.content, options);
  });
}

/** 每拍调用一次；返回这次新写入的条数。 */
export async function storePetChat(context: Context, messages: readonly PetChatMessage[]): Promise<number> {
  return (await context.append(...petChatEntries(messages))).length;
}
```

- 同一线程里键重复的条目被跳过，`append` 只返回真正新写入的。
- `at` 用原来的时间，导入的条目排回原来的位置，和应用自己写的条目按时间交错。
- 键必须稳定：同一条记录每次算出来都一样。`pet:<ts>:<role>:<text>` 在同一毫秒里同一个角色说两遍同一句话时会并成一条，这里可以接受。

## 事实不进日志

来源取到的是“现在”：当前任务、粘贴板、天气。写进日志，下一轮就成了过期信息，而且每轮都重复一遍、白占预算。所以事实每次调用现取，缺省追加在指令后面，也可以放进最后一条临时用户消息（`prompt`），两种都不写日志。

需要留下来的变化（例如“粘贴板里出现过这段文字”）由应用自己追加成事件，这是明确的选择，不是收集事实的副作用。

## 延后记录

`generate` 缺省先记用户这句、再记回复。要“说出口”才算数的生成用 `record: false`：

```ts
import { eventEntry, type Context } from '@modelctx-ai/ctx';

declare function speak(text: string): Promise<void>; // 合成语音、投喂给桌宠

export async function whisper(context: Context, instructions: string): Promise<string> {
  const { text } = await context.generate({
    instructions,
    prompt: (facts) => [...facts.map((fact) => fact.text), '请再说一句碎碎念。'].join('\n'),
    record: false,
    temperature: 0.8,
  });
  const line = text.trim();
  await speak(line); // 失败就抛出，日志不变
  await context.append(eventEntry('whisper', { text: line }));
  return line;
}
```

- 合成或投喂失败时日志里没有这句，模型下次不会以为自己说过。
- 记下的是真正说出口的那句（应用清理过的），不是模型的原始输出。
- yoyo 的回复也这样：用户这句先单独写进日志，回复说出口以后再写。

## 代价

- 日志只增不减，除了 `clear(thread)` 没有删除。投影的长度靠压缩控制，存储空间一直增长。
- 每次调用都要读日志再投影，成本和最近一条摘要之后的条目数成正比。
- 摘要有损，还要多调一次模型；什么时候压缩由应用决定。
- token 是估算值，`maxTokens` 是近似的预算。
- 改不了过去：写错的条目只能追加更正，或者清空线程重来。
- 幂等键怎么取由应用负责，取得不好会漏导或重复。

## 没有采用

- 可变消息数组：见上表。
- 只存渲染好的提示词文本：存储和提示词格式绑死，换模型或者改写法都要迁移数据。
- 以向量检索为主存储：不在核心包的范围里。需要时写成一个 `ContextSource`（检索结果作为事实）或一个工具。
