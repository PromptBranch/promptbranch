/**
 * Implementation module for ./highlight.ts. Everything Shiki-heavy (grammars,
 * themes, engine) is imported statically HERE, and highlight.ts only imports
 * this module dynamically — so the bundler splits all of it into a lazy
 * chunk and the initial renderer bundle stays lean. Do not import this file
 * from anywhere else.
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import langBash from "shiki/langs/bash.mjs";
import langCss from "shiki/langs/css.mjs";
import langDiff from "shiki/langs/diff.mjs";
import langGo from "shiki/langs/go.mjs";
import langHtml from "shiki/langs/html.mjs";
import langJavaScript from "shiki/langs/javascript.mjs";
import langJson from "shiki/langs/json.mjs";
import langJsx from "shiki/langs/jsx.mjs";
import langMarkdown from "shiki/langs/markdown.mjs";
import langPython from "shiki/langs/python.mjs";
import langRust from "shiki/langs/rust.mjs";
import langSql from "shiki/langs/sql.mjs";
import langTsx from "shiki/langs/tsx.mjs";
import langTypeScript from "shiki/langs/typescript.mjs";
import langYaml from "shiki/langs/yaml.mjs";
import themeGithubDark from "shiki/themes/github-dark.mjs";
import themeGithubLight from "shiki/themes/github-light.mjs";

/** Create the shared highlighter with every grammar/theme we ship. */
export function createHighlighter(): Promise<HighlighterCore> {
  return createHighlighterCore({
    themes: [themeGithubDark, themeGithubLight],
    langs: [
      langBash,
      langCss,
      langDiff,
      langGo,
      langHtml,
      langJavaScript,
      langJson,
      langJsx,
      langMarkdown,
      langPython,
      langRust,
      langSql,
      langTsx,
      langTypeScript,
      langYaml,
    ],
    // forgiving: grammars with Oniguruma-only constructs degrade instead of throwing
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
}
