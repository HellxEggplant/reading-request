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

function readBrowserSetting(scope, key, fallback = '') {
  try {
    const storage = scope === 'session' ? sessionStorage : localStorage;
    return storage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

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
  translationReview: new Map(),
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
  pomodoroPanelOpen: false,
  pomodoroAutoStart: readBrowserSetting('local', 'reading-request-pomodoro-auto', '1') !== '0',
  heroSlide: 0,
  immersiveOpen: false,
  translationSettingsOpen: false,
  aiApiKey: readBrowserSetting('session', 'readquest-deepseek-api-key'),
  aiModel: readBrowserSetting('local', 'readquest-deepseek-model', 'deepseek-flash'),
  aiCompanionOpen: false,
  aiCompanionSending: false,
  aiCompanionMessages: [],
  aiCompanionError: '',
};

let dbPromise;
let difficultHintTimer;
let pomodoroTimer;
let heroCarouselTimer;
let tomatoWasDragged = false;
let companionDragUntil = 0;

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
    ${aiCompanionMarkup()}
    ${translationSettingsDialog()}
  `;
}

function translationSettingsDialog() {
  if (!ui.translationSettingsOpen) return '';
  return `<div class="translation-settings-overlay" data-translation-settings-overlay>
    <section class="translation-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="translationSettingsTitle">
      <form data-translation-settings-form>
      <header><div><span>LANGUAGE AI</span><h2 id="translationSettingsTitle">DeepSeek AI 设置</h2><p>一个接口用于参考译文、译文校验、双语词典和 AI 精灵。</p></div><button type="button" data-close-translation-settings aria-label="关闭设置">×</button></header>
      <div class="deepseek-service-card"><span>统一 AI 服务</span><div><b>DeepSeek API</b><small>密钥只在当前标签页中使用</small></div><em>ACTIVE</em></div>
      <section class="ai-translation-settings visible">
        <label>DeepSeek API 密钥<div class="api-key-input"><input id="translationApiKey" type="password" value="${esc(ui.aiApiKey)}" placeholder="sk-…" autocomplete="new-password" spellcheck="false"><button type="button" data-toggle-api-key aria-label="显示 API 密钥" aria-pressed="false"><span aria-hidden="true">◉</span><b>显示</b></button></div></label>
        <label>DeepSeek 模型<select id="translationAiModel">
          <option value="deepseek-flash" ${ui.aiModel === 'deepseek-flash' ? 'selected' : ''}>DeepSeek Flash · 快速经济</option>
          <option value="deepseek-v4-pro" ${ui.aiModel === 'deepseek-v4-pro' ? 'selected' : ''}>DeepSeek V4 Pro · 质量优先</option>
        </select></label>
        <p><b>密钥安全提示</b> 密钥仅保留在当前标签页，关闭后自动清除，不会写入 GitHub 或书库备份。使用具体功能前，网站会说明即将发送的文字范围并征求确认。</p>
      </section>
        <footer><button class="outline" type="button" data-close-translation-settings>取消</button><button class="primary" type="submit">保存设置</button></footer>
      </form>
    </section>
  </div>`;
}

function aiCompanionMarkup() {
  if (ui.view !== 'reader' || !ui.selectedArticleId) return '';
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const sentence = article?.sentences?.[ui.readerSentenceIndex];
  if (!article) return '';
  const messages = ui.aiCompanionMessages;
  return `<aside class="ai-companion ${ui.aiCompanionOpen ? 'is-open' : ''}" aria-label="AI 精灵">
    <button type="button" class="ai-companion-orb" data-toggle-ai-companion aria-expanded="${ui.aiCompanionOpen}">
      <span aria-hidden="true">AI</span><b>AI 精灵</b>
    </button>
    ${ui.aiCompanionOpen ? `<section class="ai-companion-panel">
      <header><div><span>陪你读懂每一句</span><h2>AI 精灵</h2><p>${sentence ? `一起看看第 ${ui.readerSentenceIndex + 1} 句` : '聊聊你的问题'}</p></div><button type="button" data-toggle-ai-companion aria-label="关闭 AI 精灵">×</button></header>
      <div class="ai-companion-messages" data-ai-companion-messages>
        ${messages.length ? messages.map(message => `<article class="${message.role}"><b>${message.role === 'user' ? '我' : 'AI 精灵'}</b><p>${esc(message.content)}</p></article>`).join('') : `<div class="ai-companion-welcome"><b>这句话哪里不明白？</b><p>可以问词义、语法、句子结构、翻译差异，也可以让我举例说明。</p><div><button type="button" data-ai-suggestion="帮我拆解这个句子的结构">拆解句子</button><button type="button" data-ai-suggestion="我的翻译哪里还可以改进？">检查翻译</button><button type="button" data-ai-suggestion="请解释这句话最容易误解的地方">易错点</button></div></div>`}
        ${ui.aiCompanionSending ? '<article class="assistant is-typing"><b>AI 精灵</b><p><i></i><i></i><i></i></p></article>' : ''}
        ${ui.aiCompanionError ? `<p class="ai-companion-error">${esc(ui.aiCompanionError)}</p>` : ''}
      </div>
      <form class="ai-companion-form" data-ai-companion-form>
        <textarea name="question" rows="2" placeholder="输入你的问题…" aria-label="向 AI 精灵提问" ${ui.aiCompanionSending ? 'disabled' : ''}></textarea>
        <button type="submit" ${ui.aiCompanionSending ? 'disabled' : ''}>发送</button>
      </form>
      <footer><span>只发送当前句及必要上下文</span><button type="button" data-open-translation-settings>⚙ 设置</button></footer>
    </section>` : ''}
  </aside>`;
}

function bindCompanionDrag() {
  const root = document.querySelector('.ai-companion');
  const handle = root?.querySelector('.ai-companion-orb');
  if (!handle) return;
  let position;
  try { position = JSON.parse(readBrowserSetting('local', 'readquest-companion-position', 'null')); } catch {}
  const place = (x, y) => {
    const width = handle.offsetWidth;
    const height = handle.offsetHeight;
    const left = Math.max(12, Math.min(innerWidth - width - 12, x));
    const top = Math.max(12, Math.min(innerHeight - height - 12, y));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    const panel = root.querySelector('.ai-companion-panel');
    if (panel) {
      const panelWidth = Math.min(390, innerWidth - 24);
      const available = Math.max(top - 24, innerHeight - top - height - 24);
      panel.style.width = `${panelWidth}px`;
      panel.style.height = `${Math.min(580, available)}px`;
      panel.style.left = `${Math.max(12, Math.min(innerWidth - panelWidth - 12, left)) - left}px`;
      panel.style.top = top > innerHeight / 2 ? 'auto' : `${height + 10}px`;
      panel.style.bottom = top > innerHeight / 2 ? `${height + 10}px` : 'auto';
    }
    return { x: left, y: top };
  };
  const initial = handle.getBoundingClientRect();
  position = place(Number.isFinite(position?.x) ? position.x : initial.left, Number.isFinite(position?.y) ? position.y : initial.top);
  let drag;
  handle.title = '点击聊天 · 拖动调整位置';
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, start: position, moved: false };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    root.classList.add('is-dragging');
    position = place(drag.start.x + dx, drag.start.y + dy);
  });
  const end = event => {
    if (drag?.moved) {
      companionDragUntil = Date.now() + 350;
      try { localStorage.setItem('readquest-companion-position', JSON.stringify(position)); } catch {}
    }
    drag = null;
    root.classList.remove('is-dragging');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  window.onresize = () => { position = place(position.x, position.y); };
}

function libraryPage() {
  const heroSlides = [
    { image: 'assets/editorial-reading-desk.png', position: 'center 60%', crop: '', eyebrow: 'READ DEEPLY', copy: '每一次精读，都是一次真正的语言实践。' },
    { image: 'assets/modern-chinese-reading-thumbnails.png', position: 'left center', crop: 'crop-left', eyebrow: '静心入文', copy: '一桌、一卷、一段不被打断的阅读时间。' },
    { image: 'assets/modern-chinese-reading-thumbnails.png', position: 'right center', crop: 'crop-right', eyebrow: '日日有得', copy: '把读过的句子，慢慢变成自己的语言。' },
  ];
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
      <figure class="library-heading-visual" data-hero-carousel aria-roledescription="轮播图">
        <div class="hero-slides">
          ${heroSlides.map((slide, index) => `<article class="hero-slide ${slide.crop} ${index === ui.heroSlide ? 'active' : ''}" data-hero-slide="${index}" aria-hidden="${index === ui.heroSlide ? 'false' : 'true'}">
            <img src="${slide.image}" style="object-position:${slide.position}" alt="${index === 0 ? '阳光下放着英文杂志和笔记本的阅读桌' : '现代中式阅读空间'}">
            <figcaption><b>${slide.eyebrow}</b><span>${slide.copy}</span></figcaption>
          </article>`).join('')}
        </div>
        <div class="hero-carousel-controls">
          <button type="button" data-hero-step="-1" aria-label="上一张图片">←</button>
          <div>${heroSlides.map((_, index) => `<button type="button" class="${index === ui.heroSlide ? 'active' : ''}" data-hero-dot="${index}" aria-label="查看第 ${index + 1} 张图片" aria-current="${index === ui.heroSlide ? 'true' : 'false'}"></button>`).join('')}</div>
          <button type="button" data-hero-step="1" aria-label="下一张图片">→</button>
        </div>
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
      <div class="reader-actions"><div class="reader-progress" aria-label="精读进度 ${progress}%"><div><span>精读进度</span><b>${progress}%</b></div><i><em style="width:${progress}%"></em></i></div><button class="outline immersive-enter-button" data-open-immersive>沉浸模式</button><button class="outline reader-save-button" data-save-reader>保存</button><button class="primary reader-complete-button" data-complete-reader>${article.completed ? '已完成 ✓' : '完成精读'}</button></div>
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
    ${ui.immersiveOpen ? '' : pomodoroMarkup()}
    ${reconstructionSidebarMarkup(article)}
    ${ui.immersiveOpen ? immersiveReaderMarkup(article, activeSentence, progress) : ''}
    ${ui.sourceDialog ? sourceDialogMarkup(article) : ''}
    ${ui.wordDialog ? wordDialogMarkup(article) : ''}
  `);
}

