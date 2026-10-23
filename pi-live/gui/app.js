// pi-live browser viewer. Markup and classes follow pi's /export HTML template (template.js), so the
// export stylesheet styles it as-is. State arrives over SSE (/events); commands go to POST /api/send.
(function () {
  'use strict';

  const config = JSON.parse(document.getElementById('pi-live-config').textContent);
  const token = config.token;
  const local = !!config.local;
  const label = local ? 'pi' : 'pi-live';

  // ============================================================
  // HELPERS (same as the export template)
  // ============================================================

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeMarkdownUrl(value) {
    const href = String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, '');
    if (!href) return href;
    const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) return null;
    return href;
  }

  function replaceTabs(text) {
    return text.replace(/\t/g, '   ');
  }

  function shortenPath(p) {
    if (typeof p !== 'string') return '';
    if (p.startsWith('/Users/')) {
      const parts = p.split('/');
      if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
    }
    if (p.startsWith('/home/')) {
      const parts = p.split('/');
      if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
    }
    return p;
  }

  function getLanguageFromPath(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const extToLang = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
      sql: 'sql', html: 'html', css: 'css', scss: 'scss',
      json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
      md: 'markdown', dockerfile: 'dockerfile'
    };
    return extToLang[ext];
  }

  const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
  const markedOptions = {
    breaks: true,
    gfm: true,
    tokenizer: {
      html() { return undefined; },
      tag() { return undefined; },
      del(src) {
        const match = strictStrikethroughRegex.exec(src);
        if (!match) return undefined;
        return { type: 'del', raw: match[0], text: match[2], tokens: this.lexer.inlineTokens(match[2]) };
      }
    },
    renderer: {
      link(token) {
        const href = sanitizeMarkdownUrl(token.href);
        if (href === null) return this.parser.parseInline(token.tokens);
        let out = '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"';
        if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
        return out + '>' + this.parser.parseInline(token.tokens) + '</a>';
      },
      image(token) {
        // Remote images are blocked by the page's CSP; show alt text like an unsafe URL.
        const href = sanitizeMarkdownUrl(token.href);
        if (href === null || !href.startsWith('data:')) return escapeHtml(token.text || '');
        return '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || '') + '">';
      },
      code(token) {
        const code = token.text;
        const lang = token.lang;
        let highlighted;
        if (lang && hljs.getLanguage(lang)) {
          try { highlighted = hljs.highlight(code, { language: lang }).value; } catch { highlighted = escapeHtml(code); }
        } else {
          try { highlighted = hljs.highlightAuto(code).value; } catch { highlighted = escapeHtml(code); }
        }
        return `<pre><code class="hljs">${highlighted}</code></pre>`;
      },
      codespan(token) {
        return `<code>${escapeHtml(token.text)}</code>`;
      }
    }
  };
  if (typeof markedCjkFriendly === 'function') markedOptions.tokenizer.emStrong = markedCjkFriendly().tokenizer.emStrong;
  marked.use(markedOptions);

  function safeMarkedParse(text) {
    try {
      return marked.parse(text);
    } catch {
      return `<p>${escapeHtml(text)}</p>`;
    }
  }

  function formatExpandableOutput(text, maxLines, lang) {
    text = replaceTabs(text);
    const lines = text.split('\n');
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    const expanded = toolOutputsExpanded ? ' expanded' : '';

    if (lang) {
      let highlighted;
      try { highlighted = hljs.highlight(text, { language: lang }).value; } catch { highlighted = escapeHtml(text); }
      if (remaining > 0) {
        let previewHighlighted;
        try { previewHighlighted = hljs.highlight(displayLines.join('\n'), { language: lang }).value; } catch { previewHighlighted = escapeHtml(displayLines.join('\n')); }
        return `<div class="tool-output expandable${expanded}" data-toggle="expanded">
          <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
          <div class="expand-hint">... (${remaining} more lines)</div></div>
          <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
      }
      return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
    }

    if (remaining > 0) {
      let out = `<div class="tool-output expandable${expanded}" data-toggle="expanded">`;
      out += '<div class="output-preview">';
      for (const line of displayLines) out += `<div>${escapeHtml(line)}</div>`;
      out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
      out += '<div class="output-full">';
      for (const line of lines) out += `<div>${escapeHtml(line)}</div>`;
      out += '</div></div>';
      return out;
    }
    let out = '<div class="tool-output">';
    for (const line of displayLines) out += `<div>${escapeHtml(line)}</div>`;
    return out + '</div>';
  }

  // ============================================================
  // STATE
  // ============================================================

  let state = null;
  let items = [];
  let thinkingExpanded = true;
  let toolOutputsExpanded = false;
  let lastNotice = null;

  const messagesEl = document.getElementById('transcript');
  const headerEl = document.getElementById('header-container');
  const composerEl = document.getElementById('composer-container');

  /** Tool result items by tool call id (they render inside the assistant message that made the call). */
  let resultsById = new Map();
  /** Item index → DOM node. */
  let nodes = [];
  /** Tool call id → index of the assistant item that made it. */
  let callOwner = new Map();
  let tailEl = null;

  // ============================================================
  // RENDERING (pi-live items → export markup)
  // ============================================================

  function thinkingHtml(text) {
    return `<div class="thinking-block">
      <div class="thinking-text"${thinkingExpanded ? '' : ' style="display: none"'}>${escapeHtml(text)}</div>
      <div class="thinking-collapsed"${thinkingExpanded ? '' : ' style="display: block"'}>Thinking ...</div>
    </div>`;
  }

  function renderToolCall(call, result) {
    const statusClass = result ? (result.isError ? 'error' : 'success') : 'pending';
    const name = call.name;
    const args = call.args || '';
    const output = result ? result.text.trim() : '';
    let html = `<div class="tool-execution ${statusClass}">`;
    switch (name) {
      case 'bash':
        html += `<div class="tool-command">$ ${escapeHtml(args || '...')}</div>`;
        if (output) html += formatExpandableOutput(output, 5);
        break;
      case 'read': {
        html += `<div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${escapeHtml(shortenPath(args))}</span></div>`;
        const lang = args ? getLanguageFromPath(args) : null;
        if (output) html += formatExpandableOutput(output, 10, lang);
        break;
      }
      case 'write':
      case 'edit':
      case 'ls':
        html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span> <span class="tool-path">${escapeHtml(shortenPath(args))}</span></div>`;
        if (output) html += formatExpandableOutput(output, name === 'ls' ? 20 : 10);
        break;
      default:
        html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
        if (args) html += `<div class="tool-output"><pre>${escapeHtml(args)}</pre></div>`;
        if (output) html += formatExpandableOutput(output, 10);
    }
    html += '</div>';
    return html;
  }

  function renderItem(item) {
    switch (item.k) {
      case 'user':
        return `<div class="user-message"><div class="markdown-content">${safeMarkedParse(item.text)}</div></div>`;
      case 'assistant': {
        let html = '<div class="assistant-message">';
        if (item.thinking && item.thinking.trim()) html += thinkingHtml(item.thinking);
        if (item.text && item.text.trim()) html += `<div class="assistant-text markdown-content">${safeMarkedParse(item.text)}</div>`;
        for (const call of item.calls || []) html += renderToolCall(call, resultsById.get(call.id));
        if (item.error === 'aborted') html += '<div class="error-text">Aborted</div>';
        else if (item.error) html += `<div class="error-text">Error: ${escapeHtml(item.error)}</div>`;
        return html + '</div>';
      }
      case 'tool': {
        // A result without a matching call (e.g. the host's `!command`).
        const isBash = item.text.startsWith('$ ');
        let html = `<div class="tool-execution ${item.isError ? 'error' : 'success'}">`;
        if (isBash) {
          const nl = item.text.indexOf('\n');
          const cmd = nl < 0 ? item.text.slice(2) : item.text.slice(2, nl);
          const out = nl < 0 ? '' : item.text.slice(nl + 1).trim();
          html += `<div class="tool-command">$ ${escapeHtml(cmd)}</div>`;
          if (out) html += formatExpandableOutput(out, 10);
        } else {
          html += `<div class="tool-header"><span class="tool-name">${escapeHtml(item.name)}</span></div>`;
          if (item.text.trim()) html += formatExpandableOutput(item.text.trim(), 10);
        }
        return html + '</div>';
      }
      case 'info': {
        const model = /^\[model → (.*)\]$/.exec(item.text);
        if (model) return `<div class="model-change">Switched to model: <span class="model-name">${escapeHtml(model[1])}</span></div>`;
        if (item.text === '[context compacted]') {
          return `<div class="compaction"><div class="compaction-label">[compaction]</div><div class="compaction-collapsed">Context compacted</div></div>`;
        }
        const tagged = /^\[([^\]\n]+)\] ?([\s\S]*)$/.exec(item.text);
        if (tagged && tagged[1] === 'branch summary') {
          return `<div class="branch-summary"><div class="branch-summary-header">Branch Summary</div><div class="markdown-content">${safeMarkedParse(tagged[2])}</div></div>`;
        }
        if (tagged) {
          return `<div class="hook-message"><div class="hook-type">[${escapeHtml(tagged[1])}]</div><div class="markdown-content">${safeMarkedParse(tagged[2])}</div></div>`;
        }
        return `<div class="hook-message"><div class="markdown-content">${safeMarkedParse(item.text)}</div></div>`;
      }
    }
    return '';
  }

  function toNode(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild || document.createElement('div');
  }

  /** Whether this tool result is shown inside an assistant message instead of on its own. */
  function absorbed(item) {
    return item.k === 'tool' && item.id && callOwner.has(item.id);
  }

  function indexItem(item, i) {
    if (item.k === 'assistant') for (const c of item.calls || []) if (c.id) callOwner.set(c.id, i);
    if (item.k === 'tool' && item.id) resultsById.set(item.id, item);
  }

  function renderAll() {
    resultsById = new Map();
    callOwner = new Map();
    items.forEach(indexItem);
    messagesEl.innerHTML = '';
    nodes = [];
    if (state && state.omitted) {
      messagesEl.appendChild(toNode(`<div class="model-change">… ${state.omitted} earlier messages not shown</div>`));
    }
    items.forEach((item, i) => {
      if (absorbed(item)) return;
      const node = toNode(renderItem(item));
      nodes[i] = node;
      messagesEl.appendChild(node);
    });
    tailEl = null;
  }

  function appendItems(fresh) {
    for (const item of fresh) {
      const i = items.length;
      items.push(item);
      indexItem(item, i);
      if (absorbed(item)) {
        const owner = callOwner.get(item.id);
        const old = nodes[owner];
        if (old) {
          const node = toNode(renderItem(items[owner]));
          old.replaceWith(node);
          nodes[owner] = node;
        }
        continue;
      }
      const node = toNode(renderItem(item));
      nodes[i] = node;
      messagesEl.insertBefore(node, tailEl && tailEl.parentNode === messagesEl ? tailEl : null);
    }
  }

  /** In-flight assistant output and running tools, re-rendered on every update. */
  function renderTail() {
    const s = state;
    let html = '';
    if (s.streaming.thinking.trim() || s.streaming.text.trim()) {
      html += '<div class="assistant-message">';
      if (s.streaming.thinking.trim()) html += thinkingHtml(s.streaming.thinking);
      if (s.streaming.text.trim()) html += `<div class="assistant-text markdown-content">${safeMarkedParse(s.streaming.text)}</div>`;
      html += '</div>';
    }
    // Running tools whose call is already shown as pending in its assistant message are not repeated.
    const loose = s.running.filter((r) => !callOwner.has(r.id));
    if (loose.length) {
      html += '<div class="assistant-message">';
      for (const r of loose) html += renderToolCall({ id: r.id, name: r.name, args: r.args });
      html += '</div>';
    }
    if (!html) {
      if (tailEl) tailEl.remove();
      tailEl = null;
      return;
    }
    const node = toNode(`<div>${html}</div>`);
    node.id = 'live-tail';
    node.style.display = 'contents';
    if (tailEl && tailEl.parentNode) tailEl.replaceWith(node);
    else messagesEl.appendChild(node);
    tailEl = node;
  }

  function statusText(s) {
    if (s.conn === 'live') return 'live';
    return s.detail ? `${s.conn} (${s.detail})` : s.conn;
  }

  let lastHeaderHtml = '';
  function renderHeader() {
    const s = state;
    const title = s.session?.name || s.session?.cwd || 'remote session';
    const activity = s.waitingForHost ? (local ? 'waiting for you in the terminal' : 'waiting for host (answering a prompt in their terminal)') : s.busy ? 'working' : 'idle';
    const control = s.control ? 'yes' : s.controlPending ? 'requested, waiting for host…' : 'no (view only)';
    const controlBtn = s.control
      ? ''
      : `<button type="button" class="header-toggle-btn" data-action="request-control" ${s.controlPending || s.conn !== 'live' ? 'disabled' : ''} title="Ask the host for control">Request control</button>`;
    const abortBtn = s.control && s.busy ? '<button type="button" class="header-toggle-btn" data-action="abort" title="Abort the running turn">Abort</button>' : '';
    let html = `
      <div class="header">
        <h1>${label}: ${escapeHtml(title)}</h1>
        <div class="help-bar">
          <span class="help-hint">T toggle thinking · O toggle tools · Enter send · Shift+Enter newline</span>
          <div class="help-actions">
            <button type="button" class="header-toggle-btn" data-action="toggle-thinking" aria-pressed="${thinkingExpanded}" title="Toggle thinking (T)">Toggle thinking</button>
            <button type="button" class="header-toggle-btn" data-action="toggle-tools" aria-pressed="${toolOutputsExpanded}" title="Toggle tools (O)">Toggle tools</button>
            ${controlBtn}${abortBtn}
          </div>
        </div>
        <div class="header-info">
          <div class="info-item"><span class="info-label">Connection:</span><span class="info-value">${escapeHtml(statusText(s))}</span></div>
          <div class="info-item"><span class="info-label">Activity:</span><span class="info-value">${escapeHtml(activity)}</span></div>
          ${local ? '' : `<div class="info-item"><span class="info-label">Control:</span><span class="info-value">${escapeHtml(control)}</span></div>`}
          ${s.session?.model ? `<div class="info-item"><span class="info-label">Model:</span><span class="info-value">${escapeHtml(s.session.model)}</span></div>` : ''}
          ${s.session?.cwd ? `<div class="info-item"><span class="info-label">Directory:</span><span class="info-value">${escapeHtml(shortenPath(s.session.cwd))}</span></div>` : ''}
          ${local ? (s.viewers ? `<div class="info-item"><span class="info-label">Live viewers:</span><span class="info-value">${s.viewers}</span></div>` : '') : `<div class="info-item"><span class="info-label">Watching:</span><span class="info-value">${s.viewers || 1}</span></div>`}
          ${lastNotice ? `<div class="info-item"><span class="info-label">Notice:</span><span class="info-value${lastNotice.level === 'error' ? ' error-text' : ''}">${escapeHtml(lastNotice.text)}</span></div>` : ''}
        </div>
      </div>`;
    if (html !== lastHeaderHtml) headerEl.innerHTML = lastHeaderHtml = html;
  }

  let composerMode = null;
  function renderComposer() {
    const s = state;
    const mode = s.control ? (s.busy ? 'busy' : 'idle') : 'view';
    if (mode === composerMode) return;
    composerMode = mode;
    if (mode === 'view') {
      composerEl.innerHTML = '';
      return;
    }
    const existing = document.getElementById('composer-input');
    const value = existing ? existing.value : '';
    const hadFocus = existing && document.activeElement === existing;
    composerEl.innerHTML = `
      <div class="header">
        <textarea id="composer-input" class="sidebar-search" rows="3" placeholder="${mode === 'busy' ? 'Message (queued as a follow-up, or Steer to interrupt)' : 'Message'}"></textarea>
        <div class="help-bar">
          <span class="help-hint"></span>
          <div class="help-actions">
            ${mode === 'busy' ? '<button type="button" class="header-toggle-btn" data-action="steer" title="Steer the running turn (Alt+Enter)">Steer</button>' : ''}
            <button type="button" class="header-toggle-btn" data-action="send" title="Send (Enter)">Send</button>
          </div>
        </div>
      </div>`;
    const input = document.getElementById('composer-input');
    input.value = value;
    if (hadFocus) input.focus();
  }

  function nearBottom() {
    const doc = document.scrollingElement || document.documentElement;
    return doc.scrollHeight - doc.scrollTop - window.innerHeight < 80;
  }

  function scrollToBottom() {
    const doc = document.scrollingElement || document.documentElement;
    doc.scrollTop = doc.scrollHeight;
  }

  let firstState = true;
  function applyState(msg) {
    const follow = firstState || nearBottom();
    const prev = state;
    state = msg;
    if (msg.full) {
      items = msg.items.slice();
      renderAll();
    } else if (msg.items) {
      appendItems(msg.items);
    } else if (prev && prev.omitted !== msg.omitted) {
      renderAll();
    }
    renderTail();
    renderHeader();
    renderComposer();
    document.title = `${label}: ${msg.session?.name || msg.session?.cwd || 'remote'}${msg.busy ? ' (working)' : ''}`;
    if (follow) scrollToBottom();
    firstState = false;
  }

  // ============================================================
  // TOGGLES (as in the export)
  // ============================================================

  function setThinkingExpanded(expanded) {
    thinkingExpanded = expanded;
    document.querySelector('[data-action="toggle-thinking"]')?.setAttribute('aria-pressed', String(expanded));
    document.querySelectorAll('.thinking-text').forEach((el) => { el.style.display = thinkingExpanded ? '' : 'none'; });
    document.querySelectorAll('.thinking-collapsed').forEach((el) => { el.style.display = thinkingExpanded ? 'none' : 'block'; });
  }

  function setToolOutputsExpanded(expanded) {
    toolOutputsExpanded = expanded;
    document.querySelector('[data-action="toggle-tools"]')?.setAttribute('aria-pressed', String(expanded));
    document.querySelectorAll('.tool-output.expandable').forEach((el) => el.classList.toggle('expanded', toolOutputsExpanded));
    document.querySelectorAll('.compaction').forEach((el) => el.classList.toggle('expanded', toolOutputsExpanded));
  }

  // ============================================================
  // COMMANDS
  // ============================================================

  async function send(t, text) {
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pi-live-token': token },
        body: JSON.stringify({ t, text })
      });
      const body = res.ok ? await res.json() : { ok: false, error: await res.text() };
      if (!body.ok) showNotice('warning', body.error || 'failed');
      return body.ok;
    } catch (err) {
      showNotice('error', `viewer is not reachable (${err.message || err})`);
      return false;
    }
  }

  async function submit(steer) {
    const input = document.getElementById('composer-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const kind = steer && state?.busy ? 'steer' : 'prompt';
    if (await send(kind, text)) {
      input.value = '';
      scrollToBottom();
    }
  }

  function showNotice(level, text) {
    lastNotice = { level, text };
    if (state) renderHeader();
  }

  document.addEventListener('click', (e) => {
    if (window.getSelection().toString()) return;
    const action = e.target.closest?.('[data-action]')?.dataset.action;
    if (action === 'toggle-thinking') return setThinkingExpanded(!thinkingExpanded);
    if (action === 'toggle-tools') return setToolOutputsExpanded(!toolOutputsExpanded);
    if (action === 'request-control') return void send('control_request');
    if (action === 'abort') return void send('abort');
    if (action === 'send') return void submit(false);
    if (action === 'steer') return void submit(true);
    const toggle = e.target.closest?.('[data-toggle]');
    if (toggle) toggle.classList.toggle(toggle.dataset.toggle);
  });

  const isEditableTarget = (element) => {
    if (!element) return false;
    const tagName = element.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') return true;
    return element.isContentEditable;
  };

  document.addEventListener('keydown', (e) => {
    if (e.target?.id === 'composer-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      return void submit(e.altKey);
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(document.activeElement)) return;
    const key = e.key.toLowerCase();
    if (key === 't') {
      e.preventDefault();
      setThinkingExpanded(!thinkingExpanded);
    } else if (key === 'o') {
      e.preventDefault();
      setToolOutputsExpanded(!toolOutputsExpanded);
    }
  });

  // ============================================================
  // EVENTS
  // ============================================================

  const events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
  events.addEventListener('state', (e) => applyState(JSON.parse(e.data)));
  events.addEventListener('notice', (e) => {
    const n = JSON.parse(e.data);
    showNotice(n.level, n.text);
  });
  events.addEventListener('error', () => {
    if (events.readyState === EventSource.CLOSED || state) {
      showNotice('error', local ? 'lost connection to pi (did it exit, or was /gui stop run?)' : 'lost connection to the local viewer (is /watch or watch-cli still running?)');
    }
  });
  events.addEventListener('open', () => {
    if (lastNotice && lastNotice.text.startsWith('lost connection to the local viewer')) lastNotice = null;
  });
})();
