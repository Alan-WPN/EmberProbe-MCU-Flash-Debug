"use strict";

// P4 一次性机械迁移：从旧模板字符串抽出 CSS 和浏览器逻辑。
// 保留脚本便于审阅迁移规则；若模板已迁移则拒绝再次覆盖。
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function extract(fileName, area, cssVar, rendererVar) {
    const file = path.join(root, "src", fileName);
    let source = fs.readFileSync(file, "utf8");
    if (source.includes(`loadWebviewAsset("${area}"`)) {
        throw new Error(`${fileName} is already externalized`);
    }
    const styles = Array.from(source.matchAll(/<style>([\s\S]*?)<\/style>/g));
    const scripts = Array.from(source.matchAll(/<script>([\s\S]*?)<\/script>/g));
    if (!styles.length || scripts.length < 2) throw new Error(`Unexpected template shape: ${fileName}`);

    const outputDir = path.join(root, "src", "webview", area);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "app.css"), styles.map((match) => match[1].trim()).join("\n") + "\n");
    const renderer = scripts
        .at(-1)[1]
        .replace(
            "${shiftSliderBounds.toString()}",
            "function shiftSliderBounds(min,max,current,next){const lo=Number(min),hi=Number(max),from=Number(current),to=Number(next);if(![lo,hi,from,to].every(Number.isFinite)||hi<=lo||to>=lo&&to<=hi)return{min:lo,max:hi};const span=hi-lo,anchor=Math.min(hi,Math.max(lo,from)),offset=anchor-lo,newMin=to-offset;return{min:newMin,max:newMin+span}}"
        )
        .replace(
            "${buildCsv.toString()}",
            "function buildCsv(names,buffers){function esc(value){const text=String(value);return /[\",\\r\\n]/.test(text)?'\"'+text.replace(/\"/g,'\"\"')+'\"':text}const rows=[['time'].concat(names.map(esc)).join(',')];const times=[];const cellsByTime=new Map();buffers.forEach((arr,seriesIndex)=>{for(const point of arr){if(!point)continue;let cells=cellsByTime.get(point.t);if(!cells){cells=new Array(names.length).fill('');cellsByTime.set(point.t,cells);times.push(point.t)}cells[seriesIndex]=esc(point.v)}});times.sort((a,b)=>a-b);for(const time of times)rows.push([new Date(time).toISOString()].concat(cellsByTime.get(time)).join(','));return '\\uFEFF'+rows.join('\\r\\n')+'\\r\\n'}"
        )
        .trim();
    fs.writeFileSync(path.join(outputDir, "renderer.js"), renderer + "\n");

    source = source.replace(
        'const { STRINGS, t, normalizeLang, jsonForScript } = require("./i18n");',
        'const { STRINGS, t, normalizeLang, jsonForScript } = require("./i18n");\n' +
            'const { loadWebviewAsset } = require("./webviewTemplate");\n' +
            `const ${cssVar} = loadWebviewAsset("${area}", "app.css");\n` +
            `const ${rendererVar} = loadWebviewAsset("${area}", "renderer.js");`
    );
    source = source.replace(styles[0][0], `<style>\n\${${cssVar}}\n</style>`);
    for (let index = 1; index < styles.length; index++) source = source.replace(styles[index][0], "");
    source = source.replace(scripts.at(-1)[0], `<script>\n\${${rendererVar}}\n</script>`);
    fs.writeFileSync(file, source);
}

extract("modernView.js", "sidebar", "sidebarCss", "sidebarRenderer");
extract("liveWatchView.js", "liveWatch", "liveWatchCss", "liveWatchRenderer");
