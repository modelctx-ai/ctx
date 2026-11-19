---
type: Specification
title: 'Protocol layer'
description: 'English translation of the protocol layer: what the nine protocols do, their signatures, JSON shapes, the activation formula, contract tests, the hosting matrix and the HTTP wire format'
tags: [protocol, specification, en]
status: stable
translation_of: ../protocol.md
synced: 2026-11-19
---

# Protocol layer

> This is a translation of [协议层](../protocol.md). The Chinese text is authoritative; this one records the date it was last brought in line with it (synced in the front matter). A test checks that both texts name the same identifiers, paths and types (everything in inline code), so a change to the specification that is not carried over here fails CI. Wording can lag; the shapes cannot.

`@modelctx-ai/ctx-protocol` defines nine protocols (six for the seven components, plus memory's `MemoryStore`, `DecisionModel` and `ExtractionModel`), the JSON shapes that go with them, pure functions that depend only on those shapes, and a contract test for each protocol. It contains no implementation. Models are AI SDK's `LanguageModel`, not redefined here; messages are ctx's own JSON format (see [Message format and versions](#message-format-and-versions)), and the protocol package does not depend on AI SDK's message types.

This document explains the protocols; the `.d.ts` files in the package are authoritative for types, and the signatures below omit `readonly` and doc comments. Package usage and the list of contract tests are in [`packages/protocol`](../../packages/protocol/README.md).

## General rules

| Rule                        | Meaning                                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interfaces and factories    | A protocol is an `interface`; an implementation is `createX(options): X`. No class inheritance                                                                                                                                                                 |
| JSON in, JSON out           | Method arguments and return values can go through `JSON.stringify`. Exceptions: `AbortSignal` and an in-process `LanguageModel`. Across a boundary a model is a name string                                                                                    |
| Messages                    | ctx's own `Message`, all JSON (binary is a base64 string, a URL is a string), so neither storage nor the wire needs an encoding; conversion to and from AI SDK lives in `@modelctx-ai/ctx`                                                                     |
| String identities           | `session`, tool names, executor names and `runId` are all strings                                                                                                                                                                                              |
| Streams are event sequences | A streamed result is an `AsyncIterable<Event>`; across a boundary it is NDJSON or SSE                                                                                                                                                                          |
| Optional methods            | A method marked `?` may be left out by an implementation; callers must check                                                                                                                                                                                   |
| Cancellation                | Methods that can be cancelled take `signal?: AbortSignal`                                                                                                                                                                                                      |
| Errors                      | Throw an `Error`; across a boundary it is `{ error: ErrorInfo }`, where `ErrorInfo` is `{ message, type?, retryable?, statusCode?, responseBody? }` and `type` is a machine-readable category (`not_found`, `conflict`, `session_busy`, `context_overflow`, …) |
| Contract tests              | `describeXContract(name, factory, { describe, test })` from `@modelctx-ai/ctx-protocol/testing`; implementations run it (see [Contract tests](#contract-tests))                                                                                                |
| Versions                    | The wire protocol's version is `PROTOCOL_VERSION` (currently `0.3`, moving with the packages' minor version); a client reads `GET /protocol` before anything else and fails right away on a different version                                                  |
| Language neutral            | Wire shapes have a JSON Schema (`PROTOCOL_SCHEMA`) and paths have an OpenAPI document; an implementation in another language runs the same contract tests against an address (`ctx-conformance`)                                                               |

## Sessions `SessionStore`

An append-only event log; the detailed semantics are in [ADR 0003](../adr/0003-context-model.md). The only exceptions are deletion (`clear`, `truncate`, `remove`) and redaction (`redact`); see [Erasure](#erasure) below and [ADR 0007](../adr/0007-deletion-and-retention.md).

```ts
interface EntryBase {
  id: string; // globally unique; generated by the store when not given
  session: string; // filled in by the store
  v: number; // format version when this row was written; what you read is always the current shape; new entries get `ENTRY_VERSION` (1), filled in by the store
  seq: number; // position in the session, filled in by the store in write order: strictly increasing within a session, from 1, never going back or reused after deletion; 0 is the start of the session
  at: number; // logical time (ms), defaults to the time of writing; only used for projection order and display, may be earlier than existing entries
  key?: string; // idempotency key: a second entry with the same key in a session is skipped
  source?: string; // who wrote it: user, model, harness, an application name
  meta?: JsonObject;
}
interface MessageEntry extends EntryBase {
  type: 'message';
  message: Message;
}
interface EventEntry extends EntryBase {
  type: 'event';
  kind: string;
  text?: string;
  data?: JsonValue;
}
interface SummaryEntry extends EntryBase {
  type: 'summary';
  text: string;
  covers: number; // entries with seq ≤ covers are replaced by this summary
}
type Entry = MessageEntry | EventEntry | SummaryEntry;
type EntryType = Entry['type'];
/** Passed to append: id and at are optional, session and seq are filled in by the store. */
type NewEntry = NewMessageEntry | NewEventEntry | NewSummaryEntry;

interface ListOptions {
  after?: number; // seq, exclusive
  last?: number; // the N entries with the largest seq, still in ascending seq order; floored, empty when not a finite positive number
  limit?: number; // the N entries with the smallest seq after filtering; pages forward with after; when given with last, last applies first
  types?: readonly EntryType[];
  kinds?: readonly string[]; // events only, whose kind is in the list; intersected with types; an empty list matches nothing
  atAfter?: number; // only entries whose at is greater (exclusive); NaN does not filter
}
interface SessionsOptions {
  prefix?: string; // literal prefix, not a wildcard
  after?: string; // last name of the previous page, exclusive
  limit?: number; // floored, empty when not positive; unlimited when not given
}
interface WatchOptions {
  after?: number; // seq, exclusive
  signal?: AbortSignal; // iteration ends normally after abort
}

interface AppendOptions {
  expectSeq?: number; // write only if the session's last seq equals it (0 for an empty session); otherwise write none of the batch and throw conflict
}

interface SessionStore {
  append(session: string, entries: readonly NewEntry[], options?: AppendOptions): Promise<Entry[]>;
  list(session: string, options?: ListOptions): Promise<Entry[]>;
  clear(session: string): Promise<number>; // empty the whole session, returns how many entries were deleted
  truncate(session: string, upTo: number): Promise<number>; // delete entries with seq ≤ upTo
  remove(session: string, ids: readonly string[]): Promise<number>; // hard delete by id
  redact(session: string, ids: readonly string[]): Promise<number>; // redact by id: the position stays, the content becomes ctx.redacted
  sessions(options?: SessionsOptions): Promise<string[]>; // ascending by name
  /** First yields the entries already after `after`, then keeps yielding new ones; used for remote streaming reads. */
  watch?(session: string, options?: WatchOptions): AsyncIterable<Entry>;
}
```

- A session name is any non-empty string except `.` and `..`: these three cannot be a URL path segment (an empty segment disappears, `.` and `..` are collapsed by normalization), so they could neither be read nor deleted through a remote store. Every store method (except `sessions`) throws `invalid_request` for them, and `checkSessionName(session)` implements the rule; names with `/`, `%`, spaces or Chinese characters are fine.
- What goes in is a copy, and so is what comes out: a caller changing its own draft after `append`, or changing an entry returned by `list` or `watch`, does not change the log. Append-only does not rely on callers behaving, and hooks that edit messages in place behave the same on every implementation.
- `append` is atomic for a batch: it never writes half a batch and never interleaves with a concurrent batch. Resuming after a crash depends on this.
- `expectSeq` is a precondition on the write, not a lease: when it does not hold, none of the batch is written and it throws `CtxError('conflict')` (`retryable: true`; 409 over HTTP). The precondition is checked before deduplication, so retrying a batch that already succeeded is still a `conflict` if someone else wrote in between; the caller re-reads and sees its own entries are there. Not given, not checked. It is stateless, so a crashed harness has nothing to release; `seq` itself is the fencing token. The pure function `headSeq(store, session)` (`list({ last: 1 })`, 0 for an empty session) reads the current end, and `isConflict(error)` recognizes `conflict` (including those converted by the local and remote clients). The memory store checks and writes in one synchronous section; `ctx-sqlite` does it inside `BEGIN IMMEDIATE` (a SAVEPOINT when the application already has a transaction).
- Deduplication is not a failure: an entry whose `id` repeats (globally) or whose `key` repeats (within a session, including within the same batch) is silently skipped and the rest of the batch is written; the return value is exactly the entries written. Retrying a batch relies on this to avoid recording twice.
- `list` and `watch` return entries in ascending `seq`, that is, write order. An entry imported with an old `at` sits where it was written (so a new write is always visible after `after`); the logical order the model sees is reordered by the projection by `(at, seq)` (`compareEntries`). `seq` is only monotonic within a session; consumers must not compare it across sessions.
- `sessions` lists only sessions with content, ascending by name (code point order, which is UTF-8 byte order). Paging: `after` is the last name of the previous page, `prefix` matches literally, `limit` caps the count.
- `limit` is for paging: `list({ after, limit })` reads one page, the next page's `after` is the `seq` of this page's last entry, and you stop at a short page. A long session never has to be read into memory at once; `ctx-sqlite`'s `watch` and the `ctx-remote` server both read page by page.
- `kinds` returns only events, since messages and summaries have no `kind`; it is intersected with `types`, so nothing comes back when `types` lacks `event`; `last` applies after filtering, so `{ kinds: [a, b], last: 1 }` is the last of those events written.
- `atAfter` filters by `at`; the result is still in ascending `seq`. It is intersected with the other conditions, and `last` and `limit` apply after filtering. A reader that only reads the tail uses it to find entries written earlier whose `at` sorts after the tail (reminders that use their due time as `at`); see `projectSession`.
- The summary in effect is the one with the largest `covers`; on equal `covers` the one with the larger `seq` (written later) wins.
- Event `kind` is `{domain}.{action}`. The framework reserves the `ctx.` prefix; the constants are `CTX_EVENTS`:

| `kind`            | Written by            | `data`                                                                                                                                                                                                   |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.run.started` | harness               | `RunStartedData`: `{ runId, agent, owner?, parent?, harness? }`, where `agent` is `agentSpecToJson(spec)` and `harness` is an external harness's identity, `HarnessInfo`: `{ name, version?, session? }` |
| `ctx.run.ended`   | harness               | `RunEndedData`: `{ runId, stopReason, usage?, executors? }`; `executors` says, on `requires_action`, who runs the calls left to external executors: call `id` → executor name                            |
| `ctx.compacted`   | context               | `CompactedData`: `{ covers, summaryId }`                                                                                                                                                                 |
| `ctx.error`       | harness, orchestrator | `CtxErrorData`: `{ runId?, message, type? }`                                                                                                                                                             |
| `ctx.unreadable`  | (never written)       | `UnreadableData`: `{ v?, type?, error: { type, message } }`, see below                                                                                                                                   |
| `ctx.erased`      | store                 | `ErasedData`: `{ op, upTo?, seqs?, count }`, see [Erasure](#erasure)                                                                                                                                     |
| `ctx.redacted`    | store                 | `RedactedData`: `{ type?, role? }`, the placeholder a redacted entry leaves behind                                                                                                                       |

These events are invisible to the model by default; like application events, projection rules decide whether they are rendered.

`ctx.unreadable` is not a stored entry but a placeholder given on read: when a store reads a row it cannot decode (a format version newer than it knows, a part it does not recognize), it throws by default, so the caller sees the problem instead of carrying on with history missing a piece. An implementation may offer a lenient mode (`placeholder` in `UnreadableMode`; the `unreadable` option of `ctx-sqlite` and the `ctx-remote` client), in which that row reads as a `ctx.unreadable` event: its `id`, `session`, `seq` and `at` are the row's own, so `after`, `watch` and `expectSeq` keep working and the rest of the session reads normally; `data` records the original `v`, `type` and the error. It is an event, so it stays out of the model's context by default; since it is not a stored `kind`, `list({ kinds })` cannot filter for it. `readEntry(raw, mode?, fallback?)` implements this rule (`upgradeEntry` plus the placeholder), and `unreadableEntry(raw, error)` builds the placeholder.

Pure functions: `upgradeEntry` (below); `userEntry`, `assistantEntry`, `messageEntry`, `eventEntry`, `summaryEntry` build entries; `runStartedEntry`, `runEndedEntry`, `compactedEntry`, `ctxErrorEntry`, `erasedEntry` build framework events (optional fields that are not given do not appear in `data`); `isFrameworkKind`; `isEvent(entry, kind)` and `runIdOf(entry)` tell which kind an event is and which run it belongs to, and `ctxEventData(entry, kind)` reads `data` back by `CtxEventData` (the type of `data` for each framework event `kind`): `undefined` when a required field is wrong, only the optional fields of the right type, and `{}` for a missing `agent` of `ctx.run.started`; `lastHarnessRun(lifecycle, name)` finds the `harness.session` that the external harness called `name` recorded in its latest run; `compareEntries`, `textOf`; `filterEntries(entries, options)` is the semantics of `ListOptions`, `filterSessions(names, options)` the semantics of `SessionsOptions`, `eraseEntries(entries, erasure)` the semantics of the three erasure methods, all usable directly by in-memory stores; `redactedEntry(raw)` builds the placeholder after redaction, and `isErased(data, seq)` tells whether an erasure record touched a position.

### Erasure

```ts
type EraseOp = 'truncate' | 'remove' | 'redact';
interface ErasedData {
  op: EraseOp;
  upTo?: number; // truncate: the largest seq among the deleted entries
  seqs?: readonly number[]; // remove, redact: seqs of the entries touched, ascending
  count: number; // how many entries were touched
}
interface RedactedData {
  type?: string; // the original type: message, event, summary
  role?: string; // the role, when it was a message
}
type Erasure = { op: 'truncate'; upTo: number } | { op: 'remove' | 'redact'; ids: readonly string[] };
function eraseEntries(
  entries: readonly Entry[],
  erasure: Erasure,
): { entries: Entry[]; touched: Entry[]; erased?: ErasedData };
```

The three methods other than `clear` are together called erasure. What each does:

| Method                 | What it does                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `truncate(session, n)` | Deletes entries with `seq ≤ n`. `n` is floored; nothing is deleted when it is not a finite number. To clean up history covered by a summary, pass the summary's `covers` as `n`                                                                                                             |
| `remove(session, ids)` | Hard delete by `id`. Afterwards its `id` and `key` can be used again (as with `clear`)                                                                                                                                                                                                      |
| `redact(session, ids)` | Redact by `id`: the entry becomes a `ctx.redacted` event; `id`, `session`, `seq`, `at`, `key` and `source` stay, `v` is the current version, the message, text, data and `meta` are dropped, and `data` is `RedactedData`. Entries already redacted are skipped, so repeating it is a no-op |

Common rules:

- Each returns how many entries it actually touched. Unknown `id`s and `id`s from another session are skipped, not an error; a repeated `id` counts once.
- They work only on columns such as `id` and `seq` and never decode the body: rows that cannot be read (`unsupported_version`, `unsupported_part`) can still be deleted or redacted, and once redacted they read fine. Take a bad row's `id` from the `ctx.unreadable` placeholder of the lenient mode.
- **Atomic**: all or nothing, never interleaved with a concurrent `append`.
- **A record stays**: when entries were actually touched, the store appends a `ctx.erased` (`ErasedData`, `source: 'store'`) in the same operation, with positions only and no content. Nothing touched (returns 0), nothing appended.
- **`seq`**: never goes back and is never reused; the remaining entries keep their `id`, `seq` and `at`. Because of that record, the end of the session always moves forward one step after an erasure, even when the last entry was deleted, even when the whole session was (then the session holds only that record and `sessions` still lists it).
- **`expectSeq`**: so a write that uses the end from before the erasure as its precondition always gets one `conflict`, and re-reading shows the record. Erasure itself takes no `expectSeq`.
- **`watch`**: subscribers receive `ctx.erased` and update their own copies (mirrors, UIs) from it; deleted or redacted entries are not sent again.
- **A summary's `covers`**: after `truncate(session, covers)` the summary still applies; the entries it replaces are just gone. Earlier summaries at positions below `covers` are deleted with them. Erasure does not change a summary's text: the summary was computed from the covered entries, and deleting those entries does not take their content out of it; to clear both, `redact` the summary too and compact again. A redacted summary is no longer a summary, and the entries it covered that still exist become visible again.
- **Projection after redaction**: `ctx.redacted` is an event and stays out of the model's context by default; a tool call or result missing its other half is completed or dropped by the projection (see [Context](#context-contextbuilder)). To leave a "deleted" note in place, write an event rule for `ctx.redacted`; `data.role` is the original role.
- **Lifecycle events**: deleting a run's `ctx.run.ended` while keeping its `ctx.run.started` makes the session look like it has an unfinished run, which only `recover` clears.
- **A running harness**: see the write rules under [Harness](#harness): when entries this run wrote are erased, it stops at its next write.

`clear` is not covered by these rules: it leaves no record, the session goes back to empty and its end back to 0 (`seq` still is not reused), `sessions` no longer lists it, and `watch` subscribers are not notified. A running harness notices it by "my `ctx.run.started` is gone". To empty a session and leave a trace, use `truncate(session, end)`.

Erasure covers the entries in the store. Text in summaries, facts extracted into memory from those entries, and backups are outside this guarantee; how thoroughly each implementation erases on its medium is in its own documentation (for `ctx-sqlite`, see [its package docs](../../packages/sqlite/README.md#删除和文件大小)).

### Export, import, copy

```ts
interface SessionExportHeader {
  format: 'ctx.session';
  version: number; // SESSION_EXPORT_VERSION, currently 1
  session: string; // session name at export time
  exportedAt: number;
}
interface SessionExportEnd {
  end: true;
  entries: number; // number of entry lines in between
}

function exportSession(
  store: Pick<SessionStore, 'list'>,
  session: string,
  options?: { pageSize?: number; unreadable?: 'throw' | 'skip'; now?: () => number; signal?: AbortSignal },
): AsyncGenerator<string>;

type ImportIds = 'keep' | 'new' | ((id: string) => string);
function importSession(
  store: Pick<SessionStore, 'append' | 'list'>,
  source: string | Iterable<string> | AsyncIterable<string>,
  options?: { session?: string; ids?: ImportIds; batchSize?: number; signal?: AbortSignal },
): Promise<{
  session: string;
  header: SessionExportHeader;
  read: number;
  written: number;
  skipped: number;
  remap(seq: number): number;
}>;

function copySession(
  source: Pick<SessionStore, 'list'>,
  from: string,
  target: Pick<SessionStore, 'append' | 'list'>,
  to: string,
  options?,
): Promise<ImportSessionResult>;
```

Each store assigns its own `seq`, so moving a session to another store (switching implementation, restoring a backup, forking, renaming) cannot be `list` followed by `append`: a summary's `covers` would still be a `seq` of the source store, and in the target it would either cover what it should not or cover nothing. These three functions use only `list` and `append`, so they work on any implementation, and they rewrite the fields that refer to `seq` along the way.

**The format** is JSON Lines (one JSON object per line, ending in `\n`): the first line is a `SessionExportHeader`, each line in between is an entry (the shape `list` returns, in ascending `seq`, with `v` being the `ENTRY_VERSION` at export time), and the last line is a `SessionExportEnd`. A file without the end line is truncated.

**Export** reads page by page (`pageSize`, default 500) and is not a snapshot: entries written by others during the export are included as far as it gets. A `ctx.unreadable` placeholder (a row the store could not decode in lenient mode) throws `unreadable` by default, so history with a piece missing is not exported as if complete; `unreadable: 'skip'` skips that line.

**Import** rules:

- `source` is the whole text, or the text in chunks split anywhere (a file stream, the return value of `exportSession`).
- The target session defaults to the name in the header; `session` renames it. `at`, `key`, `source` and `meta` are kept as they are; `session`, `seq` and `v` are filled in by the target store.
- **References to `seq` are rewritten**: a summary's `covers` and the `covers` of `ctx.compacted` become `remap(old)`, the target `seq` of the last entry whose source `seq` is at most the old value, or 0 when there is none (the covered entries had been `truncate`d). So entries covered by a summary in the source are still covered after the move. The `upTo` of `ctx.erased` is rewritten the same way; `seqs` keeps only positions still present in the file (redaction placeholders), since deleted entries have no position to point to. The `remap` in the return value is for things outside the session that refer to `seq` (memory's `SourceRef`, positions the application stored).
- **`id`**: `keep` (the default) keeps it. `id` is globally unique, so importing the same file twice yields one copy, and after a failure halfway you import the complete file again to finish; it also means you cannot copy within one store: when an entry's `id` already exists in another session it throws `conflict` rather than silently dropping it. `new` lets the target store generate new ones, and importing twice writes a second copy. A function maps ids with it (same input must give same output), and importing twice still yields one copy. The `summaryId` of `ctx.compacted` follows the summary's new `id`.
- **Not atomic**: it appends in batches (`batchSize`, default 200), and on a failure halfway what was written stays in the target session. A truncated file throws `invalid_request` when it runs out, after the part it read has been written.
- A line whose `v` is below its own `ENTRY_VERSION` is upgraded (as `upgradeEntry`), one above throws `unsupported_version`; a header `version` above `SESSION_EXPORT_VERSION` throws the same. Not an export file, lines out of order, or a count that does not match the end line throws `invalid_request`.
- It does not check that the target session is empty: importing into a session with content lets the imported summaries cover the existing entries too.

`copySession` is export followed by import. When both stores are the same object, `ids` defaults to `new`, otherwise `keep`; two clients of the same database cannot tell they are the same, so pass `ids` yourself.

### Message format and versions

The protocol package defines ctx's own `Message` (four roles: `system`, `user`, `assistant`, `tool`), a subset of AI SDK's `ModelMessage` that is all JSON:

| Part                                 | Shape                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `reasoning`                  | `{ type, text, providerOptions? }`; reasoning signatures live in `providerOptions`, stored as they are and needed when sent back                                                                        |
| `file`                               | `{ type, mediaType, data: ToolFileData, filename?, providerOptions? }`; `mediaType` may be just `image`; AI SDK's deprecated `image` merges into `file`                                                 |
| `reasoning-file`                     | Like `file`, but `data` is only bytes (`data`) or an address (`url`), as in AI SDK                                                                                                                      |
| `custom`                             | `{ type, kind, providerOptions? }`, provider-defined content                                                                                                                                            |
| `tool-call`                          | `{ type, id, name, input, providerExecuted?, providerOptions? }`, field names as in `ToolCall`                                                                                                          |
| `tool-result`                        | `{ type, id, name, output: ToolOutput, providerOptions? }`                                                                                                                                              |
| `tool-approval-request`, `-response` | `approvalId`, `callId`, `reason?`, `approved`, …; the request also has `isAutomatic?`, `signature?`, `inputSchemaInput?` (the signature binds the approval to the call; lose it and verification fails) |

`ToolFileData` is `{ type: 'data', data: base64 } | { type: 'url', url } | { type: 'reference', reference } | { type: 'text', text }`. The `providerOptions` inside `tool-result.output` and the `custom` content parts have nothing serializable and are dropped on conversion.

- Conversion to and from AI SDK lives in `@modelctx-ai/ctx`: `toModelMessages`, `fromModelMessages` (`createContext()` still takes AI SDK's `UserContent` and converts at the boundary). A part outside the subset (something AI SDK adds later) throws `unsupported_part` rather than being dropped silently; the harness ends the run with `error`, writes `ctx.error`, and writes no partial output. The core package has a compile-time exhaustiveness check (`AI_SDK_PART_TYPES`): if AI SDK adds a part to `UserContent`, `AssistantContent` or `ToolContent`, the core package stops compiling.
- `ENTRY_VERSION = 1`, and every entry carries `v`. A store writes `v: 1` on new rows and calls `upgradeEntry(raw)` on every row it reads to bring it to the current shape, **without writing old rows back**. A missing `v` reads as 0 (how 0.2 and earlier wrote it: AI SDK messages as they were, binary and URLs marked with `\u0000ctx`, a summary's `covers` as `{ at, seq }`); 0 → 1 converts messages to `Message` and takes `covers.seq` for `covers`. The `Entry.v` you read is the version the row was written with (0 for old rows) while the shape is already current; a `v` newer than it knows throws `unsupported_version`, so upgrade ctx and read again (in lenient mode it reads as `ctx.unreadable`, see above). The remote client checks the server's entries by the same rule.
- Rolling upgrades: when old and new versions share a database (or a remote), **upgrade the readers first**. Once the new version writes a row in the new format, the old process's `list`, `view` and `watch` on that session all throw `unsupported_version`; to keep an old process working during the transition, give it `unreadable: 'placeholder'`, at the cost of not seeing entries in the new format. There is no downgrade path: `ctx-sqlite`'s schema migrations (renamed columns, changed indexes) are irreversible, and an old version cannot open an upgraded database.
- A version 0 summary covers old entries by `at`, version 1 by `seq`, so an old record written in later can be covered by an old summary. `findLossySummaries(store, { session? })` in `@modelctx-ai/ctx` only reads and lists summaries with `v` 0 that cover entries, as `{ session, summaryId, covers, hidden: seq[] }`; `recompactLossy(builder, finding, options)` appends a new summary with the same `covers` (its input is the old summary's text plus the covered entries) and replaces the old one through "on equal `covers` the later one wins". The new summary has `v: 1`, so a second run of `findLossySummaries` finds nothing, and it can run at every startup.

## Context `ContextBuilder`

Assembles the session log, facts fetched from sources and this run's input into one model call. It holds a `SessionStore`; the harness only gives it a session name.

```ts
interface WindowOptions {
  maxMessages?: number; // summaries do not count
  maxTokens?: number; // estimated, summaries included
  truncate?: boolean; // shorten messages when they do not fit, not only drop whole ones; off by default
}
interface BuildRequest {
  session: string;
  input?: MessageContent; // this run's input; omitted when it is already in the log
  instructions?: string; // the AgentSpec's instructions
  prompt?: MessageContent; // a final, temporary user message that is not logged
  tools?: readonly ToolDefinition[]; // candidate tools; the builder may filter further
  window?: WindowOptions;
  facts?: boolean | FactsSpec; // whether to collect sources, default yes; FactsSpec also picks sources, placement, heading
  projection?: string; // projection config name, default `default`; an unknown name fails build with not_found, no fallback
  signal?: AbortSignal;
}
interface PreparedCall {
  instructions?: string; // instructions + facts + system text from the projection
  messages: Message[]; // no system messages any more
  tools: readonly string[]; // tool names given to the model this time
  facts: readonly Fact[];
  projection: Projection;
  tokens?: number; // estimate for the whole call: instructions, facts, tool definitions, messages; multiplied by calibration when calibrated; the harness's overflow check uses it
  calibration?: number; // factor applied when calibrating against the previous run's actual usage (greater than 1); absent otherwise
}
interface CompactOptions {
  model?: ModelRef;
  keep?: number; // how many recent entries stay as they are
  minimum?: number; // do not compact when fewer older entries than this
  instructions?: string;
  maxInputTokens?: number; // cap (estimated) on the input given to the summary model at once; longer history is summarized in rolling segments
  maxOutputTokens?: number; // cap on each summary's output
  timeoutMs?: number; // the whole compaction, every segment included
  signal?: AbortSignal;
}
type CompactStatus = 'compacted' | 'not_needed' | 'truncated' | 'empty' | 'input_too_long';
interface CompactResult {
  status: CompactStatus;
  summary?: SummaryEntry; // the last summary written this time (the one now in effect); absent when none was written
  calls: number; // how many times the summary model was called
  compacted: number; // messages now in a summary
  remaining: number; // messages that should have gone in and did not this time
  shortened: number; // messages shortened before going into the summary's input
}
interface ContextBuilder {
  build(request: BuildRequest): Promise<PreparedCall>;
  /** The current view: summary + entries after it, rendered by the rules. The gateway uses it. */
  view(session: string, options?: { window?: WindowOptions; projection?: string }): Promise<Projection>;
  /** Compacts older history into a summary and appends it, recording ctx.compacted. Returns null when no summary was written. */
  compact?(session: string, options?: CompactOptions): Promise<SummaryEntry | null>;
  /** Like compact, and says how it ended. */
  compactDetailed?(session: string, options?: CompactOptions): Promise<CompactResult>;
}

interface ContextSource {
  name: string;
  collect(context: { session: string; signal?: AbortSignal }): Awaitable<string | null | undefined>;
}
interface Fact {
  source: string;
  text: string;
}

// Projection: input and output of the pure function project(entries, options)
interface ProjectionOptions {
  events?: Record<string, EventRule>; // events without a rule stay out of the context
  summary?: (entry: SummaryEntry) => Message;
  message?: (entry: MessageEntry) => Message | null | undefined;
  window?: WindowOptions & { estimate?: (message: Message) => number }; // ProjectionWindow
}
interface EventRule {
  fold?: boolean;
  render(events: readonly EventEntry[]): Message | readonly Message[] | null | undefined;
}
interface Projection {
  messages: Message[];
  items: readonly ProjectedMessage[]; // each with from, upTo, at, pinned, tokens
  tokens: number;
  dropped: number; // messages dropped by the window; when projectSession read only the tail, it counts only the part it read
  truncated: number; // messages shortened because of window.truncate
  summary?: SummaryEntry;
}
```

- The reference implementation = projection rules (event rendering, summary rendering, message rewriting, window) + sources + compaction, which is what `prepare`, `view` and `compact` in `createContext` do today.
- Projection, source collection, token estimation and shortening are pure functions in the protocol package: `project(entries, options)`, `projectSession(store, session, options)`, `latestSummary`, `defaultSummaryMessage`, `collectFacts(sources, { session, timeoutMs?, only?, logger?, onError? })` (`only` picks sources by name, `logger` records errors, timeouts and names not registered), `renderFacts`, `defineSource`, `estimateTokens`, `estimateTextTokens`, `estimateFileTokens`, `truncateText`, `truncateMessage`. Their semantics are in [the architecture](../architecture.md#投影).
- Long sessions need not be read whole: `projectSession` reads the effective summary and the entries after it, then projects them, with the same result as reading them and calling `project`, but with a window it reads only as much of the tail as it needs. It reads the last N entries by `seq` (`last`) and uses `atAfter` to add entries written earlier whose `at` sorts after those N, so what it read is a complete tail in projection order. When the window pushed out the possibly incomplete first group (a fold of same-kind events cut in two, or tool results whose call is further back) and at least one complete group after it, nothing earlier can enter the window; otherwise it reads four times as many and tries again. Without a window (or with `{}`) it reads everything. The reference implementation's `view` and `build` use it.
- A projection's output is a message sequence a model API accepts, whatever the log looks like and wherever the window cuts: a tool result without its call (the call was cut, or never existed) is dropped; a tool call without a result (the run broke off) gets an error result (`No result was recorded for this tool call.`), except calls the provider executed itself (`providerExecuted`); after the window cuts, no orphaned tool result is left at the start, and without a summary it does not start with an assistant message either (it cuts on to the next user message). The two tool approval parts (`tool-approval-request`, `tool-approval-response`) are for the application only and are dropped in projection (`withoutApprovals(message)`; a message left empty is dropped): an approved call is run by the harness, which writes its result, so the model sees the call and the result.
- The window is configured in two places: a `window` in the request (`BuildRequest`, `ViewOptions`, `AgentSpec`) **replaces** the builder's limits entirely when given, and `{}` means no cutting; `estimate` is a function that cannot cross the wire, so the builder's is always used. In `build`, `maxTokens` covers the whole call: the estimates of instructions, facts, tool definitions, `input` and `prompt` are taken out first and what is left is the budget for history; `view` has none of those, so there `maxTokens` is the history budget.
- `window.truncate`: by default the window only drops whole groups and always keeps the last group, even when it alone is over budget (a 250k-token tool result, a long pasted text). With `truncate: true` (which needs `maxTokens` as well) it does two more things: first it caps single messages, shortening any message over half the history budget to half, so it does not push out all other history; then if only the last group is left and it is still over, it keeps shortening from the largest message until it fits. Shortening uses `truncateMessage(message, maxTokens, estimate?)`: text keeps its head and tail with a note in the middle on how many characters were left out (`truncateText(text, maxTokens, estimate?)`), a tool result first replaces inline files with a note and then is written as text and shortened (an error result shortens only the message and drops `data`), and inline files in a message are replaced with a note; reasoning, tool-call inputs and provider-defined content are left alone (cutting them breaks signatures or makes the call invalid), so the result may still be over. Shortening happens only in this projection and the log is unchanged; `Projection.truncated` is how many messages were shortened.
- Compaction (`compact?`, `compactDetailed?`):
  - **Segments.** When the history to compact is over `maxInputTokens` (the estimate of the compaction instructions, the existing summary and this segment together), it summarizes segment by segment: each segment goes to the model with the summary so far, and the new summary is carried into the next segment. Tool-call inputs and tool results are shortened before going into the summary's input; a single message over a segment's budget is shortened too, or it would never get through.
  - **Checkpoints.** After each segment it appends a `summary` and a `ctx.compacted` (`covers` falls between this segment and the next; a tool call and its result are never split across them). If the model fails, times out or is cut off halfway, what was already compacted stays, and calling again continues from there. So one compaction can leave several summaries; only the last one is in effect.
  - **How it ends.** The `status` of `compactDetailed`: `compacted`, everything that should go into the summary did; `not_needed`, the history is not long enough and the model was not called; `truncated`, a segment's summary was cut off by `maxOutputTokens`, that segment is not written and it stops there; `empty`, the model gave no text, likewise not written; `input_too_long`, it still does not fit after segmenting (the existing summary plus instructions already fill `maxInputTokens`, or the summary model itself reports the context is too long even after halving a segment all the way down). `compact` is its shorthand: it returns the last summary written this time, or `null` when none was. Errors of the model call itself (network, timeout) are thrown as usual.
  - **Entries with `at` in the future.** Events whose `at` is a due time always sort last in the view. They do not count toward "the most recent `keep` entries": those written before the cut go into the summary, those written after stay in the view as usual. Previously their `seq` pinned `covers` before them, and messages written later could never be compacted. `ProjectedMessage.at` is the latest `at` among the entries a message comes from.
- Token estimation does not tokenize: a CJK character counts 1, 4 ASCII characters count 1, 2 other characters count 1; attachments use `estimateFileTokens(mediaType, data)`: inline text by its characters, base64 by its decoded size (images up to 64 KiB 256, larger 1600; text types bytes divided by 4; anything else 1 per 20 bytes, at least 256), and addresses and provider references, whose size is unknown, 256. For accuracy, plug a tokenizer into `window.estimate`. The harness records the estimate for the first step's request in `StepMeta.estimatedInputTokens`, so comparing it with `usage.inputTokens` shows how far off it was; the reference builder uses that ratio to tighten the next run's `maxTokens` (`PreparedCall.calibration`, only ever tighter), see [the architecture](../architecture.md#调用).
- `ProjectionOptions` contains functions; it is configuration of an in-process builder and never goes through protocol methods, which only carry the serializable `WindowOptions`.
- Prompt caching: appending facts to the end of the instructions changes the system prefix every time, so the reference implementation offers to put facts in the final temporary user message instead.

## Tools `ToolRegistry`

The tool catalog. It holds definitions, not functions; each definition is bound to an executor by name.

```ts
interface ToolDefinition {
  name: string; // [a-zA-Z0-9_-]{1,64}
  description?: string;
  inputSchema: JsonObject; // JSON Schema
  executor: string; // the executor's name
  source?: string; // local, mcp:<server>, process, …
  tags?: readonly string[];
}
/** A serializable selection: within each item any value may match; every item given must match. */
type ToolSelection =
  | boolean
  | readonly string[]
  | { names?: readonly string[]; tags?: readonly string[]; sources?: readonly string[] };
/** In process a function also works. */
type ToolFilter = ToolSelection | ((tool: ToolDefinition) => boolean);

interface ToolRegistry {
  size: number;
  add(definition: ToolDefinition, options?: { replace?: boolean }): ToolRegistry;
  remove(name: string): boolean;
  removeSource(source: string): number;
  has(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[]; // in the order added
  select(filter?: ToolFilter): ToolDefinition[]; // same as selectTools(list(), filter)
  executor?: Executor; // the registry's own executor (the reference implementation keeps addTool's functions there), used by harnesses along with their own executors
}
```

- `add` throws when the name is invalid, or when the name exists and `replace` was not given. The catalog is synchronous: it travels with the harness and does not cross a boundary on its own.
- Pure functions: `isValidToolName`, `matchesTool`, `selectTools`.
- The reference implementation adds sugar: `registry.addTool(name, aiSdkTool, meta)` turns a zod tool into a JSON Schema definition and puts the function in an in-process function executor.
- Naming conventions come from Anthropic's article on tool design: prefix by service and resource (an MCP tool is `<server>__<tool>`), use unambiguous parameter names (`user_id`, not `user`), and write descriptions for a new colleague.

## Executors `Executor`

Where tool calls actually happen.

```ts
interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}
type ToolOutput =
  | { type: 'text'; text: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'content'; parts: readonly ToolContentPart[] }
  | { type: 'error'; message: string; retryable?: boolean; data?: JsonValue };
type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mediaType: string; data: ToolFileData; filename?: string };
type ToolFileData =
  | { type: 'data'; data: string } // base64
  | { type: 'url'; url: string }
  | { type: 'reference'; reference: Record<string, string> } // a provider's file reference
  | { type: 'text'; text: string };

interface ExecutionContext {
  session: string;
  runId?: string;
  signal?: AbortSignal;
}
interface Executor {
  name: string;
  /** Which tools it can run. Executors such as MCP and subprocesses report their own; a function executor reports what was registered. */
  tools?(): Promise<ToolDefinition[]>;
  /** Unknown tools and an already aborted signal both return { type: 'error' }. */
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
  provision?(): Promise<void>; // may be called repeatedly
  dispose?(): Promise<void>;
  /** Prepares one session (starts a container, creates a working directory); may be called repeatedly. Throws invalid_request when it cannot meet environment. */
  open?(session: string, options?: ExecutorSessionOptions): Promise<void>;
  close?(session: string): Promise<void>; // may be called repeatedly; open works again afterwards
}
interface ExecutorSessionOptions {
  environment?: EnvironmentSpec;
  signal?: AbortSignal;
}
interface EnvironmentSpec {
  name?: string;
  image?: string; // image or template
  packages?: Record<string, string[]>; // per package manager: { pip: ['pandas'] }
  network?: { allow?: string[] }; // outbound allowlist
  env?: string[]; // names of the environment variables needed; the deployment supplies the values
  meta?: JsonObject; // implementation-specific configuration
}
```

- A failed execution returns `{ type: 'error' }` instead of throwing: the model has to see the error to carry on. Throwing means the executor itself is broken. Error messages should be actionable ("no such file: /a/b; the current directory has …"), not error codes.
- Who owns what at the tool boundary:
  - **Input** is validated by the harness against `ToolDefinition.inputSchema` before execution; input that does not match is not executed, and the problems go back to the model as `{ type: 'error' }` to retry. So executors that only have a JSON Schema (remote, MCP, subprocess) need not each write their own, and the model sees errors written one way. The pure function `checkJsonSchema(schema, value, limit?)` returns a list of problems and checks only the keywords it knows (`type`, `enum`, `const`, `required`, `properties`, `patternProperties`, `additionalProperties`, `items`, `prefixItems`, length and numeric bounds, `pattern`, `allOf`, `anyOf`, `oneOf`, `nullable`), letting everything else through: what it reports is always a real problem, and silence does not mean full conformance. Executors must still check the constraints they care about, since callers that call `execute` directly skip this layer. An executor that has a schema more precise than JSON Schema and validates by itself (the zod tools of `addTool` in the reference implementation) may be exempted from the harness check.
  - **Output** is cut or paged by the executor before it reaches the model: it knows how to cut usefully (keep the head and tail of command output, page files by lines). The harness adds a floor: a result over the limit (configurable, `DEFAULT_MAX_TOOL_OUTPUT_CHARS` by default, 200,000 characters) is cut with a note on how much was left out, so an executor that forgets cannot fill the context. The pure function `limitToolOutput(output, maxChars)`: text and error messages are cut directly, `json` that is over once serialized becomes cut text, and `content` is counted across parts, with inline files that do not fit replaced by a note.
- Conversion to and from AI SDK: `toolOutputToAiSdk(output)` gives a tool result's `output` (`text`, `json`, `error-text`, `error-json`, `content`), and `toolOutputFromAiSdk` converts back. Protocol → AI SDK → protocol loses nothing: an error with only text is `error-text`, one with `retryable` or `data` is `error-json` with `{ message, retryable?, data? }`; when `URL` normalization would change the spelling, the original string goes into `originalUrl`. In the other direction: binary becomes base64, the deprecated `image-data`, `file-url` and the like become `file`, `execution-denied` becomes an error, an `error-json` of any shape goes whole into `data`, and `providerOptions` and `custom` parts are dropped.
- `errorOutput(message, { retryable?, data? })` builds an error result.
- `Executors` is a collection of executors: an array keyed by each `name`, an object by its keys. `executorMap(executors, registry?)` gives the table by name, with the registry's own (`ToolRegistry.executor`) added and `executors` winning on a name clash; `executorTools(executors)` is the definitions the executors' `tools()` report, keeping the first of each name.
- **Per-session executors ([ADR 0009](../adr/0009-hosted-prerequisites.md)).** `provision` and `dispose` manage the whole executor; `open` and `close` manage one session: one container, one working directory per session. Before a run first hands a call to an executor, the harness calls its `open(session, { environment: agent.environment })` once; when `open` throws, every call this run hands to it gets an error result, the model sees why, and the run carries on. When a session ends is the application's decision, and the framework does not guess: the application calls each executor's `close` (`closeExecutorSessions(executors, session)` in the reference implementation). Reclaiming idle sessions is the executor's own policy. When an `EnvironmentSpec` cannot be met (no such image, no allowlist support, a variable not configured), `open` throws `invalid_request` and does not quietly degrade.
- **Credentials stay out of executors.** Credentials never appear in `ToolCall`, `ExecutionContext` or `AgentSpec`, so they are never in the log either; `EnvironmentSpec.env` has only variable names. Tools that need credentials run on the harness side (function executors, MCP servers), out of reach of model-generated code; those that must use them inside a sandbox have them swapped in at the egress by the deployment: the sandbox holds only a placeholder and an outbound proxy puts in the real one. Environment variables handed to a subprocess are readable by model-generated code.
- Implementations: in-process functions (core package), MCP servers (`ctx-mcp`), local subprocesses (`ctx-exec`, one working directory per session with `sessionCwd`), HTTP remote (`ctx-remote`). The other direction: `createMcpServer` in `ctx-mcp` wraps executors as an MCP server (stdio or Streamable HTTP), through which programs with their own loop call ctx's tools; the callers do not go through a harness, so input checks, result truncation, opening the session before execution (`open`) and `deny` (`permissions`) all happen on its side. `listenMcpHttp` starts a local HTTP server with a one-time token for the subprocesses one starts.
- A remote executor can be connected two ways: the harness calls it (it is a service), or it takes work from the harness (a worker that needs only outbound connections, like Managed Agents' self-hosted sandbox). The protocol is the same, and `ctx-remote` does both: the server mounts `executors`, or a worker takes work by name (`POST /work/:executor/claim`, see "Tool calls through the log" below).

## Harness

One run.

```ts
type ModelRef = string | Exclude<LanguageModel, string>; // only a name across a boundary

interface CallSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: readonly string[];
  maxRetries?: number;
  timeoutMs?: number; // the whole run, tool steps included
  headers?: Record<string, string>;
  providerOptions?: Record<string, JsonObject>;
}
interface AgentSpec {
  name?: string;
  model: ModelRef;
  instructions?: string;
  tools?: ToolSelection; // default: all
  maxSteps?: number; // default: 5 with tools, 1 without
  window?: WindowOptions;
  context?: ContextSpec; // how this agent's context is assembled
  settings?: CallSettings;
  version?: string; // the application's version label for this configuration, recorded in ctx.run.started
  output?: OutputSpec; // structured output
  toolChoice?: ToolChoice; // default auto
  permissions?: ToolPermissions; // allow, ask or deny per tool name
  budget?: RunBudget; // limits for the whole run, checked between steps
  environment?: EnvironmentSpec; // handed to the executors' open, see "Executors"
}
interface OutputSpec {
  schema: JsonObject; // JSON Schema
  name?: string;
  description?: string;
}
type ToolChoice = 'auto' | 'none' | 'required' | { tool: string };
type ToolPermission = 'allow' | 'ask' | 'deny';
interface ToolPermissions {
  default?: ToolPermission; // default allow
  tools?: Record<string, ToolPermission>;
}
interface RunBudget {
  maxTotalTokens?: number; // totalTokens summed over all steps
  maxDurationMs?: number; // wall-clock time from the start of the run
}
interface ContextSpec {
  facts?: boolean | FactsSpec; // false collects no facts; collected by default
  projection?: string; // name of a projection config registered in the builder; default `default`
  overflow?: OverflowSpec; // what to do when the whole call exceeds the model's window; unchecked by default
  inherit?: InheritSpec; // put another session's projection (usually the parent's) in front
}
interface InheritSpec {
  session: string;
  upTo?: number; // only up to this seq, default all
}
interface OverflowSpec {
  maxTokens: number; // cap on the estimated tokens of the whole call: the model's window minus room for output, with a margin
  strategy?: 'compact' | 'trim' | 'error'; // default compact: compact first, then trim if still over
  compact?: Pick<
    CompactOptions,
    'keep' | 'minimum' | 'instructions' | 'maxInputTokens' | 'maxOutputTokens' | 'timeoutMs'
  >;
}
interface FactsSpec {
  sources?: readonly string[]; // only these sources (ContextSource.name); default all
  placement?: 'instructions' | 'prompt';
  heading?: string; // heading line before the facts
}
interface RunRequest {
  session: string;
  agent: AgentSpec;
  input?: MessageContent;
  inputKey?: string; // idempotency key of the input, so a retry does not record it twice
  prompt?: MessageContent; // temporary last message, not logged
  record?: boolean; // logged by default
  runId?: string; // generated when not given
  owner?: string; // orchestrator instance name
  parent?: RunParent; // this run was dispatched by another agent
  signal?: AbortSignal;
}
interface RunParent {
  session: string; // parent session
  runId: string; // parent run
  toolCallId?: string; // the tool call in the parent session that dispatched it
}
type StopReason = 'end_turn' | 'max_steps' | 'max_tokens' | 'max_budget' | 'requires_action' | 'aborted' | 'error';
interface Usage {
  inputTokens?: number; // including tokens read from and written to the cache
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number; // input read from the prompt cache
  cacheWriteTokens?: number; // input written to the prompt cache
  reasoningTokens?: number; // output spent on reasoning
}
interface StepMeta {
  // meta.step, written by the harness on each step's assistant message
  runId: string;
  step: number; // counted from 0
  provider?: string;
  modelId?: string; // the model identifier in the provider's response
  finishReason?: string;
  usage?: Usage; // this step's usage
  estimatedInputTokens?: number; // first step only: the estimate for this request (PreparedCall.tokens)
  calibration?: number; // first step only: the calibration factor applied to that estimate
}
interface RunResult {
  runId: string;
  text: string;
  messages: Message[]; // messages the model produced in this run
  recorded: readonly Entry[];
  stopReason: StopReason;
  usage?: Usage;
  output?: JsonValue; // the parsed answer when agent.output was given
  pending?: readonly ToolCall[]; // with stopReason requires_action, the calls waiting to be executed elsewhere
  approvals?: readonly ToolApproval[]; // the calls in pending waiting for a person's approval
  error?: ErrorInfo; // with stopReason error; carries statusCode and responseBody when an upstream HTTP API failed; type is context_overflow when the context was too long
}
interface ToolApproval {
  approvalId: string; // the tool-approval-request written in the call's assistant message
  callId: string;
  reason?: string; // shown to the person approving
}
type RunEvent =
  | { type: 'run.started'; runId: string; session: string; seq?: number }
  | { type: 'model.started'; runId: string; step: number }
  | { type: 'text.delta'; runId: string; text: string }
  | { type: 'reasoning.delta'; runId: string; text: string }
  | { type: 'tool.called'; runId: string; call: ToolCall }
  | { type: 'tool.returned'; runId: string; callId: string; output: ToolOutput }
  | { type: 'model.ended'; runId: string; step: number; usage?: Usage; seq?: number }
  | { type: 'run.ended'; runId: string; result: Omit<RunResult, 'messages' | 'recorded'>; seq?: number }
  | { type: 'error'; runId: string; message: string };

type ToolDecision =
  | { allow: true; input?: JsonValue }
  | { allow: false; reason: string }
  | { ask: true; reason?: string };
interface ModelHookContext {
  runId: string;
  session: string;
  step: number;
  signal?: AbortSignal;
}
interface Hooks {
  beforeModel?(call: PreparedCall, context: ModelHookContext): Awaitable<PreparedCall | void>;
  beforeTool?(call: ToolCall, context: ExecutionContext): Awaitable<ToolDecision | void>;
  afterTool?(call: ToolCall, output: ToolOutput, context: ExecutionContext): Awaitable<ToolOutput | void>;
}
interface Harness {
  run(request: RunRequest): Promise<RunResult>;
  stream?(request: RunRequest): AsyncIterable<RunEvent>;
}
```

- `AgentSpec.context` picks facts and a projection per run. Functions (a source's `collect`, a projection's `render`) cannot be serialized, so they are picked by name only, the same idea as `ToolSelection`: register them with the builder in code (`createContextBuilder({ sources, projection, projections })`) and refer to the names in `context`. The harness puts `agent.context` into the `BuildRequest` as it is; `RunRequest` gains no field, since `agent` is already complete. `context` is JSON, the `agent` in `ctx.run.started` records the configuration the run used, and the remote needs no new routes. A third-party builder that ignores `context` silently falls back to the defaults, and the harness contract test exposes that with "an unknown projection name must end in `not_found`".
- What the harness does in a run: `ctx.run.started` → record the input → `ContextBuilder.build` → (when `context.overflow` is configured) the overflow check → call the model → for each tool call: `beforeTool` → find the bound executor → `execute` → `afterTool` → the tool result goes back to the model, until it stops → `ctx.run.ended`.
- **Every step is logged as it happens.** Output does not wait for the run to end: when a step calls tools, the call (an assistant message) is written before the tools run; when the step ends the rest of it is written (tool results, or the assistant message when there was no tool call); `ctx.run.ended` comes last. Every write carries `expectSeq`. So whenever the process crashes, the log has the steps already done, and at least "call sent, result unknown". When the run ends halfway (error, cancellation), the steps already written stay; tool calls that were written but never got a result first get an error result, then `ctx.error` and `ctx.run.ended` are written.
- A model error or a cancellation still writes `ctx.run.ended`, and `run` returns as usual, with `stopReason` and `error` saying why; it rejects only when writing the log itself fails. Remote callers therefore always get the same shape.
- `stream` yields `RunEvent`s: when the caller stops reading early, the run is aborted. `streamRun(request, run)` wraps a run that hands out events as it goes (`run(request, emit)`) as `stream`, aborting, waiting for it to end and rethrowing by this rule.
- **Capabilities in `AgentSpec` that can only be expressed in JSON**, so they survive a change of harness and a trip through remote (#47):
  - `version`: the application's own version label, recorded as it is in `ctx.run.started`, so looking back you know which version a run used.
  - `output`: structured output. The final answer is generated against `schema` (with constrained decoding when the provider supports it), parsed, checked with `checkJsonSchema` and put in `RunResult.output`; when it is not JSON or does not match the schema the run ends in `error` with `error.type` `invalid_output` (`retryable: false`). It is parsed only on `end_turn`: a run that stopped at tool calls (`requires_action`, `max_steps`, `max_budget`) has no answer to parse.
  - `toolChoice`: `auto`, `none`, `required`, or `{ tool }` naming one; naming a tool not among this run's tools is `invalid_request`. Ignored when there are no tools.
  - `permissions`: `allow`, `ask` or `deny` per tool name (`default` is `allow` by default; the pure function `toolPermission(permissions, name)` gives a tool's permission). A `deny` tool is not run, the model sees the refusal, and the run continues, even when it is bound to an external executor (`deny` comes first); an `ask` tool is not run: the call and an approval request are written and the run stops with `requires_action`, waiting for the application's decision (see "Human approval" below). `Hooks.beforeTool` is called as usual after `allow`.
  - `budget`: `maxTotalTokens` (the sum of every step's `totalTokens`, or input plus output when missing) and `maxDurationMs` (wall clock). Checked only between steps: once over, no further step is taken and `stopReason` is `max_budget`; a model call or tool in progress is not interrupted, so use `settings.timeoutMs` for a hard limit. Cost limits are not here: price lists are the application's business, computed from the usage in `meta.step`.
  - `environment`: the execution environment this agent needs, handed by the harness as it is to the executors' `open` (see "Executors" above). Recorded in `ctx.run.started`.
  - When these values are wrong (a budget that is not positive, a permission that is not one of the three, an `output.schema` that is not an object), the run ends in `invalid_request`. A harness that does not support one of them must not silently ignore it: it either ends in `invalid_request` or says so in its conformance level.
- **Tool calls through the log ([ADR 0008](../adr/0008-tool-calls-through-the-log.md)).** Tools bound to an "external executor" (configured in the harness implementation; `createHarness({ external })` in the reference implementation) are given to the model but not run on the harness side: when the model calls them, the run writes the calls and ends with `requires_action`, with `pending` listing those calls, and does not hold the session. The executor appends results: `toolResultEntry(call, output)` is a `tool` message with the idempotency key `ctx.tool-result:<id>` (`TOOL_RESULT_KEY_PREFIX`), so a call is recorded once. Once all results are in, the next run continues without input. `pendingToolCalls(entries)` is a pure function that gives the waiting calls (`PendingToolCall`: `call`, `runId`, the `seq` of the entry with the call, `executor?`): those left by the run that ended with `requires_action`, minus those whose results were appended since; if a later run ends for another reason, the earlier waiting calls are void. When results never come, it is the application's call: submit the next run as usual and the projection gives the calls without results a "no result recorded".
  - **Taking work by name.** When a run ends with `requires_action`, the harness records in `ctx.run.ended` who runs the calls left to external executors (`RunEndedData.executors`: call `id` → executor name, the `ToolDefinition.executor`), and `PendingToolCall.executor` carries it; calls run in the harness (waiting for approval included) are not recorded. An executor uses it to find its work by its own name, without knowing which sessions exist: `POST /work/:executor/claim` in `ctx-remote` (see "Wire format").
- **Human approval (#21).** Calls waiting for a person's decision take the same path: calls under the `ask` permission, and calls for which `beforeTool` returned `{ ask: true, reason? }` based on the input (input that does not match `inputSchema` goes back to the model first, without asking the hook or a person). The call is not run; the harness writes an approval request (`tool-approval-request`: `approvalId`, `callId`, `reason`) in that call's assistant message, and once the step is done the run ends with `requires_action`, with the call in `pending` and the approval requests in `approvals` (`ToolApproval`).
  1. The application's decision is a `tool` message: `toolApprovalEntry(approvalId, { approved, reason? })` (`tool-approval-response`), with the idempotency key `ctx.tool-approval:<approvalId>` (`TOOL_APPROVAL_KEY_PREFIX`); only the first decision for a request counts. After appending it, submit the next run, with or without new input.
  2. At the start of the next run, before the input is recorded, the harness handles the decisions the previous run left: an approved call run here is run as usual (without asking `beforeTool` again; this run's `deny` still comes first), a denied one gets `approvalDeniedOutput(call, reason)` (`Tool call "<name>" was not approved: <reason>`), both as `toolResultEntry`; an approved call bound to an external executor is left to the executor. When streaming, these results come as `tool.returned` after `run.started`; the calls were reported in the previous run's stream. Undecided calls are left alone: the model sees a missing result, and once this run ends for another reason they are void, so a late decision does not count.
  3. `PendingToolCall.approval` (`PendingApproval`: `approvalId`, `reason`, and the `decision` the application appended) says what a waiting call is waiting for; `readPendingToolCalls(store, session)` reads the calls waiting in a session now (when the last lifecycle event is a run that ended with `requires_action`). An executor only runs calls without an approval request, or those already approved: undecided and denied calls are left alone. An approval request with `isAutomatic` does not count.
  4. Approval parts are for the application only and are dropped in projection (see "Context" above).
- **Overflow fallback (`AgentSpec.context.overflow`, off by default).** After `build` the harness estimates the whole call (`PreparedCall.tokens`; when the builder does not give it, it computes instructions, messages and the tool definitions given to the model with `estimateTokens` and `estimateTextTokens`), and goes on as usual when it is within `maxTokens`. When over, by `strategy`:
  1. `compact` (the default): calls `ContextBuilder.compact` (options from `overflow.compact`, with `keep` at least 1, so the input just recorded in this run does not go into the summary) and builds again when a summary was written. The summary model is the builder's; when the builder has none, this run's model is used, so the configuration carries no model name and a remote caller cannot use it to pick an arbitrary model. A builder without `compact`, a compaction that did not work (a warning is logged), or still over after compacting all go to the next step. A run that is not logged (`record: false`) skips this step: compaction appends a summary, and it should write nothing.
  2. Trim (the step after `compact`, or straight here with `strategy: 'trim'`): builds again with `window: { ...agent.window, maxTokens, truncate: true }`, dropping from the oldest message and shortening single messages over budget. Writes nothing.
  3. Still over (instructions, tool definitions or the `input` itself do not fit), or `strategy: 'error'`: the run does not call the model and ends with `stopReason: 'error'` and `error.type: 'context_overflow'` (`retryable: false`), writing `ctx.error` and `ctx.run.ended` as usual.
     The configuration is all JSON, crosses the wire with `agent.context`, and is recorded in `ctx.run.started`; a `maxTokens` that is not positive or an unknown `strategy` ends the run in `invalid_request`. The check happens only before the first model call: context that grows during tool steps is held by the cap on tool result length and the error mapping below.
- **Context-too-long errors.** When a provider refuses a call saying the context exceeds the model's window, the harness maps it to `stopReason: 'error'`, `error.type: 'context_overflow'`, `retryable: false` (the same `type` in `ctx.error`), still carrying `statusCode` and `responseBody`. No new `StopReason`: like `session_busy` and `not_found` it is a kind of "this run did not happen", so the existing `stopReason === 'error'` branches (the orchestrator's `failed`, the remote's status codes) need no change, and whoever needs to tell it apart looks at `error.type`. The pure function `isContextOverflow(error)` looks only at `type` and recognizes `CtxError`, `ErrorInfo` and errors converted by the remote client; the constant is `CONTEXT_OVERFLOW`. `isContextOverflowText(text, status?)` recognizes a raw upstream error: HTTP 413 counts, 401, 403, 404 and 429 never do, and otherwise it looks for common provider error codes and messages in the text. AI SDK has no dedicated error type, so the reference implementation hands it the message and response body of an API error (see [the architecture](../architecture.md#harness)), and an external harness's adapter hands it the error the program reports; **providers' error shapes have not been verified against real services**, and anything not recognized stays `api_call`. What an application does after seeing `context_overflow`: compact with `compactDetailed` and retry, or configure `context.overflow` on the agent.
- **A failed retry does not make history longer.** The input is written to the log before the model is called, so it stays when the run fails. A retry is recognized two ways: with `inputKey` the store deduplicates by key; without it, the harness checks whether the previous run ended in `error` or `aborted` and whether the last non-framework entry in the log is a user message with the same content (followed only by `ctx.*` events and summaries not covering it), and if so does not record it again, and it is not in `recorded` either. A successful previous run, a different sentence, or other entries written by the application between the runs are all recorded as usual. Previously a retry without `inputKey` added an entry for every failure, and with an overflowing context each retry made it longer. The pure function `endedInFailure(lifecycle)` recognizes a failed previous run, and `repeatsFailedInput(tail, input, { key?, harness? })` whether this sentence is the one the failed run left; an external harness passes `harness` so that its own events (`<harness>.*`) are skipped too.
- **At most one unfinished run per session, across processes too** (only for runs whose `record` is not `false`; a run with `record: false` never touches the log, does not hold the session, never meets `session_busy`, and is never seen by `recover`):
  1. Start: read the last lifecycle event (`list({ kinds: [ctx.run.started, ctx.run.ended], last: 1 })`). A `started` means an unfinished run exists, and `run` ends with `ErrorInfo.type: 'session_busy'` (`retryable: true`) without writing anything; otherwise it appends `ctx.run.started` with `expectSeq`, and on conflict re-reads and decides again.
  2. While running: every write carries `expectSeq` (the end after this run's previous write). On conflict it reads the lifecycle events and erasure records from its own `ctx.run.started` on (`kinds: [ctx.run.started, ctx.run.ended, ctx.erased]`): its own `runId` already has a `ctx.run.ended`, so someone took it over as a broken run; its own `ctx.run.started` is gone, so the session was `clear`ed meanwhile, or `truncate` or `remove` deleted it; a `ctx.erased` touched entries this run wrote (`isErased`, `redact` counts), so this run's input or output was deleted. All three mean it is fenced: it stops with `stopReason: 'aborted'` and writes no `ctx.run.ended`, `ctx.error` or output, so an answer about deleted content is never written back. Otherwise someone just wrote application events, or the erasure was of history before this run or of entries others wrote meanwhile, and it retries with the new end. The context already built is not rebuilt: this run's model can still see the earlier content that was erased, so to block that too, cancel the run before deleting. The pure function `isFenced(lifecycle, run)` is this rule (`run` is a `RunPosition`: `runId`, `started`, `recorded`), and `afterConflict(store, session, run)` reads and decides: `undefined` when fenced, the new end otherwise.
  3. A harness instance keeps an in-process serial queue per session (only for runs whose `record` is not `false`): a second run in the same process waits for the first to end, so `session_busy` only shows up across processes or other harness instances. A `signal` aborted while queued ends the run with `aborted` and writes nothing. The queue only saves a conflict; the orchestrator keeps its own queue, and the two layers of serialization do not clash. `createSessionQueue()` is this queue: `enter(session, signal?)` returns `release` when it is the run's turn, and `undefined` when aborted while queued.
  4. An unfinished run left by a crashed process keeps that session `session_busy` until an orchestrator `recover`s it. **So an application that keeps the `record` default (logging) must `recover()` at startup before accepting new `submit`s.** Runs that do not log have no such requirement.
  5. Resuming: for a broken run, `recover` gives tool calls that were written without a result an error result ("the run ended before the tool returned; the result is unknown"), written in one batch with `ctx.run.ended`; to resume, submit a run without new input on the same session, and the model sees the finished steps and that error result in the log and carries on. Tools that already have results are not run again; whether to retry the one with an unknown result is the model's call, and tools with side effects should be idempotent themselves.
  6. `RunRequest.owner` is written as the `owner` of `ctx.run.started` (the orchestrator fills in its own `owner`).
- `text.delta` and `reasoning.delta` are not logged, like Managed Agents' event deltas; every other event has a matching log entry. `run.started`, `model.ended` and `run.ended` carry `seq` and are where the stream lines up with the log: when one is emitted, the log has been written up to that `seq` (`ctx.run.started`, the step's last entry, `ctx.run.ended`). When the stream breaks, continue reading the log with `watch(session, { after })` or `list({ after })` from the last `seq` received, with nothing missed and nothing repeated; runs that do not log have no `seq`.
- **Usage.** The three cache and reasoning fields of `Usage` are optional and absent when the provider does not give them or they are 0 (AI SDK adapters often fill in 0 when the provider gives no breakdown, so the two cannot be told apart); `inputTokens` includes what was read from and written to the cache, which cost differently by each provider's prices. The run's total is in `RunResult.usage` and the `usage` of `ctx.run.ended`; each step's is in `meta.step` of that step's assistant message (`StepMeta`, written with `stepMetaToJson(meta)` and read with `stepMetaOf(entry)`), which also carries the model identifier from the provider's response, so when an alias was requested or a fallback happened you can see which model was actually used. Price lists are not in the protocol: the application computes cost from `provider`, `modelId` and these fields. Providers' usage fields are mapped through AI SDK and **have not been verified against real services**.
- Pure functions: `modelName(model)` records an in-process model as `<provider>/<modelId>`; `agentSpecToJson(spec)` is the serializable part written to `ctx.run.started`. `settings.headers` keeps only the names, with values replaced by `REDACTED_HEADER` (`[redacted]`): request headers often hold credentials, and the log is append-only and visible to anyone who can read the session.
- **Parent and child runs** (#48). One agent handing work to another is a tool call in the parent run that runs one turn on a child session. Each side records half:
  - Child session: `RunRequest.parent` (the parent session, the parent `runId`, the id of that tool call) is recorded as it is in the `parent` of `ctx.run.started`. When the shape is wrong (`runParentProblem(parent)` says why), the run ends in `invalid_request` and `parent` is not recorded.
  - Parent session: the result of that tool call is a `ChildRunResult`: `{ child: { session, runId }, stopReason, text?, output?, usage?, error? }`. `childRunOutput(child, result)` builds it; when the child run ends in `error` or `aborted` it is a `type: 'error'` output with the `ChildRunResult` in `data`. `childRunsOf(entries)` finds these results among the parent session's entries, so looking back at the parent session finds every child session.
  - Usage is not added up automatically: `RunResult.usage` is only this run's own, and the child run's is in `ChildRunResult.usage`. For the whole tree, `addUsage(parent.usage, ...childRunsOf(entries).map((run) => run.usage))`, and read the child sessions the same way one level further down.
  - Cancellation passes down the chain: when the parent run is cancelled, the child runs it dispatched that have not ended are cancelled too. In process through the tool call's `signal`; for those dispatched through the orchestrator, `cancel(parent runId)` also cancels the runs whose `parent` it is (recursively). Cancellation across processes is up to the executor: it takes the parent's `signal` and calls the remote `cancel`.
  - `recover` still recovers session by session; `InterruptedRun.parent` carries the `parent` from `ctx.run.started`, and `resume` decides whether to resume: the parent run has probably broken off too, and when it resumes the model decides again whether to dispatch.
  - A child agent's context is the application's decision: fresh (the default, the child session has only its own), with a summary (written into the child run's input), or with the parent session's projection (`AgentSpec.context.inherit`: `build` first projects the entries of `inherit.session` with `seq` up to `upTo`, then this session's history; the window goes to this session first, and when it does not fit the parent's oldest go first). `inherit` only reads, and a wrong shape is `invalid_request`.
  - When a process-level harness (Claude Code, dsh and the like) starts its own subagent, the adapter writes the subagent's trajectory into a child session with the same `parent` and writes a `ChildRunResult` on the parent side, so looking back it is the same as one dispatched in process.
  - Not covered: orchestration patterns (routing, group chat, hierarchies) are the application's business; the protocol only fixes how the parent-child relationship is recorded.
- **Conformance levels** (#23). A harness is not necessarily the loop here: process-level programs (Claude Code, pi, dsh) bring their own loop and tools and manage their own context, and a hosted service's loop is somewhere else. So the harness contract is split by capability, and an adapter runs the levels it reaches and says so in its documentation (`describeHarnessContract(name, factory, api, { levels })`, `HarnessLevel`, the constant `HARNESS_LEVELS`; all of them by default):
  - `trace`: a run is written into the session log: lifecycle events, input, reply, errors, cancellation, `runId`, `owner`, `parent`, nothing written with `record: false`, and the order of stream events. At this level the log can be inspected, memory works, and other components can subscribe. The other levels all build on it.
  - `execute`: tool calls go to ctx's `Executor`; input is checked against `inputSchema` before running, a result over the limit is cut with a note, and each step is logged when it ends. Process-level programs reach ctx's executors through MCP (`createMcpServer` in `ctx-mcp`); built-in tools they run themselves only go into the log.
  - `resume`: one unfinished run per session (`session_busy`), idempotent input (`inputKey`, a failed retry does not record the input again), and continuing from the log after a crash.
  - `context`: context assembled with `ContextBuilder` (projection names and facts in `agent.context`, `context.overflow`). Harnesses that manage their own context skip it.
  - `output`: structured output with `AgentSpec.output`, and `version`.
  - `approval`: human approval through the log ("Human approval" above): an `ask` call is not run, its approval request is in the same assistant message as the call, and `RunResult.approvals` lists it; after the decision is appended, the next run first runs the approved calls and writes a refusal for the denied ones. A harness whose whole run happens inside another program skips this one.
    The reference implementation passes them all; `ctx-conformance --harness-levels` runs them by level against an address.
- **An external harness's identity.** The adapter writes `harness` (`HarnessInfo`) into `ctx.run.started`: `name` (`claude-code`, `pi`, `pydantic-ai`, `managed-agents`), `version`, and its own session `session`. A program that stores its own conversations maps one ctx session to one of its sessions, and the next run continues from the `session` recorded most recently; things only the adapter uses, such as a position in the program's own records, go into the entries' `meta`. A framework that stores no conversations projects the history from the ctx log on every run and writes no `session`. The reference implementation does not write it. Existing adapters: `ctx-claude-code`, `ctx-pi`, `ctx-managed-agents` (TypeScript) and `ctx-pydantic-ai` (Python, served over the wire protocol), all passing `trace`, `execute`, `resume`, `output`, with `ctx-pydantic-ai` also passing `context` and `approval`, and `ctx-managed-agents` also passing `approval`; how and why are in [ADR 0010](../adr/0010-external-harness-adapters.md).
- `Hooks` are constructor arguments of a harness implementation, not part of `RunRequest`: they are functions and cannot cross a boundary.
- Permission prompts are one implementation of `beforeTool`: returning `{ allow: false }` makes the tool result an error, the model sees the reason, and the run continues; to wait for a person's decision, return `{ ask: true, reason? }` ("Human approval" above).
- The reference implementation is based on AI SDK's `generateText` / `streamText`: the selected `ToolDefinition`s are wrapped as AI SDK tools whose `execute` forwards to the executor.
- Remote harness (`ctx-remote`): `POST /runs` takes a `RunRequest` without `signal` (the model as a name) and returns a `RunResult`; `stream` is the NDJSON of `POST /runs?stream=1`. When `signal` aborts, the client sends `DELETE /runs/:runId` and the same request still returns with `stopReason: aborted`; when the client disconnects, the server aborts the run too.

## Orchestration `Orchestrator`

Scheduling across runs and sessions. The protocol fixes only a minimal set; patterns (chaining, routing, parallel, orchestrator-workers) are composed by the application with `Harness.run`.

```ts
type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
interface RunHandle {
  runId: string;
  session: string;
  done: Promise<RunResult>; // how to wait in process; across a boundary use status or events
}
interface OrchestratorEvent {
  type: `run.${RunStatus}`;
  runId: string;
  session: string;
}

interface Orchestrator {
  /** Runs on the same session are serial, on different sessions parallel. */
  submit(request: RunRequest): Promise<RunHandle>;
  status(runId: string): Promise<RunStatus | undefined>;
  cancel(runId: string): Promise<boolean>;
  /** After a crash: finds runs with ctx.run.started and no ctx.run.ended in the log, gives dangling tool calls error results, adds a ctx.run.ended (stopReason error); whether to resume is up to the implementation. */
  recover?(): Promise<RecoveredRun[]>; // only runs whose owner matches its own
  events?(options?: { signal?: AbortSignal }): AsyncIterable<OrchestratorEvent>;
  close(): Promise<void>;
}
interface RecoveredRun {
  session: string;
  runId: string;
  resumed?: string; // when resumed, the runId of the run submitted on this session to continue it
}
```

- `completed` means it finished; `failed` means `stopReason: error` or the harness threw; `cancelled` means it was cancelled by `cancel` or `signal` (a run stopped by fencing is also `aborted`, which counts as `cancelled`).
- `owner`: `createOrchestrator({ owner })` is a stable instance name given by the deployer (for example `yoyo`), written into each run's `ctx.run.started`. `recover()` only handles broken runs whose `owner` matches its own (both unconfigured counts as a match), so two processes sharing a database each configure a name and never take each other's runs. It writes `ctx.run.ended` with `expectSeq` (the end read again after finding the break): a new entry in the session between the read and the write means that run is actually moving, so it is skipped; and even if it guesses wrong, the live run discovers at its next write that it has been ended and stops (fencing). `recover` reads only the last lifecycle event of each session (`kinds`, `last: 1`) and reads the end once more only for those with a break. A misconfigured `owner` (two processes with the same name, or neither configured) falls back to relying on fencing alone.
- `cancel(runId)` also cancels runs in this orchestrator whose `parent` it is (`RunRequest.parent.runId`), level by level down.
- The reference implementation is an in-process queue: one queue per session, one harness.
- yoyo's `createYoyoOrchestrator` is an application-level orchestrator that implements this protocol: timers, yielding, an inbox. Its idle chatter and its replies are two `AgentSpec`s run by the same harness; the director is left with stage directions only, and the resident loop only manages the process.
- Remote orchestrator (`ctx-remote`): its paths are under `/orchestrator`, apart from the harness's `/runs`: `POST /orchestrator/runs`, `GET /orchestrator/runs/:id` (long polling with `?wait=`, carrying `result` once it ends; the client's `done` relies on it), `DELETE /orchestrator/runs/:id`, `POST /orchestrator/recover`, `GET /orchestrator/events` (NDJSON).

## Memory `MemoryStore`, `DecisionModel`, `ExtractionModel`, `Memory`

The eighth component. Memory only reads the session log and never changes it; the store, the two System One models and the facade are one protocol each, all JSON in and out. Why it is split this way is in [Memory](../memory.md) and [ADR 0006](../adr/0006-memory.md); the reference implementation is in [the architecture](../architecture.md#记忆). The signatures below omit `readonly` and some comments; `ctx-protocol`'s `.d.ts` is authoritative.

### Store `MemoryStore`

Memory's storage. Four collections with a few methods each; all JSON in and out, so it can sit on the other side of a process boundary. Identities are strings.

A store is divided into **scopes**: `store.scope(name)` is a view of the scope named `name` over the same data, and all four collections live inside a scope. One scope per user, tenant or project, named by the application (a string of at most `MAX_MEMORY_SCOPE_LENGTH` = 256 characters, compared as is); without `scope`, the default scope `DEFAULT_MEMORY_SCOPE` (the empty string) is used.

- One scope cannot read, search, change or delete anything in another: `list`, `search`, `head`, `core.get` and `core.history` see only their own; an `id` from another scope is treated like one that does not exist (`close`, `supersede`, `cite`, `confirm`, `retire` throw `not_found`; `settle`, `fail`, `retry`, `touch`, `archive`, `restore`, `reopen`, `forget` skip it), and `supersededBy` cannot point into another scope either. Indexes an implementation builds for `search` must be split by scope too.
- Names are absolute, not nested: `store.scope('a').scope('b')` is `store.scope('b')`. A scope never written to is empty and need not be created first. An invalid name (`checkMemoryScope`) throws `invalid_request`.
- An `id` is unique across the whole store, not just within a scope.
- Scopes are isolation, not authorization: which scopes someone may use is the application's decision (the remote `/memory/*` with only an access token configured lets the token holder use any scope; with principals configured it checks their `memoryScopes`, see "Wire format").
- Evidence (`SourceRef`) points into session logs, and sessions themselves are not scoped: the application ensures which session belongs to which scope, and `createMemory` in the reference implementation has `ownsSession` as an extra guard.

```ts
/** Points to a range of a session log; evidence always points to the original text. 1 ≤ from ≤ upTo. */
interface SourceRef {
  session: string;
  from: number; // seq, inclusive
  upTo: number; // seq, inclusive
}

interface Note {
  id: string;
  session: string;
  from: number;
  upTo: number;
  at: number; // when it was scored (ms)
  salience: number; // 0..1
  kind?: string; // application-defined: pref, obs, fail, ok, …
  topic?: string; // application-defined topic name
  settledAt?: number; // when it was processed overnight; pending when absent and not dead-lettered
  attempts?: number; // how many times processing failed (recorded by fail)
  error?: string; // the reason for the last failure
  failedAt?: number; // when failures reached the limit and it went to the dead letters
}
/** A segment that did not pass the gate is written too, with settledAt equal to at: head still moves forward and the scores stay as the threshold's distribution. Failure records can only be written by fail. */
type NewNote = Omit<Note, 'id' | 'attempts' | 'error' | 'failedAt'>;
interface NoteQuery {
  session?: string;
  pending?: boolean; // true: only pending (never processed, not dead letters); false: only processed; unrestricted by default
  failed?: boolean; // true: only dead letters; false: no dead letters; unrestricted by default
  since?: number; // only those whose at is not earlier than this
  limit?: number; // the N written earliest
}

interface MemoryFact {
  id: string;
  key?: string; // idempotency key, unique within a scope
  subject: string; // "user", "project:agent", … application-defined
  predicate?: string;
  text: string; // a sentence that stands on its own
  topic?: string;
  at: number; // when it was written into memory; activation counts from it
  validFrom: number; // when it starts to hold
  validTo?: number; // still holds when absent
  supersededBy?: string; // which fact replaced it
  confidence: number; // 0..1
  salience: number; // 0..1, s in the activation formula
  sources: readonly SourceRef[]; // required; facts without evidence are not allowed
  recalls: readonly number[]; // the most recent times it was recalled (at most MAX_FACT_RECALLS = 32), t_i in the activation formula
  archivedAt?: number; // when it was archived; not archived when absent
}
// without at, the store records validFrom
type NewMemoryFact = Omit<MemoryFact, 'id' | 'at' | 'validTo' | 'supersededBy' | 'recalls' | 'archivedAt'> & {
  at?: number;
};
interface FactHit {
  fact: MemoryFact;
  score: number; // 0..1, higher is more relevant; recall uses it as similarity
}

interface Procedure {
  id: string;
  topic?: string;
  when: string; // the trigger
  do: string; // the action
  evidence: readonly SourceRef[];
  confirmations: number; // independent confirmations, 1 at add; the application decides how many make it effective
  at: number;
  retiredAt?: number;
}
type NewProcedure = Omit<Procedure, 'id' | 'confirmations' | 'retiredAt'>;
interface ProcedureQuery {
  topic?: string;
  active?: boolean; // true: only those not retired; false or absent: unrestricted
}

/** Results in ascending id (code point order); paging works like SessionStore.sessions. */
interface FactQuery {
  subject?: string;
  topic?: string;
  open?: boolean; // true: only those with no validTo and not archived; false or absent: unrestricted
  after?: string; // last id of the previous page, exclusive
  limit?: number;
}
interface SearchQuery {
  text: string; // the implementation chooses full text, vectors or both; a hit needs at least one word in common with the fact (searchTerms), and no length is an error
  topic?: string;
  k?: number; // default 10
  open?: boolean; // default true; false also searches closed and archived facts
  archived?: boolean; // true also searches archived facts among those that still hold, still not closed ones; default false
}

interface CoreVersion {
  text: string;
  at: number;
}

interface MemoryStore {
  /** A view of another scope over the same data; names are absolute. */
  scope(scope: string): MemoryStore;
  notes: {
    /** When a note for the same session, from and upTo exists, nothing is written and the existing one is returned. */
    add(notes: readonly NewNote[]): Promise<Note[]>;
    list(query?: NoteQuery): Promise<Note[]>; // in write order
    /** Returns how many were actually marked; processed ones and dead letters are not changed. */
    settle(ids: readonly string[], at: number): Promise<number>;
    /** Records a failure: attempts plus 1, error recorded; when it reaches maxAttempts, failedAt = at and it goes to the dead letters. Returns the notes changed. */
    fail(ids: readonly string[], at: number, options: { error: string; maxAttempts: number }): Promise<Note[]>;
    /** Puts dead letters back to pending: clears failedAt, attempts and error. */
    retry(ids: readonly string[]): Promise<number>;
    /** Deletes this session's notes, or all of them without a session; head goes back to 0. */
    forget(session?: string): Promise<number>;
    /** The largest seq covered by this session's notes (processed and dead letters included); 0 when none. gate reads from after it. */
    head(session: string): Promise<number>;
  };
  facts: {
    /** When the key already exists nothing is written and the existing one is returned. */
    add(fact: NewMemoryFact): Promise<MemoryFact>;
    /** Atomic "add the new, close the old": writes fact and does close(id, at, { supersededBy: new }) on id. Writes nothing when id is unknown. */
    supersede(id: string, fact: NewMemoryFact, at: number): Promise<MemoryFact>;
    /** Closes the validity. A fact's text is never rewritten: when it changes, supersede (or add a new one and close the old). Already closed ones are not changed. */
    close(id: string, at: number, options?: { supersededBy?: string }): Promise<void>;
    /** Appends evidence (when merging), the text unchanged; identical ranges are skipped. */
    cite(id: string, sources: readonly SourceRef[]): Promise<MemoryFact>;
    /** Records a recall; when recalls exceeds MAX_FACT_RECALLS the earliest are dropped. */
    touch(ids: readonly string[], at: number): Promise<void>;
    archive(ids: readonly string[], at: number): Promise<number>;
    /** Restores archived facts (clears archivedAt) and returns how many were actually restored; validity untouched. */
    restore(ids: readonly string[]): Promise<number>;
    /** Undoes a close: clears validTo and supersededBy, returns how many were actually reopened. For closes that were wrong. */
    reopen(ids: readonly string[]): Promise<number>;
    /** Hard delete, clearing supersededBy links that point to it too. The owner's right. */
    forget(ids: readonly string[]): Promise<number>;
    list(query?: FactQuery): Promise<MemoryFact[]>;
    search(query: SearchQuery): Promise<FactHit[]>; // by score, highest first
  };
  procedures: {
    add(procedure: NewProcedure): Promise<Procedure>;
    /** confirmations plus 1; identical evidence is not another confirmation. */
    confirm(id: string, evidence: readonly SourceRef[]): Promise<Procedure>;
    retire(id: string, at: number): Promise<void>;
    forget(ids: readonly string[]): Promise<number>; // hard delete
    list(query?: ProcedureQuery): Promise<Procedure[]>; // in write order
  };
  core: {
    get(): Promise<CoreVersion | null>;
    /** Appends a version and keeps the old ones; rolling back is setting the old text again. */
    set(text: string, at: number): Promise<void>;
    /** In write order; last works like ListOptions.last. */
    history(options?: { last?: number }): Promise<CoreVersion[]>;
    /** Deletes every version (hard delete); get goes back to null. */
    clear(): Promise<number>;
  };
}
```

- **Facts are never UPDATEd.** When something changes, `supersede`: the new one is written, the old one closed, linked by `supersededBy`. "Which database did we use last month" can always be answered. A wrong close is undone with `reopen`.
- **When a fact was written and when it holds are separate.** `at` is when the fact was written into memory, `validFrom` is when it starts to hold: a fact extracted from the log overnight may have held for a long time. Without `at`, the store records `validFrom` (for imported or hand-written facts nobody knows when they were learned).
- **Each method is atomic on its own.** The add-new-close-old of `supersede` succeeds or fails as a whole: split into `add` then `close`, a failure of the second step would leave two facts that both hold.
- **Several processes writing one store do not duplicate.** A segment of a log (session plus `from`, `upTo`) has only one note, and `notes.add` returns the existing one when it meets it; a fact with a `key` exists once per scope, and `add` and `supersede` return the existing one for an existing key and change nothing. Two processes gating at once, or processing the same batch of notes overnight at once, end up as one process would.
- **Failures and dead letters.** When processing a batch of notes fails, the caller calls `fail`: the count and reason are recorded and the notes stay pending; once the count reaches the limit they go to the dead letters (`failedAt`), no longer count as pending, are listed by `list({ failed: true })`, and go back with `retry` once the cause is fixed. So a segment of log that always makes the model fail is neither retried every night nor quietly marked as processed.
- **Evidence is required.** `MemoryFact.sources` and `Procedure.evidence` point to `seq` ranges of session logs. A fact without evidence does not enter the store; this is the first gate against fabrication.
- **Archiving does not delete, and archived facts can be found again.** `archive` only takes a fact out of `open` queries; `forget` deletes. An archived fact is still found by `search` with `archived: true` (the store does not down-rank it; how the score is discounted is the caller's choice), and `restore` makes it unarchived again.
- **`recalls` is capped.** `touch` keeps only the most recent `MAX_FACT_RECALLS` (32) times and drops earlier ones: a fact does not grow without bound with recalls, and its activation has an upper bound.
- **Deletion is hard deletion.** `facts.forget`, `procedures.forget`, `notes.forget` and `core.clear` all delete rows and leave no tombstones. The profile is text condensed from facts, so it may still mention a deleted fact: the facade's `forget` clears the profile's history too (see the facade below).
- **Errors.** Invalid arguments (no evidence, `from > upTo`) are `CtxError` `invalid_request`, an unknown `id` is `not_found`; batch methods (`settle`, `fail`, `retry`, `touch`, `archive`, `restore`, `reopen`, `forget`) skip unknown `id`s. The store never looks at a clock; every time is given by the caller.
- **Memory does not write session logs.** Memory is a reader of the log. An application that wants a trace in the log (for example "tidied up 12 entries tonight") appends an event itself, as a deliberate choice.
- How `search` works is up to the implementation: full text, vectors, or a mix. The protocol fixes that the input is text, plus three floors (all checked by the contract tests):
  - **A word in common is a hit.** Words are split by `searchTerms(text)`: NFKC normalization and lowercasing first; a run of letters and digits is one word, and since CJK text has no spaces, each pair of adjacent characters is a word (a lone character is a word by itself). So 「我平时喜欢喝什么茶？」 ("what tea do I usually like to drink?") finds 「主人喜欢喝乌龙茶」 ("the owner likes oolong tea") through the shared words 「喜欢」 and 「欢喝」. English matches whole words: `Postgre` does not match `PostgreSQL`.
  - **More shared words rank higher.** The full-text score is `termOverlap(shared, a, b)`: the overlap coefficient `shared / min(a, b)`, which is 1 when one side's words are all in the other. A short query against a long fact and a long passage against a short fact both get scores.
  - **No query is too long.** An implementation looks at no more than `MAX_SEARCH_TERMS` (256) distinct words: `searchTerms(text, MAX_SEARCH_TERMS)` takes the first half and the last half when there are more.
- A fact in memory is a `MemoryFact`, which is not the same as a fact fetched from a source, `Fact` (`{ source, text }`, used for one call only): the former is durable and has a validity, the latter is "now".
- Pure functions: `activation(fact, now, options?)` and `retrievability(fact, now, options?)` (see [Activation](#activation-activation-retrievability), default parameters `ACTIVATION_DEFAULTS`), `rankFacts(facts, scores, options?)` (`scores` maps fact `id` to similarity, usually `FactHit.score`), the default form of `renderCore(facts, budget, { now })` (sorted by activation, stopping before `estimateTextTokens` exceeds `budget`), `sourceRef(session, entries)`; `searchTerms` and `termOverlap` for retrieval (constant `MAX_SEARCH_TERMS`); and for store implementations `checkSourceRef`, `checkEvidence`, `sameSourceRef`, `inSourceRef`, `isOpenFact`, `filterFacts`, `inSearchScope` (the `topic`, `open` and `archived` of `SearchQuery` written as a predicate) and the constant `MAX_FACT_RECALLS`.
- Remote memory store (`ctx-remote`): the server mounts `memory` with paths under `/memory/notes`, `/memory/facts`, `/memory/procedures` and `/memory/core`, and the scope is the query parameter `?scope=` (the default one when absent); the client is `createRemoteMemoryStore`. Batch methods and methods by `id` get one `POST` each: `/memory/notes/{settle,fail,retry,forget}`, `/memory/facts/{search,touch,archive,restore,reopen,forget}`, `/memory/facts/:id/{close,supersede,cite}`, `/memory/procedures/forget`, `/memory/procedures/:id/{confirm,retire}`; `DELETE /memory/core` is `core.clear`. Decision and extraction models have no wire form; each process builds them by name.

### Decision and extraction models `DecisionModel`, `ExtractionModel`

Most judgments in the memory loop are not open-ended generation but classifying, scoring and filling in fields. Those go to models that make one forward pass and return probabilities (Cloudflare calls them System One: the decision models Clef and Jev, the extraction model Clairic), and only summarizing and wording are left to a `LanguageModel`. ctx gives each a protocol whose shape follows the System One API, so adapters stay thin; but the types are ctx's own, all JSON, with no dependency on any provider's SDK.

```ts
const MAX_DECISION_QUESTIONS = 64;

type DecisionQuestion =
  | { type: 'noul'; instructions: string } // yes / no, returns P(yes)
  | { type: 'choice'; instructions: string; criteria: Record<string, string> } // pick one, at least one option
  | { type: 'score'; instructions: string; criteria: readonly string[] }; // ordinal scale, low to high, at least two levels
type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: readonly number[] }; // score = Σ pᵢ · i / (n − 1)

