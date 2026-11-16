import { ENTRY_VERSION } from './version.ts';
import { CtxError } from './types.ts';

/**
 * 线上协议的版本。和包的 minor 版本一起走：1.0 之前不兼容的改动升 minor，线上形状也跟着变。
 * 客户端连上先读 `GET /protocol`，版本不同就以 `unsupported_version` 失败，不去猜对方的形状。
 */
export const PROTOCOL_VERSION = '0.3';

/** 一个服务挂了哪些组件、可选方法有没有。没挂的组件不出现。 */
export interface ProtocolComponents {
  readonly sessions?: { readonly watch: boolean };
  readonly executors?: { readonly names: readonly string[] };
  readonly harness?: { readonly stream: boolean };
  readonly orchestrator?: { readonly recover: boolean; readonly events: boolean };
  readonly memory?: Readonly<Record<string, never>>;
}

/** `GET /protocol` 的响应：版本和能力。只读，不改任何状态。 */
export interface ProtocolInfo {
  /** `PROTOCOL_VERSION`。 */
  readonly protocol: string;
  /** 条目的格式版本（`ENTRY_VERSION`）：服务端写进日志的行是这一版。 */
  readonly entryVersion: number;
  readonly components: ProtocolComponents;
}

/** 这一端能不能和 `info` 说的那一端说话：协议版本要相同，对方的条目格式不能比这一端新。不能就抛 `unsupported_version`。 */
export function checkProtocolInfo(info: unknown): ProtocolInfo {
  if (typeof info !== 'object' || info === null) {
    throw new CtxError('unsupported_version', 'The server did not describe its protocol (GET /protocol).');
  }
  const { protocol, entryVersion, components } = info as Partial<ProtocolInfo>;
  if (protocol !== PROTOCOL_VERSION) {
    throw new CtxError(
      'unsupported_version',
      `The server speaks ctx protocol ${JSON.stringify(protocol)}; this client speaks ${PROTOCOL_VERSION}.`,
    );
  }
  if (typeof entryVersion !== 'number' || entryVersion > ENTRY_VERSION) {
    throw new CtxError(
      'unsupported_version',
      `The server writes entry format ${JSON.stringify(entryVersion)}, newer than ${ENTRY_VERSION}. Upgrade @modelctx-ai/ctx-protocol.`,
    );
  }
  if (typeof components !== 'object' || components === null) {
    throw new CtxError('unsupported_version', 'The server did not list its components (GET /protocol).');
  }
  return info as ProtocolInfo;
}
