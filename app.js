let pdfjsLib;

async function ensurePdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('./vendor/pdfjs/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';
  return pdfjsLib;
}

const DB_NAME = 'readquest-library';
const DB_VERSION = 2;
const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const ui = {
  view: 'library',
  documents: [],
  articles: [],
  activities: [],
  selectedDocumentId: null,
  selectedArticleId: null,
  pdf: null,
  page: 1,
  regions: [],
  articleTitle: '',
  articleLevel: 'B1',
  activeRect: null,
  textItems: [],
  rendering: false,
  libraryQuery: '',
  librarySort: 'recent',
  favoriteOnly: false,
  documentDialog: null,
  selectionFocus: false,
  pdfZoom: 1,
  readerSplit: 52,
  sourceDialog: false,
  sourcePreviewArticleId: null,
  selectedListArticleId: null,
  articleEditId: null,
  translationCheckIds: new Set(),
  translationGeneration: new Map(),
  practiceRevealIds: new Set(),
  reconstructionDialogSentenceId: null,
  reconstructionDrawerOpen: false,
  reconstructionPracticeOpen: false,
  difficultHintVisible: false,
  wordDialog: null,
  readerSentenceIndex: 0,
  readerCardDirection: 'next',
  webUrl: '',
  webPage: null,
  webSelections: [],
  webLoading: false,
  webError: '',
  webArticleTitle: '',
  webArticleLevel: 'B1',
  pomodoroMode: 'focus',
  pomodoroRemaining: 25 * 60,
  pomodoroRunning: false,
  pomodoroEndsAt: null,
};

