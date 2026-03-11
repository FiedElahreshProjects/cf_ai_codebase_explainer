import { Agent, callable, routeAgentRequest } from "agents";

type Role = "user" | "assistant" | "system";

type Message = {
  role: Role;
  content: string;
  ts: number;
};

type FileIndexItem = {
  path: string;
  size: number;
  snippet: string;
};

type CodebaseState = {
  repoUrl: string | null;
  repoSummary: string | null;
  filesIndex: FileIndexItem[];
  messages: Message[];
};

type Env = {
  AI: {
    run: (
      model: string,
      args: {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      }
    ) => Promise<any>;
  };
};

const GITHUB_REPO_REGEX =
  /^https:\/\/github\.com\/([^\/\s]+)\/([^\/\s#]+)(?:#.*)?$/i;

// Limit how much we ingest from GitHub to keep prompts manageable
const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 200_000; // ~200 KB

export class CodebaseExplainerAgent extends Agent<Env, CodebaseState> {
  initialState: CodebaseState = {
    repoUrl: null,
    repoSummary: null,
    filesIndex: [],
    messages: [],
  };

  parseRepoUrl(url: string): { owner: string; repo: string } {
    const match = GITHUB_REPO_REGEX.exec(url.trim());
    if (!match) {
      throw new Error(
        "Please provide a GitHub repository URL in the form https://github.com/{owner}/{repo}"
      );
    }
    const owner = match[1]!;
    const repo = match[2]!;
    return { owner, repo };
  }

  async fetchRepositoryContext(url: string): Promise<{
    repoMeta: any;
    filesIndex: FileIndexItem[];
  }> {
    const { owner, repo } = this.parseRepoUrl(url);
    const base = `https://api.github.com/repos/${owner}/${repo}`;

    const ghHeaders: HeadersInit = {
      "User-Agent": "cf-ai-codebase-explainer",
      "Accept": "application/vnd.github.v3+json",
    };

    const repoRes = await fetch(base, { headers: ghHeaders });
    if (!repoRes.ok) {
      throw new Error(
        `Failed to fetch repository metadata: ${repoRes.status} ${repoRes.statusText}`
      );
    }
    const repoMeta = await repoRes.json();

    const contentsRes = await fetch(`${base}/contents`, { headers: ghHeaders });
    if (!contentsRes.ok) {
      throw new Error(
        `Failed to list repository contents: ${contentsRes.status} ${contentsRes.statusText}`
      );
    }
    const contents = await contentsRes.json();

    const filesToFetch: Array<{
      path: string;
      size: number;
      url: string | null;
      priority: number;
    }> = [];

    const enqueueFile = (item: any, priority: number) => {
      if (item.type !== "file") return;
      filesToFetch.push({
        path: item.path,
        size: item.size ?? 0,
        url: item.download_url ?? null,
        priority,
      });
    };

    for (const item of contents) {
      if (item.type === "file") {
        const name = String(item.name || "").toLowerCase();
        if (name.startsWith("readme")) {
          enqueueFile(item, 1);
        } else if (
          name === "package.json" ||
          name === "pyproject.toml" ||
          name === "requirements.txt"
        ) {
          enqueueFile(item, 2);
        } else if (name.endsWith(".md")) {
          enqueueFile(item, 3);
        } else if (
          name.endsWith(".js") ||
          name.endsWith(".ts") ||
          name.endsWith(".jsx") ||
          name.endsWith(".tsx") ||
          name.endsWith(".py") ||
          name.endsWith(".go") ||
          name.endsWith(".rs")
        ) {
          enqueueFile(item, 4);
        }
      }
    }

    const srcDirs = (contents as any[]).filter(
      (item) =>
        item.type === "dir" &&
        (item.name === "src" || item.name === "app" || item.name === "backend")
    );

    for (const dir of srcDirs) {
      const dirRes = await fetch(`${base}/contents/${dir.path}`, {
        headers: ghHeaders,
      });
      if (!dirRes.ok) continue;
      const dirContents = await dirRes.json();
      for (const item of dirContents) {
        if (item.type === "file") {
          const name = String(item.name || "").toLowerCase();
          if (
            name.endsWith(".js") ||
            name.endsWith(".ts") ||
            name.endsWith(".jsx") ||
            name.endsWith(".tsx") ||
            name.endsWith(".py") ||
            name.endsWith(".go") ||
            name.endsWith(".rs")
          ) {
            enqueueFile(item, 5);
          }
        }
      }
    }

    filesToFetch.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.size - b.size;
    });

    const filesIndex: FileIndexItem[] = [];
    let totalBytes = 0;

    for (const file of filesToFetch) {
      if (filesIndex.length >= MAX_FILES) break;
      if (totalBytes + file.size > MAX_TOTAL_BYTES) break;
      if (!file.url) continue;

      const fileRes = await fetch(file.url, { headers: ghHeaders });
      if (!fileRes.ok) continue;

      const content = await fileRes.text();
      totalBytes += content.length;

      const snippet = content.split("\n").slice(0, 80).join("\n");
      filesIndex.push({
        path: file.path,
        size: file.size,
        snippet,
      });
    }

    return { repoMeta, filesIndex };
  }

  buildInitialExplanationPrompt(context: { repoMeta: any; filesIndex: FileIndexItem[] }) {
    const { repoMeta, filesIndex } = context;
    const fileSummaries = filesIndex
      .map(
        (f) =>
          `PATH: ${f.path}\nSIZE: ${f.size} bytes\nSNIPPET:\n${f.snippet}\n---`
      )
      .join("\n");

    const description = repoMeta.description || "No description provided.";

    const system = `
You are a senior software engineer explaining software projects to other developers.
Given GitHub repository metadata and selected file snippets, you will:
- Provide a high-level overview of what the project does.
- Describe the main technologies and entrypoints.
- Outline the high-level architecture and data/control flow.
- Call out any assumptions or uncertainties explicitly.
`.trim();

    const user = `
Repository name: ${repoMeta.full_name}
Description: ${description}
Primary language: ${repoMeta.language}
Stars: ${repoMeta.stargazers_count}
Forks: ${repoMeta.forks_count}

Key files and snippets:
${fileSummaries}

Please explain this project to a developer who is new to the codebase. Respond with:
1. A concise overview of what the project does.
2. The main technologies and components.
3. How the main pieces fit together (architecture).
4. Where to start reading the code to understand it.
`.trim();

    return { system, user };
  }

  async callWorkersAiForExplanation(prompt: { system: string; user: string }): Promise<string> {
    const { system, user } = prompt;
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];

    // Set this to the model ID that is enabled for your Cloudflare account.
    // The assignment recommends Llama 3.3; if it’s available in your account,
    // you can use: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    const modelId = "@cf/meta/llama-3.1-8b-instruct";

    try {
      const response = await (this as any).env.AI.run(modelId, { messages });

      if (typeof response === "string") return response;
      if (response && typeof (response as any).response === "string") {
        return (response as any).response;
      }
      return JSON.stringify(response);
    } catch (err: any) {
      const msg =
        err?.message ||
        "Workers AI call failed. Check your Workers AI configuration or model availability.";
      throw new Error(msg);
    }
  }

  @callable()
  async loadRepository(url: string) {
    const context = await this.fetchRepositoryContext(url);
    const prompt = this.buildInitialExplanationPrompt(context);
    const explanation = await this.callWorkersAiForExplanation(prompt);

    const now = Date.now();
    const systemMessage: Message = {
      role: "system",
      content: "Initialized explanation for repository " + url,
      ts: now,
    };
    const assistantMessage: Message = {
      role: "assistant",
      content: explanation,
      ts: now,
    };

    this.setState({
      ...this.state,
      repoUrl: url,
      repoSummary: explanation,
      filesIndex: context.filesIndex,
      messages: [systemMessage, assistantMessage],
    });

    return {
      repoUrl: url,
      repoSummary: explanation,
      filesIndex: context.filesIndex.map((f) => ({ path: f.path, size: f.size })),
      messages: this.state.messages,
    };
  }

  buildFollowupPrompt(question: string) {
    const { repoUrl, repoSummary, filesIndex, messages } = this.state;
    const recentMessages = messages.slice(-6);
    const historyText = recentMessages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const fileListText = filesIndex
      .map((f) => `- ${f.path} (${f.size} bytes)`)
      .join("\n");

    const system = `
You are a senior engineer helping a developer understand a codebase.
You have:
- A high-level summary of the repository.
- A list of important files.
- A short history of the conversation.

Answer the user's question as clearly and concretely as possible. If you are not sure about something,
state your uncertainty and suggest where in the code they could look.
`.trim();

    const user = `
Repository URL: ${repoUrl}

High-level summary:
${repoSummary || "(not available)"}

Important files:
${fileListText}

Recent conversation:
${historyText || "(no prior messages)"}

User question:
${question}
`.trim();

    return { system, user };
  }

  @callable()
  async askQuestion(question: string) {
    if (!question || !question.trim()) {
      throw new Error("Question cannot be empty.");
    }
    if (!this.state.repoUrl || !this.state.repoSummary) {
      throw new Error("Repository not loaded yet. Call loadRepository(url) first.");
    }

    const now = Date.now();
    const userMessage: Message = { role: "user", content: question, ts: now };

    const prompt = this.buildFollowupPrompt(question);
    const answer = await this.callWorkersAiForExplanation(prompt);
    const assistantMessage: Message = {
      role: "assistant",
      content: answer,
      ts: Date.now(),
    };

    this.setState({
      ...this.state,
      messages: [...this.state.messages, userMessage, assistantMessage],
    });

    return { answer, messages: this.state.messages };
  }

  @callable()
  async resetSession() {
    this.setState({
      repoUrl: null,
      repoSummary: null,
      filesIndex: [],
      messages: [],
    });
  }

  // Handle direct HTTP requests to this agent instance, used by the inline client.
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "";

    try {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = await request.json().catch(() => ({}));
      const arg0 = (body as any)[0] ?? (body as any).url ?? (body as any).question;

      if (last === "loadRepository") {
        if (typeof arg0 !== "string") {
          return new Response("Missing repository URL", { status: 400 });
        }
        const result = await this.loadRepository(arg0);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (last === "askQuestion") {
        if (typeof arg0 !== "string") {
          return new Response("Missing question", { status: 400 });
        }
        const result = await this.askQuestion(arg0);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (err: any) {
      const message = err?.message || String(err);
      return new Response(message, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);
    if (url.pathname === "/") {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>cf_ai_codebase_explainer</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: dark;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #020617 0, #020617 40%, #000000 100%);
        color: #e5e7eb;
        display: flex;
        justify-content: center;
        align-items: stretch;
        min-height: 100vh;
      }
      .app-root {
        width: 100%;
        max-width: 1080px;
        padding: 28px 16px 40px;
      }
      .header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
        gap: 12px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .brand-mark {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: conic-gradient(from 210deg, #22d3ee, #4f46e5, #22c55e, #22d3ee);
        box-shadow: 0 0 18px rgba(59,130,246,0.8);
      }
      .brand-text {
        font-size: 0.95rem;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        color: #c7d2fe;
      }
      .badge {
        font-size: 0.7rem;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,255,0.5);
        background: rgba(15,23,42,0.9);
        color: #e5e7ff;
        white-space: nowrap;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 2.4fr) minmax(0, 1.4fr);
        gap: 16px;
      }
      .card {
        background: radial-gradient(circle at top left, #1f2937, #020617);
        border-radius: 18px;
        padding: 20px 20px 16px;
        box-shadow: 0 24px 80px rgba(0,0,0,0.7);
        border: 1px solid rgba(148,163,255,0.25);
      }
      .side-card {
        background: rgba(15,23,42,0.9);
        border-radius: 16px;
        padding: 14px 14px 12px;
        border: 1px solid rgba(31,41,55,0.9);
      }
      .title {
        font-size: 1.45rem;
        font-weight: 650;
        margin-bottom: 4px;
      }
      .subtitle {
        font-size: 0.9rem;
        color: #9ca3c7;
        margin-bottom: 16px;
      }
      .input-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }
      .input-row input {
        flex: 1 1 260px;
        min-width: 0;
        padding: 9px 11px;
        border-radius: 9px;
        border: 1px solid rgba(148,163,255,0.35);
        background: rgba(15,23,42,0.9);
        color: #f9fafb;
        font-size: 0.86rem;
        outline: none;
      }
      .input-row input::placeholder {
        color: #6b7280;
      }
      .input-row button {
        padding: 9px 15px;
        border-radius: 9px;
        border: none;
        background: linear-gradient(135deg, #4f46e5, #06b6d4);
        color: white;
        font-weight: 560;
        font-size: 0.86rem;
        cursor: pointer;
        white-space: nowrap;
        box-shadow: 0 8px 25px rgba(59,130,246,0.5);
      }
      .input-row button:disabled {
        opacity: 0.6;
        cursor: default;
        box-shadow: none;
      }
      .chat-container {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(148,163,255,0.3);
        max-height: 60vh;
        overflow: auto;
      }
      .message {
        margin-bottom: 10px;
        display: flex;
      }
      .message-role {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #9ca3c7;
        margin-bottom: 2px;
      }
      .bubble {
        padding: 8px 10px;
        border-radius: 10px;
        font-size: 0.85rem;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .bubble.assistant {
        background: rgba(15,23,42,0.96);
        border: 1px solid rgba(148,163,255,0.55);
      }
      .bubble.user {
        background: rgba(21,128,61,0.12);
        border: 1px solid rgba(34,197,94,0.7);
      }
      .question-row {
        margin-top: 10px;
        display: flex;
        gap: 8px;
      }
      .question-row textarea {
        flex: 1;
        min-height: 48px;
        max-height: 120px;
        resize: vertical;
        padding: 8px 10px;
        border-radius: 9px;
        border: 1px solid rgba(148,163,255,0.35);
        background: rgba(15,23,42,0.9);
        color: #f9fafb;
        font-size: 0.86rem;
        outline: none;
      }
      .hint {
        margin-top: 6px;
        font-size: 0.76rem;
        color: #9ca3c7;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 0.72rem;
        background: rgba(15,23,42,0.9);
        border: 1px solid rgba(148,163,255,0.5);
        color: #e5e7ff;
        margin-left: 6px;
      }
      .steps-title {
        font-size: 0.8rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #9ca3c7;
        margin-bottom: 6px;
      }
      .steps-list {
        margin: 0;
        padding-left: 16px;
        font-size: 0.8rem;
        color: #d1d5db;
      }
      .steps-list li {
        margin-bottom: 4px;
      }
      .footnote {
        margin-top: 8px;
        font-size: 0.72rem;
        color: #6b7280;
      }
      @media (max-width: 880px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
        .side-card {
          order: -1;
        }
      }
      @media (max-width: 640px) {
        .card {
          padding: 16px 14px 14px;
        }
        .app-root {
          padding-inline: 12px;
        }
      }
    </style>
  </head>
  <body>
    <div id="root" class="app-root"></div>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script type="module">
      const e = React.createElement;
      const { useState, useEffect, useRef } = React;

      async function callAgent(method, args) {
        const url = "/agents/codebase-explainer/default/" + method;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args || {}),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error("Agent call failed: " + res.status + " " + text);
        }
        return res.json();
      }

      function App() {
        const [repoUrl, setRepoUrl] = useState("");
        const [loadingRepo, setLoadingRepo] = useState(false);
        const [asking, setAsking] = useState(false);
        const [messages, setMessages] = useState([]);
        const [question, setQuestion] = useState("");
        const chatRef = useRef(null);

        useEffect(() => {
          if (chatRef.current) {
            chatRef.current.scrollTop = chatRef.current.scrollHeight;
          }
        }, [messages]);

        async function handleLoadRepo() {
          if (!repoUrl.trim()) return;
          setLoadingRepo(true);
          try {
            const result = await callAgent("loadRepository", { 0: repoUrl.trim() });
            setMessages(result.messages || []);
          } catch (err) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: String(err.message || err), ts: Date.now() },
            ]);
          } finally {
            setLoadingRepo(false);
          }
        }

        async function handleAsk() {
          if (!question.trim()) return;
          setAsking(true);
          const q = question.trim();
          setQuestion("");
          try {
            const result = await callAgent("askQuestion", { 0: q });
            setMessages(result.messages || []);
          } catch (err) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: String(err.message || err), ts: Date.now() },
            ]);
          } finally {
            setAsking(false);
          }
        }

        return e(
          "div",
          null,
          e(
            "div",
            { className: "header-row" },
            e(
              "div",
              { className: "brand" },
              e("div", { className: "brand-mark" }),
              e("div", { className: "brand-text" }, "CF AI · Codebase Explainer")
            ),
            e(
              "div",
              { className: "badge" },
              "Agents + Workers AI + GitHub"
            )
          ),
          e(
            "div",
            { className: "layout" },
            e(
              "div",
              { className: "card" },
              e(
                "div",
                null,
                e(
                  "div",
                  { className: "title" },
                  "Understand any GitHub repo faster",
                  e("span", { className: "pill" }, "LLM-powered explanation")
                ),
                e(
                  "div",
                  { className: "subtitle" },
                  "Paste a public GitHub repository and let the agent fetch key files, summarize architecture, and answer follow-up questions."
                )
              ),
              e(
                "div",
                { className: "input-row" },
                e("input", {
                  placeholder: "https://github.com/owner/repo",
                  value: repoUrl,
                  onChange: (ev) => setRepoUrl(ev.target.value),
                }),
                e(
                  "button",
                  { type: "button", onClick: handleLoadRepo, disabled: loadingRepo },
                  loadingRepo ? "Analyzing…" : "Load repo"
                )
              ),
              e(
                "div",
                { className: "hint" },
                "Only public repositories are supported. The agent fetches a small, prioritized subset of files to keep prompts compact."
              ),
              e(
                "div",
                { className: "chat-container", ref: chatRef },
                messages.map((m) =>
                  e(
                    "div",
                    { key: m.ts + ":" + m.role, className: "message" },
                    e(
                      "div",
                      null,
                      e("div", { className: "message-role" }, m.role.toUpperCase()),
                      e(
                        "div",
                        {
                          className:
                            "bubble " + (m.role === "user" ? "user" : "assistant"),
                        },
                        m.content
                      )
                    )
                  )
                )
              ),
              e(
                "div",
                { className: "question-row" },
                e("textarea", {
                  placeholder:
                    "Ask about architecture, data flow, or where to start reading the code.",
                  value: question,
                  onChange: (ev) => setQuestion(ev.target.value),
                }),
                e(
                  "button",
                  { type: "button", onClick: handleAsk, disabled: asking },
                  asking ? "Thinking…" : "Ask"
                )
              )
            ),
            e(
              "div",
              { className: "side-card" },
              e("div", { className: "steps-title" }, "How this agent works"),
              e(
                "ol",
                { className: "steps-list" },
                e(
                  "li",
                  null,
                  "You paste a public GitHub URL."
                ),
                e(
                  "li",
                  null,
                  "The agent fetches repo metadata and a curated set of files via the GitHub API."
                ),
                e(
                  "li",
                  null,
                  "It builds a compact context and calls a Workers AI LLM to explain the project."
                ),
                e(
                  "li",
                  null,
                  "Your follow-up questions are answered using the stored summary, file index, and conversation state."
                )
              ),
              e(
                "div",
                { className: "footnote" },
                "Implemented with Cloudflare Agents (Durable Objects), Workers AI, and a minimal React UI served directly from the Worker."
              )
            )
          )
        );
      }

      const root = ReactDOM.createRoot(document.getElementById("root"));
      root.render(React.createElement(App));
    </script>
  </body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

