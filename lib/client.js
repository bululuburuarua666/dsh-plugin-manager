window.__ModuleLoader__.load({ id: "@bululuburuarua666/dsh-plugin-manager", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/locales.ts
var zh = {
  tab: "\u63D2\u4EF6\u7BA1\u7406",
  placeholder: "\u63D2\u4EF6\u7BA1\u7406\u52A0\u8F7D\u4E2D\uFF08T01 \u9AA8\u67B6\uFF09"
};
var en = {
  tab: "Plugin manager",
  placeholder: "Plugin manager loading (T01 skeleton)"
};

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register("dsh-plugin-manager", { zh, en }), "dsh-plugin-manager: dictionaries");
  const t = ctx.locale.bind("dsh-plugin-manager");
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
    name: "settings.plugins.tab",
    id: "manager",
    order: 20,
    label: () => t("tab"),
    locale: "dsh-plugin-manager",
    inject: () => ({ ready: true })
  }, PlaceholderTab));
}
function PlaceholderTab({ label }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", { "data-plugin-manager-tab": true, children: label });
}
return module.exports; } });
//# sourceMappingURL=client.js.map
