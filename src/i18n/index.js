"use strict";

const zh = require("./zh");
const en = require("./en");

const DEFAULT_LANG = "zh";
const SUPPORTED_LANGS = ["zh", "en"];
const STRINGS = Object.freeze({ zh, en });

function normalizeLang(lang) {
    return SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

function interpolate(template, params) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        params && params[key] != null ? String(params[key]) : ""
    );
}

function t(lang, key, params) {
    const table = STRINGS[normalizeLang(lang)] || STRINGS[DEFAULT_LANG];
    const raw = table[key] != null
        ? table[key]
        : (STRINGS[DEFAULT_LANG][key] != null ? STRINGS[DEFAULT_LANG][key] : key);
    return interpolate(raw, params);
}

function matchVscodeLang(lang) {
    return String(lang || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function jsonForScript(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

module.exports = {
    STRINGS,
    t,
    interpolate,
    DEFAULT_LANG,
    SUPPORTED_LANGS,
    normalizeLang,
    matchVscodeLang,
    jsonForScript
};
