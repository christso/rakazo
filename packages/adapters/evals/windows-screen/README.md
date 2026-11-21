# Windows screen control eval

The workbench fixture simulates a Windows UI Automation driver. Its form
appears after opening a new order. Each case passes when the app saves the
exact requested record. The inspection case also requires a code visible in
the screenshot and absent from the accessibility tree.

## Live Rakazo eval

The live suite starts the API and Pi agent from each Git checkout with a
disposable Postgres database. It sends a normal chat message and connects the
fixture through the paired-computer gateway. Both model variants drive the
same app. The suite enables image input through Rakazo's model settings for
GPT-6.2 Sol because the bundled catalog on these revisions predates that model.
The inspection case verifies that a screenshot reached the model and the code
was saved. The report uses Rakazo's model usage ledger and counts paired-app
calls and screenshots separately.

Prepare the base and PR checkouts with workspace dependencies and `pnpm db:generate`.
Set `RAKAZO_EVAL_OPENROUTER_KEY` to an OpenRouter key. Both models use fixed
OpenRouter routes for the paired comparison.

```sh
export RAKAZO_EVAL_PR="$PWD"
export RAKAZO_EVAL_BASE=/path/to/base-checkout
eval_suite="$RAKAZO_EVAL_PR/packages/adapters/evals/windows-screen"
cd "$(mktemp -d)"
npm install --save-exact promptfoo@0.125.1 oh-my-promptfoo@1.31.2 js-tiktoken@1.0.21

npx allagents-promptfoo eval --config "$eval_suite/live.yaml" \
  --public-labels true --output-dir live-results -- --no-cache --max-concurrency 3
```

Docker is required. The native `results.json` export records the Git revision,
route, task outcome, input, cached input, output, desktop calls, and
screenshots for each trial. Compare base and PR results within each model.
These measurements cover a simulated Windows app.

## Scripted replay

From the same tooling directory, run the offline replay to check the two
automation flows and compare tool response sizes.

```sh
npx allagents-promptfoo eval --config "$eval_suite/replay.yaml" \
  --public-labels true --output-dir replay-results -- --no-cache
```

The replay counts tool-response text with `o200k_base` and records images
separately. Model usage comes from the live suite. Versions of oh-my-promptfoo
that support `publicNamedScores` display the selected custom metrics in their
reports. They are also available in Promptfoo's native `results.json`.

## Results

The image-enabled matrix passed all 16 trials. Each row covers three form
tasks and one inspection badge task on one revision. The base was `97a74ffc4`
and the Windows implementation was `1006d0c45`. Input includes cached tokens.
The cached column is the subset read from cache.

| Model               | Revision | Passed |   Input | Cache reads | Output |   Total | Model calls | Desktop calls | Screenshots |
| ------------------- | -------- | -----: | ------: | ----------: | -----: | ------: | ----------: | ------------: | ----------: |
| GPT-6.2 Sol         | Base     |    4/4 | 301,736 |     243,876 |  1,107 | 302,843 |          26 |            17 |          17 |
| GPT-6.2 Sol         | PR       |    4/4 | 187,141 |     142,008 |  1,092 | 188,233 |          18 |            10 |           2 |
| DeepSeek V4.1 Flash | Base     |    4/4 | 423,449 |     361,472 |  6,986 | 430,435 |          30 |            17 |          17 |
| DeepSeek V4.1 Flash | PR       |    4/4 | 429,144 |     373,504 |  8,308 | 437,452 |          31 |            16 |           2 |

GPT-6.2 Sol used 37.8% fewer total tokens. DeepSeek used 1.6% more in this
matrix. Its token counts varied in two earlier passes as the model took
different numbers of turns. Both models used zero screenshots on the PR's
three ordinary form tasks and requested screenshots for the badge.