interface DecisionRequest {
  state: JsonValue; // text or JSON
  questions: Record<string, DecisionQuestion>; // at most 64 at once, in parallel
  signal?: AbortSignal; // rejects after abort
}
interface DecisionModel {
  name: string;
  decide(request: DecisionRequest): Promise<Record<string, DecisionAnswer>>;
}

// The shape of value when found: text a string; number a number; date 'YYYY-MM-DD'; datetime ISO 8601; duration seconds; list an array
type ExtractionField =
  | { type: 'text'; instructions?: string }
  | { type: 'number'; instructions?: string; integer?: boolean; decimals?: number; unit?: string }
  | { type: 'date' | 'datetime' | 'duration'; instructions?: string }
  | { type: 'list'; items: 'text' | 'number'; instructions?: string };
interface ExtractionAnswer {
  value: JsonValue; // null when not found
  pNull: number; // probability that the value is not in the input
  confidence: number;
}
interface ExtractionRequest {
  state: JsonValue;
  fields: Record<string, ExtractionField>; // any number
  signal?: AbortSignal;
}
interface ExtractionModel {
  name: string;
  extract(request: ExtractionRequest): Promise<Record<string, ExtractionAnswer>>;
}
```

- Neither protocol produces text; they only take input tokens, which suits calling them every turn.
- The output is always well-formed but not necessarily right: callers use `confidence` and `pNull` to decide how far to automate, escalating to a `LanguageModel` below a threshold.
- When no usable answer comes back (the service did not return JSON, it was cut off), they reject with `type` `invalid_response`, rather than filling in an "unsure" answer: the caller could not tell a judgment from a failure, and extraction would treat it as "nothing was said" and lose that piece of memory. When an individual question or field is missing or has the wrong shape, that item gets a well-formed answer with low confidence.
- Across a boundary a model is a name string, as with `ModelRef`.
- Without a System One service there are two fallbacks: the heuristic implementations (no network, see [the architecture](../architecture.md#模型)), or a `LanguageModel` dressed up as a decision model (asked to output JSON; slow and expensive, but the same interface).

### Facade `Memory`

The five operations sit behind one facade, which is itself an `Executor`. The protocol fixes only the shapes; the reference implementation is `createMemory` in `@modelctx-ai/ctx-memory`, see [the architecture](../architecture.md#记忆).

```ts
interface Memory extends Executor {
  /**
   * Daytime: reads the session's new entries after notes.head, scores them, writes notes, returns the notes written. Does not change the log.
   * A segment below the threshold also gets a processed note (settledAt = at), so head still moves forward; returns empty when there are no new entries.
   */
  gate(session: string, options?: GateOptions): Promise<Note[]>; // GateOptions = { signal? }
  /**
   * Daytime: recalls facts that still hold by text, ranks them with rankFacts, records a touch; includes procedures with a matching topic.
   * Archived facts are searched too (with discounted similarity), and the ones recalled are unarchived; facts with confidence below minConfidence are not recalled.
   */
  recall(query: string, options?: RecallOptions): Promise<Recalled>;
  /**
   * Overnight: processes pending notes, decays and archives, rewrites core. Repeatable as a whole. Isolated by batch: a failed batch does not block later ones,
   * the failed notes get fail, and they go to the dead letters once the count reaches the limit.
   */
  consolidate(options?: ConsolidateOptions): Promise<ConsolidateReport>; // ConsolidateOptions = { now?, signal? }
  /** Deletion; never interleaved with consolidate. */
  forget(request: ForgetRequest): Promise<ForgetReport>;
  /**
   * As a source: core plus facts recalled by query, rendered as text; empty when there is nothing.
   * Sources run every turn, so the facts they bring cannot be touched every time: implementations must rate-limit it (once a day per fact in the reference implementation).
   */
  source(options?: MemorySourceOptions): ContextSource;
  /** As a tool: recall (MEMORY_RECALL_TOOL), bound to this executor. */
  tools(): Promise<ToolDefinition[]>;
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolOutput>;
}
interface MemorySourceOptions {
  name?: string; // default memory
  query?: (session: string) => Promise<string>; // default: the text of the session's latest user message
  k?: number;
}
interface RecallOptions {
  topic?: string;
  k?: number;
  budgetTokens?: number;
  minConfidence?: number; // facts whose MemoryFact.confidence is below it are not recalled; default chosen by the implementation (0.5 in the reference implementation), 0 does not filter
  evidence?: boolean; // bring back the evidence text; on for tool calls, off as a source
  signal?: AbortSignal;
}
interface Recalled {
  facts: readonly MemoryFact[]; // already touched; formerly archived ones are restored and carry no archivedAt
  procedures: readonly Procedure[];
  evidence?: readonly Entry[]; // only with evidence: entries in the evidence ranges, deduplicated by id, ordered by session and seq
}
interface ConsolidateReport {
  notes: number; // processed (settled) this time
  failed: number; // failed this time and kept for the next try (not counting dead letters)
  dead: number; // went to the dead letters this time
  facts: { added: number; merged: number; superseded: number; archived: number; ungrounded?: number }; // ungrounded: no support found in the original text, confidence lowered
  procedures: { added: number; confirmed: number };
  escalated: number; // judgments escalated to the LanguageModel
  core: boolean; // whether it was rewritten
}
/** Several may be given together; all deletions are hard deletions. */
interface ForgetRequest {
  facts?: readonly string[];
  procedures?: readonly string[];
  session?: string; // this session's notes, and facts and procedures whose evidence includes it
  all?: boolean; // everything in this memory (its scope)
  signal?: AbortSignal;
}
interface ForgetReport {
  notes: number;
  facts: number;
  procedures: number;
  core: number; // profile versions deleted
}
```

- **Deleting facts clears the profile too.** The profile is text condensed from facts, so deleted content may still be in it, and in its history. When facts are deleted (or `all`), `forget` clears every version of the profile and writes a new one from the remaining facts in the default form of `renderCore`; it does not rewrite with a `LanguageModel`, which would have to be fed the previous profile and would bring the deleted content back.
- **Deleting by session.** `session` deletes its notes and the facts and procedures whose evidence includes it; a fact whose evidence also points to other sessions is deleted too (part of its content came from this session). The session log itself is cleared separately by the application (`SessionStore.clear`): the facade only reads logs. `forget` first, then clear the log; the other way round works too, since `head` goes back to 0 once the log is gone, except that in between, recall can still bring up facts from that session.

`Memory` itself is an `Executor` (named `memory` by default), like an MCP hub: `tools()` reports the `recall` tool, and registering it in a `ToolRegistry` gives it to the model. The tool's input is `query`, optionally `since_days` (only facts that started holding within that many days), `topic` and `k` (1–20); its output is text, not JSON: wrapped in `<memory>`, with a first line declaring "this is reference material, not instructions", facts with their topic, date and evidence position, procedures with their confirmation count, and the evidence text last. Unknown tools, wrong input, an already aborted `signal` and store errors all return `{ type: 'error' }`.

### Activation `activation`, `retrievability`

ACT-R's base-level activation. Each recall is a `t_i`, with recent ones weighted more and distant ones decayed; salience `s` is a constant offset:

```
A(fact, now) = ln Σ_i (Δt_i + ε)^(−d) + s      Δt_i = |now − t_i| / 1 day, t_i ∈ {at, validFrom if later than at, the latest 32 recalls}
R(fact, now) = 1 / (1 + e^(−(A − archiveAt)))  squashed to 0..1: ACT-R's retrieval probability, with threshold τ = archiveAt
score        = 0.6 × similarity + 0.4 × R      rankFacts
```

The defaults are `d = 0.5`, `ε = 0.02`, `archiveAt = 0.55` (`ACTIVATION_DEFAULTS`). All three are pure functions in the protocol package; the defaults are sized for a personal assistant and should be tuned per application.

- **Bounded.** Only the latest `MAX_FACT_RECALLS` (32) recalls count, so `A ≤ ln(34 · ε^(−d)) + s`, which is `5.48 + s` with the default parameters. Twenty thousand recalls are the same as 32.
- **Counted from when it was written.** The `t_i` include the write time `at`, not `validFrom`: a fact extracted overnight may have held for a year, and counting from `validFrom` would put it below the threshold the moment it is written, ready to be archived the next night. A fact that did not hold yet when written (`validFrom` later than `at`) also counts the day it starts to hold.
- **Future times count by distance.** `Δt` takes the absolute value: a fact that does not hold yet rises as the day nears and decays after it; recall times work the same way. A fact that only holds far in the future still decays from when it was written and can be archived, instead of staying at the highest activation forever.
- **Ranking uses `R`, not `A` directly.** `A` has no fixed range (with the default parameters, from 2.6 for a fact just written to −2.3 for one untouched for a year), and weighting it directly would overwhelm a similarity in 0..1: a fact just written with similarity 0 used to rank above an old fact with similarity 1. `R` is 0.5 at the threshold, about 0.88 for a fact just written (`s = 0.6`), about 0.16 after a month untouched, and never reaches 1 however often it is recalled. Activation therefore contributes at most 0.4: a fact 0.67 higher in similarity ranks first however often the other one is recalled.
- **Archiving looks at `A`.** A fact with `s = 0.6` that is never recalled falls below the threshold about 1.09 days after it is written (the protocol package's unit tests pin "still there at 1 day, below at 1.2 days"); recalled once within a day of being written, it falls below around day 4.4–4.9. Falling below the threshold is necessary for archiving, not sufficient: the reference implementation also requires the fact to have missed enough chances to be recalled (see "consolidate" in [the architecture](../architecture.md#记忆)), or a new fact would vanish after two days without a related question.

## Contract tests

`@modelctx-ai/ctx-protocol/testing`; usage is in [the package docs](../../packages/protocol/README.md#实现一个协议).

| Contract test                     | Factory                                                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeSessionStoreContract`    | `({ now }) => SessionStore`                                             | What goes in is a copy; session names (the empty string, `.` and `..` rejected by every method, other names round-trip); ordering; equal times; deduplication; the rest of a batch written when it has duplicates; two concurrent batches never interleave; `after`/`last`/`limit`/`types`/`kinds`; round trips; messages that are all JSON; `expectSeq` (writes only when it matches, a conflict writes none of the batch, checked before deduplication, exactly one of two concurrent writers succeeds); `clear`; erasure (counts and remaining entries of `truncate`, `remove`, `redact`, the `ctx.erased` record, no record when nothing was touched, the end moving forward and an old `expectSeq` conflicting, whether `id`/`key` are released, no interleaving with a concurrent `append`); `sessions` ascending and paged; export then import (`covers` pointing at the right position in another store, the same projection, importing twice leaves one copy, a truncated file can be finished, copying within one store, positions of erasure records); `watch?` reading existing entries, new writes, erasure records, and aborting |
| `describeExecutorContract`        | `() => { executor, echo }`                                              | Has a name; `tools?()` lists the echo tool bound to itself; `execute` echoes and round-trips through JSON; unknown tools and an aborted `signal` return `{ type: 'error' }` without throwing; `provision?` repeatable; `open?` and `close?` repeatable, and `open` works again after `close`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `describeToolRegistryContract`    | `() => ToolRegistry`                                                    | Adding, looking up and order; name validation; duplicates and `replace`; `remove`/`removeSource`; `select` agrees with `selectTools`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `describeHarnessContract`         | `({ script }) => { harness, store, agent }`                             | Grouped by level (`levels`): a run's log order and `recorded`; `runId`; tool calls go through the executor; a model error still returns `error` and writes `ctx.run.ended`; each step is logged when it ends (a model error after a tool call leaves the previous step in the log); tool input that does not match `inputSchema` is not run (the problem goes back to the model as `{ type: 'error' }`); a result over the limit (`maxToolOutputChars`) is cut with a note; `inputKey` retries; a failed retry without `inputKey` does not record the input again; a model reporting the context is too long is `context_overflow`; `context.overflow` (over with `error` does not call the model, `trim` cuts until it fits); `record: false`; an aborted `signal`; event order and errors of `stream?`; `session_busy`; `owner`; `record: false` unaffected; human approval (the approval request in the same assistant message as the call, an approved call run first in the next run, the model seeing why a call was denied, the stream's `run.ended` carrying `approvals`)                                                              |
| `describeContextBuilderContract`  | `({ script }) => { builder, store }`                                    | Message order of `build` (history, `input`, `prompt`), instructions, the tool list, leaving the log alone, all JSON; an unknown projection name is `not_found`; in `view`, events without a rule are invisible and a summary replaces the entries it covers; `maxMessages`, `{}` and `truncate` of `window`; `tokens?`; `compact?` when not long enough, writing the summary and `ctx.compacted`, not writing when cut off, segmenting over `maxInputTokens`; the `status` of `compactDetailed?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `describeOrchestratorContract`    | `({ script }) => { orchestrator, store, agent }`                        | `submit`/`status`; serial within a session; cancelling a queued run; `events?`; `recover?` giving dangling tool calls error results and adding `ctx.run.ended` (including sessions longer than a page, and only runs of the same `owner`); nothing accepted after `close`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `describeMemoryStoreContract`     | `({ now }) => MemoryStore`                                              | Scope isolation (including search indexes, archiving and restoring); notes' `head`, `pending`, `settle`, one note per segment, `fail` counting and dead letters, `retry`, `failed` and `since`, `forget` by session; facts never rewritten, `at` defaulting to `validFrom`, `key` idempotency, `supersede` atomic (an unknown `id` writes nothing), `reopen`, `close` and `supersededBy`, `cite` deduplication, `touch` appending and keeping only the latest `MAX_FACT_RECALLS`, `archive` leaving `open`, `restore` restoring, `forget` hard deleting, `list` paging; `search` full-text hits, Chinese questions, very long queries (thousands of distinct words), ranking by relevance, `archived`; procedures' `confirm` counting and `forget`; `core` history and `clear`                                                                                                                                                                                                                                                                                                                                                                 |
| `describeDecisionModelContract`   | `() => DecisionModel`                                                   | Shapes of the three question types; probabilities summing to 1; `choice` is the most probable; aborting with `signal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `describeExtractionModelContract` | `() => ExtractionModel`                                                 | The `value` shape of each field type; `value: null` with a high `pNull` when not found; aborting with `signal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `describeMemoryContract`          | `(setup: { sessions, decision, extraction, now }) => { memory, store }` | `gate` leaves the log alone, notes point to the right `seq` ranges, `head` moves forward; `consolidate` idempotent, superseding does not overwrite, evidence points back into the log, written facts have `at` equal to this run's `now`; `recalls` grows by one after `recall`, archived facts are recalled and restored, `minConfidence`; `source` over several turns does not grow `recalls` with it; the shapes of `source` and `tools`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The harness, orchestrator and context factories get a model script `script` (`ModelScriptStep[]`: `text` (with `truncated`, output cut off by `maxOutputTokens`), a `tool-call` of the echo tool, `error`) and build the model and echo tool from it (the echo tool's `inputSchema` requires `text` to be a string, and its result carries the input unchanged; a harness whose tool-result limit is not `DEFAULT_MAX_TOOL_OUTPUT_CHARS` passes `maxToolOutputChars` in the fourth argument of `describeHarnessContract`); `createScriptedModel` in `@modelctx-ai/ctx/testing` is ready to use. The context factory gives a builder with the default configuration and the store it reads; the script is for the summary model of `compact`. The memory contracts use the scripted models `createScriptedDecisionModel` and `createScriptedExtractionModel` from the protocol package's `/testing`: `describeMemoryContract` builds them and an in-memory session log itself and hands them to the factory. Who runs what: the memory store contract is run by `ctx-memory`'s in-memory store (with and without `embed`), `createSqliteMemoryStore` and `createRemoteMemoryStore`; the decision model contract by the scripted model, the heuristic, `decisionFromLanguageModel`, and the two providers of `ctx-models` (with a fake `fetch`); the extraction model contract by the scripted model, `extractionFromLanguageModel` and `cloudflare` from `ctx-models`; `describeMemoryContract` by `createMemory` with an in-memory store, with the gate threshold fixed between 0.1 and 0.9 and no `LanguageModel` needed. The context contract is run by `createContextBuilder` with an in-memory store; it covers only behavior visible through protocol methods, while in-process configuration such as projection rules (how events render, how summaries are written) is left to the unit tests of `project`.

## Hosting matrix

Each component comes in three forms. "In process" is `@modelctx-ai/ctx` and the adapter packages; "another local process / remote" relies on the HTTP server and clients of `ctx-remote`, or on services others implement against the protocol.

Not every component has a wire protocol. Sessions, executors, the harness, orchestration and the memory store can cross processes and have a wire form and conformance tests. Context, the tool catalog and models are not wire protocols: most of `ContextBuilder`'s behavior lives in functions such as projection rules, so it has no conformance test and travels with the harness; the tool catalog is a synchronous in-process object, and remote executors report definitions through `tools()`; models are AI SDK's `LanguageModel` directly, and only names cross a boundary. This is not a gap: they live in the same process as the harness anyway.

| Component                      | In process                                                          | Another process / remote                                                                                                                                | Third-party hosted                                                       |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Sessions                       | memory, SQLite                                                      | `ctx-remote`: the server mounts `store` / `createRemoteSessionStore` (with `watch`)                                                                     | any storage service implementing `SessionStore`                          |
| Context                        | projection + sources                                                | travels with the harness; can also be its own service                                                                                                   | —                                                                        |
| Tools                          | registry                                                            | travels with the harness; remote executors' `tools()` report definitions added to a local registry                                                      | —                                                                        |
| Executors                      | functions, subprocesses (`ctx-exec`), MCP                           | `ctx-remote`: the server mounts `executors` / `createRemoteExecutor`; a worker with only outbound connections takes work by name (`createRemoteWorker`) | container platforms, Managed Agents' sandbox                             |
| Harness                        | AI SDK loop                                                         | `ctx-remote`: the server mounts `harness` / `createRemoteHarness` (with `stream`)                                                                       | `ctx-managed-agents`: Managed Agents                                     |
| Orchestration                  | in-process queue                                                    | `ctx-remote`: the server mounts `orchestrator` / `createRemoteOrchestrator` (with `recover`, `events`)                                                  | any task queue                                                           |
| Models                         | AI SDK                                                              | name → built by the remote harness itself                                                                                                               | each provider                                                            |
| Memory                         | memory (`ctx-memory`), SQLite (`ctx-sqlite`); facade `createMemory` | `ctx-remote`: the server mounts `memory` / `createRemoteMemoryStore`                                                                                    | memory services implementing `MemoryStore`                               |
| Decision and extraction models | heuristic, a `LanguageModel` dressed up (`ctx-memory`)              | name → built by each process                                                                                                                            | `ctx-models`: Cloudflare (Clef, Clairic), TypeSafe (Jev, decisions only) |

The server is `startRemote(options)` or `createRemoteHandler(options)` from `@modelctx-ai/ctx-remote/server`: it mounts paths for whichever components it is given, and one service can mount several.

A typical distributed deployment: the orchestrator on the local machine, the harness as a service, sessions in a hosted database, the executor a container in a public cloud or a local subprocess, the model any provider. Each side knows only the protocol.

## Wire format

`ctx-remote` carries the protocol over HTTP. JSON requests and responses; streams are NDJSON (one value per line, with `{ error }` as the last line on failure; empty lines are heartbeats the reader skips); an error body is `{ error: ErrorInfo }`, which the client turns into an `Error` with `status`. Authentication is `Authorization: Bearer <token>`; by default it listens only locally, accepts only the listening address as Host, and answers 403 to requests with `Origin`. Messages are JSON themselves, so there is no encoding on the wire (since 0.3; 0.2 clients and servers cannot be mixed with it). Paths are grouped by component and can all be mounted under a prefix:

- **Versions and capability discovery.** `GET /protocol` returns `ProtocolInfo`: `protocol` (`PROTOCOL_VERSION`), `entryVersion` (`ENTRY_VERSION`) and `components` (the mounted components and their optional methods: `sessions: { watch }`, `executors: { names }`, `harness: { stream }`, `orchestrator: { recover, events }`, `memory: {}`). A client reads it before its first request (`checkProtocolInfo`): a different version, an entry format newer than its own, or no such endpoint all fail with `unsupported_version` instead of guessing the other side's shapes.
- **Specifications of shapes and paths.** `GET /protocol/schema` is the JSON Schema (2020-12) of the wire shapes, with `$defs` named like the TypeScript types, describing only what crosses the wire (`AgentSpec.model` can only be a name, `RunRequest` has no `signal`), and objects reject keys not listed; `GET /protocol/openapi` is OpenAPI 3.1 with one entry per path, referring to the same shapes. Copies of both are in [`schema/`](../../schema) at the repository root. They are written by hand, not generated from types, and kept consistent by tests: the copies match the code, real wire values (sessions, harness, streams, orchestrator, executors, memory, discovery) all conform to the schema, and the server recognizes every path the OpenAPI document lists.

| Component     | Method            | Path                                                               | Request body → response                                                                                                                                                       |
| ------------- | ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions      | `append`          | `POST /sessions/:session/entries`                                  | `{ entries, expectSeq? }` → `{ entries }`; 409 when the precondition fails (`type: conflict`, `retryable`)                                                                    |
|               | `list`            | `GET /sessions/:session/entries?after=&last=&limit=&types=&kinds=` | → `{ entries, more? }`; `types` and `kinds` comma-separated (no commas in a `kind`); at most one page at a time, and with `more: true` read on with the last `seq` as `after` |
|               | `watch`           | `GET /sessions/:session/entries/stream?after=`                     | → NDJSON `Entry`; the server polls `list` when the store has no `watch`                                                                                                       |
|               | `clear`           | `DELETE /sessions/:session`                                        | → `{ deleted }`                                                                                                                                                               |
|               | `truncate`        | `POST /sessions/:session/entries/truncate`                         | `{ upTo }` → `{ deleted }`; 400 when `upTo` is not a number                                                                                                                   |
|               | `remove`          | `POST /sessions/:session/entries/remove`                           | `{ ids }` → `{ removed }`; 400 when `ids` is not an array of strings                                                                                                          |
|               | `redact`          | `POST /sessions/:session/entries/redact`                           | `{ ids }` → `{ redacted }`                                                                                                                                                    |
|               | `sessions`        | `GET /sessions?prefix=&after=&limit=`                              | → `{ sessions }`; ascending by name                                                                                                                                           |
| Executors     | (list names)      | `GET /executors`                                                   | → `{ executors }`                                                                                                                                                             |
|               | `tools`           | `GET /executors/:name/tools`                                       | → `{ tools }`                                                                                                                                                                 |
|               | `execute`         | `POST /executors/:name/execute`                                    | `{ call, context: { session, runId? } }` → `{ output }`; disconnecting aborts                                                                                                 |
|               | `open`            | `POST /executors/:name/sessions/:session/open`                     | `{ environment? }` → `{}`; does nothing when the executor has no `open`                                                                                                       |
|               | `close`           | `DELETE /executors/:name/sessions/:session`                        | → `{}`                                                                                                                                                                        |
|               | (take work)       | `POST /work/:executor/claim`                                       | `{ limit?, waitMs?, leaseMs? }` → `{ calls }` (`ClaimedToolCall[]`); see below                                                                                                |
| Harness       | `run`             | `POST /runs`                                                       | `RunRequest` without `signal` (may carry `aborted: true`) → `RunResult`                                                                                                       |
|               | `stream`          | `POST /runs?stream=1`                                              | as above → NDJSON `RunEvent`; disconnecting aborts                                                                                                                            |
|               | cancel (`signal`) | `DELETE /runs/:runId`                                              | → `{ cancelled }`                                                                                                                                                             |
| Orchestration | `submit`          | `POST /orchestrator/runs`                                          | as `POST /runs` → `{ runId, session }`                                                                                                                                        |
|               | `status` / `done` | `GET /orchestrator/runs/:runId?wait=<ms>&session=`                 | → `{ runId, status, session?, result?, error? }`; `wait` is long polling; with `session` the result can be restored from the session log                                      |
|               | `cancel`          | `DELETE /orchestrator/runs/:runId`                                 | → `{ cancelled }`                                                                                                                                                             |
|               | `recover`         | `POST /orchestrator/recover`                                       | → `{ recovered }`                                                                                                                                                             |
|               | `events`          | `GET /orchestrator/events`                                         | → NDJSON `OrchestratorEvent`                                                                                                                                                  |
| Memory        | `notes.*`         | under `/memory/notes`                                              | one path per method, listed in [`packages/remote`](../../packages/remote/README.md)                                                                                           |
|               | `facts.*`         | under `/memory/facts`                                              | likewise                                                                                                                                                                      |
|               | `procedures.*`    | under `/memory/procedures`                                         | likewise                                                                                                                                                                      |
|               | `core.*`          | under `/memory/core`                                               | likewise                                                                                                                                                                      |

Rules across paths:

- The two requests that can take long to produce a result (`POST /runs`, `POST /executors/:name/execute`) send a 200 response head before the result is ready, write a newline as a heartbeat now and then, and only then the JSON body (JSON allows leading whitespace). An error after the head was sent cannot change the status code, so the body is `{ error, status }`, with `status` being the status code it should have had.
- **Principals ([ADR 0009](../adr/0009-hosted-prerequisites.md)).** A server can map a request to a principal `Principal { id, sessionPrefixes?, memoryScopes?, admin? }` (`authenticate` in `ctx-remote`, an alternative to a single access token). Not recognized is 401. Every endpoint with a session checks it against `sessionPrefixes` and answers 403 `permission_error` when it is out of range: session paths, the `context.session` of `execute`, `open` and `close` of executor sessions, the `session`, `parent.session` and `agent.context.inherit.session` of a submitted run, and the run's session when cancelling or checking status by `runId`. `GET /sessions` lists only sessions in range, taking work scans only sessions in range, and the orchestrator's event stream sends only those in range; the scope of `/memory/*` is checked against `memoryScopes`; `recover` spans every session, so only `admin` may call it. Where identities come from (JWT, mTLS, headers passed by a gateway) is the deployment's business.
- **Taking work.** `POST /work/:executor/claim` scans the sessions the principal can see and gives the calls that can run now (not waiting for approval, or approved) whose last run stopped with `requires_action` and whose `ctx.run.ended` says they belong to this executor, each with its session (`ClaimedToolCall`: a `PendingToolCall` plus `session`). A claimed call is not given to another claim while its lease lasts (`leaseMs`, the server's setting by default, 5 minutes in `ctx-remote`); once the executor appends the result to the session (`toolResultEntry`), it is no longer waiting. With nothing to give, it long-polls for at most `waitMs` (capped at 30 seconds). `limit` defaults to 16, at most 100. The lease only spares several workers duplicate work: it lives in the server process's memory, and a call's result is recorded once because of the idempotency key. The server needs a session store mounted; without one it is 404.
- At a concurrency limit the answer is 429 (`type: rate_limit_error`, `retryable: true`).
- The `message` of a 500 is a generic sentence and a reference number, with the original in the server's log; protocol errors (`invalid_request`, `not_found`, `conflict`) keep their own `type` and text.
- Safe for a client to retry: every `GET`, an `append` whose entries carry an `id` (the store deduplicates by `id`), and the two cancellations. Submitting a run, executing a tool, taking work and memory writes are not idempotent and are not retried. Sending a session's `clear` or one of the three erasures again deletes nothing more, but the second answer counts 0, so this package's client does not retry them automatically; a caller who wants to can resend them.

**Running conformance tests against an address.** The service under test runs in conformance mode, with an extra endpoint `POST /conformance/instances`: the request body is a `ConformanceSetup` (`components`, the model script `script`, the model delay `delayMs`, the store clock `clock`), and the answer is a new isolated instance (a relative `baseUrl`, plus the `agent` and `executor: { name, echo }` the contracts use). `ctx-conformance --url <address>` (from `@modelctx-ai/ctx-remote`) creates an instance per test case and runs the contract tests for sessions, executors, the harness, the orchestrator and the memory store through the clients. A server written in any language that offers this endpoint and implements the wire format can be verified this way (the Python `ctx-pydantic-ai` verifies its harness like this; see [`python/pydantic-ai`](../../python/pydantic-ai/README.md#一致性等级)); the script's semantics are in [`packages/remote`](../../packages/remote/README.md#对一个地址跑一致性测试).

The orchestrator lives under `/orchestrator` rather than sharing `/runs` with the harness: one service can mount both, and "run now and wait for the result" and "put in the queue" are two different things. Details (cancellation timing, long-polling limits, secure defaults) are in [`packages/remote`](../../packages/remote/README.md).

WebSocket transport comes later, without changing the protocol.
