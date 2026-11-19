import assert from 'node:assert/strict';

import { filterFacts, MAX_FACT_RECALLS, type MemoryFact, type MemoryStore } from '../memory.ts';

import type { ContractTestApi } from './api.ts';
import { factById, hasType, ids, MEMORY_NOW, newFact, ref, roundTrips } from './shared.ts';

/** 每个用例调一次，拿到一个空的存储。存储的时刻都由调用方给；`now` 只给要用时钟生成 `id` 的实现。 */
export type MemoryStoreFactory = (options: { readonly now: () => number }) => MemoryStore | Promise<MemoryStore>;

const MEMORY_STORE_SETUP = { now: (): number => MEMORY_NOW };

/** `search` 命中的事实的 `id`，按返回的顺序。 */
async function searchIds(store: MemoryStore, query: Parameters<MemoryStore['facts']['search']>[0]): Promise<string[]> {
  return (await store.facts.search(query)).map((hit) => hit.fact.id);
}

/** 自然的中文问句和它该找回的事实：两边没有一个整句的子串，只有零散的共同的词。 */
const CHINESE_RECALL: readonly (readonly [question: string, fact: string])[] = [
  ['我们项目现在用的是什么数据库？', '主人的项目数据库从 MySQL 换成了 PostgreSQL'],
  ['我平时喜欢喝什么茶？', '主人喜欢喝乌龙茶，不喝咖啡'],
  ['你还记得我住在哪个城市吗', '主人住在杭州西湖区'],
  ['数据库一般什么时候备份', '主人每周五下午备份数据库'],
  ['我家的猫叫什么名字', '主人的猫叫年糕，三岁'],
  ['我有什么过敏的东西吗', '主人对花生过敏'],
  ['下个月出差是去哪里', '主人下个月要去东京出差'],
];

