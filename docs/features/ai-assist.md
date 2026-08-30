# AI Prompt Assist

PromptBranch includes built-in AI authoring tools to help you draft new prompt templates from scratch or refine existing prompts with natural language instructions.

---

## Capabilities

### 1. Generate from a Goal Description
When starting a new prompt project, you can generate a complete, structured prompt from a brief description of what you want to achieve:
1. In the **New Prompt** dialog, fill in the **Initial content (v1)** field's **Generate with AI…** action.
2. Enter your goal description (e.g., *"A prompt that reviews PRs for performance regressions in PostgreSQL queries and suggests indexing strategies"*).
3. Click **Generate**.
4. PromptBranch invokes your connected AI model with a specialized prompt-engineering meta-prompt to produce a structured, production-ready prompt template containing clear constraints, context, and dynamic `{{variable}}` placeholders.

---

### 2. Improve an Existing Prompt
To refine an existing prompt with targeted instructions:
1. Open the prompt you wish to improve.
2. Click the **sparkles (✨) button** — *Improve with AI* — on the editor toolbar.
3. Enter your revision instruction (e.g., *"Make the output format strict JSON and add negative constraints against hallucinating extra fields"*).
4. Click **Improve**.
5. The AI rewrites the prompt according to your instruction.

---

## Review Before Applying

Changes are never applied to your draft automatically:
- PromptBranch shows the generated or improved result in a preview pane.
- Review the output, then click **Apply to editor** to load it into your editor, or cancel to discard.
- Once applied, it becomes part of your editable draft — test it with real models and click **Save as new version** when you're happy with it.