function immersiveReaderMarkup(article, sentence, progress) {
  if (!sentence) return '';
  return `<section class="immersive-reader" role="dialog" aria-modal="true" aria-label="沉浸精读模式">
    <header>
      <div><span>IMMERSIVE READING</span><b>${esc(article.title)}</b></div>
      <div class="immersive-header-actions">
        <button class="immersive-exit-button" type="button" data-close-immersive aria-label="退出沉浸模式">退出 <span aria-hidden="true">×</span></button>
      </div>
    </header>
    <div class="immersive-progress"><i style="width:${progress}%"></i><span>${ui.readerSentenceIndex + 1} / ${article.sentences.length}</span></div>
    <main>${immersiveSentenceMarkup(article, sentence)}</main>
    <nav class="immersive-navigation" aria-label="沉浸模式逐句切换">
      <button type="button" data-reader-sentence="-1" ${ui.readerSentenceIndex <= 0 ? 'disabled' : ''}>← 上一句</button>
      <span>${sentence.difficult ? '◆ 长难句' : '逐句精读'}</span>
      <button type="button" data-reader-sentence="1" ${ui.readerSentenceIndex >= article.sentences.length - 1 ? 'disabled' : ''}>下一句 →</button>
    </nav>
    ${pomodoroMarkup()}
  </section>`;
}

function immersiveSentenceMarkup(article, sentence) {
  const tokens = tokenize(sentence.text).map(token => /^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/.test(token)
    ? `<button type="button" data-word="${esc(token)}">${esc(token)}</button>`
    : esc(token)).join('');
  return `
      <p class="immersive-kicker">第 ${String(ui.readerSentenceIndex + 1).padStart(2, '0')} 句</p>
      <article class="immersive-sentence ${sentence.difficult ? 'difficult' : ''}">${tokens}</article>
      <label class="immersive-translation"><span>我的中文理解</span><textarea data-immersive-translation placeholder="写下你对这句话的理解…">${esc(sentence.translation || '')}</textarea></label>
  `;
}

function updateImmersiveSentence(article) {
  const immersive = document.querySelector('.immersive-reader');
  const sentence = article.sentences[ui.readerSentenceIndex];
  if (!immersive || !sentence) return render();
  const translated = article.sentences.filter(item => item.translation?.trim()).length;
  const progress = article.sentences.length ? Math.round(translated / article.sentences.length * 100) : 0;
  immersive.querySelector('main').innerHTML = immersiveSentenceMarkup(article, sentence);
  const progressBar = immersive.querySelector('.immersive-progress i');
  if (progressBar) progressBar.style.width = `${progress}%`;
  const progressText = immersive.querySelector('.immersive-progress span');
  if (progressText) progressText.textContent = `${ui.readerSentenceIndex + 1} / ${article.sentences.length}`;
  const previous = immersive.querySelector('[data-reader-sentence="-1"]');
  const next = immersive.querySelector('[data-reader-sentence="1"]');
  if (previous) previous.disabled = ui.readerSentenceIndex <= 0;
  if (next) next.disabled = ui.readerSentenceIndex >= article.sentences.length - 1;
  const status = immersive.querySelector('.immersive-navigation > span');
  if (status) status.textContent = sentence.difficult ? '◆ 长难句' : '逐句精读';
  immersive.querySelectorAll('[data-word]').forEach(button => button.addEventListener('click', () => openWordDefinition(button.dataset.word)));
  immersive.querySelector('[data-immersive-translation]')?.addEventListener('input', syncImmersiveTranslation);
  immersive.querySelector('main')?.scrollTo({ top: 0 });
}

function syncImmersiveTranslation(event) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  const sentence = article?.sentences[ui.readerSentenceIndex];
  if (!sentence) return;
  sentence.translation = event.target.value;
}

