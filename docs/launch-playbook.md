# OSS adoption playbook

This playbook turns the project page and contribution board into evidence-backed
adoption. It deliberately avoids mass outreach, vote solicitation, and hidden
analytics.

## Target outcome

The first adoption cycle is complete when:

- 10 or more opt-in pilot reports include time-to-first-diff and export outcome;
- 20 distinct external public repositories have tried the workflow;
- 10 external repositories publish a task link or badge; and
- 5 external contributors have landed a change.

Record public evidence in [adoption registry issue #9](https://github.com/haya-inc/wasmhatch/issues/9).

## Sequence

### 1. Recruit five pilot sessions

Ask five maintainers or contributors individually to spend 10 minutes on one
real, small public issue. Personalize every request; do not send bulk DMs. Ask
for negative evidence and observe the full path from task link to patch export.

Use this message:

> I’m testing WasmHatch, an Apache-2.0 browser workspace for turning one small
> public GitHub issue into a reviewed patch before setting up the repository.
> Would you try one real task for 10 minutes? No account is required; an API key
> is optional because manual editing works. I’m specifically looking for where
> import, editing, review, or patch handoff breaks down—not praise.
>
> Project: https://haya-inc.github.io/wasmhatch/
> Report: https://github.com/haya-inc/wasmhatch/issues/9

After every session, classify the first blocker as `import`, `task clarity`,
`editing`, `agent trust`, `review`, or `patch handoff`. Fix a blocker before wider
distribution when it appears in two sessions or causes data loss, credential
exposure, or an unrecoverable dead end once.

### 2. Publish a Show HN

Only post when the live workspace and a no-key path are working and the author
can stay present to answer questions. Hacker News requires a Show HN to be
something people can try, recommends removing signup barriers, and prohibits
asking friends to vote or add booster comments. See the official
[Show HN guidelines](https://news.ycombinator.com/showhn.html) and
[moderator presentation tips](https://news.ycombinator.com/item?id=22336638).

Title:

> Show HN: WasmHatch – turn a GitHub issue into a patch in your browser

Opening comment:

> I built WasmHatch because a small open-source contribution can take less time
> than configuring its repository. A maintainer can publish one URL containing a
> public repository, exact revision, issue, and focused task. The contributor
> imports it into browser-managed storage, edits manually or uses bounded
> Anthropic BYOK file tools, reviews every proposed write as a diff, and exports
> a standard patch or zip.
>
> The core path has no command runtime, account, or server-side workspace. That
> also means it does not run project tests or open a pull request; the patch is a
> handoff to the repository’s normal validation flow. I chose that boundary to
> keep the first interaction inspectable and local-first.
>
> I’d value concrete feedback on the patch handoff, browser BYOK trust model,
> and whether revision-pinned task links would help maintainers onboard first-time
> contributors. The live contribution board has five real tasks to inspect.

Link directly to `https://haya-inc.github.io/wasmhatch/#contribute`, not to a
blog post. Do not coordinate votes or comments.

### 3. Share in one relevant community

Choose one community where the poster already participates and verify its local
rules before posting. Reddit's site-wide guidance prohibits repeated unsolicited
promotion, mass posting, and bulk private messages, and explicitly tells posters
to check each community's rules. See Reddit's official
[spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam).

Use a discussion-first framing:

> I built a local-first browser workspace for the narrow gap between “this looks
> like a good first issue” and “I have the repository configured.” It imports a
> pinned public revision, stages model writes behind a diff, and exports a normal
> patch. It intentionally does not run commands or create PRs yet. For maintainers:
> where does a patch-only handoff stop being useful in your contribution flow?

Post once. Do not cross-post the same copy to multiple communities or send
unsolicited DMs to respondents.

## Response loop

For seven days after each public post:

1. Answer factual questions and acknowledge bugs within one working day.
2. Link each reproducible defect to a focused GitHub issue.
3. Ask adopters to add public evidence to issue #9; do not copy private feedback
   into the registry without permission.
4. Prioritize repeated conversion blockers over new feature requests.
5. Publish the next newcomer task before closing a claimed starter issue, so the
   board never reaches zero available lanes.

## Stop conditions

Pause distribution immediately for a confirmed credential-persistence defect,
workspace loss without a clear recovery path, incorrect patch baseline, or a
critical import-validation bypass. Document the mitigation before resuming.

Do not broaden the product into a cloud IDE merely to answer launch feedback.
Use the [product landscape](landscape.md) to route runtime, direct-commit, and
full-project requests to the appropriate surface.