let dbPromise;
let difficultHintTimer;
let pomodoroTimer;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('documents')) {
        database.createObjectStore('documents', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('articles')) {
        database.createObjectStore('articles', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('activities')) {
        database.createObjectStore('activities', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function storeRequest(storeName, mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const records = {
  all: store => storeRequest(store, 'readonly', objectStore => objectStore.getAll()),
  get: (store, id) => storeRequest(store, 'readonly', objectStore => objectStore.get(id)),
  put: (store, value) => storeRequest(store, 'readwrite', objectStore => objectStore.put(value)),
  delete: (store, id) => storeRequest(store, 'readwrite', objectStore => objectStore.delete(id)),
};

async function refreshData() {
  const [documents, articles, activities] = await Promise.all([
    records.all('documents'),
    records.all('articles'),
    records.all('activities'),
  ]);
  ui.documents = documents.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  ui.articles = articles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  ui.activities = activities.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(iso));
}

function shell(content) {
  const navItems = [
    ['library', '▤', '阅读书库'],
    ['articles', '⌁', '精读文章'],
    ['growth', '◉', '阅读记录'],
  ];
  return `
    <header class="topbar">
      <button class="brand" data-view="library" aria-label="返回阅读书库">
        <span class="brand-mark">R</span>
        <span><b>精读任务站</b><small>THE READING DESK</small></span>
      </button>
      <nav class="topnav" aria-label="主要导航">
        ${navItems.map(([id, icon, label]) => `
          <button class="nav-item ${ui.view === id ? 'active' : ''}" data-view="${id}">
            <span>${icon}</span><b>${label}</b>
          </button>
        `).join('')}
      </nav>
      <div class="sync-pill"><i></i><span>本地保存</span></div>
      <details class="resource-upload-menu">
        <summary><span>＋</span> 上传资料</summary>
        <div class="resource-upload-options">
          <button type="button" data-trigger-pdf-upload aria-label="上传 PDF 文件">
            <span>PDF</span><b>上传 PDF</b><small>导入期刊或杂志文件</small>
          </button>
          <button type="button" data-view="webImport" aria-label="通过文章网址导入">
            <span>URL</span><b>文章网址</b><small>粘贴链接并选择正文</small>
          </button>
        </div>
        <input type="file" accept="application/pdf,.pdf" data-pdf-input hidden>
      </details>
    </header>
    <div class="app-shell">
      <main class="main">${content}</main>
    </div>
  `;
}

function libraryPage() {
  const recent = ui.articles.slice(0, 3);
  const query = ui.libraryQuery.trim().toLocaleLowerCase();
  const visibleDocuments = ui.documents
    .filter(document => !query || document.name.toLocaleLowerCase().includes(query))
    .filter(document => !ui.favoriteOnly || document.favorite)
    .sort((a, b) => {
      if (Boolean(a.favorite) !== Boolean(b.favorite)) return a.favorite ? -1 : 1;
      if (ui.librarySort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
      if (ui.librarySort === 'pages') return (b.pageCount || 0) - (a.pageCount || 0);
      return (b.addedAt || '').localeCompare(a.addedAt || '');
    });
  const showUploadCard = !query && !ui.favoriteOnly;
  return shell(`
    <section class="page-heading library-heading">
      <div class="library-heading-copy">
        <p class="eyebrow">THE PERSONAL READING ARCHIVE · 个人阅读书库</p>
        <h1>读好文章，<br><em>练真英语。</em></h1>
        <p>收藏英文期刊与杂志，在原版版面中选择文章，再进入安静、深入的逐句精读。</p>
        <div class="hero-metrics">
          <span><b>${ui.documents.length}</b><small>本资料</small></span>
          <span><b>${ui.articles.length}</b><small>篇精读</small></span>
          <span><b>${ui.articles.filter(article => article.completed).length}</b><small>篇完成</small></span>
        </div>
      </div>
      <figure class="library-heading-visual">
        <img src="assets/editorial-reading-desk.png" alt="阳光下放着英文杂志和笔记本的阅读桌">
        <figcaption><b>READ DEEPLY</b><span>每一次精读，都是一次真正的语言实践。</span></figcaption>
      </figure>
    </section>

    <section class="section-block">
      <div class="section-title">
        <div><p class="eyebrow">LIBRARY</p><h2>我的资料</h2></div>
        <span>${ui.documents.length ? `显示 ${visibleDocuments.length} / ${ui.documents.length} 本资料` : '还没有上传资料'}</span>
      </div>
      ${ui.documents.length ? `
        <div class="library-tools">
          <label class="library-search"><span>⌕</span><input id="librarySearch" value="${esc(ui.libraryQuery)}" placeholder="搜索期刊、杂志或文件名" aria-label="搜索资料"></label>
          <select id="librarySort" aria-label="资料排序">
            <option value="recent" ${ui.librarySort === 'recent' ? 'selected' : ''}>最近上传</option>
            <option value="name" ${ui.librarySort === 'name' ? 'selected' : ''}>按名称</option>
            <option value="pages" ${ui.librarySort === 'pages' ? 'selected' : ''}>按页数</option>
          </select>
          <button class="favorite-filter ${ui.favoriteOnly ? 'active' : ''}" data-favorite-filter aria-pressed="${ui.favoriteOnly}">★ 只看收藏</button>
        </div>
      ` : ''}
      <div class="library-portability">
        <div><b>本地书库备份</b><small>换电脑时，先导出整库，再在新设备恢复。PDF、文章与笔记都会包含在备份中。</small></div>
        <div>
          <button class="outline" type="button" data-export-library>导出整库</button>
          <label class="outline backup-import">恢复整库<input type="file" accept="application/json,.json" data-import-library hidden></label>
        </div>
      </div>
      <div class="document-grid">
        ${visibleDocuments.map(document => documentCard(document)).join('')}
        ${showUploadCard ? `
          <button class="document-upload-card web-upload-card" type="button" data-view="webImport">
            <span>⌁</span><b>添加网页</b><small>粘贴链接，在站内选择文章正文</small><em>IMPORT FROM URL</em>
          </button>
          <label class="document-upload-card" id="dropZone">
            <input type="file" accept="application/pdf,.pdf" data-pdf-input hidden>
            <span>＋</span><b>添加 PDF</b><small>点击选择或拖入英文期刊与杂志</small><em>ADD TO ARCHIVE</em>
          </label>
        ` : ''}
      </div>
      ${visibleDocuments.length || showUploadCard ? '' : emptyState('⌕', '没有找到资料', '换一个关键词，或者关闭“只看收藏”后再试。')}
    </section>

    ${recent.length ? `
      <section class="section-block">
        <div class="section-title"><div><p class="eyebrow">RECENT</p><h2>最近精读</h2></div><button class="text-button" data-view="articles">查看全部 →</button></div>
        <div class="recent-list">${recent.map(articleRow).join('')}</div>
      </section>
    ` : ''}
    ${documentDialog()}
  `);
}

function documentCard(document) {
  const articleCount = ui.articles.filter(article => article.documentId === document.id).length;
  return `
    <article class="document-card">
      <div class="cover ${document.coverDataUrl ? 'has-thumbnail' : ''}">
        ${document.coverDataUrl ? `<img class="document-cover-image" src="${document.coverDataUrl}" alt="${esc(document.name.replace(/\.pdf$/i, ''))} 封面">` : ''}
        <span>PDF</span>
        <button class="favorite-button ${document.favorite ? 'active' : ''}" data-favorite-document="${document.id}" aria-label="${document.favorite ? '取消收藏' : '收藏资料'}" title="${document.favorite ? '取消收藏' : '收藏资料'}">★</button>
        ${document.coverDataUrl ? '' : `<b>${esc(document.name.replace(/\.pdf$/i, '').slice(0, 38))}</b>`}
        <i>${document.pageCount} PAGES</i>
      </div>
      <div class="document-info">
        <div><h3>${esc(document.name.replace(/\.pdf$/i, ''))}</h3><p>${formatBytes(document.size)} · ${formatDate(document.addedAt)}</p></div>
        <span class="count-chip">${articleCount} 篇</span>
      </div>
      <button class="primary full" data-open-document="${document.id}">打开并框选文章 <span>→</span></button>
      <div class="document-actions">
        <button data-rename-document="${document.id}">重命名</button>
        <button data-download-document="${document.id}">下载</button>
        <button class="danger" data-delete-document="${document.id}">删除</button>
      </div>
    </article>
  `;
}

function documentDialog() {
  if (!ui.documentDialog) return '';
  const document = ui.documents.find(item => item.id === ui.documentDialog.id);
  if (!document) return '';
  const articleCount = ui.articles.filter(article => article.documentId === document.id).length;
  if (ui.documentDialog.type === 'rename') {
    return `
      <dialog class="document-dialog" id="documentDialog">
        <form method="dialog" data-rename-form>
          <span class="dialog-kicker">RENAME DOCUMENT</span>
          <h2>重命名资料</h2>
          <p>只修改书库里的显示名称，不会改变 PDF 内容。</p>
          <label>资料名称<input id="renameDocumentInput" value="${esc(document.name.replace(/\.pdf$/i, ''))}" maxlength="120" required></label>
          <div><button value="cancel" class="outline" data-close-document-dialog>取消</button><button value="default" class="primary" type="submit">保存名称</button></div>
        </form>
      </dialog>`;
  }
  return `
    <dialog class="document-dialog danger-dialog" id="documentDialog">
      <form method="dialog" data-delete-form>
        <span class="dialog-kicker">DELETE DOCUMENT</span>
        <h2>删除这份资料？</h2>
        <p>“${esc(document.name)}”将从当前浏览器的书库中删除。这个操作无法撤销。</p>
        ${articleCount ? `<label class="delete-related"><input id="deleteRelatedArticles" type="checkbox"><span><b>同时删除 ${articleCount} 篇相关精读文章</b><small>不勾选时，已经生成的精读文章和笔记会继续保留。</small></span></label>` : '<p class="dialog-safe">这份资料还没有生成精读文章。</p>'}
        <div><button value="cancel" class="outline" data-close-document-dialog>取消</button><button value="default" class="danger-button" type="submit">确认删除</button></div>
      </form>
    </dialog>`;
}

function articlesPage() {
  const previewArticle = ui.articles.find(article => article.id === ui.sourcePreviewArticleId);
  return shell(`
    <section class="page-heading article-page-heading">
      <div><p class="eyebrow">INTENSIVE READING</p><h1>精读文章</h1><p>从原版页面进入逐句翻译、词汇标记和长难句记录。</p></div>
      <div class="heading-stat"><b>${ui.articles.length}</b><span>篇文章</span></div>
    </section>
    ${ui.articles.length ? `
      <div class="article-library">
        ${ui.articles.map((article, index) => articleRecord(article, index)).join('')}
      </div>
    ` : emptyState('⌁', '还没有精读文章', '先从阅读书库打开一本 PDF，框选文章正文并生成精读内容。', '<button class="primary" data-view="library">前往书库</button>')}
    ${ui.sourceDialog && previewArticle ? sourceDialogMarkup(previewArticle) : ''}
    ${articleEditDialog()}
  `);
}

function articleRecord(article, index) {
  const translated = article.sentences.filter(sentence => sentence.translation?.trim()).length;
  const progress = article.sentences.length ? Math.round(translated / article.sentences.length * 100) : 0;
  const selected = ui.selectedListArticleId === article.id ? 'is-selected' : '';
  return `
    <article class="article-record ${selected}" data-preview-article="${article.id}" tabindex="0" aria-label="查看《${esc(article.title)}》原文" aria-selected="${selected ? 'true' : 'false'}">
      <div class="article-record-cover art-${index % 3}" aria-hidden="true"></div>
      <div class="article-record-content">
        <div class="article-record-meta"><span>${esc(article.level)}</span><i>${esc(article.documentName)}</i></div>
        <h2>${esc(article.title)}</h2>
        <p>${article.sentences.length} 个句子 · ${article.vocabulary.length} 个生词</p>
        <div class="progress"><i style="width:${progress}%"></i></div>
        <footer>
          <span>${article.completed ? '✓ 已完成' : `已完成 ${progress}%`}</span>
          <div>
            <button class="outline" data-edit-article="${article.id}">编辑</button>
            <button class="primary" data-open-article="${article.id}">继续精读 →</button>
          </div>
        </footer>
      </div>
    </article>`;
}

function articleEditDialog() {
  const article = ui.articles.find(item => item.id === ui.articleEditId);
  if (!article) return '';
  return `
    <dialog class="article-edit-dialog" id="articleEditDialog">
      <form method="dialog" data-article-edit-form>
        <header><div><span>EDIT ARTICLE</span><h2>编辑精读文章</h2></div><button type="button" data-close-article-edit>关闭 ×</button></header>
        <div class="article-edit-fields">
          <label>文章标题<input id="editArticleTitle" value="${esc(article.title)}" maxlength="220" required></label>
          <label>CEFR 难度<select id="editArticleLevel">${CEFR.map(level => `<option ${level === article.level ? 'selected' : ''}>${level}</option>`).join('')}</select></label>
          <label class="article-content-field">英文正文<textarea id="editArticleContent" required>${esc(article.rawText || article.sentences.map(sentence => sentence.text).join(' '))}</textarea></label>
        </div>
        <p>保存后会重新按句切分正文。句子数量不变时，已有翻译、笔记和长难句标记会按顺序保留。</p>
        <footer><button type="button" class="outline" data-close-article-edit>取消</button><button type="submit" class="primary">保存修改</button></footer>
      </form>
    </dialog>`;
}

function sourceDialogMarkup(article) {
  const originalPages = article.regions?.length
    ? article.regions.map((region, index) => sourceRegionMarkup(region, index, true)).join('')
    : '<p class="source-dialog-empty">这篇文章没有保存原版框选图片。</p>';
  const extractedText = article.rawText || article.sentences.map(sentence => sentence.text).join(' ');
  return `
    <dialog class="source-dialog" id="sourceDialog">
      <header><div><span>ORIGINAL ARTICLE</span><b>${esc(article.title)}</b></div><button type="button" data-close-source-dialog aria-label="关闭原文">关闭 ×</button></header>
      <div class="source-dialog-gallery">
        ${originalPages}
        <section class="source-dialog-text">
          <span>EXTRACTED TEXT</span>
          <h3>提取后的英文正文</h3>
          <p>${esc(extractedText)}</p>
        </section>
      </div>
    </dialog>`;
}

function sourceRegionMarkup(region, index, dialog = false) {
  if (region.kind === 'web') {
    return `<figure class="web-source-region ${dialog ? 'dialog-web-source' : ''}">
      <span>${String(index + 1).padStart(2, '0')} · WEB</span>
      <blockquote>${esc(region.text)}</blockquote>
    </figure>`;
  }
  return `<figure>
    <span>${String(index + 1).padStart(2, '0')} · 第 ${region.page} 页</span>
    <img src="${region.imageData}" alt="第 ${region.page} 页框选区域">
  </figure>`;
}

function articleRow(article) {
  const translated = article.sentences.filter(sentence => sentence.translation?.trim()).length;
  return `
    <button class="recent-row" data-open-article="${article.id}">
      <span class="level-badge">${esc(article.level)}</span>
      <span><b>${esc(article.title)}</b><small>${esc(article.documentName)}</small></span>
      <em>${translated}/${article.sentences.length} 句</em>
      <i>→</i>
    </button>
  `;
}

function growthPage() {
  const sentences = ui.articles.flatMap(article => article.sentences);
  const translated = sentences.filter(sentence => sentence.translation?.trim()).length;
  const words = new Set(ui.articles.flatMap(article => article.vocabulary.map(word => word.toLowerCase())));
  const completed = ui.articles.filter(article => article.completed).length;
  const difficult = sentences.filter(sentence => sentence.difficult).length;
  const levelCounts = CEFR.map(level => ({
    level,
    count: ui.articles.filter(article => article.level === level).length,
  }));
  const maxLevel = Math.max(1, ...levelCounts.map(item => item.count));
  const timeline = buildGrowthTimeline();
  const activeDays = timeline.map(day => day.dateKey);
  const streak = calculateReadingStreak(activeDays);
  const lastSevenStart = new Date();
  lastSevenStart.setHours(0, 0, 0, 0);
  lastSevenStart.setDate(lastSevenStart.getDate() - 6);
  const lastSeven = timeline.filter(day => new Date(`${day.dateKey}T00:00:00`) >= lastSevenStart);
  const weeklyTranslations = lastSeven.reduce((sum, day) => sum + day.gains.translated, 0);
  const weeklyWords = lastSeven.reduce((sum, day) => sum + day.gains.vocabulary, 0);
  return shell(`
    <section class="page-heading growth-heading">
      <div><p class="eyebrow">READING RECORD</p><h1>阅读记录</h1><p>回看每天读过的文章与完成的练习，让词汇、翻译和句子理解的进步清晰可见。</p></div>
      <div class="growth-streak"><span>连续阅读</span><b>${streak}</b><small>天</small></div>
    </section>
    <div class="stat-grid">
      ${[
        ['日', activeDays.length, '有效阅读日'],
        ['⌁', completed, '完成精读'],
        ['译', translated, '已译句子'],
        ['Aa', words.size, '标记生词'],
      ].map(([icon, value, label]) => `<article class="stat-card"><span>${icon}</span><b>${value}</b><small>${label}</small></article>`).join('')}
    </div>
    <section class="weekly-growth-strip">
      <div><span>最近 7 天</span><b>${lastSeven.length}</b><small>天有阅读</small></div>
      <div><span>翻译提升</span><b>＋${weeklyTranslations}</b><small>句</small></div>
      <div><span>词汇积累</span><b>＋${weeklyWords}</b><small>词</small></div>
      <div><span>当前训练</span><b>${difficult}</b><small>个长难句</small></div>
    </section>
    <div class="growth-dashboard">
      <section class="daily-record-panel">
        <div class="section-title"><div><p class="eyebrow">DAILY PROGRESS</p><h2>每天完成了什么</h2></div><span>${timeline.length ? `${timeline.length} 天记录` : '从今天开始积累'}</span></div>
        ${timeline.length ? `<div class="daily-timeline">${timeline.map(growthDayMarkup).join('')}</div>` : `
          <div class="growth-empty"><span>日</span><h3>还没有阅读记录</h3><p>完成一次句子翻译、标记生词或保存精读后，这里会按日期显示你的学习进步。</p><button class="primary" data-view="articles">开始精读</button></div>`}
      </section>
      <aside class="level-panel growth-level-panel">
        <div class="section-title"><div><p class="eyebrow">CEFR</p><h2>阅读难度分布</h2></div></div>
        <div class="level-chart">
          ${levelCounts.map(item => `
            <div><span><b>${item.level}</b><small>${item.count} 篇</small></span><i><em style="width:${item.count / maxLevel * 100}%"></em></i></div>
          `).join('')}
        </div>
        <div class="growth-reading-tip"><span>本阶段观察</span><p>${growthObservation(levelCounts, translated, words.size, difficult)}</p></div>
      </aside>
    </div>
  `);
}

function articleStudyMetrics(article) {
  return {
    sentences: article.sentences.length,
    translated: article.sentences.filter(sentence => sentence.translation?.trim()).length,
    notes: article.sentences.filter(sentence => sentence.notes?.trim()).length,
    vocabulary: new Set(article.vocabulary.map(word => word.toLocaleLowerCase())).size,
    difficult: article.sentences.filter(sentence => sentence.difficult).length,
    completed: Boolean(article.completed),
  };
}

function localDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildGrowthTimeline() {
  const events = ui.activities.map(activity => ({ ...activity }));
  ui.articles.forEach(article => {
    if (events.some(event => event.articleId === article.id && event.type === 'study')) return;
    events.push({
      id: `legacy:${article.id}`,
      type: 'study',
      articleId: article.id,
      articleTitle: article.title,
      articleLevel: article.level,
      sourceName: article.documentName,
      occurredAt: article.updatedAt || article.createdAt,
      dateKey: localDayKey(article.updatedAt || article.createdAt),
      metrics: articleStudyMetrics(article),
      legacy: true,
    });
  });

  const previousByArticle = new Map();
  const enriched = events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).map(event => {
    if (event.type !== 'study') return event;
    const previous = previousByArticle.get(event.articleId) || { translated: 0, notes: 0, vocabulary: 0, difficult: 0, completed: false };
    const metrics = event.metrics || {};
    const gains = {
      translated: Math.max(0, (metrics.translated || 0) - (previous.translated || 0)),
      notes: Math.max(0, (metrics.notes || 0) - (previous.notes || 0)),
      vocabulary: Math.max(0, (metrics.vocabulary || 0) - (previous.vocabulary || 0)),
      difficult: Math.max(0, (metrics.difficult || 0) - (previous.difficult || 0)),
      completed: Boolean(metrics.completed && !previous.completed),
    };
    previousByArticle.set(event.articleId, metrics);
    return { ...event, gains };
  });

  const days = new Map();
  enriched.forEach(event => {
    const dateKey = event.dateKey || localDayKey(event.occurredAt);
    if (!days.has(dateKey)) days.set(dateKey, {
      dateKey,
      events: [],
      articles: new Map(),
      gains: { translated: 0, notes: 0, vocabulary: 0, difficult: 0, completed: 0, practices: 0 },
    });
    const day = days.get(dateKey);
    day.events.push(event);
    if (event.type === 'study') {
      const gains = event.gains || {};
      day.gains.translated += gains.translated || 0;
      day.gains.notes += gains.notes || 0;
      day.gains.vocabulary += gains.vocabulary || 0;
      day.gains.difficult += gains.difficult || 0;
      day.gains.completed += gains.completed ? 1 : 0;
      const existing = day.articles.get(event.articleId);
      day.articles.set(event.articleId, existing?.practice ? { ...event, practice: existing.practice } : event);
    }
    if (event.type === 'practice') {
      day.gains.practices += 1;
      const existing = day.articles.get(event.articleId) || event;
      day.articles.set(event.articleId, { ...existing, practice: event.practice });
    }
    if (event.type === 'created' && !day.articles.has(event.articleId)) day.articles.set(event.articleId, event);
  });
  return [...days.values()].map(day => ({ ...day, articles: [...day.articles.values()] })).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
}

function formatGrowthDate(dateKey) {
  const today = localDayKey();
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  if (dateKey === today) return '今天';
  if (dateKey === localDayKey(yesterdayDate)) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${dateKey}T12:00:00`));
}

function growthDayMarkup(day) {
  const badges = [
    day.gains.translated ? `＋${day.gains.translated} 句翻译` : '',
    day.gains.vocabulary ? `＋${day.gains.vocabulary} 个生词` : '',
    day.gains.difficult ? `＋${day.gains.difficult} 个长难句` : '',
    day.gains.notes ? `＋${day.gains.notes} 条笔记` : '',
    day.gains.completed ? `完成 ${day.gains.completed} 篇` : '',
    day.gains.practices ? `${day.gains.practices} 次默写` : '',
  ].filter(Boolean);
  return `<article class="growth-day">
    <header><div><time datetime="${day.dateKey}">${formatGrowthDate(day.dateKey)}</time><span>${day.dateKey}</span></div><b>${day.articles.length} 篇文章</b></header>
    <div class="growth-gains">${badges.length ? badges.map(badge => `<span>${badge}</span>`).join('') : '<span>建立了阅读记录</span>'}</div>
    <div class="growth-article-list">${day.articles.map(growthArticleMarkup).join('')}</div>
  </article>`;
}

function growthArticleMarkup(event) {
  const metrics = event.metrics || {};
  const progress = metrics.sentences ? Math.round((metrics.translated || 0) / metrics.sentences * 100) : 0;
  const details = [];
  if (event.type === 'created' || event.reason === 'created') details.push('建立精读文章');
  if (metrics.translated) details.push(`已翻译 ${metrics.translated}/${metrics.sentences} 句`);
  if (metrics.vocabulary) details.push(`积累 ${metrics.vocabulary} 个生词`);
  if (metrics.difficult) details.push(`训练 ${metrics.difficult} 个长难句`);
  if (event.practice) details.push(`默写 ${event.practice.correct}/${event.practice.total} 词正确`);
  if (metrics.completed) details.push('已完成精读');
  return `<div class="growth-article-row">
    <span class="level-badge">${esc(event.articleLevel || '—')}</span>
    <div><b>${esc(event.articleTitle || '未命名文章')}</b><p>${details.join(' · ') || '阅读并更新了这篇文章'}${event.legacy ? ' · 历史数据补录' : ''}</p></div>
    <em>${metrics.sentences ? `${progress}%` : '新建'}</em>
  </div>`;
}

function calculateReadingStreak(dayKeys) {
  const days = new Set(dayKeys);
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!days.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (days.has(localDayKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function growthObservation(levelCounts, translated, wordCount, difficultCount) {
  const activeLevels = levelCounts.filter(item => item.count).sort((a, b) => CEFR.indexOf(b.level) - CEFR.indexOf(a.level));
  if (!ui.articles.length) return '完成第一篇精读后，这里会根据翻译、词汇和长难句练习给出阶段性观察。';
  const level = activeLevels[0]?.level || 'B1';
  if (!translated) return `你已经开始阅读 ${level} 难度文章。下一步可以先完成几句中文翻译，让理解过程留下可比较的记录。`;
  if (!wordCount && !difficultCount) return `目前已完成 ${translated} 句翻译。接下来标记生词和长难句，会更清楚地看到词汇与句法能力的增长。`;
  return `你已经在 ${level} 难度文章中完成 ${translated} 句翻译，积累 ${wordCount} 个生词，并训练 ${difficultCount} 个长难句。保持按天记录，更容易看见稳定提升。`;
}

function webImportPage() {
  const page = ui.webPage;
  return shell(`
    <section class="web-import-heading">
      <div>
        <button class="back-button" data-view="library">← 返回书库</button>
        <p class="eyebrow">IMPORT FROM THE WEB</p>
        <h1>从网页选择精读文章</h1>
        <p>输入文章链接，载入清爽阅读版，再用鼠标选中需要精读的英文内容。</p>
      </div>
    </section>
    <section class="web-url-panel">
      <form data-web-load-form>
        <label for="webUrlInput">文章网址</label>
        <div><input id="webUrlInput" type="url" value="${esc(ui.webUrl)}" placeholder="https://example.com/article" required><button class="primary" type="submit" ${ui.webLoading ? 'disabled' : ''}>${ui.webLoading ? '正在读取…' : '读取网页'}</button></div>
        <small>点击“读取网页”即表示允许把这个公开网址发送给清爽阅读服务。不会发送你的 PDF、笔记或学习记录。</small>
      </form>
      ${ui.webError ? `<div class="web-import-error"><b>暂时无法读取这个网页</b><p>${esc(ui.webError)}</p><div>${ui.webUrl ? `<a href="${esc(ui.webUrl)}" target="_blank" rel="noopener noreferrer">打开原网页 ↗</a>` : ''}<button type="button" data-use-manual-web>手动粘贴正文</button></div></div>` : ''}
    </section>
    ${page ? `
      <div class="web-import-layout">
        <section class="web-reader-workbench">
          <header>
            <div><span>WEB READER</span><h2>${esc(page.title || '网页文章')}</h2><a href="${esc(page.url)}" target="_blank" rel="noopener noreferrer">访问原网页 ↗</a></div>
            <button class="primary" type="button" data-add-web-selection>＋ 加入选中文字</button>
          </header>
          <div class="web-selection-tip"><b>第一步：拖动鼠标选中文字</b><span>第二步：点击右上角“加入选中文字”。可分多次选择，顺序就是最终阅读顺序。</span></div>
          ${page.manual ? `<textarea class="web-manual-content" id="webManualContent" placeholder="在这里粘贴英文文章正文。可以选中其中一部分后加入，也可以不选择并加入全部内容。">${esc(page.manualText || '')}</textarea>` : `
            <article class="web-readable-content" id="webReadableContent">
              ${page.paragraphs.map((paragraph, index) => paragraph.heading
                ? `<h${Math.min(4, Math.max(2, paragraph.level || 2))} data-web-paragraph="${index}">${esc(paragraph.text)}</h${Math.min(4, Math.max(2, paragraph.level || 2))}>`
                : `<p data-web-paragraph="${index}">${esc(paragraph.text)}</p>`).join('')}
            </article>`}
        </section>
        <aside class="web-selection-panel">
          <div class="region-panel-head"><span>ARTICLE BUILDER</span><b>已选 ${ui.webSelections.length} 段</b></div>
          <label class="field-label">文章标题<input id="webArticleTitle" value="${esc(ui.webArticleTitle)}" placeholder="输入文章标题"></label>
          <label class="field-label">CEFR 难度<select id="webArticleLevel">${CEFR.map(level => `<option ${level === ui.webArticleLevel ? 'selected' : ''}>${level}</option>`).join('')}</select></label>
          <div class="web-selection-list">
            ${ui.webSelections.length ? ui.webSelections.map((selection, index) => `
              <article class="web-selection-item">
                <header><span>${String(index + 1).padStart(2, '0')}</span><div><button type="button" data-move-web-selection="${selection.id}:-1" title="向前移动">↑</button><button type="button" data-move-web-selection="${selection.id}:1" title="向后移动">↓</button><button type="button" data-remove-web-selection="${selection.id}" title="删除">×</button></div></header>
                <textarea data-web-selection-text="${selection.id}" aria-label="第 ${index + 1} 段网页正文">${esc(selection.text)}</textarea>
              </article>`).join('')
              : '<div class="region-empty"><span>⌁</span><b>尚未选择正文</b><p>在左侧文章中选中文字，再点击“加入选中文字”。</p></div>'}
          </div>
          <div class="region-actions">
            <button class="outline full" type="button" data-clear-web-selections ${ui.webSelections.length ? '' : 'disabled'}>清除全部</button>
            <button class="primary full" type="button" data-create-web-article ${ui.webSelections.length ? '' : 'disabled'}>生成逐句精读 <span>→</span></button>
          </div>
          <p class="privacy-note">正文、网址和学习结果仅保存在当前浏览器。请遵守来源网站的版权与使用规则。</p>
        </aside>
      </div>` : `
      <section class="web-import-placeholder">
        <span>⌁</span><h2>${ui.webLoading ? '正在整理网页文章…' : '等待输入文章链接'}</h2><p>${ui.webLoading ? '正在移除导航、广告和无关内容，请稍候。' : '支持公开英文文章；登录、付费或禁止读取的页面可能需要手动粘贴正文。'}</p>
      </section>`}
  `);
}

function importPage() {
  const document = ui.documents.find(item => item.id === ui.selectedDocumentId);
  if (!document) return libraryPage();
  const pageCount = Math.max(1, document.pageCount || ui.pdf?.numPages || 1);
  const previousDisabled = ui.page <= 1 ? 'disabled' : '';
  const nextDisabled = ui.page >= pageCount ? 'disabled' : '';
  const pager = (className = '') => `
    <div class="page-controls ${className}" aria-label="PDF 翻页">
      <button data-change-page="-1" ${previousDisabled} aria-label="上一页"><span aria-hidden="true">←</span><b>上一页</b></button>
      <label>第 <input data-page-number type="number" inputmode="numeric" min="1" max="${pageCount}" value="${ui.page}" aria-label="当前页码"> / ${pageCount} 页</label>
      <button data-change-page="1" ${nextDisabled} aria-label="下一页"><b>下一页</b><span aria-hidden="true">→</span></button>
    </div>`;
  return shell(`
    <section class="import-heading">
      <div>
        <button class="back-button" data-view="library">← 返回书库</button>
        <p class="eyebrow">SELECT ARTICLE REGIONS</p>
        <h1>${esc(document.name.replace(/\.pdf$/i, ''))}</h1>
      </div>
      ${pager('page-controls-top')}
    </section>

    <div class="import-layout">
      <section class="pdf-workbench">
        <div class="workbench-tip"><b>拖动鼠标框选正文</b><span>双栏文章请先框左栏，再框右栏；框选顺序就是阅读顺序。</span></div>
        <div class="canvas-pager">
          <span>PDF 原版页面</span>
          <div class="canvas-tools">
            ${ui.selectionFocus ? `
              <div class="zoom-controls" aria-label="页面缩放">
                <button data-pdf-zoom="-0.15" aria-label="缩小页面">−</button>
                <button data-pdf-fit aria-label="适应整页">适应整页</button>
                <button data-pdf-zoom="0.15" aria-label="放大页面">＋</button>
              </div>
            ` : ''}
            <button class="focus-toggle ${ui.selectionFocus ? 'active' : ''}" data-toggle-selection-focus>${ui.selectionFocus ? '退出全屏' : '全屏框选'}</button>
          </div>
          ${pager('page-controls-canvas')}
        </div>
        <div class="pdf-stage" id="pdfStage">
          <div class="loading-card" id="pdfLoading"><i></i><span>正在加载原版页面…</span></div>
          <canvas id="pdfCanvas"></canvas>
          <canvas id="selectionCanvas" aria-label="文章框选区域"></canvas>
        </div>
      </section>
      <aside class="region-panel">
        <div class="region-panel-head"><span>ARTICLE BUILDER</span><b>已选 ${ui.regions.length} 个区域</b></div>
        <label class="field-label">文章标题<input id="articleTitle" value="${esc(ui.articleTitle)}" placeholder="输入文章标题"></label>
        <label class="field-label">CEFR 难度<select id="articleLevel">${CEFR.map(level => `<option ${level === ui.articleLevel ? 'selected' : ''}>${level}</option>`).join('')}</select></label>
        <div class="region-list">
          ${ui.regions.length ? ui.regions.map((region, index) => `
            <article class="region-item">
              <header><span>${String(index + 1).padStart(2, '0')}</span><b>第 ${region.page} 页</b><div><button data-move-region="${region.id}:-1" title="向前移动">↑</button><button data-move-region="${region.id}:1" title="向后移动">↓</button><button data-remove-region="${region.id}" title="删除">×</button></div></header>
              <textarea data-region-text="${region.id}" aria-label="区域提取文字" placeholder="这个区域没有检测到文字。扫描版 PDF 可暂时手动粘贴文字。">${esc(region.text)}</textarea>
            </article>
          `).join('') : `
            <div class="region-empty"><span>⌗</span><b>尚未框选正文</b><p>在左侧原版页面上拖动，框住需要精读的文章内容。</p></div>
          `}
        </div>
        <div class="region-actions">
          <button class="outline full" data-clear-regions ${ui.regions.length ? '' : 'disabled'}>清除全部框选</button>
          <button class="primary full" data-create-article ${ui.regions.length ? '' : 'disabled'}>生成逐句精读 <span>→</span></button>
        </div>
        <p class="privacy-note">PDF、框选区域和提取结果仅保存在当前浏览器。飞书同步将在第二阶段接入。</p>
      </aside>
    </div>
  `);
}

function readerPage() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return articlesPage();
  const sentenceCount = article.sentences.length;
  ui.readerSentenceIndex = Math.max(0, Math.min(ui.readerSentenceIndex, Math.max(0, sentenceCount - 1)));
  const activeSentence = article.sentences[ui.readerSentenceIndex];
  const translated = article.sentences.filter(sentence => sentence.translation?.trim()).length;
  const progress = article.sentences.length ? Math.round(translated / article.sentences.length * 100) : 0;
  return shell(`
    <section class="reader-heading">
      <div><button class="back-button" data-view="articles">← 返回精读文章</button><p class="eyebrow">${esc(article.level)} · ${esc(article.documentName)}</p><h1>${esc(article.title)}</h1></div>
      <div class="reader-actions">${pomodoroMarkup()}<div class="reader-progress" aria-label="精读进度 ${progress}%"><div><span>精读进度</span><b>${progress}%</b></div><i><em style="width:${progress}%"></em></i></div><button class="outline reader-save-button" data-save-reader>保存</button><button class="primary reader-complete-button" data-complete-reader>${article.completed ? '已完成 ✓' : '完成精读'}</button></div>
    </section>
    <div class="reader-layout" style="--reader-split:${ui.readerSplit}%">
      <section class="source-pane">
        <header><span>ORIGINAL ${article.sourceType === 'web' ? 'WEBPAGE' : 'LAYOUT'}</span><b>${article.sourceType === 'web' ? '网页原文' : '原版页面'}</b><small>${article.regions.length} 个选区</small><button class="source-header-button" data-open-source-dialog>放大查看</button></header>
        <div class="source-gallery">
          ${article.regions.map((region, index) => sourceRegionMarkup(region, index)).join('')}
        </div>
      </section>
      <div class="reader-divider" data-reader-divider role="separator" aria-orientation="vertical" aria-label="调整原版页面和逐句精读的宽度" aria-valuemin="30" aria-valuemax="72" aria-valuenow="${Math.round(ui.readerSplit)}" tabindex="0"><span></span></div>
      <section class="sentence-pane">
        <header>
          <div><span>SENTENCE READING</span><b>逐句精读</b></div>
          <div class="sentence-pane-tools"><span>${sentenceCount ? `${ui.readerSentenceIndex + 1} / ${sentenceCount}` : '0 / 0'}</span><button class="text-button" data-add-sentence>＋ 添加句子</button></div>
        </header>
        <div class="vocabulary-strip">
          <b>生词 ${article.vocabulary.length}</b>
          <div>${article.vocabulary.length ? article.vocabulary.map(word => `<button data-remove-word="${esc(word)}">${esc(word)} ×</button>`).join('') : '<span>点击英文句子中的单词即可标记</span>'}</div>
        </div>
        <div class="sentence-deck">
          <div class="sentence-list ${ui.readerCardDirection === 'prev' ? 'from-left' : 'from-right'}">
            ${activeSentence ? sentenceCard(activeSentence, ui.readerSentenceIndex, article) : '<div class="sentence-deck-empty"><b>还没有句子</b><p>点击“添加句子”开始精读。</p></div>'}
          </div>
          <nav class="sentence-navigation" aria-label="逐句切换">
            <button type="button" data-reader-sentence="-1" ${ui.readerSentenceIndex <= 0 ? 'disabled' : ''}><span>←</span><b>上一句</b></button>
            <div><span>阅读进度</span><i><em style="width:${sentenceCount ? (ui.readerSentenceIndex + 1) / sentenceCount * 100 : 0}%"></em></i><b>${sentenceCount ? `第 ${ui.readerSentenceIndex + 1} 句，共 ${sentenceCount} 句` : '等待添加句子'}</b></div>
            <button type="button" class="next" data-reader-sentence="1" ${ui.readerSentenceIndex >= sentenceCount - 1 ? 'disabled' : ''}><b>下一句</b><span>→</span></button>
          </nav>
        </div>
      </section>
    </div>
    ${reconstructionSidebarMarkup(article)}
    ${ui.sourceDialog ? sourceDialogMarkup(article) : ''}
    ${ui.wordDialog ? wordDialogMarkup(article) : ''}
  `);
}

function pomodoroMarkup() {
  const minutes = Math.floor(ui.pomodoroRemaining / 60);
  const seconds = ui.pomodoroRemaining % 60;
  const time = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const label = ui.pomodoroMode === 'focus' ? '专注' : '休息';
  return `<div class="pomodoro-widget" tabindex="0" aria-label="番茄时钟，${label}${time}">
    <div class="pomodoro-main"><span aria-hidden="true">◷</span><div><small>${label}</small><b data-pomodoro-time>${time}</b></div></div>
    <div class="pomodoro-actions"><button type="button" data-pomodoro-toggle>${ui.pomodoroRunning ? '暂停' : '开始'}</button><button type="button" data-pomodoro-reset>重置</button></div>
    <aside class="pomodoro-tooltip" role="tooltip"><b>什么是番茄时钟？</b><p>用 25 分钟专注精读，再休息 5 分钟。短时段可以减少分心，让阅读更容易坚持。</p><small>当前阶段：${label} · ${ui.pomodoroMode === 'focus' ? '25' : '5'} 分钟</small></aside>
  </div>`;
}

function reconstructionSidebarMarkup(article) {
  const difficultSentences = article.sentences.filter(sentence => sentence.difficult);
  const selected = difficultSentences.find(sentence => sentence.id === ui.reconstructionDialogSentenceId) || difficultSentences[0];
  return `
    <button type="button" class="reconstruction-rail-button ${ui.reconstructionDrawerOpen ? 'is-open' : ''}" data-open-reconstruction-drawer aria-label="打开长难句默写" aria-expanded="${ui.reconstructionDrawerOpen}">
      <span>长难句默写</span><b>${difficultSentences.length}</b>
    </button>
    ${ui.difficultHintVisible ? `
      <aside class="difficult-hint" role="status">
        <button type="button" data-close-difficult-hint aria-label="关闭提示">×</button>
        <b>长难句已加入默写练习</b>
        <p>练习入口在页面右侧的“长难句默写”。</p>
        <label><input type="checkbox" data-disable-difficult-hint> 不再提示</label>
      </aside>` : ''}
    ${ui.reconstructionDrawerOpen ? `
      <button type="button" class="reconstruction-drawer-backdrop" data-close-reconstruction-drawer aria-label="关闭长难句默写"></button>
      <aside class="reconstruction-drawer reconstruction-list-drawer" aria-label="长难句默写侧边栏">
        <header><div><span>FINAL PRACTICE</span><h2>长难句列表</h2></div><button type="button" data-close-reconstruction-drawer>关闭 ×</button></header>
        <nav class="difficult-sentence-list" aria-label="选择长难句">
          <div><b>选择一句开始默写</b><span>${difficultSentences.length} 句</span></div>
          ${difficultSentences.length ? difficultSentences.map((sentence, index) => `
            <button type="button" class="${sentence.id === selected?.id ? 'active' : ''}" data-open-reconstruction-practice="${sentence.id}">
              <span>${String(index + 1).padStart(2, '0')}</span><b>${esc(sentence.referenceTranslation?.trim() || '正在生成参考译文…')}</b><small>${sentence.reconstructionWords?.some(Boolean) ? '继续练习 →' : '开始默写 →'}</small>
            </button>`).join('') : '<div class="drawer-empty"><span>译</span><b>还没有长难句</b><p>先在逐句精读中标记句子。</p></div>'}
        </nav>
      </aside>` : ''}
    ${ui.reconstructionPracticeOpen && selected ? reconstructionPracticeDialogMarkup(selected, difficultSentences) : ''}`;
}

function reconstructionPracticeDialogMarkup(sentence, difficultSentences) {
  const index = difficultSentences.findIndex(item => item.id === sentence.id);
  return `
    <dialog class="reconstruction-practice-dialog" id="reconstructionPracticeDialog" data-reconstruction-practice="${sentence.id}">
      <header><div><span>DIFFICULT SENTENCE ${String(index + 1).padStart(2, '0')}</span><h2>长难句默写</h2></div><button type="button" data-close-reconstruction-practice>关闭 ×</button></header>
      ${reconstructionPracticeMarkup(sentence)}
    </dialog>`;
}

function reconstructionPracticeMarkup(sentence) {
  const generation = ui.translationGeneration.get(sentence.id);
  const checked = ui.practiceRevealIds.has(sentence.id);
  const reference = sentence.referenceTranslation?.trim() || '';
  const expectedWords = sentence.text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
  const savedWords = sentence.reconstructionWords || String(sentence.backTranslation || '').match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
  const correctCount = checked ? expectedWords.filter((word, index) => normalizePracticeWord(word) === normalizePracticeWord(savedWords[index])).length : 0;
  return `
      <div class="reconstruction-practice-body">
        <section class="dialog-chinese-prompt">
          <span>中文参考译文</span>
          ${reference ? `<p>${esc(reference)}</p>` : generation?.status === 'loading'
            ? '<p class="reference-loading"><i></i>正在生成中文参考译文…</p>'
            : `<button type="button" class="text-button" data-generate-reference="${sentence.id}">${generation?.status === 'error' ? '生成失败，点击重试' : '生成中文参考译文'}</button>`}
        </section>
        <section class="word-slot-practice">
          <div class="word-slot-heading"><span>根据中文写出英文</span><small>${expectedWords.length} 个单词</small></div>
          <div class="word-slots">
            ${expectedWords.map((expected, index) => {
              const answer = savedWords[index] || '';
              const state = checked ? (normalizePracticeWord(answer) === normalizePracticeWord(expected) ? 'is-correct' : 'is-wrong') : '';
              const width = Math.max(5, Math.min(15, expected.length + 2));
              return `<label class="word-slot ${state}" style="--slot-width:${width}ch"><input data-reconstruction-word="${index}" value="${esc(answer)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="第 ${index + 1} 个英文单词"><span>${String(index + 1).padStart(2, '0')}</span>${checked && state === 'is-wrong' ? `<small>${esc(expected)}</small>` : ''}</label>`;
            }).join('')}
          </div>
          <p class="slot-tip">输入一个单词后按空格可跳到下一格；也可以直接粘贴整句。</p>
        </section>
        ${checked ? `<section class="standard-answer"><div><span>核对结果</span><b>${correctCount} / ${expectedWords.length} 个单词正确</b></div><p>${esc(sentence.text)}</p></section>` : ''}
      </div>
      <footer class="reconstruction-practice-footer">
        <small>红色表示错误或漏词；重新输入时提示会自动收起。</small>
        <div class="reconstruction-practice-actions">
          <button type="button" class="outline" data-redo-reconstruction="${sentence.id}">重做</button>
          <button type="button" class="primary" data-check-reconstruction="${sentence.id}">${checked ? '重新查验' : '查验标准原文'}</button>
        </div>
      </footer>`;
}

function normalizePracticeWord(value) {
  return String(value || '').trim().toLowerCase().replace(/’/g, "'");
}

function wordDialogMarkup(article) {
  const state = ui.wordDialog;
  const key = state.word.toLowerCase();
  const note = article.wordNotes?.[key] || '';
  const definition = state.definition;
  return `
    <dialog class="word-dialog" id="wordDialog">
      <header>
        <div><span>VOCABULARY</span><h2>${esc(state.word)}</h2>${definition?.phonetic ? `<p>${esc(definition.phonetic)}</p>` : ''}</div>
        <div class="word-dialog-head-actions">
          <b>已标记生词</b>
          ${definition ? `<button type="button" class="word-audio-button" data-speak-word="${esc(state.word)}">▶ 发音</button>` : ''}
          <button type="button" class="word-dialog-close" data-close-word-dialog aria-label="关闭单词释义">关闭 ×</button>
        </div>
      </header>
      <div class="word-dialog-content">
        ${state.status === 'loading' ? `<div class="word-loading"><i></i><b>正在查询词典…</b><p>生词标记已经保存。</p></div>` : ''}
        ${state.status === 'error' ? `<div class="word-error"><b>暂时无法获取在线词典</b><p>${esc(state.error || '请检查网络后重新打开。你仍然可以填写中文释义。')}</p><button type="button" class="outline" data-retry-word>重新查询</button></div>` : ''}
        ${definition ? `
          <div class="word-bilingual-dictionary">
            ${ecdictSectionMarkup(definition.chinese)}
            <section class="word-dictionary-section word-english-dictionary">
              <div class="word-section-title"><span>英文词典</span><b>DATAMUSE</b></div>
              <div class="word-meanings">
                ${definition.meanings.map(meaning => `
                  <section>
                    <h3>${esc(meaning.partOfSpeech || '释义')}</h3>
                    <ol>${meaning.definitions.map(item => `<li><p>${esc(item.definition)}</p>${item.example ? `<small>例句：${esc(item.example)}</small>` : ''}</li>`).join('')}</ol>
                    ${meaning.synonyms?.length ? `<div><span>关联词</span>${meaning.synonyms.map(item => `<button type="button" data-related-word="${esc(item)}">${esc(item)}</button>`).join('')}</div>` : ''}
                  </section>`).join('')}
                ${definition.origin ? `<details><summary>词源信息</summary><p>${esc(definition.origin)}</p></details>` : ''}
              </div>
            </section>
            <p class="dictionary-source">释义来源：${esc(definition.source || '词典服务')} · 已保存到本地缓存</p>
          </div>` : ''}
        <label class="word-chinese-note"><span>我的中文笔记</span><textarea id="wordChineseNote" placeholder="写下适合本文语境的中文意思或记忆提示…">${esc(note)}</textarea></label>
      </div>
      <footer><small>再次点击单词不会取消生词；请在上方生词列表中点“×”移除。</small><div><button type="button" class="outline" data-close-word-dialog>关闭</button><button type="button" class="primary" data-save-word-note>保存释义</button></div></footer>
    </dialog>`;
}

function ecdictSectionMarkup(entry) {
  if (!entry) return `<section class="word-dictionary-section word-chinese-dictionary"><div class="word-section-title"><span>中文释义</span><b>待补充</b></div><p class="dictionary-empty">暂未找到中文释义，可以在下方填写适合本文语境的中文笔记。</p></section>`;
  const lines = String(entry.translation || '').split(/\n+/).map(item => item.trim()).filter(Boolean);
  const tagNames = { zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研', ielts: '雅思', toefl: '托福', gre: 'GRE' };
  const tags = String(entry.tag || '').split(/\s+/).map(tag => tagNames[tag.toLowerCase()] || '').filter(Boolean);
  if (Number(entry.oxford)) tags.unshift('牛津核心词');
  if (Number(entry.collins) > 0) tags.unshift(`柯林斯 ${entry.collins} 星`);
  const exchangeNames = { p: '过去式', d: '过去分词', i: '现在分词', 3: '第三人称单数', r: '比较级', t: '最高级', s: '复数', 0: '词根', 1: '原形' };
  const exchanges = String(entry.exchange || '').split('/').map(item => {
    const [code, ...value] = item.split(':');
    return value.length ? { label: exchangeNames[code] || code, value: value.join(':') } : null;
  }).filter(Boolean);
  return `
    <section class="word-dictionary-section word-chinese-dictionary">
      <div class="word-section-title"><span>中文释义</span><b>${esc(entry.source || 'ECDICT')}</b></div>
      ${lines.length ? `<ul class="chinese-definition-list">${lines.map(line => `<li>${esc(line)}</li>`).join('')}</ul>` : '<p class="dictionary-empty">暂无中文释义。</p>'}
      ${tags.length ? `<div class="word-meta-tags">${[...new Set(tags)].map(tag => `<span>${esc(tag)}</span>`).join('')}</div>` : ''}
      ${exchanges.length ? `<details class="word-exchange"><summary>词形变化</summary><div>${exchanges.map(item => `<span><small>${esc(item.label)}</small>${esc(item.value)}</span>`).join('')}</div></details>` : ''}
    </section>`;
}

function sentenceCard(sentence, index, article) {
  const difficult = sentence.difficult ? 'difficult' : '';
  const checkOpen = ui.translationCheckIds.has(sentence.id);
  const reference = sentence.referenceTranslation || '';
  const generation = ui.translationGeneration.get(sentence.id);
  return `
    <article class="sentence-card ${difficult}" data-sentence-id="${sentence.id}">
      <header><span>${String(index + 1).padStart(2, '0')}</span><button data-toggle-difficult="${sentence.id}">${sentence.difficult ? '◆ 已标记长难句' : '◇ 标记长难句'}</button></header>
      <p class="sentence-text">${tokenize(sentence.text).map(token => /^[A-Za-z]/.test(token)
        ? `<button class="${article.vocabulary.some(word => word.toLowerCase() === token.toLowerCase()) ? 'marked' : ''}" data-word="${esc(token)}">${esc(token)}</button>`
        : esc(token)).join('')}</p>
      <label>中文翻译<textarea data-translation placeholder="写下你对这句话的理解…">${esc(sentence.translation || '')}</textarea></label>
      <label>语法或阅读笔记<input data-notes value="${esc(sentence.notes || '')}" placeholder="可选：句子结构、语法现象或疑问"></label>
      <section class="translation-check ${checkOpen ? 'is-open' : ''}">
        <button type="button" class="translation-check-toggle" data-toggle-translation-check="${sentence.id}">
          <span>${generation?.status === 'loading' ? '正在生成参考译文…' : '参考译文'}</span><b>${checkOpen ? '收起 −' : '查看 +'}</b>
        </button>
        ${checkOpen ? `
          <div class="translation-check-body">
            <label class="reference-translation-only"><span>参考译文</span><textarea data-reference-translation placeholder="正在等待生成，也可以直接填写…" ${generation?.status === 'loading' ? 'aria-busy="true"' : ''}>${esc(reference)}</textarea></label>
            ${generation?.status === 'loading' ? '<p class="translation-generating"><i></i>在线翻译正在生成，首次使用可能需要几秒钟。</p>' : ''}
            ${generation?.status === 'error' ? `<p class="translation-generation-error">${esc(generation.error)}</p>` : ''}
            <footer><small>MyMemory 在线生成 · 结果仅供核对，可修改。</small><div><button type="button" class="text-button" data-generate-reference="${sentence.id}" ${generation?.status === 'loading' ? 'disabled' : ''}>${reference ? '重新生成' : generation?.status === 'error' ? '重试生成' : '立即生成'}</button><button type="button" class="outline" data-save-reference="${sentence.id}" ${generation?.status === 'loading' ? 'disabled' : ''}>保存参考译文</button></div></footer>
          </div>` : ''}
      </section>
      <details><summary>校对识别文字</summary><textarea data-sentence-text>${esc(sentence.text)}</textarea></details>
    </article>
  `;
}

function tokenize(text) {
  return String(text).split(/([A-Za-z]+(?:['’\-][A-Za-z]+)*)/g).filter(Boolean);
}

function emptyState(icon, title, message, action = '') {
  return `<div class="empty-state"><span>${icon}</span><h2>${title}</h2><p>${message}</p>${action}</div>`;
}

function render() {
  const pages = {
    library: libraryPage,
    articles: articlesPage,
    growth: growthPage,
    webImport: webImportPage,
    import: importPage,
    reader: readerPage,
  };
  document.body.classList.toggle('selection-focus-mode', ui.view === 'import' && ui.selectionFocus);
  document.querySelector('#app').innerHTML = (pages[ui.view] || libraryPage)();
  bind();
  if (ui.view === 'import') requestAnimationFrame(mountPdfEditor);
}

function bind() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    ui.view = button.dataset.view;
    ui.selectedArticleId = null;
    ui.sourceDialog = false;
    ui.sourcePreviewArticleId = null;
    ui.articleEditId = null;
    ui.wordDialog = null;
    render();
  }));

  document.querySelector('[data-web-load-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    loadWebArticle(document.querySelector('#webUrlInput')?.value);
  });
  document.querySelector('#webUrlInput')?.addEventListener('input', event => { ui.webUrl = event.currentTarget.value; });
  document.querySelector('[data-use-manual-web]')?.addEventListener('click', useManualWebImport);
  document.querySelector('[data-add-web-selection]')?.addEventListener('click', addWebSelection);
  document.querySelectorAll('[data-remove-web-selection]').forEach(button => button.addEventListener('click', () => {
    collectWebSelectionText();
    ui.webSelections = ui.webSelections.filter(item => item.id !== button.dataset.removeWebSelection);
    render();
  }));
  document.querySelectorAll('[data-move-web-selection]').forEach(button => button.addEventListener('click', () => {
    const [id, direction] = button.dataset.moveWebSelection.split(':');
    moveWebSelection(id, Number(direction));
  }));
  document.querySelector('[data-clear-web-selections]')?.addEventListener('click', () => {
    ui.webSelections = [];
    render();
  });
  document.querySelector('[data-create-web-article]')?.addEventListener('click', createWebArticle);
  document.querySelector('#webArticleTitle')?.addEventListener('input', event => { ui.webArticleTitle = event.currentTarget.value; });
  document.querySelector('#webArticleLevel')?.addEventListener('change', event => { ui.webArticleLevel = event.currentTarget.value; });

  document.querySelectorAll('[data-pdf-input]').forEach(input => input.addEventListener('change', event => {
    const [file] = event.target.files;
    if (file) importPdf(file);
  }));
  document.querySelector('[data-trigger-pdf-upload]')?.addEventListener('click', () => {
    document.querySelector('.resource-upload-menu [data-pdf-input]')?.click();
  });
  document.querySelector('[data-export-library]')?.addEventListener('click', exportLibraryBackup);
  document.querySelector('[data-import-library]')?.addEventListener('change', event => {
    const [file] = event.target.files;
    if (file) importLibraryBackup(file);
  });

  const dropZone = document.querySelector('#dropZone');
  dropZone?.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone?.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
    const file = [...event.dataTransfer.files].find(item => item.type === 'application/pdf' || item.name.toLowerCase().endsWith('.pdf'));
    if (file) importPdf(file);
  });

  document.querySelectorAll('[data-open-document]').forEach(button => button.addEventListener('click', () => openDocument(button.dataset.openDocument)));
  document.querySelector('#librarySearch')?.addEventListener('input', event => {
    const caret = event.currentTarget.selectionStart;
    ui.libraryQuery = event.currentTarget.value;
    render();
    const input = document.querySelector('#librarySearch');
    input?.focus();
    input?.setSelectionRange(caret, caret);
  });
  document.querySelector('#librarySort')?.addEventListener('change', event => {
    ui.librarySort = event.currentTarget.value;
    render();
  });
  document.querySelector('[data-favorite-filter]')?.addEventListener('click', () => {
    ui.favoriteOnly = !ui.favoriteOnly;
    render();
  });
  document.querySelectorAll('[data-favorite-document]').forEach(button => button.addEventListener('click', () => toggleFavorite(button.dataset.favoriteDocument)));
  document.querySelectorAll('[data-rename-document]').forEach(button => button.addEventListener('click', () => {
    ui.documentDialog = { type: 'rename', id: button.dataset.renameDocument };
    render();
  }));
  document.querySelectorAll('[data-delete-document]').forEach(button => button.addEventListener('click', () => {
    ui.documentDialog = { type: 'delete', id: button.dataset.deleteDocument };
    render();
  }));
  document.querySelectorAll('[data-download-document]').forEach(button => button.addEventListener('click', () => downloadDocument(button.dataset.downloadDocument)));
  document.querySelectorAll('[data-close-document-dialog]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    ui.documentDialog = null;
    render();
  }));
  document.querySelector('[data-rename-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    renameDocument(ui.documentDialog?.id, document.querySelector('#renameDocumentInput')?.value);
  });
  document.querySelector('[data-delete-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    deleteDocument(ui.documentDialog?.id, Boolean(document.querySelector('#deleteRelatedArticles')?.checked));
  });
  const documentModal = document.querySelector('#documentDialog');
  if (documentModal && !documentModal.open) {
    documentModal.addEventListener('cancel', event => {
      event.preventDefault();
      ui.documentDialog = null;
      render();
    });
    documentModal.showModal();
    document.querySelector('#renameDocumentInput')?.focus();
  }
  document.querySelectorAll('[data-open-article]').forEach(button => button.addEventListener('click', () => {
    ui.selectedArticleId = button.dataset.openArticle;
    ui.selectedListArticleId = button.dataset.openArticle;
    ui.sourceDialog = false;
    ui.sourcePreviewArticleId = null;
    ui.wordDialog = null;
    ui.readerSentenceIndex = 0;
    ui.readerCardDirection = 'next';
    ui.view = 'reader';
    render();
  }));

  const openArticleSource = articleId => {
    ui.selectedListArticleId = articleId;
    ui.sourcePreviewArticleId = articleId;
    ui.sourceDialog = true;
    render();
  };
  document.querySelectorAll('[data-preview-article-button]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    openArticleSource(button.dataset.previewArticleButton);
  }));
  document.querySelectorAll('.article-record[data-preview-article]').forEach(record => {
    record.addEventListener('click', event => {
      if (event.target.closest('button, a, input, select, textarea')) return;
      openArticleSource(record.dataset.previewArticle);
    });
    record.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key) || event.target !== record) return;
      event.preventDefault();
      openArticleSource(record.dataset.previewArticle);
    });
  });
  document.querySelectorAll('[data-edit-article]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    ui.selectedListArticleId = button.dataset.editArticle;
    ui.articleEditId = button.dataset.editArticle;
    render();
  }));
  document.querySelectorAll('[data-close-article-edit]').forEach(button => button.addEventListener('click', () => {
    ui.articleEditId = null;
    render();
  }));
  document.querySelector('[data-article-edit-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    saveArticleEdits(
      ui.articleEditId,
      document.querySelector('#editArticleTitle')?.value,
      document.querySelector('#editArticleLevel')?.value,
      document.querySelector('#editArticleContent')?.value,
    );
  });
  const articleEditModal = document.querySelector('#articleEditDialog');
  if (articleEditModal && !articleEditModal.open) {
    articleEditModal.addEventListener('cancel', event => {
      event.preventDefault();
      ui.articleEditId = null;
      render();
    });
    articleEditModal.showModal();
    document.querySelector('#editArticleTitle')?.focus();
  }

  document.querySelectorAll('[data-change-page]').forEach(button => button.addEventListener('click', () => changePage(Number(button.dataset.changePage))));
  document.querySelector('[data-toggle-selection-focus]')?.addEventListener('click', () => {
    collectRegionText();
    ui.selectionFocus = !ui.selectionFocus;
    ui.pdfZoom = 1;
    render();
  });
  document.querySelectorAll('[data-pdf-zoom]').forEach(button => button.addEventListener('click', () => {
    ui.pdfZoom = Math.max(.55, Math.min(2.2, ui.pdfZoom + Number(button.dataset.pdfZoom)));
    render();
  }));
  document.querySelector('[data-pdf-fit]')?.addEventListener('click', () => {
    ui.pdfZoom = 1;
    render();
  });
  document.querySelectorAll('[data-page-number]').forEach(input => {
    input.addEventListener('change', event => goToPage(Number(event.target.value)));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        goToPage(Number(event.currentTarget.value));
      }
    });
  });

  document.onkeydown = event => {
    if (event.key === 'Escape' && ui.reconstructionPracticeOpen) return;
    if (event.key === 'Escape' && ui.reconstructionDrawerOpen) {
      event.preventDefault();
      closeReconstructionDrawer();
      return;
    }
    if (ui.view === 'reader' && !ui.reconstructionDrawerOpen && !event.altKey && !event.metaKey && !event.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        changeReaderSentence(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        changeReaderSentence(1);
        return;
      }
    }
    if (ui.view !== 'import' || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Escape' && ui.selectionFocus) {
      ui.selectionFocus = false;
      ui.pdfZoom = 1;
      render();
      return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    if (event.key === 'ArrowLeft') changePage(-1);
    if (event.key === 'ArrowRight') changePage(1);
  };

  document.querySelectorAll('[data-remove-region]').forEach(button => button.addEventListener('click', () => {
    collectRegionText();
    ui.regions = ui.regions.filter(region => region.id !== button.dataset.removeRegion);
    normalizeRegionOrder();
    render();
  }));
  document.querySelectorAll('[data-move-region]').forEach(button => button.addEventListener('click', () => {
    collectRegionText();
    const [id, direction] = button.dataset.moveRegion.split(':');
    moveRegion(id, Number(direction));
  }));
  document.querySelector('[data-clear-regions]')?.addEventListener('click', () => {
    ui.regions = [];
    render();
  });
  document.querySelector('[data-create-article]')?.addEventListener('click', createArticle);
  document.querySelector('#articleTitle')?.addEventListener('input', event => { ui.articleTitle = event.target.value; });
  document.querySelector('#articleLevel')?.addEventListener('change', event => { ui.articleLevel = event.target.value; });

  document.querySelectorAll('[data-word]').forEach(button => button.addEventListener('click', () => openWordDefinition(button.dataset.word)));
  document.querySelectorAll('[data-remove-word]').forEach(button => button.addEventListener('click', () => toggleWord(button.dataset.removeWord)));
  document.querySelectorAll('[data-toggle-difficult]').forEach(button => button.addEventListener('click', () => toggleDifficult(button.dataset.toggleDifficult)));
  document.querySelectorAll('[data-toggle-translation-check]').forEach(button => button.addEventListener('click', () => {
    const article = ui.articles.find(item => item.id === ui.selectedArticleId);
    if (article) collectReader(article);
    const sentenceId = button.dataset.toggleTranslationCheck;
    const opening = !ui.translationCheckIds.has(sentenceId);
    opening ? ui.translationCheckIds.add(sentenceId) : ui.translationCheckIds.delete(sentenceId);
    render();
    const sentence = article?.sentences.find(item => item.id === sentenceId);
    if (opening && !sentence?.referenceTranslation?.trim()) generateReferenceTranslation(sentenceId);
  }));
  document.querySelectorAll('[data-generate-reference]').forEach(button => button.addEventListener('click', () => generateReferenceTranslation(button.dataset.generateReference, true)));
  document.querySelectorAll('[data-save-reference]').forEach(button => button.addEventListener('click', () => saveReferenceTranslation(button.dataset.saveReference)));
  document.querySelector('[data-open-reconstruction-drawer]')?.addEventListener('click', openReconstructionDrawer);
  document.querySelectorAll('[data-close-reconstruction-drawer]').forEach(button => button.addEventListener('click', closeReconstructionDrawer));
  document.querySelectorAll('[data-open-reconstruction-practice]').forEach(button => button.addEventListener('click', () => openReconstructionPractice(button.dataset.openReconstructionPractice)));
  document.querySelectorAll('[data-close-reconstruction-practice]').forEach(button => button.addEventListener('click', closeReconstructionPractice));
  document.querySelectorAll('[data-check-reconstruction]').forEach(button => button.addEventListener('click', () => checkReconstructionWords(button.dataset.checkReconstruction)));
  document.querySelectorAll('[data-redo-reconstruction]').forEach(button => button.addEventListener('click', () => redoReconstruction(button.dataset.redoReconstruction)));
  document.querySelector('[data-close-difficult-hint]')?.addEventListener('click', () => hideDifficultHint());
  document.querySelector('[data-disable-difficult-hint]')?.addEventListener('change', event => {
    if (!event.target.checked) return;
    localStorage.setItem('readquest-hide-difficult-hint', '1');
    hideDifficultHint();
  });
  bindReconstructionInputs();
  const reconstructionPracticeDialog = document.querySelector('#reconstructionPracticeDialog');
  if (reconstructionPracticeDialog && !reconstructionPracticeDialog.open) {
    reconstructionPracticeDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeReconstructionPractice();
    });
    reconstructionPracticeDialog.showModal();
    reconstructionPracticeDialog.querySelector('[data-reconstruction-word]')?.focus();
  }
  document.querySelectorAll('[data-open-source-dialog]').forEach(button => button.addEventListener('click', () => {
    const article = ui.articles.find(item => item.id === ui.selectedArticleId);
    if (article) collectReader(article);
    ui.sourcePreviewArticleId = ui.selectedArticleId;
    ui.sourceDialog = true;
    render();
  }));
  document.querySelector('[data-close-source-dialog]')?.addEventListener('click', () => {
    ui.sourceDialog = false;
    ui.sourcePreviewArticleId = null;
    render();
  });
  const sourceDialog = document.querySelector('#sourceDialog');
  if (sourceDialog && !sourceDialog.open) {
    sourceDialog.addEventListener('cancel', event => {
      event.preventDefault();
      ui.sourceDialog = false;
      ui.sourcePreviewArticleId = null;
      render();
    });
    sourceDialog.showModal();
  }
  document.querySelectorAll('[data-close-word-dialog]').forEach(button => button.addEventListener('click', closeWordDialog));
  document.querySelector('[data-save-word-note]')?.addEventListener('click', saveWordNote);
  document.querySelector('[data-retry-word]')?.addEventListener('click', () => loadWordDefinition(ui.wordDialog?.word, true));
  document.querySelectorAll('[data-related-word]').forEach(button => button.addEventListener('click', () => openWordDefinition(button.dataset.relatedWord)));
  document.querySelector('[data-play-word-audio]')?.addEventListener('click', event => {
    const audio = new Audio(event.currentTarget.dataset.playWordAudio);
    audio.play().catch(() => toast('暂时无法播放单词发音。', true));
  });
  document.querySelector('[data-speak-word]')?.addEventListener('click', event => {
    if (!('speechSynthesis' in window)) return toast('当前浏览器暂不支持单词发音。', true);
    const utterance = new SpeechSynthesisUtterance(event.currentTarget.dataset.speakWord);
    utterance.lang = 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
  const wordDialog = document.querySelector('#wordDialog');
  if (wordDialog && !wordDialog.open) {
    wordDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeWordDialog();
    });
    wordDialog.showModal();
  }
  const readerDivider = document.querySelector('[data-reader-divider]');
  const readerLayout = document.querySelector('.reader-layout');
  if (readerDivider && readerLayout) {
    const updateSplit = clientX => {
      const bounds = readerLayout.getBoundingClientRect();
      const next = Math.max(30, Math.min(72, (clientX - bounds.left) / bounds.width * 100));
      ui.readerSplit = next;
      readerLayout.style.setProperty('--reader-split', `${next}%`);
      readerDivider.setAttribute('aria-valuenow', String(Math.round(next)));
    };
    readerDivider.addEventListener('pointerdown', event => {
      event.preventDefault();
      readerDivider.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-reader');
    });
    readerDivider.addEventListener('pointermove', event => {
      if (readerDivider.hasPointerCapture(event.pointerId)) updateSplit(event.clientX);
    });
    readerDivider.addEventListener('pointerup', event => {
      if (readerDivider.hasPointerCapture(event.pointerId)) readerDivider.releasePointerCapture(event.pointerId);
      document.body.classList.remove('resizing-reader');
    });
    readerDivider.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      ui.readerSplit = Math.max(30, Math.min(72, ui.readerSplit + (event.key === 'ArrowLeft' ? -3 : 3)));
      readerLayout.style.setProperty('--reader-split', `${ui.readerSplit}%`);
      readerDivider.setAttribute('aria-valuenow', String(Math.round(ui.readerSplit)));
    });
  }
  document.querySelector('[data-save-reader]')?.addEventListener('click', () => saveReader(false));
  document.querySelector('[data-complete-reader]')?.addEventListener('click', () => saveReader(true));
  document.querySelector('[data-pomodoro-toggle]')?.addEventListener('click', togglePomodoro);
  document.querySelector('[data-pomodoro-reset]')?.addEventListener('click', resetPomodoro);
  document.querySelector('[data-add-sentence]')?.addEventListener('click', addSentence);
  document.querySelectorAll('[data-reader-sentence]').forEach(button => button.addEventListener('click', () => changeReaderSentence(Number(button.dataset.readerSentence))));
  if (ui.view === 'reader') queueMissingDifficultTranslations();
}

function queueMissingDifficultTranslations() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const next = article?.sentences.find(sentence => sentence.difficult && !sentence.referenceTranslation?.trim() && !ui.translationGeneration.has(sentence.id));
  if (next) generateReferenceTranslation(next.id);
}

async function recordStudySnapshot(article, reason = 'progress') {
  const occurredAt = new Date().toISOString();
  const dateKey = localDayKey(occurredAt);
  const activity = {
    id: `${dateKey}:study:${article.id}`,
    type: 'study',
    reason,
    articleId: article.id,
    articleTitle: article.title,
    articleLevel: article.level,
    sourceName: article.documentName,
    occurredAt,
    dateKey,
    metrics: articleStudyMetrics(article),
  };
  await records.put('activities', activity);
  ui.activities = [activity, ...ui.activities.filter(item => item.id !== activity.id)].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

async function recordPracticeResult(article, sentence, correct, total) {
  const occurredAt = new Date().toISOString();
  const dateKey = localDayKey(occurredAt);
  const id = `${dateKey}:practice:${article.id}:${sentence.id}`;
  const previous = ui.activities.find(item => item.id === id);
  const bestCorrect = Math.max(correct, previous?.practice?.correct || 0);
  const activity = {
    id,
    type: 'practice',
    articleId: article.id,
    articleTitle: article.title,
    articleLevel: article.level,
    sourceName: article.documentName,
    occurredAt,
    dateKey,
    practice: { correct: bestCorrect, total },
  };
  await records.put('activities', activity);
  ui.activities = [activity, ...ui.activities.filter(item => item.id !== id)].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

async function changeReaderSentence(direction) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article || !direction) return;
  collectReader(article);
  const nextIndex = Math.max(0, Math.min(article.sentences.length - 1, ui.readerSentenceIndex + direction));
  if (nextIndex === ui.readerSentenceIndex) return;
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await recordStudySnapshot(article);
  ui.readerCardDirection = direction < 0 ? 'prev' : 'next';
  ui.readerSentenceIndex = nextIndex;
  render();
  document.querySelector('.sentence-list')?.scrollTo({ top: 0 });
}

async function loadWebArticle(urlValue) {
  let url;
  try {
    url = new URL(String(urlValue || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    return toast('请输入完整的 http:// 或 https:// 文章网址。', true);
  }
  ui.webUrl = url.href;
  ui.webLoading = true;
  ui.webError = '';
  ui.webPage = null;
  ui.webSelections = [];
  render();
  try {
    let parsed;
    try {
      const response = await fetchWithTimeout(url.href, { headers: { Accept: 'text/html,application/xhtml+xml' } }, 12000);
      if (!response.ok) throw new Error(`网页返回 ${response.status}`);
      parsed = extractReadableHtml(await response.text(), url.href);
      if (parsed.paragraphs.length < 2) throw new Error('正文太少');
    } catch (directError) {
      const readerUrl = `https://r.jina.ai/${url.href}`;
      const response = await fetchWithTimeout(readerUrl, { headers: { Accept: 'text/plain' } }, 25000);
      if (!response.ok) throw new Error(`清爽阅读服务返回 ${response.status}`);
      parsed = extractReadableMarkdown(await response.text(), url.href);
      if (parsed.paragraphs.length < 2) throw new Error('没有识别到足够的文章正文');
    }
    ui.webPage = parsed;
    ui.webArticleTitle = parsed.title || url.hostname;
    ui.webLoading = false;
    render();
    toast('网页已整理完成，请选择需要精读的英文内容。');
  } catch (error) {
    console.error(error);
    ui.webLoading = false;
    ui.webError = '目标网站可能需要登录、存在付费墙，或暂时禁止外部读取。你可以打开原网页复制正文，再使用手动粘贴。';
    render();
  }
}

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractReadableHtml(html, url) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script,style,noscript,svg,nav,header,footer,aside,form,button,dialog').forEach(element => element.remove());
  const title = parsed.querySelector('meta[property="og:title"]')?.content?.trim()
    || parsed.querySelector('h1')?.textContent?.trim()
    || parsed.title?.trim()
    || new URL(url).hostname;
  const root = parsed.querySelector('article') || parsed.querySelector('main') || parsed.body;
  const paragraphs = [...root.querySelectorAll('h1,h2,h3,h4,p')]
    .map(element => ({
      text: element.textContent.replace(/\s+/g, ' ').trim(),
      heading: /^H[1-4]$/.test(element.tagName),
      level: Number(element.tagName.slice(1)) || 2,
    }))
    .filter(item => item.text.length >= (item.heading ? 3 : 30));
  return { title, url, paragraphs: dedupeWebParagraphs(paragraphs) };
}

function extractReadableMarkdown(markdown, url) {
  const title = markdown.match(/^Title:\s*(.+)$/mi)?.[1]?.trim()
    || markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || new URL(url).hostname;
  const content = markdown.includes('Markdown Content:') ? markdown.split('Markdown Content:').slice(1).join('Markdown Content:') : markdown;
  const blocks = content.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n+/);
  const paragraphs = blocks.map(block => {
    const clean = block
      .replace(/^!\[[^\]]*\]\([^)]*\)\s*$/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .replace(/^\s*[-+]\s+/gm, '')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    const headingMatch = clean.match(/^(#{1,4})\s*(.+)$/);
    return headingMatch
      ? { text: headingMatch[2].trim(), heading: true, level: headingMatch[1].length }
      : { text: clean.replace(/^#{1,6}\s*/, ''), heading: false, level: 0 };
  }).filter(item => item.text.length >= (item.heading ? 3 : 30) && !/^https?:\/\//i.test(item.text));
  return { title, url, paragraphs: dedupeWebParagraphs(paragraphs) };
}

function dedupeWebParagraphs(paragraphs) {
  const seen = new Set();
  return paragraphs.filter(item => {
    const key = item.text.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 500);
}

function collectWebSelectionText() {
  document.querySelectorAll('[data-web-selection-text]').forEach(textarea => {
    const selection = ui.webSelections.find(item => item.id === textarea.dataset.webSelectionText);
    if (selection) selection.text = textarea.value.trim();
  });
  ui.webArticleTitle = document.querySelector('#webArticleTitle')?.value.trim() || ui.webArticleTitle;
  ui.webArticleLevel = document.querySelector('#webArticleLevel')?.value || ui.webArticleLevel;
  const manual = document.querySelector('#webManualContent');
  if (manual && ui.webPage) ui.webPage.manualText = manual.value;
}

function addWebSelection() {
  collectWebSelectionText();
  const manual = document.querySelector('#webManualContent');
  let text = '';
  if (manual) {
    text = manual.value.slice(manual.selectionStart, manual.selectionEnd).trim() || manual.value.trim();
  } else {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const container = document.querySelector('#webReadableContent');
    if (range && container?.contains(range.commonAncestorContainer)) text = selection.toString().replace(/\s+/g, ' ').trim();
  }
  if (text.length < 10) return toast('请先在左侧文章中选中一段英文正文。', true);
  ui.webSelections.push({ id: crypto.randomUUID(), text });
  window.getSelection()?.removeAllRanges();
  render();
  toast('选中的内容已加入文章。');
}

function moveWebSelection(id, direction) {
  collectWebSelectionText();
  const index = ui.webSelections.findIndex(item => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ui.webSelections.length) return;
  [ui.webSelections[index], ui.webSelections[target]] = [ui.webSelections[target], ui.webSelections[index]];
  render();
}

async function createWebArticle() {
  collectWebSelectionText();
  const selections = ui.webSelections.filter(selection => selection.text.trim());
  const rawText = selections.map(selection => selection.text.trim()).join(' ');
  if (!rawText) return toast('请先选择需要精读的网页正文。', true);
  const sentences = splitSentences(rawText).map(text => ({
    id: crypto.randomUUID(), text, translation: '', referenceTranslation: '', notes: '', difficult: false,
  }));
  const now = new Date().toISOString();
  const sourceUrl = ui.webPage?.url || ui.webUrl;
  const article = {
    id: crypto.randomUUID(),
    documentId: null,
    documentName: new URL(sourceUrl).hostname,
    sourceType: 'web',
    sourceUrl,
    title: ui.webArticleTitle.trim() || ui.webPage?.title || '未命名网页文章',
    level: ui.webArticleLevel,
    rawText,
    regions: selections.map((selection, index) => ({ id: selection.id, kind: 'web', page: index + 1, text: selection.text.trim() })),
    sentences,
    vocabulary: [],
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
  await records.put('articles', article);
  await recordStudySnapshot(article, 'created');
  await refreshData();
  ui.selectedArticleId = article.id;
  ui.readerSentenceIndex = 0;
  ui.readerCardDirection = 'next';
  ui.view = 'reader';
  render();
  toast(`网页文章已生成 ${sentences.length} 个精读句子。`);
}

function useManualWebImport() {
  let url = ui.webUrl;
  try { url = new URL(url).href; } catch { url = 'https://example.com/'; }
  ui.webPage = { title: '手动粘贴网页文章', url, paragraphs: [], manual: true, manualText: '' };
  ui.webArticleTitle = '';
  ui.webError = '';
  render();
  document.querySelector('#webManualContent')?.focus();
}

function updatePomodoroDisplay() {
  const element = document.querySelector('[data-pomodoro-time]');
  if (!element) return;
  const minutes = Math.floor(ui.pomodoroRemaining / 60);
  const seconds = ui.pomodoroRemaining % 60;
  element.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  element.closest('.pomodoro-widget')?.setAttribute('aria-label', `番茄时钟，${ui.pomodoroMode === 'focus' ? '专注' : '休息'}${element.textContent}`);
  document.title = ui.pomodoroRunning ? `${element.textContent} · 精读任务站` : '精读任务站 · 阅读书库';
}

function tickPomodoro() {
  if (!ui.pomodoroRunning || !ui.pomodoroEndsAt) return;
  ui.pomodoroRemaining = Math.max(0, Math.ceil((ui.pomodoroEndsAt - Date.now()) / 1000));
  updatePomodoroDisplay();
  if (ui.pomodoroRemaining > 0) return;
  clearInterval(pomodoroTimer);
  ui.pomodoroRunning = false;
  ui.pomodoroEndsAt = null;
  ui.pomodoroMode = ui.pomodoroMode === 'focus' ? 'break' : 'focus';
  ui.pomodoroRemaining = ui.pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
  render();
  toast(ui.pomodoroMode === 'break' ? '25 分钟专注完成，现在休息 5 分钟吧。' : '休息结束，可以开始下一轮精读。');
}

function togglePomodoro() {
  if (ui.pomodoroRunning) {
    ui.pomodoroRemaining = Math.max(0, Math.ceil((ui.pomodoroEndsAt - Date.now()) / 1000));
    ui.pomodoroRunning = false;
    ui.pomodoroEndsAt = null;
    clearInterval(pomodoroTimer);
  } else {
    ui.pomodoroRunning = true;
    ui.pomodoroEndsAt = Date.now() + ui.pomodoroRemaining * 1000;
    clearInterval(pomodoroTimer);
    pomodoroTimer = setInterval(tickPomodoro, 250);
  }
  render();
  if (!ui.pomodoroRunning) document.title = '精读任务站 · 阅读书库';
}

function resetPomodoro() {
  clearInterval(pomodoroTimer);
  ui.pomodoroRunning = false;
  ui.pomodoroEndsAt = null;
  ui.pomodoroRemaining = ui.pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
  render();
  document.title = '精读任务站 · 阅读书库';
}

async function importPdf(file) {
  if (!(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
    return toast('请选择 PDF 文件。', true);
  }
  toast('正在读取 PDF…');
  try {
    await ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const coverDataUrl = await createPdfCover(pdf);
    const now = new Date().toISOString();
    const document = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      pageCount: pdf.numPages,
      addedAt: now,
      updatedAt: now,
      blob: file,
      coverDataUrl,
    };
    await records.put('documents', document);
    await refreshData();
    ui.selectedDocumentId = document.id;
    ui.pdf = pdf;
    ui.page = 1;
    ui.regions = [];
    ui.selectionFocus = false;
    ui.pdfZoom = 1;
    ui.articleTitle = file.name.replace(/\.pdf$/i, '');
    ui.articleLevel = 'B1';
    ui.view = 'import';
    render();
    toast('PDF 已加入书库，请框选文章正文。');
  } catch (error) {
    console.error(error);
    toast('这个 PDF 暂时无法读取，请确认文件没有损坏或加密。', true);
  }
}

async function createPdfCover(pdf) {
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.6, 440 / baseViewport.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  return canvas.toDataURL('image/jpeg', .84);
}

async function ensureDocumentCovers() {
  const missing = ui.documents.filter(document => !document.coverDataUrl && document.blob);
  for (const document of missing) {
    try {
      await ensurePdfJs();
      const data = new Uint8Array(await document.blob.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      document.coverDataUrl = await createPdfCover(pdf);
      document.updatedAt = new Date().toISOString();
      await records.put('documents', document);
      await pdf.destroy();
      render();
    } catch (error) {
      console.warn(`无法为 ${document.name} 生成封面`, error);
    }
  }
}

async function openDocument(id) {
  const document = await records.get('documents', id);
  if (!document) return;
  ui.selectedDocumentId = id;
  ui.pdf = null;
  ui.page = 1;
  ui.regions = [];
  ui.selectionFocus = false;
  ui.pdfZoom = 1;
  ui.articleTitle = document.name.replace(/\.pdf$/i, '');
  ui.articleLevel = 'B1';
  ui.view = 'import';
  render();
}

async function toggleFavorite(id) {
  const document = await records.get('documents', id);
  if (!document) return;
  document.favorite = !document.favorite;
  document.updatedAt = new Date().toISOString();
  await records.put('documents', document);
  await refreshData();
  render();
  toast(document.favorite ? '已加入收藏。' : '已取消收藏。');
}

async function renameDocument(id, value) {
  const document = await records.get('documents', id);
  const cleanName = String(value || '').trim().replace(/\.pdf$/i, '');
  if (!document || !cleanName) return toast('请输入资料名称。', true);
  document.name = `${cleanName}.pdf`;
  document.updatedAt = new Date().toISOString();
  await records.put('documents', document);
  const relatedArticles = ui.articles.filter(article => article.documentId === id);
  await Promise.all(relatedArticles.map(article => records.put('articles', { ...article, documentName: document.name, updatedAt: new Date().toISOString() })));
  ui.documentDialog = null;
  await refreshData();
  render();
  toast('资料名称已更新。');
}

async function downloadDocument(id) {
  const document = await records.get('documents', id);
  if (!document?.blob) return toast('没有找到原始 PDF 文件。', true);
  const url = URL.createObjectURL(document.blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = document.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('正在下载原始 PDF。');
}

async function deleteDocument(id, deleteRelatedArticles = false) {
  const document = await records.get('documents', id);
  if (!document) return;
  await records.delete('documents', id);
  if (deleteRelatedArticles) {
    const relatedArticles = ui.articles.filter(article => article.documentId === id);
    await Promise.all(relatedArticles.map(article => records.delete('articles', article.id)));
    const relatedIds = new Set(relatedArticles.map(article => article.id));
    const relatedActivities = ui.activities.filter(activity => relatedIds.has(activity.articleId));
    await Promise.all(relatedActivities.map(activity => records.delete('activities', activity.id)));
  }
  if (ui.selectedDocumentId === id) {
    ui.selectedDocumentId = null;
    ui.pdf = null;
    ui.regions = [];
  }
  ui.documentDialog = null;
  await refreshData();
  render();
  toast(deleteRelatedArticles ? '资料和相关精读文章已删除。' : '资料已删除，相关精读文章仍然保留。');
}

async function ensurePdf() {
  if (ui.pdf) return ui.pdf;
  await ensurePdfJs();
  const document = await records.get('documents', ui.selectedDocumentId);
  if (!document?.blob) throw new Error('PDF 文件不存在');
  const data = new Uint8Array(await document.blob.arrayBuffer());
  ui.pdf = await pdfjsLib.getDocument({ data }).promise;
  return ui.pdf;
}

async function mountPdfEditor() {
  const pdfCanvas = document.querySelector('#pdfCanvas');
  const selectionCanvas = document.querySelector('#selectionCanvas');
  const stage = document.querySelector('#pdfStage');
  if (!pdfCanvas || !selectionCanvas || !stage) return;
  const pageNumber = ui.page;
  try {
    const pdf = await ensurePdf();
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(320, stage.clientWidth - 28);
    const widthScale = availableWidth / baseViewport.width;
    const availableHeight = Math.max(320, stage.clientHeight - 28);
    const heightScale = availableHeight / baseViewport.height;
    const fitScale = Math.min(widthScale, heightScale);
    const scale = ui.selectionFocus
      ? Math.min(2.5, Math.max(.35, fitScale * ui.pdfZoom))
      : Math.min(2.15, Math.max(1.15, widthScale));
    const viewport = page.getViewport({ scale });
    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    pdfCanvas.style.width = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;
    selectionCanvas.width = viewport.width;
    selectionCanvas.height = viewport.height;
    selectionCanvas.style.width = `${viewport.width}px`;
    selectionCanvas.style.height = `${viewport.height}px`;
    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport }).promise;
    if (!pdfCanvas.isConnected || !selectionCanvas.isConnected || ui.page !== pageNumber) return;
    selectionCanvas.style.left = `${pdfCanvas.offsetLeft}px`;
    selectionCanvas.style.top = `${pdfCanvas.offsetTop}px`;
    selectionCanvas.style.transform = 'none';
    const textContent = await page.getTextContent();
    ui.textItems = textContent.items.filter(item => item.str?.trim()).map(item => {
      const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const height = Math.max(8, Math.hypot(transform[2], transform[3]));
      return {
        text: item.str,
        x: transform[4],
        y: transform[5] - height,
        width: Math.max(2, item.width * scale),
        height,
      };
    });
    document.querySelector('#pdfLoading')?.remove();
    bindCanvas(selectionCanvas);
    drawRegions(selectionCanvas);
  } catch (error) {
    console.error(error);
    const loading = document.querySelector('#pdfLoading');
    if (loading) loading.innerHTML = '<b>无法显示这一页</b><span>请确认 PDF 没有加密。</span>';
  }
}

function bindCanvas(canvas) {
  canvas.addEventListener('pointerdown', event => {
    const point = canvasPoint(event, canvas);
    ui.activeRect = { startX: point.x, startY: point.y, x: point.x, y: point.y, w: 0, h: 0 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!ui.activeRect) return;
    const point = canvasPoint(event, canvas);
    ui.activeRect.x = Math.min(ui.activeRect.startX, point.x);
    ui.activeRect.y = Math.min(ui.activeRect.startY, point.y);
    ui.activeRect.w = Math.abs(point.x - ui.activeRect.startX);
    ui.activeRect.h = Math.abs(point.y - ui.activeRect.startY);
    drawRegions(canvas);
  });
  canvas.addEventListener('pointerup', event => {
    if (!ui.activeRect) return;
    const rect = ui.activeRect;
    ui.activeRect = null;
    if (rect.w < 18 || rect.h < 18) return drawRegions(canvas);
    const text = extractRegionText(rect);
    ui.regions.push({
      id: crypto.randomUUID(),
      order: ui.regions.length,
      page: ui.page,
      x: rect.x / canvas.width,
      y: rect.y / canvas.height,
      w: rect.w / canvas.width,
      h: rect.h / canvas.height,
      text,
    });
    render();
    toast(text ? '已提取框选区域文字。' : '已保存区域，但未检测到文字；可能是扫描版 PDF。', !text);
  });
}

function canvasPoint(event, canvas) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * canvas.width / bounds.width,
    y: (event.clientY - bounds.top) * canvas.height / bounds.height,
  };
}

function drawRegions(canvas) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const regions = ui.regions.filter(region => region.page === ui.page);
  regions.forEach(region => {
    const rect = {
      x: region.x * canvas.width,
      y: region.y * canvas.height,
      w: region.w * canvas.width,
      h: region.h * canvas.height,
    };
    context.fillStyle = 'rgba(66, 244, 219, .14)';
    context.strokeStyle = '#42f4db';
    context.lineWidth = 3;
    context.fillRect(rect.x, rect.y, rect.w, rect.h);
    context.strokeRect(rect.x, rect.y, rect.w, rect.h);
    context.fillStyle = '#07131f';
    context.fillRect(rect.x, rect.y, 30, 25);
    context.fillStyle = '#6dffe9';
    context.font = '700 13px system-ui';
    context.fillText(String(region.order + 1).padStart(2, '0'), rect.x + 6, rect.y + 17);
  });
  if (ui.activeRect) {
    context.fillStyle = 'rgba(177, 106, 255, .16)';
    context.strokeStyle = '#b16aff';
    context.lineWidth = 3;
    context.fillRect(ui.activeRect.x, ui.activeRect.y, ui.activeRect.w, ui.activeRect.h);
    context.strokeRect(ui.activeRect.x, ui.activeRect.y, ui.activeRect.w, ui.activeRect.h);
  }
}

function extractRegionText(rect) {
  const selected = ui.textItems.filter(item => {
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    return centerX >= rect.x && centerX <= rect.x + rect.w && centerY >= rect.y && centerY <= rect.y + rect.h;
  });
  selected.sort((a, b) => Math.abs(a.y - b.y) < 5 ? a.x - b.x : a.y - b.y);
  const lines = [];
  selected.forEach(item => {
    let line = lines.find(candidate => Math.abs(candidate.y - item.y) < Math.max(4, item.height * .45));
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  });
  return lines
    .sort((a, b) => a.y - b.y)
    .map(line => line.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
    .join(' ')
    .replace(/-\s+([a-z])/g, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function collectRegionText() {
  document.querySelectorAll('[data-region-text]').forEach(textarea => {
    const region = ui.regions.find(item => item.id === textarea.dataset.regionText);
    if (region) region.text = textarea.value.trim();
  });
  ui.articleTitle = document.querySelector('#articleTitle')?.value.trim() || ui.articleTitle;
  ui.articleLevel = document.querySelector('#articleLevel')?.value || ui.articleLevel;
}

function normalizeRegionOrder() {
  ui.regions.forEach((region, index) => { region.order = index; });
}

function moveRegion(id, direction) {
  const index = ui.regions.findIndex(region => region.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ui.regions.length) return;
  [ui.regions[index], ui.regions[target]] = [ui.regions[target], ui.regions[index]];
  normalizeRegionOrder();
  render();
}

function changePage(direction) {
  const document = ui.documents.find(item => item.id === ui.selectedDocumentId);
  goToPage(ui.page + direction, document?.pageCount);
}

function goToPage(pageNumber, knownMax) {
  const document = ui.documents.find(item => item.id === ui.selectedDocumentId);
  const max = knownMax || document?.pageCount || 1;
  const next = Math.max(1, Math.min(max, Math.round(pageNumber || 1)));
  if (next === ui.page) return;
  collectRegionText();
  ui.page = next;
  render();
}

async function createArticle() {
  collectRegionText();
  if (!ui.regions.length) return toast('请先框选文章正文。', true);
  const rawText = ui.regions.map(region => region.text).filter(Boolean).join(' ');
  if (!rawText) return toast('没有检测到文字。扫描版 PDF 的本地 OCR 将在后续加入，现在可以在右侧粘贴文字。', true);
  const title = ui.articleTitle || '未命名精读文章';
  const button = document.querySelector('[data-create-article]');
  if (button) {
    button.disabled = true;
    button.textContent = '正在生成原版截图…';
  }
  try {
    const regions = [];
    for (const region of ui.regions) {
      regions.push({ ...region, imageData: await cropRegion(region) });
    }
    const sentences = splitSentences(rawText).map(text => ({
      id: crypto.randomUUID(),
      text,
      translation: '',
      referenceTranslation: '',
      notes: '',
      difficult: false,
    }));
    const document = ui.documents.find(item => item.id === ui.selectedDocumentId);
    const now = new Date().toISOString();
    const article = {
      id: crypto.randomUUID(),
      documentId: document.id,
      documentName: document.name.replace(/\.pdf$/i, ''),
      title,
      level: ui.articleLevel,
      rawText,
      regions,
      sentences,
      vocabulary: [],
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    await records.put('articles', article);
    await recordStudySnapshot(article, 'created');
    await refreshData();
    ui.selectedArticleId = article.id;
    ui.readerSentenceIndex = 0;
    ui.readerCardDirection = 'next';
    ui.view = 'reader';
    render();
    toast(`已生成 ${sentences.length} 个精读句子。`);
  } catch (error) {
    console.error(error);
    toast('生成精读文章时出现问题，请重新尝试。', true);
    render();
  }
}

async function cropRegion(region) {
  const pdf = await ensurePdf();
  const page = await pdf.getPage(region.page);
  const viewport = page.getViewport({ scale: 1.75 });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = viewport.width;
  pageCanvas.height = viewport.height;
  await page.render({ canvasContext: pageCanvas.getContext('2d'), viewport }).promise;
  const sourceX = Math.max(0, Math.round(region.x * pageCanvas.width));
  const sourceY = Math.max(0, Math.round(region.y * pageCanvas.height));
  const sourceWidth = Math.max(1, Math.min(pageCanvas.width - sourceX, Math.round(region.w * pageCanvas.width)));
  const sourceHeight = Math.max(1, Math.min(pageCanvas.height - sourceY, Math.round(region.h * pageCanvas.height)));
  const crop = document.createElement('canvas');
  crop.width = sourceWidth;
  crop.height = sourceHeight;
  crop.getContext('2d').drawImage(pageCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
  return crop.toDataURL('image/jpeg', .9);
}

function splitSentences(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  try {
    return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(clean)]
      .map(item => item.segment.trim())
      .filter(Boolean);
  } catch {
    return clean.match(/[^.!?]+[.!?]+(?:["’”']+)?|[^.!?]+$/g)?.map(sentence => sentence.trim()).filter(Boolean) || [clean];
  }
}

async function saveArticleEdits(articleId, titleValue, levelValue, contentValue) {
  const article = ui.articles.find(item => item.id === articleId);
  const title = String(titleValue || '').trim();
  const rawText = String(contentValue || '').replace(/\s+/g, ' ').trim();
  const level = CEFR.includes(levelValue) ? levelValue : article?.level;
  if (!article) return;
  if (!title) return toast('请填写文章标题。', true);
  if (!rawText) return toast('英文正文不能为空。', true);

  const sentenceTexts = splitSentences(rawText);
  if (!sentenceTexts.length) return toast('没有识别到可保存的英文句子。', true);

  let sentences;
  if (sentenceTexts.length === article.sentences.length) {
    sentences = sentenceTexts.map((text, index) => ({ ...article.sentences[index], text }));
  } else {
    const reusable = new Map();
    article.sentences.forEach(sentence => {
      const key = sentence.text.replace(/\s+/g, ' ').trim().toLowerCase();
      const matches = reusable.get(key) || [];
      matches.push(sentence);
      reusable.set(key, matches);
    });
    sentences = sentenceTexts.map(text => {
      const key = text.replace(/\s+/g, ' ').trim().toLowerCase();
      const existing = reusable.get(key)?.shift();
      return existing
        ? { ...existing, text }
        : { id: crypto.randomUUID(), text, translation: '', referenceTranslation: '', notes: '', difficult: false };
    });
  }

  article.title = title;
  article.level = level;
  article.rawText = rawText;
  article.sentences = sentences;
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  ui.articleEditId = null;
  await refreshData();
  render();
  toast('文章标题和正文已更新。');
}

function collectReader(article) {
  document.querySelectorAll('[data-sentence-id]').forEach(card => {
    const sentence = article.sentences.find(item => item.id === card.dataset.sentenceId);
    if (!sentence) return;
    sentence.translation = card.querySelector('[data-translation]')?.value || '';
    sentence.notes = card.querySelector('[data-notes]')?.value || '';
    const referenceInput = card.querySelector('[data-reference-translation]');
    if (referenceInput) sentence.referenceTranslation = referenceInput.value.trim();
    sentence.text = card.querySelector('[data-sentence-text]')?.value.trim() || sentence.text;
  });
  const practiceDialog = document.querySelector('[data-reconstruction-practice]');
  if (practiceDialog) {
    const sentence = article.sentences.find(item => item.id === practiceDialog.dataset.reconstructionPractice);
    if (sentence) {
      sentence.reconstructionWords = [...practiceDialog.querySelectorAll('[data-reconstruction-word]')].map(input => input.value.trim());
      sentence.backTranslation = sentence.reconstructionWords.filter(Boolean).join(' ');
    }
  }
}

async function openWordDefinition(wordValue) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const word = String(wordValue || '').trim().replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '');
  if (!article || !word) return;
  collectReader(article);
  const isNewWord = !article.vocabulary.some(item => item.toLowerCase() === word.toLowerCase());
  if (isNewWord) article.vocabulary.push(word);
  article.updatedAt = new Date().toISOString();
  const storedDefinition = article.wordDefinitions?.[word.toLowerCase()];
  const cached = storedDefinition?.dictionaryVersion >= 2 ? storedDefinition : null;
  ui.wordDialog = { word, status: cached ? 'ready' : 'loading', definition: cached || null, error: '' };
  render();
  await records.put('articles', article);
  if (isNewWord) await recordStudySnapshot(article, 'vocabulary');
  if (!cached) await loadWordDefinition(word);
}

async function loadWordDefinition(wordValue, force = false) {
  const word = String(wordValue || '').trim();
  const articleId = ui.selectedArticleId;
  if (!word || !articleId) return;
  const article = ui.articles.find(item => item.id === articleId);
  const key = word.toLowerCase();
  const storedDefinition = article?.wordDefinitions?.[key];
  const cached = storedDefinition?.dictionaryVersion >= 2 ? storedDefinition : null;
  if (cached && !force) {
    ui.wordDialog = { word, status: 'ready', definition: cached, error: '' };
    render();
    return;
  }
  ui.wordDialog = { word, status: 'loading', definition: null, error: '' };
  render();
  try {
    const shardKey = word.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || '__';
    const [exactResult, relatedResult, chineseResult] = await Promise.allSettled([
      fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dpr&ipa=1&max=1`),
      fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(word)}&max=8`),
      fetch(`./data/ecdict-shards/${shardKey}.json`),
    ]);
    const exactResponse = exactResult.status === 'fulfilled' ? exactResult.value : null;
    const relatedResponse = relatedResult.status === 'fulfilled' ? relatedResult.value : null;
    const chineseResponse = chineseResult.status === 'fulfilled' ? chineseResult.value : null;
    const exactItems = exactResponse?.ok ? await exactResponse.json() : [];
    const exact = exactItems.find(item => item.word?.toLowerCase() === key) || exactItems[0] || null;
    const related = relatedResponse?.ok ? (await relatedResponse.json()).map(item => item.word).filter(Boolean).slice(0, 8) : [];
    const chineseShard = chineseResponse?.ok ? await chineseResponse.json() : {};
    const chinese = chineseShard[key] ? { ...chineseShard[key], source: 'ECDICT' } : null;
    if (!exact && !chinese) throw new Error('两套词典中都没有找到这个词形，可以尝试点击它的原形。');
    const groups = new Map();
    (exact?.defs || []).forEach(value => {
      const [part = 'definition', ...content] = value.split('\t');
      const label = ({ n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb' })[part] || part;
      const definitions = groups.get(label) || [];
      definitions.push({ definition: content.join(' ').trim(), example: '' });
      groups.set(label, definitions);
    });
    if (!groups.size) groups.set('definition', [{ definition: 'See the Chinese definition and add your own contextual note.', example: '' }]);
    const tags = exact?.tags || [];
    const normalized = {
      dictionaryVersion: 3,
      phonetic: tags.find(tag => tag.startsWith('ipa_pron:'))?.slice(9).trim() || '',
      audio: '',
      origin: '',
      meanings: [...groups].map(([partOfSpeech, definitions], index) => ({
        partOfSpeech,
        definitions,
        synonyms: index === 0 ? related : [],
      })),
      chinese,
      source: exact && chinese ? 'Datamuse 在线英英词典 + ECDICT 英汉词典' : exact ? 'Datamuse 在线英英词典' : 'ECDICT 英汉词典',
    };
    if (!normalized?.meanings?.length) throw new Error('词典返回了空释义。');
    await cacheWordDefinition(articleId, key, word, normalized);
  } catch (error) {
    if (ui.wordDialog?.word.toLowerCase() === key) {
      ui.wordDialog = { word, status: 'error', definition: null, error: error.message || '词典查询失败。' };
      render();
    }
  }
}

async function cacheWordDefinition(articleId, key, word, definition) {
  const latestArticle = ui.articles.find(item => item.id === articleId);
  if (!latestArticle) return;
  latestArticle.wordDefinitions ||= {};
  latestArticle.wordDefinitions[key] = definition;
  latestArticle.updatedAt = new Date().toISOString();
  await records.put('articles', latestArticle);
  await refreshData();
  if (ui.wordDialog?.word.toLowerCase() === key) {
    ui.wordDialog = { word, status: 'ready', definition, error: '' };
    render();
  }
}

function closeWordDialog() {
  ui.wordDialog = null;
  render();
}

async function saveWordNote() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const word = ui.wordDialog?.word;
  if (!article || !word) return;
  article.wordNotes ||= {};
  article.wordNotes[word.toLowerCase()] = document.querySelector('#wordChineseNote')?.value.trim() || '';
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await refreshData();
  render();
  toast('中文释义和生词标记已保存。');
}

async function saveReferenceTranslation(sentenceId) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === sentenceId);
  if (!sentence?.referenceTranslation?.trim()) return toast('请先填写参考译文。', true);
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await refreshData();
  render();
  toast('参考译文已保存，可与自己的译文对照核对。');
}

function openReconstructionDrawer() {
  clearTimeout(difficultHintTimer);
  ui.difficultHintVisible = false;
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const difficultSentences = article?.sentences.filter(item => item.difficult) || [];
  if (!difficultSentences.some(item => item.id === ui.reconstructionDialogSentenceId)) {
    ui.reconstructionDialogSentenceId = difficultSentences[0]?.id || null;
  }
  ui.reconstructionDrawerOpen = true;
  ui.reconstructionPracticeOpen = false;
  render();
  const sentence = difficultSentences.find(item => item.id === ui.reconstructionDialogSentenceId);
  if (sentence && !sentence.referenceTranslation?.trim() && !ui.translationGeneration.has(sentence.id)) generateReferenceTranslation(sentence.id);
}

async function closeReconstructionDrawer() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (article) {
    collectReader(article);
    article.updatedAt = new Date().toISOString();
    await records.put('articles', article);
  }
  ui.reconstructionDrawerOpen = false;
  ui.reconstructionPracticeOpen = false;
  render();
}

async function openReconstructionPractice(sentenceId) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  ui.reconstructionDialogSentenceId = sentenceId;
  ui.practiceRevealIds.delete(sentenceId);
  ui.reconstructionPracticeOpen = true;
  render();
  const sentence = article.sentences.find(item => item.id === sentenceId);
  if (sentence && !sentence.referenceTranslation?.trim() && !ui.translationGeneration.has(sentenceId)) generateReferenceTranslation(sentenceId);
  requestAnimationFrame(() => document.querySelector('[data-reconstruction-word]')?.focus());
}

async function closeReconstructionPractice() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (article) {
    collectReader(article);
    article.updatedAt = new Date().toISOString();
    await records.put('articles', article);
  }
  ui.reconstructionPracticeOpen = false;
  render();
}

function showDifficultHint() {
  if (localStorage.getItem('readquest-hide-difficult-hint') === '1') return render();
  clearTimeout(difficultHintTimer);
  ui.difficultHintVisible = true;
  render();
  difficultHintTimer = setTimeout(() => {
    ui.difficultHintVisible = false;
    render();
  }, 3000);
}

function hideDifficultHint(shouldRender = true) {
  clearTimeout(difficultHintTimer);
  ui.difficultHintVisible = false;
  if (shouldRender) render();
}

async function checkReconstructionWords(sentenceId) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === sentenceId);
  if (!sentence?.reconstructionWords?.some(Boolean)) return toast('请先填写英文单词，再进行查验。', true);
  ui.practiceRevealIds.add(sentenceId);
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  const expectedWords = sentence.text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
  const correct = expectedWords.filter((word, index) => normalizePracticeWord(word) === normalizePracticeWord(sentence.reconstructionWords[index])).length;
  await recordPracticeResult(article, sentence, correct, expectedWords.length);
  render();
}

async function redoReconstruction(sentenceId) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const sentence = article?.sentences.find(item => item.id === sentenceId);
  if (!article || !sentence) return;
  sentence.reconstructionWords = [];
  sentence.backTranslation = '';
  ui.practiceRevealIds.delete(sentenceId);
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  render();
  requestAnimationFrame(() => document.querySelector('[data-reconstruction-word="0"]')?.focus());
}

