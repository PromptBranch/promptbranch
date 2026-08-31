# Evaluate prompt results

Use ratings, comparisons, and an optional AI judge to learn which prompt
versions and models give you the most useful results.

## Compare runs

Open **Results** and choose a run group. The compare view places model outputs
alongside their timing, token use, and estimated cost. This is useful when you
run the same prompt with multiple models or test different prompt versions.

## Rate a result

You can rate a version in the Inspector on four 1–5 dimensions:

| Dimension | Ask yourself |
| --- | --- |
| Effectiveness | Did it accomplish the requested task? |
| Clarity | Is it easy to understand? |
| Completeness | Did it cover the needed constraints and details? |
| Actionability | Can someone use it without substantial rework? |

PromptBranch keeps rating averages with the version so you can compare your
work over time.

## Judge with AI

1. Open a run group in the compare view.
2. Select **Judge with AI**.
3. Choose a connected judge model and, if useful, add your own criteria.
4. Run the judge and review its scores and rationale.
5. Select **Apply as ratings** only if you want to keep those scores.

The judge is a second opinion, not proof of quality. Use your own review and
real task results when deciding which version to make current.

Agents can also record external runs and ratings through the CLI or MCP server.