function pomodoroMarkup() {
  const minutes = Math.floor(ui.pomodoroRemaining / 60);
  const seconds = ui.pomodoroRemaining % 60;
  const time = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const label = ui.pomodoroMode === 'focus' ? '专注' : '休息';
  const duration = ui.pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
  const progress = Math.max(0, Math.min(100, (duration - ui.pomodoroRemaining) / duration * 100));
  const sprite = [
    '......ggg......',
    '....ggggggg....',
    '...ggggggggg...',
    '..rrrrrrrrrrr..',
    '.rrhhrrrrrrrrr.',
    'rrrrkrrrrrkrrrr',
    'rrrrrrrrrrrrrrr',
    'rrrrrrrrrrrrrrr',
    '.rrrrkrrrkrrrr.',
    '.rrrrrkkkrrrrr.',
    '..rrrrrrrrrrr..',
    '...rrrrrrrrr...',
    '.....rrrrr.....',
  ].flatMap((row, y) => [...row].map((color, x) => color === '.' ? '' : `<i class="pixel-${color}" style="--pixel-x:${x};--pixel-y:${y}"></i>`)).join('');
  return `<aside class="tomato-timer ${ui.pomodoroRunning ? 'is-running' : ''} ${ui.pomodoroMode === 'break' ? 'is-break' : ''} ${ui.pomodoroPanelOpen ? 'is-open' : ''}">
    <button class="tomato-trigger" type="button" data-pomodoro-panel-toggle aria-expanded="${ui.pomodoroPanelOpen}" aria-label="番茄时钟，${label} ${time}，打开计时控制">
      <span class="tomato-progress" style="--timer-progress:${progress}%" aria-hidden="true"></span>
      <span class="pixel-tomato" aria-hidden="true">${sprite}</span>
      <span class="tomato-clock"><small>${label}</small><b data-pomodoro-time>${time}</b></span>
      <span class="tomato-status" aria-hidden="true">${ui.pomodoroRunning ? '计时中' : '待开始'}</span>
    </button>
    <section class="tomato-panel" aria-label="番茄时钟控制">
      <header><div><span>POMODORO</span><b>${label}时间</b></div><em>${ui.pomodoroMode === 'focus' ? '25 MIN' : '5 MIN'}</em></header>
      <p>用 25 分钟专注精读，再休息 5 分钟。短时段更容易保持注意力。</p>
      <div class="tomato-mode-switch" role="group" aria-label="选择计时阶段"><button type="button" class="${ui.pomodoroMode === 'focus' ? 'active' : ''}" data-pomodoro-mode="focus">专注 25:00</button><button type="button" class="${ui.pomodoroMode === 'break' ? 'active' : ''}" data-pomodoro-mode="break">休息 05:00</button></div>
      <div class="tomato-panel-progress" role="progressbar" aria-label="${label}计时进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><i data-pomodoro-progress style="width:${progress}%"></i></div>
      <div class="tomato-actions"><button class="primary" type="button" data-pomodoro-toggle>${ui.pomodoroRunning ? '暂停计时' : '开始计时'}</button><button type="button" data-pomodoro-reset>重置</button></div>
      <label class="tomato-auto-start"><input type="checkbox" data-pomodoro-auto ${ui.pomodoroAutoStart ? 'checked' : ''}> 本阶段结束后自动开始下一阶段</label>
    </section>
  </aside>`;
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
  const aiDefinition = definition?.aiContexts?.[state.sentenceId] || null;
  return `
    <dialog class="word-dialog" id="wordDialog">
      <header>
        <div><span>DEEPSEEK DICTIONARY</span><h2>${esc(state.word)}</h2>${aiDefinition?.phonetic ? `<p>${esc(aiDefinition.phonetic)}</p>` : ''}</div>
        <div class="word-dialog-head-actions">
          <b>已标记生词</b>
          <button type="button" class="word-audio-button" data-speak-word="${esc(state.word)}">▶ 发音</button>
          <button type="button" class="word-dialog-close" data-close-word-dialog aria-label="关闭单词释义">关闭 ×</button>
        </div>
      </header>
      <div class="word-dialog-content">
        <div class="word-bilingual-dictionary">${aiWordDefinitionMarkup(state, aiDefinition)}</div>
        <label class="word-chinese-note"><span>我的中文笔记</span><textarea id="wordChineseNote" placeholder="写下适合本文语境的中文意思或记忆提示…">${esc(note)}</textarea></label>
      </div>
      <footer><small>再次点击单词不会取消生词；请在上方生词列表中点“×”移除。</small><div><button type="button" class="outline" data-close-word-dialog>关闭</button><button type="button" class="primary" data-save-word-note>保存释义</button></div></footer>
    </dialog>`;
}

function aiWordDefinitionMarkup(state, entry) {
  const status = state.aiStatus || (entry ? 'ready' : ui.aiApiKey ? 'idle' : 'needs-key');
  if (!state.sentenceId) return '';
  return `<section class="word-dictionary-section word-ai-dictionary">
    <div class="word-section-title"><span>中英双语词典</span><b>DEEPSEEK</b></div>
    ${status === 'loading' ? '<div class="word-ai-loading"><i></i><span>正在生成中英双语词典释义…</span></div>' : ''}
    ${status === 'needs-key' ? '<div class="word-ai-empty"><p>填写 DeepSeek API 密钥后，可获得中文释义、英文释义和本文语境义。</p><button type="button" data-open-word-ai-settings>设置 DeepSeek API</button></div>' : ''}
    ${status === 'error' ? `<div class="word-ai-empty"><p>${esc(state.aiError || 'AI 语境释义生成失败。')}</p><button type="button" data-generate-ai-word="${esc(state.word)}">重新生成</button></div>` : ''}
    ${entry ? `<div class="word-ai-result ai-dictionary-entry">
      <div class="ai-dictionary-heading"><strong>${esc(entry.headword || state.word)}</strong>${entry.phonetic ? `<em>${esc(entry.phonetic)}</em>` : ''}${entry.partOfSpeech ? `<span>${esc(entry.partOfSpeech)}</span>` : ''}</div>
      <section><h3>中文释义</h3><ol>${(entry.chineseDefinitions || [entry.meaning]).filter(Boolean).map(item => `<li>${esc(item)}</li>`).join('')}</ol></section>
      <section lang="en"><h3>English definition</h3><ol>${(entry.englishDefinitions || []).filter(Boolean).map(item => `<li>${esc(item)}</li>`).join('') || '<li>No English definition returned.</li>'}</ol></section>
      <div class="ai-context-meaning"><span>本文语境</span><p><b>中：</b>${esc(entry.contextMeaningZh || entry.explanation || '')}</p><p lang="en"><b>EN:</b> ${esc(entry.contextMeaningEn || '')}</p></div>
      ${entry.collocation ? `<small><b>语境搭配</b>${esc(entry.collocation)}</small>` : ''}
      ${entry.example ? `<small><b>例句</b>${esc(entry.example)}</small>` : ''}
      <footer><span>基于当前句及前后语境 · 已缓存</span><button type="button" data-generate-ai-word="${esc(state.word)}">重新生成</button></footer>
    </div>` : status === 'idle' ? `<div class="word-ai-empty"><p>可以让 AI 结合当前文章语境解释这个词。</p><button type="button" data-generate-ai-word="${esc(state.word)}">生成语境释义</button></div>` : ''}
  </section>`;
}

