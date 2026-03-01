# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Azure DevOps Extension that automatically reviews Pull Requests using Claude AI. It runs as a pipeline task (`ClaudePRReview@1`) that collects git diffs, sends them to the Claude Code CLI, and posts review comments back on the PR.

The project is written in **Portuguese (Brazil)** — README, comments, and commit messages follow this convention.

## Build & Development Commands

```bash
# Full build + package into .vsix (from repo root)
./build.sh

# TypeScript compile only (from task/ directory)
cd task && npm run build

# Install dependencies (from task/ directory)
cd task && npm install

# Package extension with tfx (from repo root, requires tfx-cli)
tfx extension create --manifest-globs vss-extension.json --output-path ./dist/

# Publish to marketplace
tfx extension publish --manifest-globs vss-extension.json --token <PAT>
```

There are no tests or linting configured.

## Architecture

All source code lives in `task/src/` (4 files, ~550 lines total). The compiled output goes to `task/dist/` (CommonJS, ES2020 target, Node 20+).

**Execution flow (orchestrated by `index.ts`):**

1. Read task inputs (auth method, model, filters, language, custom prompt)
2. `azuredevops.ts → getPipelineContext()` — extracts PR metadata from Azure pipeline environment variables
3. `azuredevops.ts → getLocalDiff()` — runs `git diff` locally with file extension/path filters and size truncation
4. `claude-runner.ts → installClaudeCode()` — installs `@anthropic-ai/claude-code` globally if missing
5. `claude-runner.ts → runReview()` — writes prompt to `/tmp/claude_pr_prompt.txt`, pipes it to `claude` CLI in headless mode (5-min timeout, 10MB buffer)
6. `azuredevops.ts → postPRComment()` — posts review as a PR thread comment via Azure DevOps REST API
7. Sets `ClaudeReviewOutput` pipeline output variable

**Key design decisions:**
- Uses local `git diff` instead of Azure REST API for diffs (faster, more reliable)
- Claude Code CLI is installed on-demand during pipeline execution
- Supports two auth methods: OAuth token (subscription) or Anthropic API key
- `prompts.ts` contains per-language review templates (pt-br, en, es)

## Extension Manifest

- `vss-extension.json` — extension-level manifest (publisher, version, marketplace metadata)
- `task/task.json` — task definition with 12 input parameters across 4 groups (Authentication, Model & Language, File Filters, Advanced Settings)

## Dependencies

Only 2 production dependencies: `azure-pipelines-task-lib` (task framework) and `axios` (HTTP client for Azure DevOps API calls).
