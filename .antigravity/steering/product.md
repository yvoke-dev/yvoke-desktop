# Product Overview

Yvoke - Desktop is a desktop chat client for Yvoke. The agent loop runs locally via the **Claude Agent SDK** (embedding a Claude Code binary within the desktop bundle); the backend Spring app (yvoke-web) provides the `yvoke` MCP tools and the conversation/feedback Sync API (`/api/desktop/v1`).

## Core Functionality

- **Agent SDK Execution**: Orchestrates turns and tool calling locally inside Electron main process using `@anthropic-ai/claude-agent-sdk`.
- **Preload IPC Wiring**: Electron renderer and main processes communicate securely using a preload script that exposes specific channels using `contextBridge`.
- **Authentication**:
  - **Claude (Subscription)**: Billed to the user's Anthropic Pro/Max subscription. The app picks up ambient Claude Code credentials and strips `ANCHROPIC_API_KEY` for billing safety.
  - **Server (Entra ID)**: Connects to the knowledge-base corpus and conversation storage. Bypassed in dev mode (`APP_SECURITY_MOCK=true`) using a static developer token, or uses browser-based corporate Microsoft Entra ID login (MSAL PKCE) in production.
- **Conversation Sync**:
  - Conversations are backed up on the Spring Boot Postgres database.
  - Local `userData` directory holds local thread metadata/history cache, sync queue files, and SDK session states to support session resume and offline capabilities.
- **MCP Tool Confinement**: Restricts tool usage exclusively to `mcp__yvoke__*` tools and domain-restricted web search when configured.

## Domain Context

- **Corpora / Collections**: supplied by whichever knowledge base the server is serving, and
  discovered at runtime — the client hardcodes no collection. The current deployment carries One
  Identity Manager manuals plus a database-schema corpus, but nothing in the desktop app depends on
  that; a different knowledge base needs no client change.
- **MCP Client**: Exposes knowledge-base queries as SSE (Server-Sent Events) tools.
- **Settings Store**: Persists API endpoints, MSAL tenant details, agent model choices, and thinking tokens configurations.