function dismissReconstructionFeedback(sentenceId, focusIndex) {
  if (!ui.practiceRevealIds.has(sentenceId)) return;
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (article) collectReader(article);
  ui.practiceRevealIds.delete(sentenceId);
  render();
  requestAnimationFrame(() => {
    const nextInput = document.querySelector(`[data-reconstruction-word="${focusIndex}"]`);
    nextInput?.focus();
    nextInput?.setSelectionRange(nextInput.value.length, nextInput.value.length);
  });
}

function bindReconstructionInputs() {
  const inputs = [...document.querySelectorAll('[data-reconstruction-word]')];
  inputs.forEach((input, index) => {
    const sentenceId = input.closest('[data-reconstruction-practice]')?.dataset.reconstructionPractice;
    input.addEventListener('pointerdown', () => {
      if (sentenceId) dismissReconstructionFeedback(sentenceId, index);
    });
    input.addEventListener('input', () => {
      if (sentenceId) dismissReconstructionFeedback(sentenceId, index);
    });
    input.addEventListener('keydown', event => {
      if (event.key === ' ' && input.value.trim()) {
        event.preventDefault();
        inputs[index + 1]?.focus();
      } else if (event.key === 'Backspace' && !input.value) {
        inputs[index - 1]?.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        checkReconstructionWords(ui.reconstructionDialogSentenceId);
      }
    });
    input.addEventListener('paste', event => {
      const words = event.clipboardData?.getData('text')?.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
      if (words.length < 2) return;
      event.preventDefault();
      words.forEach((word, offset) => { if (inputs[index + offset]) inputs[index + offset].value = word; });
      if (sentenceId && ui.practiceRevealIds.has(sentenceId)) {
        const article = ui.articles.find(item => item.id === ui.selectedArticleId);
        if (article) collectReader(article);
        ui.practiceRevealIds.delete(sentenceId);
        render();
        requestAnimationFrame(() => document.querySelector(`[data-reconstruction-word="${Math.min(inputs.length - 1, index + words.length)}"]`)?.focus());
        return;
      }
      inputs[Math.min(inputs.length - 1, index + words.length)]?.focus();
    });
  });
}

