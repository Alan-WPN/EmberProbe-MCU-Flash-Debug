"use strict";
const { STRINGS, t, normalizeLang, jsonForScript } = require("./i18n");
const { loadWebviewAsset } = require("./webviewTemplate");
const liveWatchCss = loadWebviewAsset("liveWatch", "app.css");
const liveWatchRenderer = loadWebviewAsset("liveWatch", "renderer.js");
// 独立实时变量面板：无外部依赖，使用高 DPI Canvas 绘制曲线。
// 采样序列 → RFC 4180 CSV：time 列（ISO 8601 UTC）+ 每变量一列，行尾 CRLF，带 UTF-8 BOM；
// 各序列按采样时间戳对齐（同一 tick 共享同一时刻），晚加入的序列起始前留空单元格
function buildCsv(names, buffers) {
    function esc(value) {
        const text = String(value);
        return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    const rows = [['time'].concat(names.map(esc)).join(',')];
    const times = [];
    const cellsByTime = new Map();
    buffers.forEach((arr, seriesIndex) => {
        for (const point of arr) {
            if (!point) continue;
            let cells = cellsByTime.get(point.t);
            if (!cells) {
                cells = new Array(names.length).fill('');
                cellsByTime.set(point.t, cells);
                times.push(point.t);
            }
            cells[seriesIndex] = esc(point.v);
        }
    });
    times.sort((a, b) => a - b);
    for (const time of times) rows.push([new Date(time).toISOString()].concat(cellsByTime.get(time)).join(','));
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
}
function getLiveWatchContent(cfg, lang) {
    const raw = cfg || {};
    const conf = {
        maxSamples: Math.min(20000, Math.max(100, Number(raw.maxSamples) || 2000)),
        intervalMs: Math.min(10000, Math.max(20, Number(raw.intervalMs) || 100))
    };
    const L = normalizeLang(lang), tr = (k, p) => t(L, k, p), i18nJson = jsonForScript(STRINGS);
    return `<!doctype html><html lang="${L==='zh'?'zh-CN':'en'}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';">
<title>${tr('lw.title')}</title><style>
${liveWatchCss}
</style></head><body><div class="top"><header class="bar"><i class="status-dot" id="dot"></i><span class="brand" data-i18n="lw.title">${tr('lw.title')}</span><span class="status" id="status">${tr('lw.ready')}</span><span class="hint" data-i18n="lw.hint">${tr('lw.hint')}</span><button class="lang-toggle" id="langToggle" type="button" data-i18n-title="common.langTitle" title="${tr('common.langTitle')}" aria-label="${tr('common.langTitle')}"></button></header><div class="toolbar">
<div class="group"><button class="ghost side-toggle" id="sideToggle" title="${tr('lw.collapsePane')}">‹ ${tr('lw.valuePane')}</button><button id="run">${tr('lw.startSampling')}</button><label><span data-i18n="lw.interval">${tr('lw.interval')}</span> <input id="interval" type="number" min="20" max="10000" step="10" value="${conf.intervalMs}"> ms</label></div>
<div class="group"><button id="import" class="secondary" data-i18n="lw.importVars">${tr('lw.importVars')}</button><span class="ac-wrap"><input id="addName" data-i18n-ph="lw.addByName" placeholder="${tr('lw.addByName')}"><div class="ac-dropdown" id="acDrop"></div></span><button id="addBtn" class="secondary" data-i18n="lw.add">${tr('lw.add')}</button></div>
<div class="group"><label><span data-i18n="lw.window">${tr('lw.window')}</span> <select id="timeWindow"><option value="10" data-i18n="lw.sec10">${tr('lw.sec10')}</option><option value="30" selected data-i18n="lw.sec30">${tr('lw.sec30')}</option><option value="60" data-i18n="lw.sec60">${tr('lw.sec60')}</option><option value="0" data-i18n="lw.all">${tr('lw.all')}</option></select></label><button id="freeze" class="ghost">${tr('lw.freeze')}</button><button id="norm" class="ghost" data-i18n="lw.normalize" data-i18n-title="lw.normalized" title="${tr('lw.normalized')}">${tr('lw.normalize')}</button><button id="clear" class="ghost" data-i18n="lw.clear">${tr('lw.clear')}</button><button id="export" class="ghost" data-i18n="lw.exportCsv" data-i18n-title="lw.exportCsvTitle" title="${tr('lw.exportCsvTitle')}">${tr('lw.exportCsv')}</button></div>
</div></div><main class="layout" id="layout"><aside class="side"><div class="side-head"><strong data-i18n="lw.currentValues">${tr('lw.currentValues')}</strong><span class="badge" id="count">0</span><span id="rate">0 Hz</span></div><div class="var-list" id="vars"><div class="empty" data-i18n="lw.varListEmpty">${tr('lw.varListEmpty')}</div></div></aside><div class="side-splitter" id="sideSplitter" data-i18n-title="lw.splitterHint" title="${tr('lw.splitterHint')}"></div><section class="chart-pane"><div class="chart-head"><strong data-i18n="lw.history">${tr('lw.history')}</strong><span id="range">—</span><span class="spacer"></span><span id="points">${tr('lw.points',{n:0})}</span></div><div class="chart-wrap" id="chartWrap"><canvas id="chart"></canvas><div class="chart-empty" id="chartEmpty" data-i18n="lw.chartEmpty">${tr('lw.chartEmpty')}</div></div></section></main>
<div class="overlay hidden" id="overlay"><div class="panel"><h3 data-i18n="lw.importTitle">${tr('lw.importTitle')}</h3><div class="filter-wrap"><input id="impFilter" data-i18n-ph="lw.filterVars" placeholder="${tr('lw.filterVars')}"><button class="filter-clear" id="impFilterClear" type="button" data-i18n-title="lw.clearFilter" title="${tr('lw.clearFilter')}" aria-label="${tr('lw.clearFilter')}">×</button></div><div class="warn" id="impWarn"></div><div class="imp-meta" id="impCount"></div><div class="imp-list" id="impList"></div><div class="right"><button class="secondary" id="impCancel" data-i18n="lw.cancel">${tr('lw.cancel')}</button><button id="impAdd" data-i18n="lw.importSelected">${tr('lw.importSelected')}</button></div></div></div>
<script>window.__CFG__=${jsonForScript(conf)};window.__LANG__=${jsonForScript(L)};window.__I18N__=${i18nJson};</script><script>
${liveWatchRenderer}
</script></body></html>`;
}
module.exports = { getLiveWatchContent, buildCsv };
