// 包内共用的 JSON 小工具，不从入口导出。
import type { Usage } from './harness.ts';
import type { JsonObject, JsonValue } from './types.ts';

/** JSON 值是不是对象（不是数组、不是 `null`）。 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 去掉值为 `undefined` 的字段：可选字段不给时不出现在 JSON 里。 */
export function definedFields(value: object): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** 从日志里读回来的 `Usage`：只留是数字的字段。 */
export function usageFromJson(value: JsonObject): Usage {
  return Object.fromEntries(
    Object.entries(value).filter((field): field is [string, number] => typeof field[1] === 'number'),
  );
}
