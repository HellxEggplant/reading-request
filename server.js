import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const ecdict = new DatabaseSync(join(root, 'data', 'ecdict.sqlite'), { readOnly: true });
const ecdictLookup = ecdict.prepare(`
  SELECT word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange
  FROM entries WHERE word = ? COLLATE NOCASE LIMIT 1
`);
const translationPython = process.env.TRANSLATION_PYTHON || join(root, '.translation-lite', 'bin', 'python3');
const translationScript = join(root, 'translation-worker.py');
const translationRequests = new Map();
let translationWorker = null;
let translationSequence = 0;
let translationBuffer = '';
const allowedPdfJs = new Set([
  'node_modules/pdfjs-dist/build/pdf.mjs',
  'node_modules/pdfjs-dist/build/pdf.worker.mjs',
]);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (requestUrl.pathname === '/api/translate') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' });
      const payload = await readRequestJson(request);
      const input = String(payload?.text || '').trim();
      if (!input || input.length > 2000) return sendJson(response, 400, { error: 'Text must contain 1–2000 characters' });
      try {
        const translatedText = await translateToChinese(input);
        return sendJson(response, 200, {
          translatedText,
          source: 'Argos Translate 本地离线英译中模型',
          generatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error('Offline translation failed:', error.message);
        return sendJson(response, 503, { error: '本地翻译暂时不可用，请稍后重试。' });
      }
    }

    if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, 'Method not allowed');

    if (requestUrl.pathname === '/api/dictionary') {
      const word = requestUrl.searchParams.get('word')?.trim() || '';
      if (!/^[A-Za-z][A-Za-z'-]{0,60}$/.test(word)) return sendJson(response, 400, { error: 'Invalid word' });
      const chinese = ecdictLookup.get(word) || null;
      let exact = null;
      let related = [];
      try {
        const [exactResult, relatedResult] = await Promise.allSettled([
          fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dpr&ipa=1&max=1`, { signal: AbortSignal.timeout(6500) }),
          fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(word)}&max=8`, { signal: AbortSignal.timeout(6500) }),
        ]);
        if (exactResult.status === 'fulfilled' && exactResult.value.ok) {
          exact = (await exactResult.value.json()).find(item => item.word?.toLowerCase() === word.toLowerCase()) || null;
        }
        if (relatedResult.status === 'fulfilled' && relatedResult.value.ok) {
          related = (await relatedResult.value.json()).map(item => item.word).filter(Boolean).slice(0, 8);
        }
      } catch {
        // ECDICT remains available when the online dictionary cannot be reached.
      }

      const groups = new Map();
      (exact?.defs || []).forEach(value => {
        const [part = 'definition', ...content] = value.split('\t');
        const label = ({ n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb' })[part] || part;
        const definitions = groups.get(label) || [];
        definitions.push({ definition: content.join(' ').trim(), example: '' });
        groups.set(label, definitions);
      });
      if (!groups.size && chinese?.definition) {
        groups.set('definition', String(chinese.definition).split('\n').filter(Boolean).slice(0, 4).map(definition => ({ definition, example: '' })));
      }
      if (!groups.size && !chinese) return sendJson(response, 404, { error: 'Definition not found' });
      const tags = exact?.tags || [];
      const phonetic = tags.find(tag => tag.startsWith('ipa_pron:'))?.slice(9).trim() || chinese?.phonetic || '';
      const meanings = [...groups].map(([partOfSpeech, definitions], index) => ({
        partOfSpeech,
        definitions,
        synonyms: index === 0 ? related : [],
      }));
      return sendJson(response, 200, {
        word,
        structured: {
          dictionaryVersion: 2,
          phonetic,
          audio: '',
          origin: '',
          meanings,
          chinese,
          source: exact ? 'Datamuse 在线英英词典 + ECDICT 英汉词典' : 'ECDICT 英汉词典',
        },
      });
    }

    const pathname = requestUrl.pathname === '/' ? '/index.html' : decodeURIComponent(requestUrl.pathname);
    const filename = normalize(join(root, pathname));
    const localPath = relative(root, filename);
    if (
      localPath.startsWith('..') ||
      localPath.split('/').some(part => part.startsWith('.')) ||
      (localPath.startsWith('node_modules/') && !allowedPdfJs.has(localPath))
    ) return send(response, 404, 'Not found');

    const info = await stat(filename);
    if (!info.isFile() || !mime[extname(filename)]) return send(response, 404, 'Not found');
    const data = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': mime[extname(filename)],
      'Cache-Control': localPath.startsWith('node_modules/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    send(response, error?.code === 'ENOENT' ? 404 : 500, error?.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}).listen(port, () => console.log(`精读任务站已启动：http://localhost:${port}`));

function getTranslationWorker() {
  if (translationWorker && !translationWorker.killed) return translationWorker;
  translationBuffer = '';
  translationWorker = spawn(translationPython, [translationScript], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARGOS_PACKAGES_DIR: join(root, 'data', 'argos-packages'),
      XDG_DATA_HOME: join(root, 'data', 'argos-data'),
      XDG_CONFIG_HOME: join(root, 'data', 'argos-config'),
      XDG_CACHE_HOME: join(root, 'data', 'argos-cache'),
      TRANSLATION_MODEL_DIR: join(root, 'data', 'argos-packages', 'translate-en_zh-1_9'),
    },
  });
  translationWorker.stdout.setEncoding('utf8');
  translationWorker.stdout.on('data', chunk => {
    translationBuffer += chunk;
    const lines = translationBuffer.split('\n');
    translationBuffer = lines.pop() || '';
    lines.filter(Boolean).forEach(line => {
      try {
        const result = JSON.parse(line);
        const pending = translationRequests.get(result.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        translationRequests.delete(result.id);
        result.error ? pending.reject(new Error(result.error)) : pending.resolve(result.translatedText);
      } catch (error) {
        console.error('Invalid translation worker response:', error.message);
      }
    });
  });
  translationWorker.stderr.setEncoding('utf8');
  translationWorker.stderr.on('data', chunk => {
    if (process.env.TRANSLATION_DEBUG) console.error(chunk.trim());
  });
  const failPending = error => {
    for (const pending of translationRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    translationRequests.clear();
    translationWorker = null;
  };
  translationWorker.on('error', error => failPending(error));
  translationWorker.on('exit', code => failPending(new Error(`Translation worker stopped (${code ?? 'unknown'})`)));
  return translationWorker;
}

function translateToChinese(text) {
  return new Promise((resolve, reject) => {
    const id = String(++translationSequence);
    const worker = getTranslationWorker();
    const timeout = setTimeout(() => {
      translationRequests.delete(id);
      reject(new Error('Translation timed out'));
    }, 45000);
    translationRequests.set(id, { resolve, reject, timeout });
    worker.stdin.write(`${JSON.stringify({ id, text })}\n`, error => {
      if (!error) return;
      clearTimeout(timeout);
      translationRequests.delete(id);
      reject(error);
    });
  });
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 12_000) request.destroy(new Error('Request too large'));
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

process.on('exit', () => translationWorker?.kill());

function send(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(message);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}
