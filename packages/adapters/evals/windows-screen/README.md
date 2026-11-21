# Windows screen control eval

Both suites use Rakazo's Windows screen adapter with a simulated UI Automation
driver. The form appears after opening a new order. The baseline returns numbered
rows and a screenshot after each call. The candidate defaults to text and can
resolve controls by name while running a batch. Each case passes when the app
saves the exact summary and assignee requested.

Run from a checkout with the workspace dependencies installed. Keep the eval
tooling and results in a separate directory.

```sh
export RAKAZO_EVAL_ROOT="$PWD"
eval_suite="$RAKAZO_EVAL_ROOT/packages/adapters/evals/windows-screen"
cd "$(mktemp -d)"
npm install --save-exact promptfoo@0.125.1 oh-my-promptfoo@1.31.2 \
  @openai/codex-sdk@0.156.1 js-tiktoken@1.0.21

npx allagents-promptfoo eval --config "$eval_suite/replay.yaml" \
  --public-labels true --output-dir replay-results -- --no-cache
```

The replay makes no model calls. It counts accessibility response text with
`o200k_base` and counts images separately. Compare the rows' `namedScores` in
the native `results.json` export. Versions of oh-my-promptfoo that support
`publicNamedScores` also show them in the readable report.

For the live comparison, point `RAKAZO_EVAL_CODEX_HOME` at a Codex home
authenticated for the eval with access to `gpt-6-sol`. Copy the config and its
assertion beside the installed tooling so Promptfoo can resolve the provider.

```sh
cp "$eval_suite/live.yaml" "$eval_suite/saved-order.mjs" .
npx allagents-promptfoo eval --config live.yaml \
  --public-labels true --output-dir live-results -- --no-cache --max-concurrency 3
```

The live run reports model usage from Codex, including cumulative input over
multiple turns. Promptfoo's request count represents one agent invocation per
case. The fixture separately records calls to the desktop tools and screenshots
returned. These runs use synthetic records and a simulated app. Actual Windows
apps can expose different controls and produce different token counts.

## Results

Each side saved the correct order in all three cases.

| Metric                           | Baseline | Candidate |
| -------------------------------- | -------: | --------: |
| Live Codex total tokens          |  477,232 |   241,540 |
| Live desktop tool calls          |       12 |        10 |
| Live screenshots                 |       12 |         0 |
| Replay tool-response text tokens |    2,324 |     1,787 |
| Replay desktop tool calls        |       12 |         6 |

The live run used 49.4% fewer total tokens across the three cases. The
candidate used two desktop calls in one live case and four in each of the
other two. The scripted replay used two calls per candidate case.
