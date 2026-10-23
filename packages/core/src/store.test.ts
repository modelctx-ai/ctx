import { createMemoryStore } from './store.ts';
import { describeStoreContract } from './testing.ts';

describeStoreContract('memory', ({ now }) => createMemoryStore({ now }));
