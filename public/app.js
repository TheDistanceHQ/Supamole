export function initApp(runExtraction) {
  const form = document.getElementById('scan-form');
  const formSection = document.getElementById('form-section');
  const loadingSection = document.getElementById('loading-section');
  const loadingStatus = document.getElementById('loading-status');
  const resultsSection = document.getElementById('results');
  const formError = document.getElementById('form-error');
  const submitBtn = document.getElementById('submit-btn');
  const exportSqlEl = document.getElementById('exportSql');
  const exportSqlFilenameWrap = document.getElementById('exportSqlFilename-wrap');
  if (exportSqlEl && exportSqlFilenameWrap) {
    exportSqlEl.addEventListener('change', () => {
      exportSqlFilenameWrap.classList.toggle('hidden', !exportSqlEl.checked);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.classList.add('hidden');
    const url = document.getElementById('url').value.trim();
    const key = document.getElementById('key').value.trim();
    if (!url || !key) {
      formError.textContent = 'URL and Anon key are required.';
      formError.classList.remove('hidden');
      return;
    }
    const exportSqlEl = document.getElementById('exportSql');
    const config = {
      url,
      key,
      email: document.getElementById('email').value.trim() || undefined,
      password: document.getElementById('password').value.trim() || undefined,
      token: document.getElementById('token').value.trim() || undefined,
      fastDiscovery: document.getElementById('fastDiscovery').checked,
      exportSql: exportSqlEl && exportSqlEl.checked ? (document.getElementById('exportSqlFilename')?.value?.trim() || 'schema.sql') : undefined,
    };
    formSection.classList.add('hidden');
    loadingSection.classList.remove('hidden');
    if (loadingStatus) loadingStatus.textContent = 'Connecting…';
    submitBtn.disabled = true;
    try {
      const data = await runExtraction(config, {
        echoToConsole: false,
        onLog: loadingStatus ? (msg) => { loadingStatus.textContent = msg; } : undefined,
      });
      renderResults(data);
      resultsSection.classList.remove('hidden');
    } catch (err) {
      formError.textContent = err.message || 'Scan failed';
      formError.classList.remove('hidden');
      formSection.classList.remove('hidden');
    } finally {
      loadingSection.classList.add('hidden');
      submitBtn.disabled = false;
    }
  });

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      if (attrs.className) node.className = attrs.className;
      if (attrs.id) node.id = attrs.id;
      if (attrs.textContent != null) node.textContent = attrs.textContent;
    }
    if (children && children.length) children.forEach((c) => (c ? node.appendChild(c) : null));
    return node;
  }

  function renderResults(data) {
    const tables = data.tables || [];
    const storage = data.storage || { buckets: [] };
    const discoveryLog = data.discoveryLog || [];
    const tablesWithPII = tables.filter((t) => t.piiFindings && t.piiFindings.length > 0);
    const publicBuckets = storage.buckets.filter((b) => b.public);
    const publicReachable = storage.buckets.filter(
      (b) => b.publicUrlCheck && b.publicUrlCheck.verified > 0
    );

    const summary = el('div', { className: 'card' }, [
      el('h2', { textContent: 'Summary' }),
      ...(data.exportSqlContent
        ? [
            el('div', { style: 'margin-bottom:0.75rem' }, [
              el('button', {
                className: 'btn',
                textContent: 'Download SQL',
                id: 'download-sql-btn',
              }),
            ]),
          ]
        : []),
      el('div', { className: 'summary-stats' }, [
        el('span', { textContent: `Tables: ${tables.length}` }),
        el('span', { textContent: `Tables with suspected PII: ${tablesWithPII.length}` }),
        el('span', { textContent: `Storage buckets: ${storage.buckets.length}` }),
        el('span', { textContent: `Public buckets: ${publicBuckets.length}` }),
        publicReachable.length
          ? el('span', { className: 'storage-warn', textContent: `${publicReachable.length} bucket(s) with reachable public URLs` })
          : null,
      ].filter(Boolean)),
    ]);

    if (data.exportSqlContent) {
      const sqlBtn = summary.querySelector('#download-sql-btn');
      if (sqlBtn) {
        sqlBtn.addEventListener('click', () => {
          const blob = new Blob([data.exportSqlContent], { type: 'text/plain;charset=utf-8' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = data.exportSqlFilename || 'schema.sql';
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }
    }

    const storageCard = el('div', { className: 'card' }, [
      el('h2', { textContent: 'Storage analysis' }),
      ...storage.buckets.map((b) => {
        const div = el('div', { className: 'accordion-body', style: 'margin-top:0.5rem' });
        div.innerHTML = [
          `<strong>${escapeHtml(b.name)}</strong>`,
          ` — Public: ${b.public ? 'Yes' : 'No'}`,
          b.fileSizeLimit != null ? ` — File size limit: ${b.fileSizeLimit}` : '',
          ` — Indexed objects: ${b.objectCount ?? 0}`,
          b.listError ? ` — Error: ${escapeHtml(b.listError)}` : '',
        ].join('');
        if (b.publicUrlCheck) {
          const warn = el('div', { className: 'storage-warn' });
          warn.textContent = `Public URL check: ${b.publicUrlCheck.verified}/${b.publicUrlCheck.sampleSize} sample URLs reachable without auth.`;
          if (b.publicUrlCheck.corsOrNetworkError) warn.textContent += ' (Some checks could not be verified due to CORS or network.)';
          else if (b.publicUrlCheck.verified > 0) warn.textContent += ' Bucket content may be publicly accessible.';
          div.appendChild(warn);
        }
        if (b.samplePaths && b.samplePaths.length) {
          const pre = document.createElement('pre');
          pre.textContent = b.samplePaths.slice(0, 10).join('\n');
          pre.style.marginTop = '0.5rem';
          pre.style.maxHeight = '120px';
          div.appendChild(pre);
        }
        return div;
      }),
    ]);

    const tablesCard = el('div', { className: 'card' }, [
      el('h2', { textContent: 'Table structure' }),
      ...tables.map((t) => {
        const fullName = t.table_schema === 'public' ? t.table_name : `${t.table_schema}.${t.table_name}`;
        const header = el('div', { className: 'accordion-header' });
        header.innerHTML = `${escapeHtml(fullName)} <span style="color:var(--text-muted)">${t.rowCount ?? 0} rows · ${(t.columns || []).length} cols</span>`;
        const body = el('div', { className: 'accordion-body', style: 'display:none' });
        if (t.columns && t.columns.length) {
          const table = document.createElement('table');
          table.innerHTML = '<thead><tr><th>Column</th><th>Type</th><th>Nullable</th></tr></thead><tbody>' +
            t.columns.map((c) => `<tr><td>${escapeHtml(c.column_name)}</td><td>${escapeHtml(c.data_type || '')}</td><td>${c.is_nullable || ''}</td></tr>`).join('') +
            '</tbody>';
          body.appendChild(table);
        }
        header.addEventListener('click', () => {
          body.style.display = body.style.display === 'none' ? 'block' : 'none';
        });
        const wrap = el('div');
        wrap.appendChild(header);
        wrap.appendChild(body);
        return wrap;
      }),
    ]);

    const piiCard = el('div', { className: 'card' }, [
      el('h2', { textContent: 'Tables with suspected PII' }),
      el('p', { className: 'note', textContent: 'These are suspected PII columns for GDPR review. Review and classify in your data governance.' }),
      ...tablesWithPII.map((t) => {
        const fullName = t.table_schema === 'public' ? t.table_name : `${t.table_schema}.${t.table_name}`;
        const div = el('div', { className: 'accordion-body', style: 'margin-bottom:0.75rem' });
        div.appendChild(el('strong', { textContent: fullName }));
        const list = document.createElement('ul');
        list.style.marginTop = '0.5rem';
        list.style.marginBottom = '0';
        t.piiFindings.forEach((f) => {
          const li = document.createElement('li');
          li.innerHTML = `<span class="pii-badge">${escapeHtml(f.piiType)}</span> ${escapeHtml(f.column)}`;
          if (f.examples && f.examples.length) {
            const ex = document.createElement('div');
            ex.className = 'note';
            ex.style.marginTop = '0.25rem';
            ex.textContent = 'Examples: ' + f.examples.slice(0, 3).join(', ');
            li.appendChild(ex);
          }
          list.appendChild(li);
        });
        div.appendChild(list);
        return div;
      }),
    ]);

    const deeperCard = el('div', { className: 'card' }, [
      el('h2', { textContent: 'Deeper output' }),
      el('div', { className: 'tabs' }, [
        el('button', { textContent: 'Discovery log', className: 'active', id: 'tab-log' }),
        el('button', { textContent: 'Full JSON', id: 'tab-json' }),
        ...(data.exportSqlContent
          ? [el('button', { className: 'btn', textContent: 'Download SQL', id: 'download-sql-deeper' })]
          : []),
      ]),
      el('div', { id: 'panel-log' }, [
        el('pre', { textContent: discoveryLog.join('\n') }),
      ]),
      el('div', { id: 'panel-json', className: 'hidden' }, [
        el('pre', { id: 'raw-json', textContent: JSON.stringify(data, null, 2) }),
        el('button', { className: 'btn', textContent: 'Download JSON', style: 'margin-top:0.5rem', id: 'download-json' }),
      ]),
    ]);

    const tabLog = deeperCard.querySelector('#tab-log');
    const tabJson = deeperCard.querySelector('#tab-json');
    const panelLog = deeperCard.querySelector('#panel-log');
    const panelJson = deeperCard.querySelector('#panel-json');
    tabLog.addEventListener('click', () => {
      tabLog.classList.add('active');
      tabJson.classList.remove('active');
      panelLog.classList.remove('hidden');
      panelJson.classList.add('hidden');
    });
    tabJson.addEventListener('click', () => {
      tabJson.classList.add('active');
      tabLog.classList.remove('active');
      panelJson.classList.remove('hidden');
      panelLog.classList.add('hidden');
    });
    deeperCard.querySelector('#download-json').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
      a.download = 'scan-result.json';
      a.click();
    });
    const sqlBtnDeeper = deeperCard.querySelector('#download-sql-deeper');
    if (sqlBtnDeeper && data.exportSqlContent) {
      sqlBtnDeeper.addEventListener('click', () => {
        const blob = new Blob([data.exportSqlContent], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = data.exportSqlFilename || 'schema.sql';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    const newScanBtn = el('button', { className: 'btn', textContent: 'New scan', id: 'new-scan-btn' });
    newScanBtn.addEventListener('click', () => {
      resultsSection.classList.add('hidden');
      formSection.classList.remove('hidden');
    });
    const resultsFooter = el('div', { style: 'text-align:center;margin-top:1.5rem;margin-bottom:1rem' }, [newScanBtn]);

    resultsSection.innerHTML = '';
    resultsSection.appendChild(summary);
    resultsSection.appendChild(storageCard);
    resultsSection.appendChild(tablesCard);
    resultsSection.appendChild(piiCard);
    resultsSection.appendChild(deeperCard);
    resultsSection.appendChild(resultsFooter);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
}
