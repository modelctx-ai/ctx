import assert from 'node:assert/strict';

import type { ExtractionField, ExtractionModel } from '../memory.ts';
import type { JsonValue } from '../types.ts';

import type { ContractTestApi } from './api.ts';
import { inUnit, roundTrips } from './shared.ts';

/** 每个用例调一次。 */
export type ExtractionModelFactory = () => ExtractionModel | Promise<ExtractionModel>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 找到时 `value` 的形状对不对（见 `ExtractionField`）。null 总是对的。 */
function extractionShapeOk(field: ExtractionField, value: JsonValue): boolean {
  if (value === null) return true;
  switch (field.type) {
    case 'text':
      return typeof value === 'string';
    case 'number': {
      if (!isFiniteNumber(value)) return false;
      if (field.integer && !Number.isInteger(value)) return false;
      if (field.decimals !== undefined) {
        const scaled = value * 10 ** field.decimals;
        if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return false;
      }
      return true;
    }
    case 'date':
      return typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value));
    case 'datetime':
      return typeof value === 'string' && DATETIME.test(value) && !Number.isNaN(Date.parse(value));
    case 'duration':
      return isFiniteNumber(value) && value >= 0;
    default:
      return (
        Array.isArray(value) &&
        value.every((item) => (field.items === 'text' ? typeof item === 'string' : isFiniteNumber(item)))
      );
  }
}

const EXTRACTION_STATE =
  '周三（2026-11-04）下午两点在台北开会，开 90 分钟，预算 1200.5 元，参会的有小明、小红，一共 2 人。';

const EXTRACTION_FIELDS: Readonly<Record<string, ExtractionField>> = {
  place: { type: 'text', instructions: '开会的地点' },
  budget: { type: 'number', instructions: '预算', unit: '元', decimals: 1 },
  people: { type: 'number', instructions: '参会人数', integer: true },
  day: { type: 'date', instructions: '开会的日期' },
  start: { type: 'datetime', instructions: '开始的时间' },
  length: { type: 'duration', instructions: '开多久' },
  names: { type: 'list', items: 'text', instructions: '参会的人' },
  amounts: { type: 'list', items: 'number', instructions: '文中出现的金额' },
};

export function describeExtractionModelContract(
  name: string,
  factory: ExtractionModelFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`ExtractionModel contract: ${name}`, () => {
    test('有名字', async () => {
      const model = await factory();
      assert.equal(typeof model.name, 'string');
      assert.ok(model.name.length > 0);
    });

    test('每种字段：键和 fields 一样，value 是 null 或对应的形状，pNull、confidence 在 0..1；结果能序列化', async () => {
      const model = await factory();
      const replies = await model.extract({ state: EXTRACTION_STATE, fields: EXTRACTION_FIELDS });
      assert.deepEqual(Object.keys(replies).toSorted(), Object.keys(EXTRACTION_FIELDS).toSorted());
      for (const [key, field] of Object.entries(EXTRACTION_FIELDS)) {
        const answer = replies[key];
        assert.ok(answer, `${key}：没有回答`);
        assert.ok(extractionShapeOk(field, answer.value), `${key}：value ${JSON.stringify(answer.value)} 的形状`);
        assert.ok(inUnit(answer.pNull), `${key}：pNull 在 0..1`);
        assert.ok(inUnit(answer.confidence), `${key}：confidence 在 0..1`);
      }
      assert.ok(roundTrips(replies), '回答能 JSON 往返');
    });

    test('输入里没有的值：value 是 null，pNull 高', async () => {
      const model = await factory();
      const fields: Record<string, ExtractionField> = {
        email: { type: 'text', instructions: '对方的电子邮件地址' },
        amount: { type: 'number', instructions: '发票金额' },
        due: { type: 'date', instructions: '截止日期' },
      };
      const replies = await model.extract({ state: '', fields });
      for (const key of Object.keys(fields)) {
        assert.equal(replies[key]?.value, null, `${key}：没找到是 null`);
        assert.ok((replies[key]?.pNull ?? 0) >= 0.5, `${key}：pNull ${replies[key]?.pNull} 应当高`);
      }
    });

    test('signal 已中止时 reject', async () => {
      const model = await factory();
      await assert.rejects(
        model.extract({ state: EXTRACTION_STATE, fields: EXTRACTION_FIELDS, signal: AbortSignal.abort() }),
      );
    });
  });
}