async function generateReferenceTranslation(sentenceId, regenerate = false) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === sentenceId);
  if (!sentence?.text?.trim() || (!regenerate && sentence.referenceTranslation?.trim())) return;
  if (localStorage.getItem('readquest-mymemory-consent') !== '1') {
    const allowed = window.confirm('生成参考译文需要把当前英文句子发送到 MyMemory 在线翻译服务。只发送这一句英文，不发送 PDF、笔记或个人信息。是否允许？');
    if (!allowed) {
      ui.translationGeneration.set(sentenceId, { status: 'error', error: '未启用在线翻译。你仍可手动填写参考译文。' });
      render();
      return;
    }
    localStorage.setItem('readquest-mymemory-consent', '1');
  }
  ui.translationGeneration.set(sentenceId, { status: 'loading', error: '' });
  render();
  try {
    const sourceText = sentence.text.trim();
    if (new TextEncoder().encode(sourceText).length > 500) throw new Error('这个句子超过在线翻译的 500 字节限制，请手动填写参考译文。');
    const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(sourceText)}&langpair=en%7Czh-CN`);
    const data = await response.json().catch(() => ({}));
    const translatedText = String(data.responseData?.translatedText || '').trim();
    if (!response.ok || data.responseStatus !== 200 || !translatedText) throw new Error(data.responseDetails || '没有生成可用的参考译文。');
    sentence.referenceTranslation = translatedText;
    sentence.referenceTranslationSource = 'MyMemory 在线翻译';
    sentence.referenceTranslationGeneratedAt = new Date().toISOString();
    article.updatedAt = new Date().toISOString();
    await records.put('articles', article);
    await refreshData();
    ui.translationGeneration.delete(sentenceId);
    render();
    toast('参考译文已生成，可继续修改并保存。');
  } catch (error) {
    ui.translationGeneration.set(sentenceId, { status: 'error', error: error.message || '参考译文生成失败，请重试。' });
    render();
  }
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function exportLibraryBackup() {
  if (!ui.documents.length && !ui.articles.length) return toast('当前书库还没有可以导出的内容。', true);
  toast('正在整理整库备份，PDF 较大时请稍候…');
  try {
    const documents = [];
    for (const item of await records.all('documents')) {
      documents.push({ ...item, blobDataUrl: item.blob ? await blobToDataUrl(item.blob) : null, blob: undefined });
    }
    const payload = {
      format: 'reading-request-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      documents,
      articles: await records.all('articles'),
      activities: await records.all('activities'),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `精读任务站备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('整库备份已导出，请妥善保存。');
  } catch (error) {
    console.error(error);
    toast('备份导出失败，请确认浏览器还有足够空间。', true);
  }
}

