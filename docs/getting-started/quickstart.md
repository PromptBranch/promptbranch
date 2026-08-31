# 5-Minute Quickstart

This guide walks you through creating your first version-controlled prompt, executing it across multiple AI models in parallel, evaluating the output with the automated LLM judge, branching an experimental variation, and publishing an unlisted share snapshot.

---

## Step 1: Create a New Prompt

1. Launch **PromptBranch**.
2. Click the **+** button (*New prompt*) at the top of the prompt list — or press <kbd>⌘K</kbd> / <kbd>Ctrl+K</kbd> and choose **New Prompt**.
3. Set a title: **`Code Refactoring Assistant`**, plus a brief description: *Refactors messy code into clean, idiomatic, well-tested functions.*
4. Leave **Initial content (v1)** empty for this walkthrough. Creating a prompt always creates `main` v1, so the save in Step 2 will create v2. You can also use **Generate with AI…** to draft the initial v1 content before creating the prompt.
5. Optionally select existing tags. New tags are created with the **+** button beside **Tags** in the left rail and can be attached after creation.
6. Click **Create prompt**.

---

## Step 2: Write a Prompt Template with Dynamic Variables

In the CodeMirror editor, enter your prompt template. Use double curly braces `{{variable_name}}` for any input parameters:

````markdown
You are a senior software engineer. Refactor the provided code according to the target style guidelines.

Guidelines:
- Language: {{language}}
- Target Architecture: Clean, modular, idiomatic {{language}} code.
- Strict Constraints: Maintain 100% functional equivalence; do not remove existing comments.
- Test Coverage: Provide unit tests covering happy paths and edge cases.

Code to Refactor:
```{{language}}
{{source_code}}
```

Provide the refactored code followed by a bulleted summary of the changes and unit tests.
````

When you reach a stable point, click **Save as new version** on the toolbar. In the *Save as v2* dialog, enter a change note (e.g. *"Initial prompt template"*) and click **Save version**. The draft is committed as an immutable version on the `main` branch.

---

## Step 3: Connect an AI Provider

1. Open **Settings** (gear icon in the bottom-left rail, or <kbd>⌘,</kbd> / <kbd>Ctrl+,</kbd>) and go to **AI Providers**.
2. Click **Connect a provider…**.
3. Pick a provider from the list — popular providers (**OpenAI**, **Anthropic**, **Google**) are pinned at the top, and the full catalog of OpenAI-compatible providers follows. For a local endpoint (Ollama, LM Studio), choose **Custom OpenAI-compatible provider**.
4. Paste your API key. If a standard key exists in your environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`), click **Use environment key** instead.
5. For a custom endpoint, also enter the **Base URL** (e.g. `http://localhost:11434/v1` for Ollama) and pick a test model.
6. Click **Connect**. PromptBranch verifies the key with a minimal test request, encrypts it using your OS keychain (`safeStorage`), and loads the model catalog from [models.dev](https://models.dev).

Add any model IDs the catalog doesn't know about (e.g. locally pulled Ollama models) later via **Manage models**.

---

## Step 4: Run Against Multiple Models in Parallel

1. Fill in the **Run variables** when prompted: the **Run** button opens a dialog with an input field for each `{{variable}}` in the prompt.
   - `language`: `typescript`
   - `source_code`: `function calc(a,b,c){ if(c=='add') return a+b; if(c=='sub') return a-b; return 0; }`
2. In the **Model Picker** next to **Run**, select up to 6 models across your connected providers (e.g. a Claude, a GPT, and a Gemini model).
3. Click **Run**.

PromptBranch streams the responses in parallel, showing live status per model (**Queued** → **Streaming** → **Done** / **Failed**) plus latency, token counts, and estimated USD cost. Variable values are remembered per prompt for your next run. You can **Cancel** in-flight runs at any time.

---

## Step 5: Evaluate Results & Use the LLM Judge

1. Open the **Results** tab and click a run group to open the side-by-side compare view: full outputs, latency, tokens, and cost for every model.
2. Click **Judge with AI** in the compare view header.
3. Pick a **Judge model**, and optionally add **Criteria** (e.g. *"Penalize responses exceeding 300 words"*).
4. Click **Run judge**. Each response is scored 1–5 on four dimensions — **Effectiveness**, **Clarity**, **Completeness**, **Actionability** — with a short rationale.
5. Click **Apply as ratings** to persist the scores onto each run.

---

## Step 6: Create an Experimental Variation

1. Open the **⋯** menu (More actions) on the prompt toolbar and click **Duplicate as variation…** — or use **Duplicate** next to any version in the History tab.
2. Name the variation: **`experiment/concise-format`** (plus an optional description) and click **Create variation**.
3. Edit the prompt to demand shorter explanations:
   ```markdown
   ...
   Output Format:
   Respond with ONLY the refactored code inside a single code block, immediately followed by the unit tests. Do not include markdown preamble or conversational filler.
   ```
4. Click **Save as new version** with the change note: *"Enforce zero-preamble concise output"*.

The version dropdown groups versions by branch, so you can switch between `main` and `experiment/concise-format` instantly.

---

## Step 7: Publish an Unlisted Share Link

1. Click the **Share** button on the prompt toolbar.
2. Choose the scope: **Current version only**, or **Include full history**.
3. PromptBranch runs the **pre-publish secret scanner** on the exact JSON payload and shows you the findings before anything leaves your machine — high-severity findings (API keys, private keys, tokens) block publishing until removed.
4. Click **Publish**.
5. PromptBranch uploads the immutable snapshot to `https://promptbranch.app/p/<id>` and shows your unlisted share link. The revocation **delete token** is stored locally — manage and revoke the share any time from the **Shares** view. (When publishing via the CLI, the token is also printed once.)

Anyone with the link can view the snapshot in a clean web viewer, inspect version diffs, or open an import preview in their own PromptBranch library via the `promptbranch://` deep link. The recipient reviews the snapshot and explicitly confirms the import.

---

## Next Steps

- [Prompt Management & Versioning](../features/prompt-management.md) for version history, diffing, and trash.
- [MCP Server Integration](../integrations/mcp-server.md) to connect coding agents like Claude Desktop and Cursor.
- [Peer-to-Peer Multi-Device Sync](../sync/peer-to-peer-sync.md) to keep your devices in sync without cloud servers.