function sentenceCard(sentence, index, article) {
  const difficult = sentence.difficult ? 'difficult' : '';
  const checkOpen = ui.translationCheckIds.has(sentence.id);
  const reference = sentence.referenceTranslation || '';
  const generation = ui.translationGeneration.get(sentence.id);
  const referenceService = 'DeepSeek AI 上下文翻译';
  const review = sentence.aiTranslationReview || null;
  const reviewState = ui.translationReview.get(sentence.id);
  return `
    <article class="sentence-card ${difficult}" data-sentence-id="${sentence.id}">
      <header><span>${String(index + 1).padStart(2, '0')}</span><button data-toggle-difficult="${sentence.id}">${sentence.difficult ? '◆ 已标记长难句' : '◇ 标记长难句'}</button></header>
      <p class="sentence-text">${tokenize(sentence.text).map(token => /^[A-Za-z]/.test(token)
        ? `<button class="${article.vocabulary.some(word => word.toLowerCase() === token.toLowerCase()) ? 'marked' : ''}" data-word="${esc(token)}">${esc(token)}</button>`
        : esc(token)).join('')}</p>
      <label>中文翻译<textarea data-translation placeholder="写下你对这句话的理解…">${esc(sentence.translation || '')}</textarea></label>
      <label>语法或阅读笔记<textarea data-notes rows="3" placeholder="记下句子结构、阅读收获或疑问…">${esc(sentence.notes || '')}</textarea></label>
      <section class="notes-ai-assistant ${review ? 'has-review' : ''}">
        <div class="notes-ai-action">
          <div><span>AI 阅读助手</span><small>结合原句、上下文和你的译文给出建议</small></div>
          <button type="button" data-review-translation="${sentence.id}" ${reviewState?.status === 'loading' ? 'disabled' : ''}>${reviewState?.status === 'loading' ? '正在分析…' : review ? '重新分析' : '检查我的翻译'}</button>
        </div>
        ${reviewState?.status === 'loading' ? '<p class="translation-review-loading"><i></i>正在核对准确性、遗漏信息和中文表达…</p>' : ''}
        ${reviewState?.status === 'error' ? `<p class="translation-generation-error">${esc(reviewState.error)}</p>` : ''}
        ${review ? translationReviewMarkup(sentence, review) : ''}
      </section>
      <section class="translation-check ${checkOpen ? 'is-open' : ''}">
        <button type="button" class="translation-check-toggle" data-toggle-translation-check="${sentence.id}">
          <span>${generation?.status === 'loading' ? '正在生成参考译文…' : '参考译文'}</span><b>${checkOpen ? '收起 −' : '查看 +'}</b>
        </button>
        ${checkOpen ? `
          <div class="translation-check-body">
            <label class="reference-translation-only"><span>参考译文</span><textarea data-reference-translation placeholder="正在等待生成，也可以直接填写…" ${generation?.status === 'loading' ? 'aria-busy="true"' : ''}>${esc(reference)}</textarea></label>
            ${generation?.status === 'loading' ? '<p class="translation-generating"><i></i>在线翻译正在生成，首次使用可能需要几秒钟。</p>' : ''}
            ${generation?.status === 'error' ? `<p class="translation-generation-error">${esc(generation.error)}</p>` : ''}
            <footer><small class="translation-source-line"><span>${referenceService} · 结果仅供核对，可修改。</span><button class="translation-settings-gear" type="button" data-open-translation-settings aria-label="DeepSeek AI 设置" aria-expanded="${ui.translationSettingsOpen}"><b aria-hidden="true">⚙</b><i role="tooltip">DeepSeek AI 设置</i></button></small><div><button type="button" class="text-button" data-generate-reference="${sentence.id}" ${generation?.status === 'loading' ? 'disabled' : ''}>${reference ? '重新生成' : generation?.status === 'error' ? '重试生成' : '立即生成'}</button><button type="button" class="outline" data-save-reference="${sentence.id}" ${generation?.status === 'loading' ? 'disabled' : ''}>保存参考译文</button></div></footer>
          </div>` : ''}
      </section>
      <details><summary>校对识别文字</summary><textarea data-sentence-text>${esc(sentence.text)}</textarea></details>
    </article>
  `;
}

