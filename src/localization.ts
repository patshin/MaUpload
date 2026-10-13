import { detectLanguage, english, message, translate, type Language, type Localized, type MessageKey } from "./i18n";

let language = detectLanguage(navigator.languages);
const textBindings = new Map<Node, Localized>();
const attributeBindings = new Map<Element, Map<string, Localized>>();

export function currentLanguage(): Language { return language; }
export function t(value: Localized): string { return translate(value, language); }
export function bindText(node: Node, value: Localized): void {
  for (const previous of textBindings.keys()) if (!previous.isConnected) textBindings.delete(previous);
  textBindings.set(node, value);
  node.textContent = t(value);
}
export function setText(id: string, value: Localized): void {
  const node = document.getElementById(id);
  if (node) bindText(node, value);
}
export function bindAttribute(element: Element, name: string, value: Localized): void {
  let bindings = attributeBindings.get(element);
  if (!bindings) { bindings = new Map(); attributeBindings.set(element, bindings); }
  bindings.set(name, value);
  element.setAttribute(name, t(value));
}
export function initializeLanguage(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const key = node.textContent?.trim();
    if (key && Object.hasOwn(english, key)) bindText(node, message(key as MessageKey));
  }
  for (const element of document.querySelectorAll("[aria-label], [placeholder], [data-tooltip]")) {
    for (const name of ["aria-label", "placeholder", "data-tooltip"]) {
      const key = element.getAttribute(name);
      if (key && Object.hasOwn(english, key)) bindAttribute(element, name, message(key as MessageKey));
    }
  }
  applyLanguage(language);
}
export function applyLanguage(next: Language): void {
  language = next;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = t(message("码上传 | 离线文字二维码工作台"));
  document.querySelector('meta[name="description"]')?.setAttribute("content", t(message("码上传：面向经授权的隔离环境文档转录，自动压缩文字并用二维码离线传递，无文档上传。")));
  for (const [node, value] of textBindings) if (node.isConnected) node.textContent = t(value);
  for (const [element, bindings] of attributeBindings) if (element.isConnected) {
    for (const [name, value] of bindings) element.setAttribute(name, t(value));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-language]")) {
    button.setAttribute("aria-pressed", String(button.dataset.language === language));
  }
  document.getElementById("guideLink")?.setAttribute("href", `./guide.html?lang=${language}`);
}