async function importLibraryBackup(file) {
  toast('正在恢复书库…');
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.format !== 'reading-request-backup' || !Array.isArray(payload.documents) || !Array.isArray(payload.articles)) {
      throw new Error('invalid backup');
    }
    for (const item of payload.documents) {
      const { blobDataUrl, ...documentRecord } = item;
      if (!documentRecord.id || !documentRecord.name) continue;
      documentRecord.blob = blobDataUrl ? await dataUrlToBlob(blobDataUrl) : null;
      await records.put('documents', documentRecord);
    }
    for (const article of payload.articles) {
      if (article?.id && article?.title) await records.put('articles', article);
    }
    for (const activity of payload.activities || []) {
      if (activity?.id && activity?.occurredAt) await records.put('activities', activity);
    }
    await refreshData();
    render();
    toast(`已恢复 ${payload.documents.length} 本资料和 ${payload.articles.length} 篇精读文章。`);
  } catch (error) {
    console.error(error);
    toast('无法恢复：请选择由“精读任务站”导出的 JSON 备份。', true);
  }
}

async function saveReader(markComplete) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  if (markComplete) article.completed = true;
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await recordStudySnapshot(article, markComplete ? 'completed' : 'saved');
  await refreshData();
  render();
  toast(markComplete ? '本次精读已完成并保存。' : '精读记录已保存到离线书库。');
}

