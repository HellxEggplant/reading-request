import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'data', 'ecdict-shards');
const database = new DatabaseSync(join(root, 'data', 'ecdict.sqlite'), { readOnly: true });
const entries = database.prepare(`
  SELECT word, phonetic, translation, pos, collins, oxford, tag, exchange
  FROM entries
  WHERE translation IS NOT NULL AND trim(translation) <> ''
    AND (
      oxford = 1 OR cast(collins AS INTEGER) > 0 OR cast(bnc AS INTEGER) > 0
      OR cast(frq AS INTEGER) > 0 OR trim(coalesce(tag, '')) <> ''
    )
  ORDER BY word COLLATE NOCASE
`).iterate();

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const shards = new Map();
for (const entry of entries) {
  const key = String(entry.word || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || '__';
  const shard = shards.get(key) || {};
  shard[String(entry.word).toLowerCase()] = {
    word: entry.word,
    phonetic: entry.phonetic || '',
    translation: entry.translation || '',
    pos: entry.pos || '',
    collins: entry.collins || 0,
    oxford: entry.oxford || 0,
    tag: entry.tag || '',
    exchange: entry.exchange || '',
  };
  shards.set(key, shard);
}

for (const [key, shard] of shards) {
  await writeFile(join(output, `${key}.json`), JSON.stringify(shard));
}

console.log(`Created ${shards.size} ECDICT shards in ${output}`);
