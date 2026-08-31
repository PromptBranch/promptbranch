# Run prompts with AI models

PromptBranch can run one prompt with up to six connected models at once, so you
can compare answers instead of guessing which model or prompt version works
best.

## Use variables

Write reusable input fields as {{variable_name}} in a prompt. Selecting **Run**
asks for a value for every variable it finds. PromptBranch remembers those
values for the prompt so you can run it again without re-entering them.

## Run and compare

1. Choose one or more models in the model picker next to **Run**.
2. Select **Run** and fill in any variables.
3. Watch each model's result as it arrives.

Open the **Results** tab and select a run group to compare its outputs. Each
result shows its status, response, elapsed time, token usage when the provider
reports it, and an estimated cost when pricing is available. You can cancel
running requests; a provider may still charge for work completed before the
cancellation.

Cost is an estimate, not a bill. Local models and models without published
pricing show no estimate.

Next: [evaluate and judge results](llm-judge-and-evaluations.md).
