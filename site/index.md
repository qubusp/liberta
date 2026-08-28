---
layout: home
title: Liberta
---

## Why it is shaped this way

Long-horizon autonomous coding sessions fail in a small number of
predictable ways: the agent tries to do everything in one giant turn, its
context fills up and it loses the plot, it leaves work half-finished because
nothing forces it to check, or it declares success without real evidence
that anything passed. Liberta's structure exists specifically to close off
each of those.

<ul class="feature-list">
  <li>
    <h3>One task, one fresh subagent</h3>
    <p>
      The controller (<code>skills/liberta</code>) never implements anything
      itself &mdash; it reads a task off a plan, hands it to the right
      specialist, and reads back a verdict. Context never accumulates past a
      thin bookkeeping layer.
    </p>
  </li>
  <li>
    <h3>Independent verification</h3>
    <p>
      A task is not &ldquo;done&rdquo; until a second, separate agent &mdash;
      one that did not write the change &mdash; reproduces the evidence that
      it works.
    </p>
  </li>
  <li>
    <h3>Durable state on disk</h3>
    <p>
      Plan, progress, budget, and an append-only event log live in a session
      store outside the target repo, so a run survives a context reset, a
      machine sleep, or a crash and picks up exactly where it left off.
    </p>
  </li>
  <li>
    <h3>A hard budget and explicit stop conditions</h3>
    <p>
      Every run has a maximum iteration count, token budget, and wall-clock
      deadline. When any of them trips, or the plan completes, or progress
      stalls for several iterations in a row, the run stops and notifies
      rather than grinding on.
    </p>
  </li>
</ul>

## Start a run

Install the harness and roster into `~/.claude/`:

```
./install.sh
```
{: tabindex="0"}

Then from any Claude Code session:

```
/liberta "<goal>" --project <path>
```
{: tabindex="0"}

MIT licensed &mdash; use it, fork it, sell it, whatever.

## Documentation

{% include docs-cards.html %}

## The name

Liberta is named after a friend of mine who has been fighting ADHD all her
life. The name is a nod to her persistence.