export function describeMemoryStoreContract(
  name: string,
  factory: MemoryStoreFactory,
  { describe, test }: ContractTestApi,
): void {
  describe(`MemoryStore contract: ${name}`, () => {
    test('scope：四个集合按作用域分开，互相读不到、搜不到', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const bob = store.scope('user:bob');
      const procedure = { when: '部署前', do: '先跑测试', evidence: [ref(1)], at: 5 };

      const [note] = await alice.notes.add([{ session: 's', from: 1, upTo: 3, at: 10, salience: 0.8 }]);
      const fact = await alice.facts.add(newFact('喜欢喝乌龙茶'));
      const rule = await alice.procedures.add(procedure);
      await alice.core.set('alice 的画像', 1);
      assert.ok(note);

      assert.deepEqual(ids(await alice.notes.list()), [note.id]);
      assert.equal(await alice.notes.head('s'), 3);
      assert.deepEqual(ids(await alice.facts.list()), [fact.id]);
      assert.deepEqual(ids((await alice.facts.search({ text: '乌龙茶' })).map((hit) => hit.fact)), [fact.id]);
      assert.deepEqual(ids(await alice.procedures.list()), [rule.id]);
      assert.equal((await alice.core.get())?.text, 'alice 的画像');

      for (const other of [bob, store]) {
        assert.deepEqual(await other.notes.list(), []);
        assert.equal(await other.notes.head('s'), 0, 'head 按作用域：同一个会话在别的作用域里没被门控过');
        assert.deepEqual(await other.facts.list(), []);
        assert.deepEqual(await other.facts.search({ text: '乌龙茶', open: false }), []);
        assert.deepEqual(await other.procedures.list(), []);
        assert.equal(await other.core.get(), null);
        assert.deepEqual(await other.core.history(), []);
      }

      // 同样的东西写进另一个作用域是另一条，画像各是各的。
      const same = await bob.facts.add(newFact('喜欢喝乌龙茶'));
      await bob.core.set('bob 的画像', 2);
      assert.notEqual(same.id, fact.id, 'id 在整份存储里不重复');
      assert.deepEqual(ids(await bob.facts.list()), [same.id]);
      assert.equal((await alice.core.get())?.text, 'alice 的画像');
      assert.deepEqual(
        (await alice.core.history()).map((version) => version.text),
        ['alice 的画像'],
      );
    });

    test('scope：别的作用域的 id 和不存在的一样，改不了也删不掉', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const bob = store.scope('user:bob');
      const [note] = await alice.notes.add([{ session: 's', from: 1, upTo: 3, at: 10, salience: 0.8 }]);
      const fact = await alice.facts.add(newFact('住在杭州'));
      const rule = await alice.procedures.add({ when: '部署前', do: '先跑测试', evidence: [ref(1)], at: 5 });
      const mine = await bob.facts.add(newFact('住在上海'));
      assert.ok(note);

      assert.equal(await bob.notes.settle([note.id], 20), 0);
      await assert.rejects(bob.facts.close(fact.id, 20), hasType('not_found'));
      await assert.rejects(bob.facts.close(mine.id, 20, { supersededBy: fact.id }), hasType('not_found'));
      await assert.rejects(bob.facts.cite(fact.id, [ref(5)]), hasType('not_found'));
      await bob.facts.touch([fact.id], 20);
      assert.equal(await bob.facts.archive([fact.id], 20), 0);
      assert.equal(await bob.facts.restore([fact.id]), 0);
      assert.equal(await bob.facts.forget([fact.id]), 0);
      await assert.rejects(bob.procedures.confirm(rule.id, [ref(5)]), hasType('not_found'));
      await assert.rejects(bob.procedures.retire(rule.id, 20), hasType('not_found'));

      assert.deepEqual(await alice.notes.list(), [note], '笔记没被处理');
      assert.deepEqual(await alice.facts.list(), [fact], '事实没被关闭、引用、召回、归档或删除');
      assert.deepEqual(await alice.procedures.list(), [rule], '程序没被确认或退役');
      assert.deepEqual(await bob.facts.list(), [mine], '没成的 close 不留下半截');
    });

    test('scope：名字是绝对的，不嵌套；空串是缺省的作用域；不合法的名字抛 invalid_request', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const fact = await store.facts.add(newFact('缺省作用域里的事实'));
      const nested = await store.scope('a').scope('b').facts.add(newFact('b 里的事实'));
      assert.deepEqual(ids(await store.scope('b').facts.list()), [nested.id]);
      assert.deepEqual(await store.scope('a').facts.list(), []);
      assert.deepEqual(ids(await store.scope('a').scope('').facts.list()), [fact.id]);
      assert.deepEqual(ids(await store.scope('b').scope('').facts.list()), [fact.id]);
      // 名字原样比较：大小写、前后空白都算不同的作用域。
      assert.deepEqual(await store.scope('B').facts.list(), []);
      assert.deepEqual(await store.scope('b ').facts.list(), []);
      const long = 'x'.repeat(256);
      const inLong = await store.scope(long).facts.add(newFact('长名字'));
      assert.deepEqual(ids(await store.scope(long).facts.list()), [inLong.id]);
      // 远端的实现到真正请求时才知道名字不合法，所以连同一次读一起看。
      await assert.rejects(
        Promise.resolve().then(() => store.scope(`${long}x`).facts.list()),
        hasType('invalid_request'),
      );
    });

    test('scope：检索的索引、归档和恢复也按作用域分开', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const bob = store.scope('user:bob');
      const hers = await alice.facts.add(newFact('主人住在杭州西湖区'));
      const his = await bob.facts.add(newFact('主人住在上海浦东'));
      const question = '主人住在哪里';
      assert.deepEqual(await searchIds(alice, { text: question }), [hers.id]);
      assert.deepEqual(await searchIds(bob, { text: question }), [his.id]);
      assert.deepEqual(await searchIds(bob, { text: '杭州西湖', open: false }), [], '别的作用域里才有的词搜不到');

      assert.equal(await alice.facts.archive([hers.id], 5), 1);
      assert.equal(await bob.facts.restore([hers.id]), 0, '恢复不了别的作用域里归档的事实');
      assert.deepEqual(await searchIds(bob, { text: question, archived: true }), [his.id]);
      assert.deepEqual(await searchIds(alice, { text: question, archived: true }), [hers.id]);
      assert.equal(await alice.facts.forget([hers.id]), 1);
      assert.deepEqual(await searchIds(alice, { text: question, open: false }), []);
      assert.deepEqual(
        await searchIds(bob, { text: question }),
        [his.id],
        '删掉一个作用域的事实，别的作用域里同样的词还搜得到',
      );
    });

    test('notes：add 按输入顺序返回并生成 id；list 按写入顺序，session、pending、limit 可组合', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const [a, b] = await store.notes.add([
        { session: 's', from: 1, upTo: 3, at: 10, salience: 0.8, kind: 'pref', topic: 'user' },
        { session: 't', from: 2, upTo: 2, at: 11, salience: 0.4 },
      ]);
      assert.ok(a && b);
      assert.deepEqual(a, {
        id: a.id,
        session: 's',
        from: 1,
        upTo: 3,
        at: 10,
        salience: 0.8,
        kind: 'pref',
        topic: 'user',
      });
      assert.deepEqual(b, { id: b.id, session: 't', from: 2, upTo: 2, at: 11, salience: 0.4 });
      assert.ok(a.id.length > 0 && b.id.length > 0 && a.id !== b.id, 'id 非空、不重复');
      const [c] = await store.notes.add([{ session: 's', from: 4, upTo: 6, at: 12, salience: 0.1, settledAt: 12 }]);
      assert.ok(c);
      assert.equal(c.settledAt, 12, '可以直接写一条处理过的笔记');
      const all = await store.notes.list();
      assert.deepEqual(all, [a, b, c], '按写入顺序，原样读回');
      assert.ok(roundTrips(all), '笔记能 JSON 往返：可选字段不给时不出现');
      assert.deepEqual(ids(await store.notes.list({ session: 's' })), [a.id, c.id]);
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [a.id, b.id]);
      assert.deepEqual(ids(await store.notes.list({ pending: false })), [c.id]);
      assert.deepEqual(ids(await store.notes.list({ session: 's', pending: true })), [a.id]);
      assert.deepEqual(ids(await store.notes.list({ limit: 2 })), [a.id, b.id], 'limit 取最早写入的');
      assert.deepEqual(ids(await store.notes.list({ limit: 1.9 })), [a.id], 'limit 向下取整');
      assert.deepEqual(await store.notes.list({ limit: 0 }), []);
      assert.deepEqual(await store.notes.list({ session: 'nope' }), []);
    });

    test('notes：settle 只标待处理的，返回真正标上的条数，可重复调；不改已有的 settledAt', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const [a, b] = await store.notes.add([
        { session: 's', from: 1, upTo: 2, at: 1, salience: 0.9 },
        { session: 's', from: 3, upTo: 4, at: 2, salience: 0.9 },
      ]);
      assert.equal(await store.notes.settle([a!.id, 'missing'], 100), 1, '认不得的 id 跳过');
      assert.equal(await store.notes.settle([a!.id, b!.id], 200), 1, '已经处理过的不算');
      assert.equal(await store.notes.settle([a!.id, b!.id], 300), 0);
      assert.equal(await store.notes.settle([], 400), 0);
      assert.deepEqual(
        (await store.notes.list()).map((note) => note.settledAt),
        [100, 200],
      );
      assert.deepEqual(await store.notes.list({ pending: true }), []);
    });

    test('notes：head 是这个会话的笔记（含处理过的）覆盖到的最大 seq，没有是 0', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      assert.equal(await store.notes.head('s'), 0);
      await store.notes.add([
        { session: 's', from: 1, upTo: 3, at: 1, salience: 0.9 },
        { session: 's', from: 7, upTo: 9, at: 2, salience: 0.1, settledAt: 2 },
        { session: 't', from: 2, upTo: 20, at: 3, salience: 0.5 },
        { session: 's', from: 4, upTo: 5, at: 4, salience: 0.5 },
      ]);
      assert.equal(await store.notes.head('s'), 9);
      assert.equal(await store.notes.head('t'), 20);
      assert.equal(await store.notes.head('u'), 0);
    });

    test('notes：区间不合法时整批不写，抛 invalid_request', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const good = { session: 's', from: 1, upTo: 2, at: 1, salience: 0.5 };
      await assert.rejects(store.notes.add([good, { ...good, from: 5, upTo: 4 }]), hasType('invalid_request'));
      await assert.rejects(store.notes.add([{ ...good, from: 0 }]), hasType('invalid_request'));
      assert.deepEqual(await store.notes.list(), []);
      assert.equal(await store.notes.head('s'), 0);
    });

    test('facts：add 生成 id，recalls 从空开始，没有有效期终点、取代和归档；字段原样读回；at 不给时是 validFrom', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const input = newFact('主人喜欢乌龙茶', {
        predicate: 'likes',
        topic: 'user',
        at: MEMORY_NOW + 5,
        validFrom: MEMORY_NOW - 3,
        sources: [ref(1, 2), ref(5, 5, 't')],
      });
      const fact = await store.facts.add(input);
      assert.ok(typeof fact.id === 'string' && fact.id.length > 0);
      assert.deepEqual(fact, { ...input, id: fact.id, recalls: [] });
      assert.deepEqual(await store.facts.list(), [fact]);
      assert.ok(roundTrips(fact), '事实能 JSON 往返：可选字段不给时不出现');
      const other = await store.facts.add(newFact('主人住在台北', { validFrom: MEMORY_NOW - 7 }));
      assert.notEqual(other.id, fact.id);
      assert.equal(other.at, MEMORY_NOW - 7, '不知道什么时候记下的：当成立的时候就记下了');
    });

    test('facts：没有证据或证据区间不合法时不写，抛 invalid_request', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      await assert.rejects(store.facts.add(newFact('编造的', { sources: [] })), hasType('invalid_request'));
      await assert.rejects(store.facts.add(newFact('编造的', { sources: [ref(3, 2)] })), hasType('invalid_request'));
      await assert.rejects(
        store.facts.add(newFact('编造的', { sources: [ref(1), ref(0, 1)] })),
        hasType('invalid_request'),
      );
      assert.deepEqual(await store.facts.list(), []);
    });

    test('facts：close 关闭有效期并记 supersededBy，文字不变；已关闭的不再改；认不得的 id 抛 not_found', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('项目用 MySQL', { topic: 'work' }));
      const next = await store.facts.add(newFact('项目用 PostgreSQL', { topic: 'work' }));
      await store.facts.close(old.id, MEMORY_NOW + 500, { supersededBy: next.id });
      const closed = await factById(store, old.id);
      assert.deepEqual(
        closed,
        { ...old, validTo: MEMORY_NOW + 500, supersededBy: next.id },
        '只多了 validTo 和 supersededBy',
      );
      await store.facts.close(old.id, MEMORY_NOW + 900);
      assert.deepEqual(await factById(store, old.id), closed, '第二次 close 什么都不做');
      await assert.rejects(store.facts.close('missing', 1), hasType('not_found'));
      await assert.rejects(store.facts.close(next.id, 1, { supersededBy: 'missing' }), hasType('not_found'));
      assert.equal((await factById(store, next.id))?.validTo, undefined, 'supersededBy 认不得时不关闭');
      await store.facts.close(next.id, MEMORY_NOW + 600);
      const plain = await factById(store, next.id);
      assert.equal(plain?.validTo, MEMORY_NOW + 600);
      assert.ok(plain && !('supersededBy' in plain), '不给 supersededBy 就没有这个字段');
      assert.deepEqual(await store.facts.list({ open: true }), []);
      assert.equal((await store.facts.list()).length, 2, '关闭不删');
    });

    test('facts：cite 追加证据，文字和有效期不变；相同的区间跳过；没有证据抛 invalid_request，认不得的 id 抛 not_found', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const fact = await store.facts.add(newFact('主人喜欢乌龙茶', { sources: [ref(1, 2)] }));
      const cited = await store.facts.cite(fact.id, [ref(5, 6), ref(1, 2)]);
      assert.deepEqual(cited, { ...fact, sources: [ref(1, 2), ref(5, 6)] });
      assert.deepEqual(await store.facts.cite(fact.id, [ref(5, 6)]), cited, '重复的证据不再记');
      assert.deepEqual(await factById(store, fact.id), cited);
      await assert.rejects(store.facts.cite(fact.id, []), hasType('invalid_request'));
      await assert.rejects(store.facts.cite(fact.id, [ref(4, 3)]), hasType('invalid_request'));
      await assert.rejects(store.facts.cite('missing', [ref(1)]), hasType('not_found'));
      assert.deepEqual(await factById(store, fact.id), cited, '失败的调用什么都不改');
    });

    test('facts：touch 按先后追加召回时刻，跳过认不得的 id', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      await store.facts.touch([a.id, 'missing'], 100);
      await store.facts.touch([a.id, b.id], 200);
      await store.facts.touch([a.id], 300);
      await store.facts.touch([], 400);
      assert.deepEqual((await factById(store, a.id))?.recalls, [100, 200, 300]);
      assert.deepEqual((await factById(store, b.id))?.recalls, [200]);
    });

    test(`facts：recalls 只留最近 ${MAX_FACT_RECALLS} 次，早的丢掉，一条事实不随召回次数无限变长`, async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      await store.facts.touch([b.id], 1);
      for (let i = 0; i < MAX_FACT_RECALLS + 5; i += 1) await store.facts.touch([a.id], 1000 + i);
      const expected = Array.from({ length: MAX_FACT_RECALLS }, (_, i) => 1005 + i);
      assert.deepEqual((await factById(store, a.id))?.recalls, expected, '留下的是最近的那些，仍按先后');
      await store.facts.touch([a.id, b.id], 5000);
      assert.deepEqual((await factById(store, a.id))?.recalls, [...expected.slice(1), 5000]);
      assert.deepEqual((await factById(store, b.id))?.recalls, [1, 5000], '没满的照常追加');
    });

    test('facts：archive 退出 open 的查询但不删，返回真正归档的条数', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      const c = await store.facts.add(newFact('丙'));
      assert.equal(await store.facts.archive([a.id, 'missing'], 100), 1);
      assert.equal(await store.facts.archive([a.id, b.id], 200), 1, '已经归档的不算，也不改 archivedAt');
      assert.deepEqual(await factById(store, a.id), { ...a, archivedAt: 100 });
      assert.equal((await factById(store, b.id))?.archivedAt, 200);
      assert.deepEqual(ids(await store.facts.list({ open: true })), [c.id]);
      assert.equal((await store.facts.list()).length, 3);
    });

    test('facts：restore 恢复归档的事实，返回真正恢复的条数；有效期不动；恢复之后可以再归档', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.facts.add(newFact('甲'));
      const b = await store.facts.add(newFact('乙'));
      const c = await store.facts.add(newFact('丙'));
      const open = async (): Promise<string[]> => ids(await store.facts.list({ open: true })).toSorted();
      assert.equal(await store.facts.archive([a.id, b.id], 100), 2);
      assert.equal(await store.facts.restore([a.id, c.id, 'missing']), 1, '没归档的、认不得的不算');
      assert.deepEqual(await factById(store, a.id), a, '恢复之后和归档之前一样，没有 archivedAt');
      assert.equal(await store.facts.restore([a.id, a.id]), 0, '已经恢复的不算');
      assert.equal(await store.facts.restore([]), 0);
      assert.deepEqual(await open(), [a.id, c.id].toSorted());

      await store.facts.close(b.id, 150);
      assert.equal(await store.facts.restore([b.id]), 1);
      assert.deepEqual(await factById(store, b.id), { ...b, validTo: 150 }, '关闭的恢复了还是关闭的');
      assert.deepEqual(await open(), [a.id, c.id].toSorted());

      assert.equal(await store.facts.archive([a.id], 300), 1);
      assert.equal((await factById(store, a.id))?.archivedAt, 300, '再归档记的是新的时刻');
    });

    test('facts：forget 真删，并清掉别的事实里指向它的 supersededBy', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('项目用 MySQL'));
      const next = await store.facts.add(newFact('项目用 PostgreSQL'));
      await store.facts.close(old.id, MEMORY_NOW + 5, { supersededBy: next.id });
      assert.equal(await store.facts.forget([next.id, 'missing']), 1);
      assert.equal(await store.facts.forget([next.id]), 0);
      assert.deepEqual(
        await store.facts.list(),
        [{ ...old, validTo: MEMORY_NOW + 5 }],
        '有效期还在，supersededBy 没了',
      );
      assert.deepEqual(await store.facts.search({ text: 'PostgreSQL', open: false }), [], '搜也搜不到');
    });

    test('facts：list 按 id 码点序；subject、topic、open 筛选和 filterFacts 一致；after、limit 翻页不重不漏', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const added: MemoryFact[] = [];
      for (const [i, extra] of [
        { subject: 'user', topic: 'user' },
        { subject: 'user', topic: 'work' },
        { subject: 'project:x', topic: 'work' },
        { subject: 'user' },
        { subject: 'project:x' },
        { subject: 'user', topic: 'work' },
        { subject: 'user', topic: 'user' },
      ].entries()) {
        added.push(await store.facts.add(newFact(`事实 ${i}`, extra)));
      }
      await store.facts.close(added[1]!.id, MEMORY_NOW + 1);
      await store.facts.archive([added[4]!.id], MEMORY_NOW + 1);
      const all = await store.facts.list();
      assert.equal(all.length, added.length);
      assert.deepEqual(ids(all), ids(filterFacts(all)), '按 id 码点序');
      const queries = [
        { subject: 'user' },
        { topic: 'work' },
        { open: true },
        { open: false },
        { subject: 'user', topic: 'work', open: true },
        { after: all[2]!.id },
        { after: all[2]!.id, limit: 2 },
        { limit: 3 },
        { limit: 2.5 },
        { limit: 0 },
        { subject: 'nobody' },
      ];
      for (const query of queries) {
        assert.deepEqual(ids(await store.facts.list(query)), ids(filterFacts(all, query)), JSON.stringify(query));
      }
      for (const base of [{}, { open: true }, { subject: 'user' }]) {
        const pages: string[] = [];
        for (let after: string | undefined; ;) {
          const page = await store.facts.list({ ...base, limit: 2, ...(after !== undefined ? { after } : {}) });
          if (page.length === 0) break;
          pages.push(...ids(page));
          after = page.at(-1)!.id;
        }
        assert.deepEqual(pages, ids(filterFacts(all, base)), `翻页 ${JSON.stringify(base)}`);
      }
    });

    test('facts：search 至少全文命中（英文词、三个字以上的中文子串）；缺省只看 open，open: false 不限；topic、k 生效；score 在 0..1 从高到低', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const pg = await store.facts.add(newFact('主人的项目用 PostgreSQL 存数据', { topic: 'work' }));
      const tea = await store.facts.add(newFact('主人的饮料是乌龙茶', { topic: 'user' }));
      const mysql = await store.facts.add(newFact('以前的项目用 MySQL', { topic: 'work' }));
      const backup = await store.facts.add(newFact('MySQL 备份在周五', { topic: 'work' }));
      await store.facts.close(mysql.id, MEMORY_NOW + 1);
      await store.facts.archive([backup.id], MEMORY_NOW + 1);
      const all = await store.facts.list();
      const hits = async (query: Parameters<MemoryStore['facts']['search']>[0]): Promise<string[]> => {
        const found = await store.facts.search(query);
        assert.ok(roundTrips(found), '命中能 JSON 往返');
        for (const [i, hit] of found.entries()) {
          assert.ok(hit.score >= 0 && hit.score <= 1, `score ${hit.score} 在 0..1`);
          if (i > 0) assert.ok(hit.score <= found[i - 1]!.score, '按 score 从高到低');
          assert.deepEqual(
            hit.fact,
            all.find((fact) => fact.id === hit.fact.id),
            '命中的事实和 list 读到的一样',
          );
        }
        return found.map((hit) => hit.fact.id);
      };
      assert.ok((await hits({ text: 'PostgreSQL' })).includes(pg.id), '英文词');
      assert.ok((await hits({ text: '乌龙茶' })).includes(tea.id), '中文子串');
      const open = await hits({ text: 'MySQL' });
      assert.ok(!open.includes(mysql.id) && !open.includes(backup.id), '缺省不看关闭的和归档的');
      const any = await hits({ text: 'MySQL', open: false });
      assert.ok(any.includes(mysql.id) && any.includes(backup.id), 'open: false 连同关闭、归档的一起搜');
      assert.ok(!(await hits({ text: 'PostgreSQL', topic: 'user' })).includes(pg.id), 'topic 不对不命中');
      assert.ok((await hits({ text: 'PostgreSQL', topic: 'work' })).includes(pg.id));
      const work = await store.facts.search({ text: '项目', topic: 'work', open: false });
      assert.ok(work.every((hit) => hit.fact.topic === 'work'));
      assert.equal((await hits({ text: '主人的', k: 1 })).length, 1, 'k 限制条数');
      assert.ok((await hits({ text: '主人的' })).length >= 2);
      assert.deepEqual(await hits({ text: '主人的', k: 0 }), []);
    });

    test('facts：search 的 archived：仍然成立的里面连归档的一起搜，关闭的不搜；open: false 本来就不限', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const open = await store.facts.add(newFact('项目用 Kubernetes 部署'));
      const archived = await store.facts.add(newFact('以前在 Kubernetes 上跑批处理'));
      const closed = await store.facts.add(newFact('Kubernetes 的版本是 1.28'));
      const both = await store.facts.add(newFact('Kubernetes 集群放在机房'));
      await store.facts.archive([archived.id, both.id], MEMORY_NOW + 1);
      await store.facts.close(closed.id, MEMORY_NOW + 1);
      await store.facts.close(both.id, MEMORY_NOW + 2);
      const found = async (query: { open?: boolean; archived?: boolean }): Promise<Set<string>> =>
        new Set(await searchIds(store, { text: 'Kubernetes', ...query }));
      const all = new Set([open.id, archived.id, closed.id, both.id]);
      assert.deepEqual(await found({}), new Set([open.id]));
      assert.deepEqual(await found({ archived: false }), new Set([open.id]));
      assert.deepEqual(await found({ archived: true }), new Set([open.id, archived.id]), '关闭的归档了也不搜');
      assert.deepEqual(await found({ open: true, archived: true }), new Set([open.id, archived.id]));
      assert.deepEqual(await found({ open: false }), all);
      assert.deepEqual(await found({ open: false, archived: false }), all, 'open: false 时 archived 不起作用');
      const hit = (await store.facts.search({ text: 'Kubernetes', archived: true })).find(
        (item) => item.fact.id === archived.id,
      );
      assert.equal(hit?.fact.archivedAt, MEMORY_NOW + 1, '归档的命中带着 archivedAt，调用方据此降权');

      assert.equal(await store.facts.restore([archived.id]), 1);
      assert.deepEqual(await found({}), new Set([open.id, archived.id]), '恢复之后缺省的搜索又搜得到');
    });

    test('facts：search 中文问句：没有空白分词也找得回该找回的那条；没有共同的词就不命中', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const added: MemoryFact[] = [];
      for (const [, text] of CHINESE_RECALL) added.push(await store.facts.add(newFact(text)));
      for (const [i, [question, text]] of CHINESE_RECALL.entries()) {
        const found = await searchIds(store, { text: question });
        assert.ok(found.includes(added[i]!.id), `「${question}」应该找回「${text}」`);
      }
      assert.deepEqual(await store.facts.search({ text: '明天天气怎么样' }), []);
      assert.deepEqual(await store.facts.search({ text: '' }), [], '空的查询什么都不命中');
      assert.deepEqual(await store.facts.search({ text: ' ，。？ ' }), [], '只有空白和标点的查询什么都不命中');
    });

    test('facts：search 超长的查询（上千个不同的词）不报错，开头和结尾的词照样命中', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const head = await store.facts.add(newFact('主人的项目用 PostgreSQL 存数据'));
      const tail = await store.facts.add(newFact('服务部署在 Kubernetes 集群上'));
      const other = await store.facts.add(newFact('主人每天早上跑步'));
      const filler = Array.from({ length: 1500 }, (_, i) => `filler${i}`).join(' ');
      const hits = await store.facts.search({ text: `PostgreSQL ${filler} Kubernetes` });
      const found = hits.map((hit) => hit.fact.id);
      assert.ok(found.includes(head.id), '开头的词命中');
      assert.ok(found.includes(tail.id), '结尾的词命中');
      assert.ok(!found.includes(other.id));
      for (const hit of hits) assert.ok(hit.score > 0 && hit.score <= 1, `score ${hit.score} 在 0..1`);

      // 没有空白的一长段中文：三千个字，接着一句问话。
      const prose = Array.from({ length: 3000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7) % 2000))).join('');
      const asked = await store.facts.search({ text: `${prose}。主人每天早上跑步吗`, k: 2 });
      assert.ok(asked.length <= 2, 'k 照样生效');
      assert.ok(
        asked.some((hit) => hit.fact.id === other.id),
        '长段后面的问话照样命中',
      );
      const huge = Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(' ');
      assert.deepEqual(await store.facts.search({ text: huge }), [], '两万个不同的词也只是没有命中');
    });

    test('facts：search 按相关度排：共同的词占得多的在前，分数也高；不相关的不出现', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const partial = await store.facts.add(newFact('集群跑在 Kubernetes 上'));
      const unrelated = await store.facts.add(newFact('主人每天早上跑步'));
      const full = await store.facts.add(newFact('Kubernetes 集群每周五部署'));
      const hits = await store.facts.search({ text: '周五 部署 Kubernetes 集群' });
      assert.deepEqual(
        hits.map((hit) => hit.fact.id),
        [full.id, partial.id],
        '四个词全中的排在只中两个的前面，和写入的先后无关',
      );
      assert.ok(hits[0]!.score > hits[1]!.score && hits[1]!.score > 0, JSON.stringify(hits.map((hit) => hit.score)));
      assert.ok(!hits.some((hit) => hit.fact.id === unrelated.id));
      // 问句里零散地提到：提到得多的在前。
      const asked = await searchIds(store, { text: '我们的集群是哪天部署来着？是每周五吗' });
      assert.deepEqual(asked.slice(0, 2), [full.id, partial.id]);
      assert.deepEqual(
        await searchIds(store, { text: '周五 部署 Kubernetes 集群', k: 1 }),
        [full.id],
        'k 取的是最相关的',
      );
    });

    test('procedures：add 的 confirmations 是 1；confirm 加 1 并追加证据，相同的证据不算；没有证据抛 invalid_request；认不得的 id 抛 not_found', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const input = {
        topic: 'work',
        when: '构建失败且提示缺少依赖',
        do: '先跑 pnpm install',
        evidence: [ref(3, 4)],
        at: 100,
      };
      const procedure = await store.procedures.add(input);
      assert.deepEqual(procedure, { ...input, id: procedure.id, confirmations: 1 });
      assert.ok(roundTrips(procedure));
      const confirmed = await store.procedures.confirm(procedure.id, [ref(9, 10)]);
      assert.deepEqual(confirmed, { ...procedure, confirmations: 2, evidence: [ref(3, 4), ref(9, 10)] });
      assert.deepEqual(
        await store.procedures.confirm(procedure.id, [ref(9, 10), ref(3, 4)]),
        confirmed,
        '同一段证据不算又一次确认',
      );
      assert.deepEqual(await store.procedures.list(), [confirmed]);
      await assert.rejects(store.procedures.add({ ...input, evidence: [] }), hasType('invalid_request'));
      await assert.rejects(store.procedures.confirm(procedure.id, []), hasType('invalid_request'));
      await assert.rejects(store.procedures.confirm(procedure.id, [ref(2, 1)]), hasType('invalid_request'));
      await assert.rejects(store.procedures.confirm('missing', [ref(1)]), hasType('not_found'));
      assert.deepEqual(await store.procedures.list(), [confirmed], '失败的调用什么都不改');
    });

    test('procedures：retire 只记第一次；list 按写入顺序，topic、active 筛选', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.procedures.add({ topic: 'work', when: '甲', do: '一', evidence: [ref(1)], at: 1 });
      const b = await store.procedures.add({ topic: 'user', when: '乙', do: '二', evidence: [ref(2)], at: 2 });
      const c = await store.procedures.add({ when: '丙', do: '三', evidence: [ref(3)], at: 3 });
      await store.procedures.retire(a.id, 50);
      await store.procedures.retire(a.id, 60);
      await assert.rejects(store.procedures.retire('missing', 1), hasType('not_found'));
      const all = await store.procedures.list();
      assert.deepEqual(all, [{ ...a, retiredAt: 50 }, b, c]);
      assert.deepEqual(ids(await store.procedures.list({ active: true })), [b.id, c.id]);
      assert.deepEqual(ids(await store.procedures.list({ active: false })), ids(all), 'active: false 不限');
      assert.deepEqual(ids(await store.procedures.list({ topic: 'work' })), [a.id]);
      assert.deepEqual(await store.procedures.list({ topic: 'work', active: true }), []);
    });

    test('core：没写过是 null；set 追加版本，get 是最后一个，history 按写入顺序保留全部，last 取最后几个', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      assert.equal(await store.core.get(), null);
      assert.deepEqual(await store.core.history(), []);
      await store.core.set('一', 1);
      await store.core.set('二', 2);
      await store.core.set('三', 3);
      assert.deepEqual(await store.core.get(), { text: '三', at: 3 });
      assert.deepEqual(await store.core.history(), [
        { text: '一', at: 1 },
        { text: '二', at: 2 },
        { text: '三', at: 3 },
      ]);
      assert.deepEqual(await store.core.history({ last: 2 }), [
        { text: '二', at: 2 },
        { text: '三', at: 3 },
      ]);
      assert.deepEqual(await store.core.history({ last: 1.5 }), [{ text: '三', at: 3 }]);
      assert.deepEqual(await store.core.history({ last: 0 }), []);
      await store.core.set('一', 4);
      assert.deepEqual(await store.core.get(), { text: '一', at: 4 }, '回滚就是把旧文字再 set 一次');
    });

    test('notes：同一个会话、同样区间的笔记只写一次，add 返回已有的那条；同一批里重复的也一样', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const draft = { session: 's', from: 1, upTo: 3, at: 10, salience: 0.8 };
      const [first] = await store.notes.add([draft]);
      const again = await store.notes.add([
        { ...draft, at: 11, salience: 0.2 },
        { ...draft, from: 2 },
        { ...draft, from: 2, at: 12 },
      ]);
      assert.ok(first);
      assert.equal(again[0]?.id, first.id);
      assert.equal(again[0]?.salience, 0.8, '已有的不改');
      assert.equal(again[1]?.id, again[2]?.id);
      assert.deepEqual(ids(await store.notes.list()), [first.id, again[1]!.id]);
      const [other] = await store.notes.add([{ ...draft, session: 't' }]);
      assert.notEqual(other?.id, first.id, '别的会话的同一个区间是另一条');
      const [scoped] = await store.scope('user:alice').notes.add([draft]);
      assert.notEqual(scoped?.id, first.id, '别的作用域的是另一条');
    });

    test('notes：fail 记失败次数和原因，到 maxAttempts 进死信；死信不算待处理，retry 放回去；list 的 failed、since', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const [a, b, done] = await store.notes.add([
        { session: 's', from: 1, upTo: 1, at: 10, salience: 0.8 },
        { session: 's', from: 2, upTo: 2, at: 20, salience: 0.8 },
        { session: 's', from: 3, upTo: 3, at: 30, salience: 0.8, settledAt: 30 },
      ]);
      assert.ok(a && b && done);
      const once = await store.notes.fail([a.id, b.id, done.id, 'missing'], 40, { error: '坏的 JSON', maxAttempts: 2 });
      assert.deepEqual(ids(once), [a.id, b.id], '处理过的、认不得的跳过');
      assert.equal(once[0]?.attempts, 1);
      assert.equal(once[0]?.error, '坏的 JSON');
      assert.equal(once[0]?.failedAt, undefined);
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [a.id, b.id], '失败一次还是待处理');

      const twice = await store.notes.fail([a.id], 50, { error: '还是坏的', maxAttempts: 2 });
      assert.equal(twice[0]?.attempts, 2);
      assert.equal(twice[0]?.error, '还是坏的');
      assert.equal(twice[0]?.failedAt, 50, '到上限进死信');
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [b.id], '死信不算待处理');
      assert.deepEqual(ids(await store.notes.list({ failed: true })), [a.id]);
      assert.deepEqual(ids(await store.notes.list({ failed: false })), [b.id, done.id]);
      assert.deepEqual(ids(await store.notes.list({ pending: false })), [done.id], '死信也不算处理过');
      assert.deepEqual(await store.notes.fail([a.id], 60, { error: 'x', maxAttempts: 2 }), [], '死信不再记');
      assert.equal(await store.notes.settle([a.id], 60), 0, '死信不能直接标成处理过');
      assert.equal(await store.notes.head('s'), 3, 'head 含死信');

      assert.equal(await store.notes.retry([a.id, b.id, 'missing']), 1, '只有死信放得回去');
      const [back] = (await store.notes.list()).filter((note) => note.id === a.id);
      assert.equal(back?.failedAt, undefined);
      assert.equal(back?.attempts, undefined);
      assert.equal(back?.error, undefined);
      assert.deepEqual(ids(await store.notes.list({ pending: true })), [a.id, b.id]);
      assert.deepEqual(ids(await store.notes.list({ since: 20 })), [b.id, done.id]);
      assert.equal((await store.scope('user:bob').notes.fail([b.id], 70, { error: 'x', maxAttempts: 1 })).length, 0);
    });

    test('notes：forget 删掉一个会话的笔记（head 回到 0），不给会话删掉全部；别的作用域不动', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const alice = store.scope('user:alice');
      const draft = { from: 1, upTo: 3, at: 10, salience: 0.8 };
      await store.notes.add([
        { ...draft, session: 's' },
        { ...draft, session: 's', from: 4, upTo: 5 },
        { ...draft, session: 't' },
      ]);
      await alice.notes.add([{ ...draft, session: 's' }]);
      assert.equal(await store.notes.forget('s'), 2);
      assert.equal(await store.notes.head('s'), 0);
      assert.deepEqual(
        (await store.notes.list()).map((note) => note.session),
        ['t'],
      );
      assert.equal(await store.notes.forget('s'), 0);
      assert.equal(await store.notes.forget(), 1);
      assert.deepEqual(await store.notes.list(), []);
      assert.equal((await alice.notes.list()).length, 1, '别的作用域的还在');
    });

    test('facts：key 一个作用域里不重复，add 遇到已有的键返回已有的那条、什么都不写', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const first = await store.facts.add(newFact('主人住在杭州', { key: 'k1' }));
      assert.equal(first.key, 'k1');
      const again = await store.facts.add(newFact('主人住在上海', { key: 'k1' }));
      assert.deepEqual(again, first);
      assert.deepEqual(ids(await store.facts.list()), [first.id]);
      const other = await store.scope('user:alice').facts.add(newFact('主人住在上海', { key: 'k1' }));
      assert.notEqual(other.id, first.id, '别的作用域的同一个键是另一条');
      const plain = [await store.facts.add(newFact('没有键')), await store.facts.add(newFact('没有键'))];
      assert.notEqual(plain[0]!.id, plain[1]!.id, '没有键的不去重');
      assert.equal((await store.facts.list()).length, 3);
    });

    test('facts：supersede 原子地加新关旧；认不得的 id 什么都不写；键已经有了什么都不改；已经关闭的只写新的', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('主人住在杭州'));
      const added = await store.facts.supersede(old.id, newFact('主人住在上海', { key: 'move', at: 40 }), 50);
      assert.equal(added.text, '主人住在上海');
      assert.equal(added.at, 40, '新的记自己的写入时刻');
      const closed = await factById(store, old.id);
      assert.equal(closed?.validTo, 50);
      assert.equal(closed?.supersededBy, added.id);
      assert.equal(closed?.at, old.at, '旧的写入时刻不变');
      assert.equal((await factById(store, added.id))?.validTo, undefined);

      await assert.rejects(store.facts.supersede('missing', newFact('不该写'), 60), hasType('not_found'));
      assert.deepEqual(
        (await store.facts.list()).map((fact) => fact.text).toSorted(),
        ['主人住在上海', '主人住在杭州'],
        '认不得的 id：新的也没写',
      );
      await assert.rejects(
        store.facts.supersede(added.id, newFact('没有证据', { sources: [] }), 60),
        hasType('invalid_request'),
      );

      const repeated = await store.facts.supersede(added.id, newFact('主人住在上海', { key: 'move' }), 70);
      assert.equal(repeated.id, added.id, '同一个键：返回已有的');
      assert.equal((await factById(store, added.id))?.validTo, undefined, '什么都不改：没有把自己关掉');

      const again = await store.facts.supersede(old.id, newFact('主人住在北京'), 80);
      assert.equal((await factById(store, old.id))?.validTo, 50, '已经关闭的不改');
      assert.equal((await factById(store, old.id))?.supersededBy, added.id);
      assert.equal((await factById(store, again.id))?.text, '主人住在北京');
      await assert.rejects(
        store.scope('user:bob').facts.supersede(added.id, newFact('别的作用域'), 90),
        hasType('not_found'),
      );
    });

    test('facts：reopen 撤销关闭，清掉 validTo 和 supersededBy，返回真正重新打开的条数', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const old = await store.facts.add(newFact('主人住在杭州'));
      const added = await store.facts.supersede(old.id, newFact('主人住在上海'), 50);
      assert.equal(await store.facts.reopen([old.id, added.id, 'missing']), 1);
      const reopened = await factById(store, old.id);
      assert.equal(reopened?.validTo, undefined);
      assert.equal(reopened?.supersededBy, undefined);
      assert.deepEqual(ids(await store.facts.list({ open: true })).toSorted(), [old.id, added.id].toSorted());
      assert.equal((await searchIds(store, { text: '杭州' }))[0], old.id, '回到 open 的搜索里');
      assert.equal(await store.facts.reopen([old.id]), 0);
      assert.equal(await store.scope('user:bob').facts.reopen([old.id]), 0);
    });

    test('procedures：forget 真删，返回删掉的条数；core：clear 删掉全部版本，get 回到 null', async () => {
      const store = await factory(MEMORY_STORE_SETUP);
      const a = await store.procedures.add({ when: '部署前', do: '先跑测试', evidence: [ref(1)], at: 1 });
      const b = await store.procedures.add({ when: '发版后', do: '看监控', evidence: [ref(2)], at: 2 });
      assert.equal(await store.scope('user:bob').procedures.forget([a.id]), 0);
      assert.equal(await store.procedures.forget([a.id, a.id, 'missing']), 1);
      assert.deepEqual(ids(await store.procedures.list()), [b.id]);

      await store.core.set('一', 1);
      await store.core.set('二', 2);
      await store.scope('user:bob').core.set('bob', 3);
      assert.equal(await store.core.clear(), 2);
      assert.equal(await store.core.get(), null);
      assert.deepEqual(await store.core.history(), []);
      assert.equal(await store.core.clear(), 0);
      assert.equal((await store.scope('user:bob').core.get())?.text, 'bob', '别的作用域的不动');
    });
  });
}
