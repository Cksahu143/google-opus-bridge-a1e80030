# Google Nexus Gateway

Build a production-ready project called Google Nexus: a universal Google integration gateway designed to let Claude access as much of the Google ecosystem as technically possible through one connection.

This is NOT just a dashboard or mock UI. Build the actual working foundation for the connector.

Core goal

The intended architecture is:

Claude → Google Nexus → best available Google integration → Google

Google Nexus should intelligently combine whatever methods are actually available:

Official Google APIs

Official Google MCP servers

OAuth

Google Cloud APIs

Google Apps Script

Workspace integrations

Specialized MCP servers

Other reliable integrations

Browser automation only when genuinely necessary

Do not force everything into one technology.

Research first

Before implementing integrations, research the current state of Google's ecosystem and determine the best implementation for each service.

Prioritize official Google documentation and official APIs/MCPs.

Research at minimum:

Gmail

Drive

Docs

Sheets

Slides

Calendar

Tasks

Contacts

Meet

Chat

Forms

Keep

Gemini

Google AI Studio

Workspace Studio

NotebookLM

Google Flow

Veo

Imagen

Google's current image/video/audio/music generation capabilities

Pay particular attention to services that don't have obvious connectors, especially NotebookLM and Google Flow.

Do not invent APIs.

If something cannot currently be integrated reliably, architect the system so a future adapter can be added without rewriting the platform.

Architecture

Create a modular connector platform with:

Google OAuth authentication

encrypted credential/token storage

service adapters

capability registry

integration router

MCP server

Claude-compatible remote MCP endpoint

workflow engine

permission system

audit logs

health monitoring

error handling

extensible adapter architecture

The router should determine the best available implementation for each requested capability.

For example:

gmail.search → Gmail API

drive.search → Drive API

calendar.create → Calendar API

notebooklm.query → best currently available NotebookLM adapter

flow.generate → best currently available Flow integration

Do not expose implementation details to Claude.

Claude integration

Make Claude a first-class client.

Implement a proper MCP interface with clear, AI-friendly tools.

The exact tool surface should be determined by research, but should support capabilities such as:

Gmail search/read

Drive search/read/create

Docs creation/editing

Sheets read/write

Slides operations

Calendar operations

NotebookLM operations where possible

Google creative capabilities where possible

multi-service Google workflows

The goal is for Claude to be able to perform workflows such as:

Search Drive → find a document → use NotebookLM → create a Google Doc → save it to Drive.

One MCP connection should expose the available Google capabilities.

iPad-first

The system must work from an iPad.

Do not require a local Mac or desktop process to stay running.

Build the architecture around secure cloud/remote access where possible.

OAuth authentication must work from Safari/iPad.

Create a responsive web interface for:

connecting Google

managing permissions

viewing connected services

seeing available capabilities

viewing operation history

checking integration health

configuring Claude/MCP

Security

Use proper Google OAuth 2.0.

Never ask for or store Google passwords.

Use:

encrypted tokens

least-privilege scopes

secure sessions

refresh-token handling

token revocation

permission management

audit logs

secret redaction

Never expose credentials or tokens to Claude.

Browser automation fallback

Only use browser automation where no better supported interface exists.

If required, isolate it inside its own adapter.

Use robust DOM/accessibility-based automation, state verification, retries and error recovery.

Never rely on hardcoded coordinates.

Never pretend an undocumented endpoint is an official API.

UI

Create a polished modern interface, but keep the UI secondary to the actual connector functionality.

The main dashboard should show:

Google Nexus

Connection status:

Google Account

Gmail

Drive

Docs

Sheets

Calendar

NotebookLM

AI

Creative tools

Other discovered integrations

Each service should show:

Connected / Not connected

Available capabilities

Authentication status

Health status

Include a Claude Connection section showing exactly how to connect Claude to the Nexus MCP endpoint.

Architecture requirement

Make every Google integration an independent adapter.

For example:

/integrations/gmail

/integrations/drive

/integrations/notebooklm

/integrations/flow

etc.

This is important because Google's products and APIs change frequently.

Replacing one adapter must not require rebuilding the entire connector.

Important

Do not build fake integrations with placeholder buttons.

Do not claim NotebookLM, Flow, music generation, or other services work unless the implementation actually works.

Where a capability is currently unavailable, show it as:

Research required / Unsupported / Adapter unavailable

and leave a clean extension point for future implementation.

Deliverables

Build the actual application and backend foundation, including:

Responsive iPad-friendly dashboard

Google OAuth

Secure credential handling

Modular Google adapter architecture

Capability registry

Intelligent routing layer

MCP server

Claude connection support

Workflow engine foundation

Audit/operation logs

Integration health system

Documentation

Environment configuration

Deployment-ready architecture

Tests for implemented integrations

Do not spend the majority of the effort making a pretty dashboard.

The connector infrastructure is the product.

Research first, build the strongest architecture you can find, and make every important component genuinely functional rather than simulated.

## Deployment

Production is hosted on Vercel:

https://google-opus-bridge-a1e80030.vercel.app

The frontend uses Vite-exposed public Supabase configuration, while server-only credentials remain in the deployment environment.

## Development

The project uses Vite, TanStack Start, React, Tailwind CSS and Supabase.

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
