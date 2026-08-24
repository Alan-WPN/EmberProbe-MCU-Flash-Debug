"use strict";

// P5 机械迁移：把原平铺 STRINGS.zh/en 写入独立词典，公共 API 由 i18n/index.js 保持。
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const legacyFile = path.join(root, "src", "i18n.js");
const { STRINGS } = require(legacyFile);
const outputDir = path.join(root, "src", "i18n");
fs.mkdirSync(outputDir, { recursive: true });

for (const lang of ["zh", "en"]) {
    const content = `"use strict";\n\nmodule.exports = Object.freeze(${JSON.stringify(STRINGS[lang], null, 4)});\n`;
    fs.writeFileSync(path.join(outputDir, `${lang}.js`), content);
}
fs.writeFileSync(legacyFile, '"use strict";\n\nmodule.exports = require("./i18n/index");\n');