function translationReviewMarkup(sentence, review) {
  const strengths = Array.isArray(review.strengths) ? review.strengths : [];
  const issues = Array.isArray(review.issues) ? review.issues : [];
  return `<details class="ai-reading-notes" open><summary>✦ AI 阅读建议</summary><div class="translation-review-result">
    <p>${esc(review.summary || review.verdict || '')}</p>
    <div class="translation-review-columns">
      <section><span>做得好的地方</span>${strengths.length ? `<ul>${strengths.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p>暂无补充。</p>'}</section>
      <section><span>需要改进</span>${issues.length ? `<ul>${issues.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p>没有明显误译或遗漏。</p>'}</section>
    </div>
    <section class="integrated-translation"><span>整合译文</span><p>${esc(review.integratedTranslation || '')}</p><button type="button" data-use-integrated-translation="${sentence.id}">采用这版译文</button></section>
  </div></details>`;
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
  bindHeroCarousel();
  document.querySelectorAll('[data-open-translation-settings]').forEach(button => button.addEventListener('click', () => {
    ui.translationSettingsOpen = !ui.translationSettingsOpen;
    render();
  }));
  document.querySelectorAll('[data-close-translation-settings]').forEach(button => button.addEventListener('click', () => {
    ui.translationSettingsOpen = false;
    render();
  }));
  document.querySelector('[data-translation-settings-overlay]')?.addEventListener('click', event => {
    if (event.target !== event.currentTarget) return;
    ui.translationSettingsOpen = false;
    render();
  });
  document.querySelector('[data-translation-settings-form]')?.addEventListener('submit', saveTranslationSettings);
  document.querySelector('[data-toggle-api-key]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    const input = document.querySelector('#translationApiKey');
    if (!input) return;
    const revealing = input.type === 'password';
    input.type = revealing ? 'text' : 'password';
    button.setAttribute('aria-pressed', revealing ? 'true' : 'false');
    button.setAttribute('aria-label', revealing ? '隐藏 API 密钥' : '显示 API 密钥');
    button.querySelector('b').textContent = revealing ? '隐藏' : '显示';
  });

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    ui.view = button.dataset.view;
    ui.selectedArticleId = null;
    ui.sourceDialog = false;
    ui.sourcePreviewArticleId = null;
    ui.articleEditId = null;
    ui.wordDialog = null;
    ui.immersiveOpen = false;
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
    ui.aiCompanionOpen = false;
    ui.aiCompanionMessages = [];
    ui.aiCompanionError = '';
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
    if (event.key === 'Escape' && ui.immersiveOpen) {
      event.preventDefault();
      closeImmersiveReader();
      return;
    }
    if (event.key === 'Escape' && ui.translationSettingsOpen) {
      event.preventDefault();
      ui.translationSettingsOpen = false;
      render();
      return;
    }
    if (event.key === 'Escape' && ui.aiCompanionOpen) {
      event.preventDefault();
      ui.aiCompanionOpen = false;
      render();
      return;
    }
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
  document.querySelectorAll('[data-review-translation]').forEach(button => button.addEventListener('click', () => reviewTranslationWithAi(button.dataset.reviewTranslation)));
  document.querySelectorAll('[data-use-integrated-translation]').forEach(button => button.addEventListener('click', () => useIntegratedTranslation(button.dataset.useIntegratedTranslation)));
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
  document.querySelector('[data-retry-word]')?.addEventListener('click', () => loadAiWordDefinition(ui.wordDialog?.word, ui.wordDialog?.sentenceId, true));
  document.querySelector('[data-open-word-ai-settings]')?.addEventListener('click', () => {
    ui.translationSettingsOpen = true;
    render();
  });
  document.querySelectorAll('[data-generate-ai-word]').forEach(button => button.addEventListener('click', () => {
    loadAiWordDefinition(button.dataset.generateAiWord, ui.wordDialog?.sentenceId, true);
  }));
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
  if (wordDialog && !ui.translationSettingsOpen && !wordDialog.open) {
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
  document.querySelector('[data-open-immersive]')?.addEventListener('click', openImmersiveReader);
  document.querySelectorAll('[data-toggle-ai-companion]').forEach(button => button.addEventListener('click', () => {
    if (Date.now() < companionDragUntil) return;
    const article = ui.articles.find(item => item.id === ui.selectedArticleId);
    if (article) collectReader(article);
    ui.aiCompanionOpen = !ui.aiCompanionOpen;
    ui.aiCompanionError = '';
    render();
    if (ui.aiCompanionOpen) requestAnimationFrame(() => document.querySelector('[data-ai-companion-form] textarea')?.focus());
  }));
  bindCompanionDrag();
  document.querySelectorAll('[data-ai-suggestion]').forEach(button => button.addEventListener('click', () => sendAiCompanionQuestion(button.dataset.aiSuggestion)));
  document.querySelector('[data-ai-companion-form]')?.addEventListener('submit', event => {
    event.preventDefault();
    sendAiCompanionQuestion(event.currentTarget.elements.question?.value);
  });
  document.querySelector('[data-close-immersive]')?.addEventListener('click', closeImmersiveReader);
  document.querySelector('[data-immersive-translation]')?.addEventListener('input', syncImmersiveTranslation);
  document.querySelector('[data-pomodoro-panel-toggle]')?.addEventListener('click', () => {
    if (tomatoWasDragged) {
      tomatoWasDragged = false;
      return;
    }
    ui.pomodoroPanelOpen = !ui.pomodoroPanelOpen;
    render();
  });
  bindPomodoroDrag();
  const tomatoTimer = document.querySelector('.tomato-timer');
  tomatoTimer?.addEventListener('mouseleave', () => {
    ui.pomodoroPanelOpen = false;
    tomatoTimer.classList.remove('is-open');
    tomatoTimer.querySelector('[data-pomodoro-panel-toggle]')?.setAttribute('aria-expanded', 'false');
    if (tomatoTimer.contains(document.activeElement)) document.activeElement.blur();
  });
  document.querySelector('[data-pomodoro-toggle]')?.addEventListener('click', togglePomodoro);
  document.querySelector('[data-pomodoro-reset]')?.addEventListener('click', resetPomodoro);
  document.querySelectorAll('[data-pomodoro-mode]').forEach(button => button.addEventListener('click', () => switchPomodoroMode(button.dataset.pomodoroMode)));
  document.querySelector('[data-pomodoro-auto]')?.addEventListener('change', event => {
    ui.pomodoroAutoStart = event.target.checked;
    try { localStorage.setItem('reading-request-pomodoro-auto', ui.pomodoroAutoStart ? '1' : '0'); } catch {}
  });
  document.querySelector('[data-add-sentence]')?.addEventListener('click', addSentence);
  document.querySelectorAll('[data-reader-sentence]').forEach(button => button.addEventListener('click', () => changeReaderSentence(Number(button.dataset.readerSentence))));
  if (ui.view === 'reader') queueMissingDifficultTranslations();
}

function bindHeroCarousel() {
  clearInterval(heroCarouselTimer);
  const carousel = document.querySelector('[data-hero-carousel]');
  if (!carousel) return;
  const slides = [...carousel.querySelectorAll('[data-hero-slide]')];
  const dots = [...carousel.querySelectorAll('[data-hero-dot]')];
  const show = index => {
    ui.heroSlide = (index + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === ui.heroSlide;
      slide.classList.toggle('active', active);
      slide.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    dots.forEach((dot, dotIndex) => {
      const active = dotIndex === ui.heroSlide;
      dot.classList.toggle('active', active);
      dot.setAttribute('aria-current', active ? 'true' : 'false');
    });
  };
  const start = () => {
    clearInterval(heroCarouselTimer);
    if (slides.length > 1) heroCarouselTimer = setInterval(() => show(ui.heroSlide + 1), 5600);
  };
  carousel.querySelectorAll('[data-hero-step]').forEach(button => button.addEventListener('click', () => {
    show(ui.heroSlide + Number(button.dataset.heroStep));
    start();
  }));
  dots.forEach(dot => dot.addEventListener('click', () => {
    show(Number(dot.dataset.heroDot));
    start();
  }));
  carousel.addEventListener('mouseenter', () => clearInterval(heroCarouselTimer));
  carousel.addEventListener('mouseleave', start);
  start();
}

async function openImmersiveReader() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (article) collectReader(article);
  ui.immersiveOpen = true;
  render();
  if (window.innerWidth > 760) try { await document.documentElement.requestFullscreen?.(); } catch {}
}

async function closeImmersiveReader() {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (article) {
    const input = document.querySelector('[data-immersive-translation]');
    if (input && article.sentences[ui.readerSentenceIndex]) article.sentences[ui.readerSentenceIndex].translation = input.value;
    article.updatedAt = new Date().toISOString();
    await records.put('articles', article);
  }
  ui.immersiveOpen = false;
  if (document.fullscreenElement) try { await document.exitFullscreen(); } catch {}
  render();
}

function tomatoPositionBounds(timer) {
  const margin = window.innerWidth <= 760 ? 10 : 14;
  const immersiveNavigation = document.querySelector('.immersive-navigation');
  const reservedBottom = immersiveNavigation ? immersiveNavigation.offsetHeight + margin : margin;
  return {
    minX: margin,
    minY: margin,
    maxX: Math.max(margin, window.innerWidth - timer.offsetWidth - margin),
    maxY: Math.max(margin, window.innerHeight - timer.offsetHeight - reservedBottom),
  };
}

function updateTomatoPanelDirection(timer) {
  const rect = timer.getBoundingClientRect();
  timer.classList.toggle('panel-below', rect.top < 260);
  timer.classList.toggle('panel-left', rect.left < 320);
}

function applySavedTomatoPosition(timer) {
  try {
    const saved = JSON.parse(localStorage.getItem('reading-request-tomato-position'));
    if (!Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) return updateTomatoPanelDirection(timer);
    const bounds = tomatoPositionBounds(timer);
    timer.style.left = `${bounds.minX + saved.x * (bounds.maxX - bounds.minX)}px`;
    timer.style.top = `${bounds.minY + saved.y * (bounds.maxY - bounds.minY)}px`;
    timer.style.right = 'auto';
    timer.style.bottom = 'auto';
  } catch {}
  updateTomatoPanelDirection(timer);
}

function saveTomatoPosition(timer) {
  const bounds = tomatoPositionBounds(timer);
  const rect = timer.getBoundingClientRect();
  const x = bounds.maxX === bounds.minX ? 0 : (rect.left - bounds.minX) / (bounds.maxX - bounds.minX);
  const y = bounds.maxY === bounds.minY ? 0 : (rect.top - bounds.minY) / (bounds.maxY - bounds.minY);
  try {
    localStorage.setItem('reading-request-tomato-position', JSON.stringify({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }));
  } catch {}
}

function bindPomodoroDrag() {
  const timer = document.querySelector('.tomato-timer');
  const trigger = timer?.querySelector('.tomato-trigger');
  if (!timer || !trigger) return;
  applySavedTomatoPosition(timer);
  let drag = null;
  trigger.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = timer.getBoundingClientRect();
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
    trigger.setPointerCapture(event.pointerId);
    timer.classList.add('is-dragging');
  });
  trigger.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    tomatoWasDragged = true;
    const bounds = tomatoPositionBounds(timer);
    timer.style.left = `${Math.max(bounds.minX, Math.min(bounds.maxX, drag.left + dx))}px`;
    timer.style.top = `${Math.max(bounds.minY, Math.min(bounds.maxY, drag.top + dy))}px`;
    timer.style.right = 'auto';
    timer.style.bottom = 'auto';
    updateTomatoPanelDirection(timer);
  });
  const endDrag = event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
    timer.classList.remove('is-dragging');
    if (drag.moved) {
      saveTomatoPosition(timer);
      setTimeout(() => { tomatoWasDragged = false; }, 0);
    }
    drag = null;
  };
  trigger.addEventListener('pointerup', endDrag);
  trigger.addEventListener('pointercancel', endDrag);
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
  const immersiveInput = document.querySelector('[data-immersive-translation]');
  if (immersiveInput && article.sentences[ui.readerSentenceIndex]) {
    article.sentences[ui.readerSentenceIndex].translation = immersiveInput.value;
  }
  if (!ui.immersiveOpen) collectReader(article);
  const nextIndex = Math.max(0, Math.min(article.sentences.length - 1, ui.readerSentenceIndex + direction));
  if (nextIndex === ui.readerSentenceIndex) return;
  article.updatedAt = new Date().toISOString();
  ui.readerCardDirection = direction < 0 ? 'prev' : 'next';
  ui.readerSentenceIndex = nextIndex;
  if (ui.immersiveOpen) updateImmersiveSentence(article);
  else {
    render();
    document.querySelector('.sentence-list')?.scrollTo({ top: 0 });
  }
  await records.put('articles', article);
  await recordStudySnapshot(article);
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
  const duration = ui.pomodoroMode === 'focus' ? 25 * 60 : 5 * 60;
  const progress = Math.max(0, Math.min(100, (duration - ui.pomodoroRemaining) / duration * 100));
  const timer = element.closest('.tomato-timer');
  timer?.querySelector('.tomato-trigger')?.setAttribute('aria-label', `番茄时钟，${ui.pomodoroMode === 'focus' ? '专注' : '休息'} ${element.textContent}，打开计时控制`);
  const progressElement = timer?.querySelector('[data-pomodoro-progress]');
  if (progressElement) progressElement.style.width = `${progress}%`;
  progressElement?.parentElement?.setAttribute('aria-valuenow', String(Math.round(progress)));
  timer?.querySelector('.tomato-progress')?.style.setProperty('--timer-progress', `${progress}%`);
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
  if (ui.pomodoroAutoStart) {
    ui.pomodoroRunning = true;
    ui.pomodoroEndsAt = Date.now() + ui.pomodoroRemaining * 1000;
  }
  render();
  if (ui.pomodoroRunning) pomodoroTimer = setInterval(tickPomodoro, 250);
  toast(ui.pomodoroMode === 'break'
    ? `25 分钟专注完成，${ui.pomodoroAutoStart ? '5 分钟休息倒计时已开始。' : '现在休息 5 分钟吧。'}`
    : `休息结束，${ui.pomodoroAutoStart ? '下一轮专注已开始。' : '可以开始下一轮精读。'}`);
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
  ui.pomodoroPanelOpen = false;
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

