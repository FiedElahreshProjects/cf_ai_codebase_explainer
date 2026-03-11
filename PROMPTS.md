## PROMPTS USED DURING DEVELOPMENT

This file documents the key AI prompts and instructions used to build `cf_ai_codebase_explainer`.

### High-level assignment and idea

- You provided the original assignment and idea (paraphrased):
  - Build an AI-powered application on Cloudflare that:
    - Uses an LLM (Llama 3.3 on Workers AI or another provider).
    - Uses workflow/coordination (Workers / Durable Objects / Workflows).
    - Accepts user input via chat or voice.
    - Maintains memory or state.
  - Application concept: **codebase explainer**:
    - User pastes a GitHub repo link.
    - App fetches repo files.
    - App sends them to an LLM.
    - LLM explains the project.
    - App stores the conversation.

### Planning prompts for the Agent implementation

- Core planning prompt to the AI assistant (this agent):
  - “Optional Assignment Instructions: We plan to fast track review of candidates who complete an assignment to build a type of AI-powered application on Cloudflare... Here's my idea, a codebase explainer, User pastes a GitHub repo link. App: fetch repo files, send to LLM, explain the project, store conversation.”
  - Additional clarifications:
    - Target platform: Cloudflare Agents + Workers AI.
    - Backend language: JavaScript for Worker/Agents code.
    - Frontend: React chat UI.
    - GitHub access: public repos only using the unauthenticated GitHub API.
    - Include README and PROMPTS.md.

- From this, the AI assistant produced an architecture plan:
  - Use `CodebaseExplainerAgent` extending `Agent` from the `agents` SDK.
  - Register the agent as a Durable Object via `wrangler.toml`.
  - Implement callable methods:
    - `loadRepository(url)`.
    - `askQuestion(message)`.
    - `resetSession()`.
  - Store `repoUrl`, `repoSummary`, `filesIndex`, and `messages` in agent state.
  - Use Workers AI with a Llama 3.3 model for explanations.

### System prompts for the LLM (Workers AI)

The backend uses Workers AI (`env.AI.run`) with messages arrays that include system and user prompts.

- **Initial explanation system prompt** (summarized):
  - “You are a senior software engineer explaining software projects to other developers.
     Given GitHub repository metadata and selected file snippets, you will:
     - Provide a high-level overview of what the project does.
     - Describe the main technologies and entrypoints.
     - Outline the high-level architecture and data/control flow.
     - Call out any assumptions or uncertainties explicitly.”

- **Initial explanation user prompt** (structure):
  - Includes:
    - Repository name (`owner/repo`), description, primary language, stars, forks.
    - A list of key files with paths, sizes, and short snippets.
  - Asks the model to respond with:
    1. A concise overview of what the project does.
    2. The main technologies and components.
    3. How the main pieces fit together (architecture).
    4. Where to start reading the code to understand it.

- **Follow-up question system prompt** (summarized):
  - “You are a senior engineer helping a developer understand a codebase.
     You have a high-level summary of the repository, a list of important files, and recent conversation.
     Answer the question as clearly as possible and, if unsure, say so and suggest where to look in the code.”

- **Follow-up question user prompt** (structure):
  - Includes:
    - Current repository URL.
    - Stored high-level repo summary.
    - Lightweight list of important files (paths + sizes).
    - Recent conversation history (last few messages formatted as `ROLE: content`).
    - The user’s new question.

These prompts are constructed dynamically in `src/server.ts` inside:
- `buildInitialExplanationPrompt(context)`
- `buildFollowupPrompt(question)`

### Implementation-focused prompts and workflow

During development, I used AI assistants as a **coding partner**, not a replacement for doing the work. I drove the architecture, decided on trade‑offs, and reviewed or edited every line that landed in the repository. The assistant was primarily used to:

- Brainstorm and refine the overall architecture (Agents + Workers AI + minimal React UI).
- Look up details from the Cloudflare docs when wiring Durable Objects and the Agents router:
  - [Build Agents on Cloudflare](https://developers.cloudflare.com/agents/)
  - [Quick Start](https://developers.cloudflare.com/agents/getting-started/quick-start/)
- Speed up boilerplate (Wrangler config, basic React wiring, and repetitive TypeScript types).
- Iterate on prompt wording for better explanations of unfamiliar codebases.

I implemented and adjusted the agent logic, GitHub fetching strategy, state model, and UI behavior myself, using AI as a helper for ideas and for tightening up code and docs. This document is intentionally high-level but captures the key prompts and design constraints that guided the implementation.

