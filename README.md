## cf_ai_codebase_explainer

**Live demo:** `https://cf_ai_codebase_explainer.elahres1.workers.dev/`

**An AI-powered Cloudflare Agents app that explains GitHub codebases using Workers AI (LLM-backed).**

Paste a public GitHub repository URL, the app fetches a curated set of files via the GitHub API, summarizes the project with a Workers AI LLM, and lets you chat with an agent that remembers context.

### Architecture

- **Agent backend (`CodebaseExplainerAgent`)**
  - Built with the Cloudflare [Agents SDK](https://developers.cloudflare.com/agents/).
  - Runs on a Durable Object with built-in SQLite state.
  - Responsibilities:
    - Validate GitHub URLs (`https://github.com/{owner}/{repo}`).
    - Fetch repo metadata and a small, prioritized subset of files using the public GitHub REST API.
    - Build a compact context (file list + snippets) for the LLM.
    - Call Workers AI (Llama 3.3) to:
      - Generate an initial high-level explanation of the project.
      - Answer follow-up questions using prior conversation and repo context.
    - Persist conversation state (`messages`, `repoUrl`, `repoSummary`, `filesIndex`) for each agent instance.

- **Worker routing (`src/server.ts`)**
  - Uses `routeAgentRequest` from `agents` to route WebSocket / agent requests.
  - Exposes:
    - `/` — Embedded React-based chat UI.
    - `/health` — Simple health check endpoint.
  - Agent is registered as a Durable Object in `wrangler.toml` and backed by SQLite via migrations.

- **React UI (served inline from Worker)**
  - A small React 18 SPA delivered from `/` using CDN React.
  - Features:
    - Input for a GitHub repo URL and “Load repo” button.
    - Chat-style view of messages (assistant/user bubbles).
    - Textarea to ask follow-up questions about the codebase.
  - Uses `fetch` to call callable agent methods over HTTP:
    - `loadRepository(url)` — analyze a new repo and get an explanation.
    - `askQuestion(question)` — ask follow-up questions about the same repo.
  - Agent namespace (as configured in `wrangler.toml`): `codebase-explainer`
  - The UI is intentionally minimal but styled for a modern, dark look.

### Backend implementation details

- **File: `src/server.ts`**
  - Defines `CodebaseExplainerAgent` extending `Agent` from the Agents SDK.
  - State shape:
    - `repoUrl: string | null`
    - `repoSummary: string | null`
    - `filesIndex: { path: string; size: number; snippet: string }[]`
    - `messages: { role: "user" | "assistant" | "system"; content: string; ts: number }[]`
  - Callable methods:
    - `loadRepository(url: string)`:
      - Validates the URL using a strict GitHub pattern.
      - Fetches repo metadata (`/repos/{owner}/{repo}`) and contents (`/repos/{owner}/{repo}/contents`).
      - Prioritizes files: `README*`, `package.json`, `pyproject.toml`, `requirements.txt`, markdown, and common source files, plus files inside `src/`, `app/`, or `backend/` (with language heuristics).
      - Applies safety limits to avoid huge prompts (cap on file count and total bytes).
      - Builds a prompt and calls Workers AI (model ID configured in `src/server.ts`) to generate an explanation.
      - Initializes state with the explanation and a system message.
    - `askQuestion(question: string)`:
      - Requires that a repo has already been loaded.
      - Builds a follow-up prompt using:
        - Current repo URL and stored summary.
        - Lightweight file list (paths + sizes).
        - Recent conversation history (last few messages).
      - Calls Workers AI to answer the question and appends user/assistant messages to state.
      - Returns the latest messages.
    - `resetSession()`:
      - Clears repo metadata, file index, and conversation history from state.

- **Workers AI integration**
  - Uses the `AI` binding configured in `wrangler.toml`:
    - Calls `env.AI.run("<Workers AI model id>", { messages })` (see `modelId` constant in `src/server.ts`).
    - Extracts the `response` text or stringifies the result as a fallback.
  - System prompts emphasize:
    - Senior-engineer-style explanations.
    - Clear architecture and data/control flow.
    - Explicitly calling out uncertainty when context is missing.

### Repository structure

- `package.json` — Node/Workers project with:
  - `dependencies`: `agents`
  - `devDependencies`: `wrangler`
  - Scripts:
    - `dev` — run locally via Wrangler.
    - `deploy` — deploy to Cloudflare.
- `wrangler.toml` — Cloudflare Workers config:
  - `main = "src/server.ts"`
  - `compatibility_date = "2026-03-11"`
  - `compatibility_flags = ["nodejs_compat"]`
  - Durable Object / agent binding for `CodebaseExplainerAgent` plus migration.
  - `ai` binding named `AI`.
- `src/server.ts` — Agent implementation, Workers routing, and inline React UI.
- `README.md` — This file, with documentation and run instructions.
- `PROMPTS.md` — AI prompts and instructions used during development.

### Running locally

1. **Prerequisites**
   - Node.js (LTS recommended).
   - `npm`.
   - Cloudflare account and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Workers AI / account**
   - Log into Cloudflare with Wrangler:
     ```bash
     npx wrangler login
     ```
   - Ensure your account has Workers AI enabled and the `AI` binding is properly configured for the project.

4. **Run in development**
   ```bash
   npm run dev
   ```
   - By default Wrangler serves on `http://127.0.0.1:8787` (check your console output).
   - Open the URL in a browser.
   - Paste a public GitHub repository URL (for example, a small open-source JS or TS repo).
   - Click **“Load repo”**, wait for the explanation, then ask follow-up questions.

### Deploying to Cloudflare

1. Make sure you are logged in and Wrangler is configured:
   ```bash
   npx wrangler whoami
   ```

2. Deploy:
   ```bash
   npm run deploy
   ```

3. Wrangler will print a deployed URL. Open it in a browser, paste a public GitHub repo URL, and interact with the explainer.

### Submission checklist

- Repository name starts with `cf_ai_` (this repo: `cf_ai_codebase_explainer`)
- `README.md` includes run instructions
- `PROMPTS.md` included
- Deployed Workers URL included in your submission

### Limitations and notes

- **Public GitHub repositories only** — no authentication is used. Private repos will fail with a GitHub API error.
- **Size limits** — only a **small subset of files** is fetched (capped by file count and total bytes) to keep LLM prompts efficient.
- **Shallow directory traversal** — only the root and a few common source directories (`src/`, `app/`, `backend/`) are inspected.
- **Best-effort explanations** — the agent calls out uncertainty when key files are missing or when context is incomplete.
- **No streaming UI** — responses are returned once the LLM call completes; upgrading to streaming (WebSockets/SSE) would be a natural future enhancement.

### References

- Cloudflare Agents overview: [https://agents.cloudflare.com/](https://agents.cloudflare.com/)
- Build Agents on Cloudflare (quick start): [https://developers.cloudflare.com/agents/](https://developers.cloudflare.com/agents/)
