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
  test('全文：按共同的词打分（termOverlap），查询的词全在事实里是 1，没有共同的词不命中', async () => {
    const store = createMemoryStore();
    const tea = await store.facts.add(fact('主人每天下午喝乌龙茶'));
    const pg = await store.facts.add(fact('项目的数据库是 PostgreSQL'));
    const scores = async (text: string): Promise<[string, number][]> =>
      (await store.facts.search({ text })).map((hit) => [hit.fact.id, hit.score]);
    assert.deepEqual(await scores('乌龙茶'), [[tea.id, 1]]);
    assert.deepEqual(await scores('下午喝什么'), [[tea.id, 0.5]], '四个词（下午、午喝、喝什、什么）里中了两个');
    assert.deepEqual(await scores('postgresql 版本'), [[pg.id, 0.5]]);
    assert.deepEqual(await scores('ＰＯＳＴＧＲＥＳＱＬ'), [[pg.id, 1]], '大小写、全角半角不分');
    assert.deepEqual(await scores('天气'), []);
    assert.deepEqual(await scores('Postgre'), [], '英文按整词');
  });

  test('分数相同时共同的词多的在前，再相同按 id；长的一段话里提到的事实也打得出分', async () => {
    const store = createMemoryStore();
    const one = await store.facts.add(fact('乌龙'));
    const two = await store.facts.add(fact('乌龙茶'));
    const more = await store.facts.add(fact('乌龙茶'));
    assert.deepEqual(
      (await store.facts.search({ text: '主人爱喝乌龙茶' })).map((hit) => [hit.fact.id, hit.score]),
      [
        [two.id, 1],
        [more.id, 1],
        [one.id, 1],
      ],
    );
    const long = `${'今天开会讨论了下个季度的预算和人员安排，'.repeat(20)}最后说到乌龙茶`;
    const hits = await store.facts.search({ text: long });
    assert.deepEqual(
      hits.map((hit) => hit.fact.id),
      [two.id, more.id, one.id],
    );
    assert.equal(hits[0]?.score, 1, '事实的词全在这段话里');
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