async function toggleWord(word) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const index = article.vocabulary.findIndex(item => item.toLowerCase() === word.toLowerCase());
  if (index >= 0) article.vocabulary.splice(index, 1);
  else article.vocabulary.push(word);
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await recordStudySnapshot(article, index >= 0 ? 'vocabulary-removed' : 'vocabulary');
  render();
  toast(index >= 0 ? `已取消生词：${word}` : `已标记生词：${word}`);
}

async function toggleDifficult(id) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === id);
  if (sentence) sentence.difficult = !sentence.difficult;
  if (sentence?.difficult) {
    ui.reconstructionDialogSentenceId = id;
    ui.practiceRevealIds.delete(id);
  } else if (ui.reconstructionDialogSentenceId === id) {
    ui.reconstructionDialogSentenceId = article.sentences.find(item => item.difficult)?.id || null;
  }
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await recordStudySnapshot(article, sentence?.difficult ? 'difficult' : 'difficult-removed');
  if (sentence?.difficult) showDifficultHint();
  else render();
  if (sentence?.difficult && !sentence.referenceTranslation?.trim() && !ui.translationGeneration.has(id)) generateReferenceTranslation(id);
}

async function addSentence() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  article.sentences.push({
    id: crypto.randomUUID(),
    text: '在“校对识别文字”中输入新的英文句子。',
    translation: '',
    referenceTranslation: '',
    notes: '',
    difficult: false,
  });
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  await recordStudySnapshot(article, 'sentence-added');
  ui.readerSentenceIndex = article.sentences.length - 1;
  ui.readerCardDirection = 'next';
  render();
}

function toast(message, error = false) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.className = `show ${error ? 'error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = ''; }, 3600);
}

async function init() {
  render();
  await refreshData();
  render();
  ensureDocumentCovers();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init().catch(error => {
  console.error(error);
  document.querySelector('#app').innerHTML = '<div class="fatal">无法打开本地书库，请刷新页面重试。</div>';
});
