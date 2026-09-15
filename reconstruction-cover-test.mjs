const browserBase = 'http://127.0.0.1:9237';
const target = await fetch(`${browserBase}/json/new?http%3A%2F%2Flocalhost%3A3000%2F%3Fv%3D26`, { method: 'PUT' }).then(response => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let id = 0;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const callback = pending.get(message.id);
    pending.delete(message.id);
    message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
});
function command(method, params = {}) {
  const commandId = ++id;
  socket.send(JSON.stringify({ id: commandId, method, params }));
  return new Promise((resolve, reject) => pending.set(commandId, { resolve, reject }));
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
await command('Runtime.enable');
await command('Page.enable');
await command('DOM.enable');
await pause(900);
const documentTree = await command('DOM.getDocument', { depth: 2 });
const requestedNode = await command('DOM.querySelector', { nodeId: documentTree.root.nodeId, selector: '[data-pdf-input]' });
await command('DOM.setFileInputFiles', {
  nodeId: requestedNode.nodeId,
  files: ['/Users/quinnchen/Documents/ChatGPT/精读任务站/outputs/daily-english-reading-2026-08-25.pdf'],
});
await evaluate(`document.querySelector('[data-pdf-input]').dispatchEvent(new Event('change', { bubbles: true }))`);
for (let attempt = 0; attempt < 50; attempt += 1) {
  await pause(300);
  if (await evaluate(`Boolean(document.querySelector('.import-heading'))`)) break;
}
await evaluate(`[...document.querySelectorAll('[data-view]')].find(node => node.dataset.view === 'library').click()`);
await pause(500);
const cover = JSON.parse(await evaluate(`JSON.stringify({
  image: Boolean(document.querySelector('.document-cover-image')),
  sourceLength: document.querySelector('.document-cover-image')?.src.length || 0,
  syntheticTitleRemoved: !document.querySelector('.cover.has-thumbnail > b'),
  pages: document.querySelector('.cover.has-thumbnail i')?.textContent || ''
})`));
await evaluate(`new Promise((resolve, reject) => {
  const request = indexedDB.open('readquest-library', 1);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const transaction = request.result.transaction('articles', 'readwrite');
    transaction.objectStore('articles').put({
      id: 'reconstruction-test', documentId: 'test-doc', documentName: 'Magazine Test', title: 'Final Reconstruction Test', level: 'B2', rawText: 'Reading carefully changes how we notice language.', regions: [],
      sentences: [{ id: 'difficult-test-sentence', text: 'Reading carefully changes how we notice language.', translation: '仔细阅读会改变我们留意语言的方式。', referenceTranslation: '', backTranslation: '', reconstructionWords: [], notes: '', difficult: false }],
      vocabulary: [], completed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  };
})`);
await command('Page.reload', { ignoreCache: true });
await pause(900);
await evaluate(`[...document.querySelectorAll('[data-view]')].find(node => node.dataset.view === 'articles').click()`);
await pause(250);
await evaluate(`document.querySelector('[data-open-article="reconstruction-test"]').click()`);
await pause(250);
await evaluate(`localStorage.removeItem('readquest-hide-difficult-hint')`);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(180);
const hint = JSON.parse(await evaluate(`JSON.stringify({
  visible: Boolean(document.querySelector('.difficult-hint')),
  text: document.querySelector('.difficult-hint')?.textContent.replace(/\\s+/g, ' ').trim() || '',
  drawerStayedClosed: !document.querySelector('.reconstruction-drawer'),
  disableOption: Boolean(document.querySelector('[data-disable-difficult-hint]'))
})`));
await evaluate(`document.querySelector('[data-open-reconstruction-drawer]').click()`);
await pause(250);
const listOnly = JSON.parse(await evaluate(`JSON.stringify({
  drawerOpen: Boolean(document.querySelector('.reconstruction-list-drawer')),
  listCount: document.querySelectorAll('[data-open-reconstruction-practice]').length,
  workspaceRemoved: !document.querySelector('.reconstruction-workspace'),
  practiceStillClosed: !document.querySelector('#reconstructionPracticeDialog')
})`));
await evaluate(`document.querySelector('[data-open-reconstruction-practice]').click()`);
await pause(250);
for (let attempt = 0; attempt < 60; attempt += 1) {
  await pause(300);
  if (await evaluate(`Boolean(document.querySelector('.dialog-chinese-prompt p:not(.reference-loading)'))`)) break;
}
const generated = await evaluate(`document.querySelector('.dialog-chinese-prompt p:not(.reference-loading)')?.textContent || ''`);
await evaluate(`(() => {
  const values = ['Writing', 'carefully', 'changes', 'how', 'we', 'notice', 'language'];
  [...document.querySelectorAll('[data-reconstruction-word]')].forEach((input, index) => { input.value = values[index] || ''; });
  document.querySelector('[data-check-reconstruction]').click();
})()`);
await pause(350);
const practice = JSON.parse(await evaluate(`JSON.stringify({
  oldBottomSectionRemoved: !document.querySelector('.reconstruction-section'),
  drawerOpen: Boolean(document.querySelector('.reconstruction-drawer')),
  title: document.querySelector('.reconstruction-practice-dialog h2')?.textContent || '',
  practiceDialogOpen: document.querySelector('#reconstructionPracticeDialog')?.open || false,
  hintClosedByRail: !document.querySelector('.difficult-hint'),
  listCount: document.querySelectorAll('[data-open-reconstruction-practice]').length,
  activeListCount: document.querySelectorAll('[data-open-reconstruction-practice].active').length,
  railWritingMode: getComputedStyle(document.querySelector('.reconstruction-rail-button span')).writingMode,
  slotCount: document.querySelectorAll('[data-reconstruction-word]').length,
  wrongCount: document.querySelectorAll('.word-slot.is-wrong').length,
  correctCount: document.querySelectorAll('.word-slot.is-correct').length,
  wrongHint: document.querySelector('.word-slot.is-wrong small')?.textContent || '',
  standard: document.querySelector('.standard-answer p')?.textContent || '',
  simplifiedReference: !document.querySelector('.translation-comparison > div'),
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
})`));
practice.generated = generated;
await evaluate(`document.querySelector('[data-close-reconstruction-practice]').click()`);
await pause(250);
await evaluate(`document.querySelector('.reconstruction-drawer header [data-close-reconstruction-drawer]').click()`);
await pause(250);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(220);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(220);
const hintBeforeTimeout = await evaluate(`Boolean(document.querySelector('.difficult-hint'))`);
await pause(3200);
const hintAutoClosed = await evaluate(`!document.querySelector('.difficult-hint')`);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(220);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(220);
await evaluate(`(() => { const box = document.querySelector('[data-disable-difficult-hint]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await pause(220);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(220);
await evaluate(`document.querySelector('[data-toggle-difficult="difficult-test-sentence"]').click()`);
await pause(220);
const preference = JSON.parse(await evaluate(`JSON.stringify({
  stored: localStorage.getItem('readquest-hide-difficult-hint'),
  staysHidden: !document.querySelector('.difficult-hint')
})`));
const stored = JSON.parse(await evaluate(`new Promise((resolve, reject) => {
  const request = indexedDB.open('readquest-library', 1);
  request.onsuccess = () => {
    const get = request.result.transaction('articles').objectStore('articles').get('reconstruction-test');
    get.onsuccess = () => resolve(JSON.stringify({ difficult: get.result.sentences[0].difficult, words: get.result.sentences[0].reconstructionWords }));
    get.onerror = () => reject(get.error);
  };
  request.onerror = () => reject(request.error);
})`));
console.log(JSON.stringify({ cover, hint, listOnly, practice, hintBeforeTimeout, hintAutoClosed, preference, stored, runtimeErrors }));
socket.close();
await fetch(`${browserBase}/json/close/${target.id}`);
