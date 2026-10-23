import { describe, test } from 'vite-plus/test';

import { createMemoryStore } from './store.ts';
import { describeStoreContract } from './testing.ts';

describeStoreContract('memory', ({ now }) => createMemoryStore({ now }), { describe, test });
