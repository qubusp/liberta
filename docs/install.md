---
layout: doc
title: Installing and running
summary: install.sh, its flags, starting the console, and dispatching a goal.
description: How to install the Liberta controller skill and agent roster into ~/.claude/, start the console, and start a run.
sources: README.md and console/README.md
---

## Install the harness

```
./install.sh
```
{: tabindex="0"}

Works on macOS and Linux. It installs the controller skill and agent roster
into `~/.claude/` — backing up anything already there before overwriting —
prepares the run-store directory, and sets up the console's dependencies.

Two flags change what it does:

```
./install.sh --no-console   # harness only, skip the console's npm install
./install.sh --start        # also start the console immediately, with a
                            # freshly generated one-off login password
```
{: tabindex="0"}

## Start a run

From any Claude Code session:

```
/liberta "<goal>" --project <path>
```
{: tabindex="0"}

`--project` names the target repository. `--profile dev|research` overrides
the profile the controller would otherwise guess. `--resume <session-id>`
picks an existing run back up.

One target repository per run. A goal spanning multiple repos should be split
into one run per repo.

## Run the console

```
cd console
npm install
LIBERTA_CONSOLE_PASSWORD='pick something' npm start
# → http://localhost:4177
```
{: tabindex="0"}

Override the port with `PORT`:

```
PORT=8080 LIBERTA_CONSOLE_PASSWORD='...' npm start
```
{: tabindex="0"}

Optionally set `LIBERTA_CONSOLE_SECRET` to a stable random string, used to
sign session cookies. If it is left unset, the server generates a random
secret at boot and warns about it — every restart will then invalidate all
existing login sessions, because the signing key changed.

See [The console]({{ '/docs/console/' | relative_url }}) for the auth model,
the database backends and the skills library.