function switchPomodoroMode(mode) {
  if (!['focus', 'break'].includes(mode) || mode === ui.pomodoroMode) return;
  clearInterval(pomodoroTimer);
  ui.pomodoroMode = mode;
  ui.pomodoroRemaining = mode === 'focus' ? 25 * 60 : 5 * 60;
  ui.pomodoroRunning = false;
  ui.pomodoroEndsAt = null;
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
    const nextTranslation = card.querySelector('[data-translation]')?.value || '';
    const referenceInput = card.querySelector('[data-reference-translation]');
    const nextReference = referenceInput ? referenceInput.value.trim() : sentence.referenceTranslation || '';
    if (nextTranslation !== (sentence.translation || '') || nextReference !== (sentence.referenceTranslation || '')) {
      delete sentence.aiTranslationReview;
      ui.translationReview.delete(sentence.id);
    }
    sentence.translation = nextTranslation;
    sentence.notes = card.querySelector('[data-notes]')?.value || '';
    if (referenceInput) sentence.referenceTranslation = nextReference;
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
  const cached = storedDefinition || null;
  const contextSentence = article.sentences[ui.readerSentenceIndex] || null;
  const aiCached = contextSentence ? cached?.aiContexts?.[contextSentence.id] : null;
  ui.wordDialog = {
    word,
    sentenceId: contextSentence?.id || null,
    status: 'ready',
    definition: cached || null,
    error: '',
    aiStatus: aiCached ? 'ready' : ui.aiApiKey ? 'loading' : 'needs-key',
    aiError: '',
  };
  render();
  await records.put('articles', article);
  if (isNewWord) await recordStudySnapshot(article, 'vocabulary');
  if (ui.aiApiKey && contextSentence && !aiCached) await loadAiWordDefinition(word, contextSentence.id);
}

function confirmDeepSeekWordContext() {
  if (localStorage.getItem('readquest-deepseek-word-context-consent-v1') === '1') return true;
  const allowed = window.confirm('为了生成中英双语词典释义，需要把目标单词、文章标题、所在句及前后各最多两句发送到 DeepSeek API。不会发送 PDF、整篇文章、中文翻译、生词表或个人笔记。是否允许？');
  if (allowed) localStorage.setItem('readquest-deepseek-word-context-consent-v1', '1');
  return allowed;
}

