import assert from 'node:assert/strict';

import { describeMemoryStoreContract } from '@modelctx-ai/ctx-protocol/testing';
import { describe, test } from 'vite-plus/test';

import { createMemoryStore } from './store.ts';

const api = { describe, test };

describeMemoryStoreContract('memory', () => createMemoryStore(), api);

/** 按字符给一个三维的假向量：含「茶」「咖啡」「数据库」的各占一维。 */
async function embed(text: string): Promise<number[]> {
  return [Number(/茶|tea/i.test(text)), Number(/咖啡|coffee/i.test(text)), Number(/数据库|database/i.test(text))];
}

describeMemoryStoreContract('memory + embed', () => createMemoryStore({ embed }), api);

const source = { session: 's', from: 1, upTo: 1 };
const fact = (text: string) => ({
  subject: 'user',
  text,
  validFrom: 0,
  confidence: 1,
  salience: 0.5,
  sources: [source],
});

describe('createMemoryStore：search', () => {
  test('全文：子串命中记 1，词重叠按 Ochiai 打分，没有重叠的不命中', async () => {
    const store = createMemoryStore();
    const tea = await store.facts.add(fact('主人每天下午喝乌龙茶'));
    const pg = await store.facts.add(fact('项目的数据库是 PostgreSQL'));
    const hits = await store.facts.search({ text: '乌龙茶' });
    assert.deepEqual(
      hits.map((hit) => [hit.fact.id, hit.score]),
      [[tea.id, 1]],
    );
    const partial = await store.facts.search({ text: '下午喝什么' });
    assert.equal(partial[0]?.fact.id, tea.id);
    const score = partial[0]?.score ?? 0;
    assert.ok(score > 0 && score < 1);
    assert.deepEqual(await store.facts.search({ text: 'postgresql 版本' }).then((h) => h.map((x) => x.fact.id)), [
      pg.id,
    ]);
    assert.deepEqual(await store.facts.search({ text: '天气' }), []);
  });

  test('给了 embed：没有字面重叠也能按余弦命中，向量按 id 缓存', async () => {
    let calls = 0;
    const store = createMemoryStore({
      embed: async (text) => {
        calls += 1;
        return embed(text);
      },
    });
    const tea = await store.facts.add(fact('主人只喝 oolong tea'));
    await store.facts.add(fact('项目的数据库是 PostgreSQL'));
    const hits = await store.facts.search({ text: '茶' });
    assert.deepEqual(
      hits.map((hit) => [hit.fact.id, hit.score]),
      [[tea.id, 1]],
    );
    const before = calls;
    await store.facts.search({ text: '茶' });
    assert.equal(calls - before, 1, '第二次只算查询的向量');
  });
});