async function requestDeepSeekWordDefinition(article, sentence, word) {
  const context = buildTranslationContext(article, sentence);
  const formatContext = items => items.length ? items.map((text, index) => `${index + 1}. ${text}`).join('\n') : '（无）';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ui.aiApiKey}`,
    },
    body: JSON.stringify({
      model: ui.aiModel || 'deepseek-flash',
      messages: [
        {
          role: 'system',
          content: '你是一名严谨的英汉双语词典编辑。根据文章上下文，为目标英文单词制作词典式条目。只输出一个 JSON 对象，不要 Markdown、代码围栏或额外文字。字段必须为：headword（词头）、phonetic（IPA 音标）、partOfSpeech（英文词性缩写与中文词性）、chineseDefinitions（2至4条中文常用义项字符串数组，语境义放第一条）、englishDefinitions（2至4条清晰简洁的英文释义字符串数组，语境义放第一条）、contextMeaningZh（说明本句具体取义的中文短句）、contextMeaningEn（说明本句具体取义的英文短句）、collocation（本句相关英文搭配及中文解释）、example（一个自然英文例句及中文翻译）。不要翻译整句。',
        },
        {
          role: 'user',
          content: `文章标题：${article.title}\n目标单词：${word}\n\n上文（仅供理解语境）：\n${formatContext(context.before)}\n\n【目标句】\n${sentence.text.trim()}\n\n下文（仅供理解语境）：\n${formatContext(context.after)}\n\n任务：只解释目标单词在【目标句】中的中文含义。`,
        },
      ],
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 700,
      temperature: 0.15,
      stream: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error('DeepSeek API 密钥无效，请在“DeepSeek AI 设置”中检查。');
    if (response.status === 402) throw new Error('DeepSeek API 账户余额不足，请充值后重试。');
    if (response.status === 429) throw new Error('DeepSeek API 请求过快，请稍后重试。');
    throw new Error(data.error?.message || `DeepSeek API 请求失败（${response.status}）。`);
  }
  const outputText = String(data.choices?.[0]?.message?.content || '').trim();
  const jsonText = outputText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('DeepSeek 没有返回可识别的语境释义。');
  let parsed;
  try { parsed = JSON.parse(jsonText.slice(start, end + 1)); } catch { throw new Error('DeepSeek 返回的语境释义格式不完整，请重试。'); }
  const result = {
    headword: String(parsed.headword || word).trim(),
    phonetic: String(parsed.phonetic || '').trim(),
    partOfSpeech: String(parsed.partOfSpeech || '').trim(),
    chineseDefinitions: Array.isArray(parsed.chineseDefinitions) ? parsed.chineseDefinitions.map(item => String(item).trim()).filter(Boolean).slice(0, 4) : [],
    englishDefinitions: Array.isArray(parsed.englishDefinitions) ? parsed.englishDefinitions.map(item => String(item).trim()).filter(Boolean).slice(0, 4) : [],
    contextMeaningZh: String(parsed.contextMeaningZh || parsed.meaning || '').trim(),
    contextMeaningEn: String(parsed.contextMeaningEn || '').trim(),
    collocation: String(parsed.collocation || '').trim(),
    example: String(parsed.example || '').trim(),
    model: ui.aiModel || 'deepseek-flash',
    generatedAt: new Date().toISOString(),
  };
  if (!result.chineseDefinitions.length || !result.englishDefinitions.length) throw new Error('DeepSeek 没有返回完整的中英双语释义，请重试。');
  return result;
}

async function loadAiWordDefinition(wordValue, sentenceId, force = false) {
  const word = String(wordValue || '').trim();
  const articleId = ui.selectedArticleId;
  const article = ui.articles.find(item => item.id === articleId);
  const sentence = article?.sentences.find(item => item.id === sentenceId);
  if (!word || !article || !sentence) return;
  const key = word.toLowerCase();
  const cached = article.wordDefinitions?.[key]?.aiContexts?.[sentenceId];
  if (cached && !force) return;
  if (!ui.aiApiKey) {
    ui.wordDialog = { ...ui.wordDialog, aiStatus: 'needs-key', aiError: '' };
    render();
    return;
  }
  if (!confirmDeepSeekWordContext()) {
    ui.wordDialog = { ...ui.wordDialog, aiStatus: 'idle', aiError: '' };
    render();
    return;
  }
  ui.wordDialog = { ...ui.wordDialog, aiStatus: 'loading', aiError: '' };
  render();
  try {
    const aiDefinition = await requestDeepSeekWordDefinition(article, sentence, word);
    const baseDefinition = article.wordDefinitions?.[key] || {
      dictionaryVersion: 4,
      phonetic: '',
      audio: '',
      origin: '',
      meanings: [],
      chinese: null,
      source: 'DeepSeek AI 语境词典',
    };
    baseDefinition.dictionaryVersion = Math.max(4, baseDefinition.dictionaryVersion || 0);
    baseDefinition.aiContexts ||= {};
    baseDefinition.aiContexts[sentenceId] = aiDefinition;
    ui.wordDialog = { ...ui.wordDialog, status: 'ready', definition: baseDefinition, error: '', aiStatus: 'ready', aiError: '' };
    await cacheWordDefinition(articleId, key, word, baseDefinition);
  } catch (error) {
    if (ui.wordDialog?.word.toLowerCase() === key) {
      ui.wordDialog = { ...ui.wordDialog, aiStatus: 'error', aiError: error.message || 'AI 语境释义生成失败。' };
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
    ui.wordDialog = { ...ui.wordDialog, word, status: 'ready', definition, error: '' };
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

function saveTranslationSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const apiKey = form.querySelector('#translationApiKey')?.value.trim() || '';
  const model = form.querySelector('#translationAiModel')?.value || 'deepseek-flash';
  if (!apiKey) {
    toast('请填写 DeepSeek API 密钥。', true);
    form.querySelector('#translationApiKey')?.focus();
    return;
  }
  ui.aiApiKey = apiKey;
  ui.aiModel = model;
  ui.translationSettingsOpen = false;
  const pendingWord = ui.wordDialog?.word;
  const pendingSentenceId = ui.wordDialog?.sentenceId;
  try {
    localStorage.setItem('readquest-deepseek-model', model);
    if (apiKey) sessionStorage.setItem('readquest-deepseek-api-key', apiKey);
    else sessionStorage.removeItem('readquest-deepseek-api-key');
  } catch {}
  render();
  if (apiKey && pendingWord && pendingSentenceId) loadAiWordDefinition(pendingWord, pendingSentenceId);
  toast('DeepSeek 已用于参考译文、译文校验、双语词典和 AI 精灵。');
}

function buildTranslationContext(article, sentence, radius = 2) {
  const sentences = Array.isArray(article.sentences) ? article.sentences : [];
  const targetIndex = sentences.findIndex(item => item.id === sentence.id);
  if (targetIndex < 0) return { before: [], after: [] };
  const cleanText = item => String(item?.text || '').trim();
  return {
    before: sentences.slice(Math.max(0, targetIndex - radius), targetIndex).map(cleanText).filter(Boolean),
    after: sentences.slice(targetIndex + 1, targetIndex + radius + 1).map(cleanText).filter(Boolean),
  };
}

async function requestDeepSeekTranslation(article, sentence) {
  const context = buildTranslationContext(article, sentence);
  const formatContext = items => items.length
    ? items.map((text, index) => `${index + 1}. ${text}`).join('\n')
    : '（无）';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ui.aiApiKey}`,
    },
    body: JSON.stringify({
      model: ui.aiModel || 'deepseek-flash',
      messages: [
        { role: 'system', content: '你是一名严谨的英语精读教师。请结合文章标题、上文和下文理解词义、指代、时态和语气，但只翻译标记为“目标句”的英文。译文应自然、准确，忠实保留目标句的逻辑和关键信息，长难句要体现从句关系。不要翻译相邻句；只输出一条目标句的简体中文译文，不要解释、序号、引号或其他内容。' },
        {
          role: 'user',
          content: `文章标题：${article.title}\n\n上文（仅供理解语境）：\n${formatContext(context.before)}\n\n【目标句】\n${sentence.text.trim()}\n\n下文（仅供理解语境）：\n${formatContext(context.after)}\n\n任务：只翻译【目标句】，不要翻译上文或下文。`,
        },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 300,
      temperature: 0.2,
      stream: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error('DeepSeek API 密钥无效，请在“译文设置”中检查。');
    if (response.status === 402) throw new Error('DeepSeek API 账户余额不足，请充值后重试。');
    if (response.status === 429) throw new Error('DeepSeek API 请求过快，请稍后重试。');
    throw new Error(data.error?.message || `DeepSeek API 请求失败（${response.status}）。`);
  }
  const outputText = String(data.choices?.[0]?.message?.content || '').trim();
  if (!outputText) throw new Error('DeepSeek API 没有返回可用的参考译文。');
  return outputText.replace(/^\s*[“"]|[”"]\s*$/g, '').trim();
}

function parseDeepSeekJson(outputText, errorMessage) {
  const clean = String(outputText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(errorMessage);
  try { return JSON.parse(clean.slice(start, end + 1)); } catch { throw new Error(errorMessage); }
}

async function requestDeepSeekTranslationReview(article, sentence) {
  const context = buildTranslationContext(article, sentence);
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ui.aiApiKey}` },
    body: JSON.stringify({
      model: ui.aiModel || 'deepseek-flash',
      messages: [
        { role: 'system', content: '你是一名严格但鼓励学生的英语精读教师。对照英文原句、学生译文和参考译文，检查信息准确性、逻辑关系、语气、指代和中文表达。只输出 JSON 对象，不要 Markdown。字段必须为：score（0至100整数）、verdict（短标题）、summary（两句话以内）、strengths（字符串数组，最多3项）、issues（字符串数组，最多4项，每项明确指出问题和改法）、integratedTranslation（吸收学生译文优点并修正问题后的完整中文译文）。参考译文也可能有误，必须以英文原句和上下文为准。' },
        { role: 'user', content: `文章标题：${article.title}\n上文：${context.before.join(' ') || '（无）'}\n【英文原句】${sentence.text.trim()}\n下文：${context.after.join(' ') || '（无）'}\n【我的译文】${sentence.translation.trim()}\n【参考译文】${sentence.referenceTranslation.trim()}\n请校验并整合。` },
      ],
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 900,
      temperature: 0.15,
      stream: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error('DeepSeek API 密钥无效，请在设置中检查。');
    if (response.status === 402) throw new Error('DeepSeek API 账户余额不足，请充值后重试。');
    if (response.status === 429) throw new Error('DeepSeek API 请求过快，请稍后重试。');
    throw new Error(data.error?.message || `DeepSeek API 请求失败（${response.status}）。`);
  }
  const parsed = parseDeepSeekJson(data.choices?.[0]?.message?.content, 'DeepSeek 返回的校验结果格式不完整，请重试。');
  const result = {
    score: Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0))),
    verdict: String(parsed.verdict || '校验完成').trim(),
    summary: String(parsed.summary || '').trim(),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String).map(item => item.trim()).filter(Boolean).slice(0, 3) : [],
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).map(item => item.trim()).filter(Boolean).slice(0, 4) : [],
    integratedTranslation: String(parsed.integratedTranslation || '').trim(),
    generatedAt: new Date().toISOString(),
    model: ui.aiModel || 'deepseek-flash',
  };
  if (!result.integratedTranslation) throw new Error('DeepSeek 没有返回整合译文，请重试。');
  return result;
}

async function reviewTranslationWithAi(sentenceId) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === sentenceId);
  if (!sentence?.translation?.trim()) return toast('请先写下自己的中文翻译。', true);
  if (!sentence.referenceTranslation?.trim()) return toast('请先生成或填写参考译文，再进行 AI 校验。', true);
  if (!ui.aiApiKey) {
    ui.translationSettingsOpen = true;
    render();
    return toast('请先填写 DeepSeek API 密钥。', true);
  }
  if (localStorage.getItem('readquest-deepseek-review-consent-v1') !== '1') {
    const allowed = window.confirm('AI 校验需要把文章标题、英文原句及前后各最多两句、你的中文译文和参考译文发送到 DeepSeek API。不会发送 PDF、生词表或其他笔记。是否允许？');
    if (!allowed) return;
    localStorage.setItem('readquest-deepseek-review-consent-v1', '1');
  }
  ui.translationReview.set(sentenceId, { status: 'loading', error: '' });
  render();
  try {
    sentence.aiTranslationReview = await requestDeepSeekTranslationReview(article, sentence);
    article.updatedAt = new Date().toISOString();
    await records.put('articles', article);
    ui.translationReview.delete(sentenceId);
    await refreshData();
    render();
    toast('AI 校验完成，已生成整合译文。');
  } catch (error) {
    ui.translationReview.set(sentenceId, { status: 'error', error: error.message || 'AI 校验失败，请重试。' });
    render();
  }
}

async function useIntegratedTranslation(sentenceId) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === sentenceId);
  const integrated = sentence?.aiTranslationReview?.integratedTranslation?.trim();
  if (!integrated) return;
  sentence.translation = integrated;
  article.updatedAt = new Date().toISOString();
  await records.put('articles', article);
  render();
  toast('整合译文已填入“中文翻译”，原校验结果仍保留。');
}

async function requestDeepSeekCompanion(article, sentence, messages) {
  const context = sentence ? buildTranslationContext(article, sentence, 1) : { before: [], after: [] };
  const learningContext = sentence
    ? `文章标题：${article.title}\n上文：${context.before.join(' ') || '（无）'}\n当前英文句：${sentence.text}\n下文：${context.after.join(' ') || '（无）'}\n学生译文：${sentence.translation || '（未填写）'}\n参考译文：${sentence.referenceTranslation || '（未生成）'}`
    : `文章标题：${article.title}`;
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ui.aiApiKey}` },
    body: JSON.stringify({
      model: ui.aiModel || 'deepseek-flash',
      messages: [
        { role: 'system', content: `你是精读任务站的 AI 精灵，是耐心、准确的英语阅读伙伴。优先围绕给定的当前句回答词义、语法、结构、指代、翻译和表达问题。先直接回答，再用简短例子帮助理解；不要假装看到了未提供的文章内容。\n\n当前学习上下文：\n${learningContext}` },
        ...messages.slice(-8).map(item => ({ role: item.role, content: item.content })),
      ],
      thinking: { type: 'disabled' },
      max_tokens: 1000,
      temperature: 0.35,
      stream: false,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error('DeepSeek API 密钥无效，请在设置中检查。');
    if (response.status === 402) throw new Error('DeepSeek API 账户余额不足。');
    if (response.status === 429) throw new Error('提问过快，请稍后再试。');
    throw new Error(data.error?.message || `DeepSeek API 请求失败（${response.status}）。`);
  }
  const answer = String(data.choices?.[0]?.message?.content || '').trim();
  if (!answer) throw new Error('AI 精灵暂时没有返回内容，请重试。');
  return answer;
}

async function sendAiCompanionQuestion(questionValue) {
  const question = String(questionValue || '').trim();
  if (!question || ui.aiCompanionSending) return;
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences[ui.readerSentenceIndex] || null;
  if (!ui.aiApiKey) {
    ui.translationSettingsOpen = true;
    render();
    return toast('请先填写 DeepSeek API 密钥。', true);
  }
  if (localStorage.getItem('readquest-deepseek-companion-consent-v1') !== '1') {
    const allowed = window.confirm('AI 精灵会把文章标题、当前英文句及相邻句、当前译文、参考译文和你的问题发送到 DeepSeek API。不会发送 PDF、整篇文章、生词表或其他笔记。是否允许？');
    if (!allowed) return;
    localStorage.setItem('readquest-deepseek-companion-consent-v1', '1');
  }
  ui.aiCompanionMessages.push({ role: 'user', content: question });
  ui.aiCompanionSending = true;
  ui.aiCompanionError = '';
  render();
  try {
    const answer = await requestDeepSeekCompanion(article, sentence, ui.aiCompanionMessages);
    ui.aiCompanionMessages.push({ role: 'assistant', content: answer });
  } catch (error) {
    ui.aiCompanionError = error.message || 'AI 精灵暂时无法回答，请重试。';
  } finally {
    ui.aiCompanionSending = false;
    render();
    requestAnimationFrame(() => {
      const list = document.querySelector('[data-ai-companion-messages]');
      if (list) list.scrollTop = list.scrollHeight;
      document.querySelector('[data-ai-companion-form] textarea')?.focus();
    });
  }
}

async function generateReferenceTranslation(sentenceId, regenerate = false) {
  const article = ui.articles.find(item => item.id === ui.selectedArticleId);
  if (!article) return;
  collectReader(article);
  const sentence = article.sentences.find(item => item.id === sentenceId);
  if (!sentence?.text?.trim() || (!regenerate && sentence.referenceTranslation?.trim())) return;
  if (!ui.aiApiKey) {
    ui.translationGeneration.set(sentenceId, { status: 'error', error: '请先在“译文设置”中填写 DeepSeek API 密钥。' });
    ui.translationSettingsOpen = true;
    render();
    return;
  }
  if (localStorage.getItem('readquest-deepseek-context-consent-v1') !== '1') {
    const allowed = window.confirm('为了结合上下文生成参考译文，需要把文章标题、当前目标句及其前后各最多两句发送到 DeepSeek API。不会发送 PDF、中文翻译、笔记、生词或整篇文章。是否允许？');
    if (!allowed) {
      ui.translationGeneration.set(sentenceId, { status: 'error', error: '未启用 DeepSeek 翻译。你仍可手动填写参考译文。' });
      render();
      return;
    }
    localStorage.setItem('readquest-deepseek-context-consent-v1', '1');
  }
  ui.translationGeneration.set(sentenceId, { status: 'loading', error: '' });
  render();
  try {
    const translatedText = await requestDeepSeekTranslation(article, sentence);
    sentence.referenceTranslation = translatedText;
    sentence.referenceTranslationSource = `DeepSeek · ${ui.aiModel} · 上下文翻译`;
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
