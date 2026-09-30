---
title: "Identity and the wall: signing in with Twenty"
tags: [auth, oauth, identity, twenty, proxy]
status: active
created: 2026-09-29
---

# Identity and the wall

Blaster has no password database and no sign-up form. **Twenty is the identity
provider**: the web app's sign-in button runs Twenty's own OAuth (PKCE) flow and
keeps the resulting token. The CLI does the same through the API. There is
exactly one credential a human ever supplies, and it is their Twenty workspace
account.

The complication is that a self-hosted Twenty is usually not reachable directly.
An **auth-guard** proxy sits in front of it and demands HTTP basic auth on every
path. That guard is "the wall", and passing it is the subject of this page.

## Two credentials, two jobs

| Credential | Carried as | Covers | Where it lives |
| --- | --- | --- | --- |
| `TWENTY_API_KEY` | `Authorization: Bearer` | `/rest/*` and `/graphql` — every record read and write | server only |
| `TWENTY_BASIC_USER` / `TWENTY_BASIC_PASSWORD` | `Authorization: Basic` | `/authorize`, `/oauth/*`, `/.well-known/*` — the OAuth endpoints | server only |

The bearer token is the workspace's own key: it identifies the workspace, not
the operator, and it is what the record APIs require. The basic credentials
identify the guard, not the workspace, and a guard normally *exempts* `/rest`
and `/graphql` precisely so the record APIs work without them.

This is the part that confuses people. The bearer token does not get you past
the wall, and the basic credentials do not let you read records. A deployment
with both needs both, on different paths:

```
Operator browser  --Bearer-->  record APIs
Operator browser  --Basic---->  the wall, then Twenty's own sign-in
Blaster API       --Basic---->  discovery, token exchange, introspection
Blaster API       --Bearer-->  record APIs (TWENTY_API_KEY)
```

## The token flow, end to end

```
web app                        Blaster API                    Twenty (behind the guard)
   |                              |                                   |
   |-- GET /api/auth/config ----->|-- Basic: /.well-known/... --------->|
   |<-- {authorizationEndpoint,    |<-- {authorization_endpoint, ...} --|
   |     clientId, redirectUri,   |                                   |
   |     scope}                   |                                   |
   |                              |                                   |
   | save PKCE state + verifier in sessionStorage                     |
   |-- redirect /authorize?code_challenge=... ----------------------->|
   |                              |            native user:pass prompt (once)
   |                              |            email + password in Twenty's UI
   |                              |<-- operator clicks Authorize      |
   |<-- /callback?code=...&state=... ---------------------------------|
   |                              |                                   |
   |-- POST /api/auth/token ----->|-- Basic: POST /oauth/token ------->|
   |<-- {tokens: access, refresh}  |<-- {access_token, refresh_token} -|
   |                              |                                   |
   |-- GET /api/auth/me --------->|-- Basic: POST /oauth/introspect -->|
   |<-- {username, scope}          |<-- {active: true, username} -----|
```

| Route | Purpose |
| --- | --- |
| `GET /api/auth/config` | Public discovery for the SPA: authorize endpoint, client id, redirect URI, scope |
| `POST /api/auth/token` | Exchange `code` + PKCE `verifier` for Twenty tokens (server-side only) |
| `POST /api/auth/refresh` | Rotate a Twenty access token from a refresh token |
| `GET /api/auth/me` | Introspect a presented Bearer token; 401 when it is not active |

`blaster login` drives the same flow from the terminal: it prints a URL, the
browser completes the round trip through `/login`, and the tokens are written to
the CLI's session file.

## Tokens, and where they live

| Token | Who holds it | Lifetime | Storage |
| --- | --- | --- | --- |
| PKCE `state` + `verifier` | browser | one sign-in | `sessionStorage` |
| Twenty `access` + `refresh` | browser, or the CLI | per Twenty's defaults | `sessionStorage` (cleared with the tab) or the CLI session file |
| `TWENTY_API_KEY` | Blaster API and Convex | per Twenty's key | server environment only |
| Guard basic credentials | Blaster API | per deployment | server environment only |

The client secret, if the client is confidential, never leaves the API. The
public PKCE client is the normal case: it is registered with
`POST {TWENTY_BASE_URL}/oauth/register` and needs no secret at all.

## Configuring it

```env
TWENTY_BASE_URL=https://twenty.example.com
TWENTY_API_KEY=...                    # bearer, for /rest and /graphql

TWENTY_OAUTH_CLIENT_ID=...            # public PKCE client, no secret needed
TWENTY_OAUTH_CLIENT_SECRET=           # unset for a public client
TWENTY_OAUTH_REDIRECT_URI=https://blaster-web-nine.vercel.app/callback
TWENTY_OAUTH_SCOPE=api profile

# Only when an auth-guard fronts the instance:
TWENTY_BASIC_USER=...
TWENTY_BASIC_PASSWORD=...
```

Local development overrides the redirect with `http://localhost:5173/callback`
(the client must have that URI registered too) and points the CLI at it with
`--web-url http://localhost:5173 --api-url http://localhost:4180`.

Two rules that are not obvious:

- **The redirect URI must match exactly.** It must be registered on the Twenty
  client (`POST {TWENTY_BASE_URL}/oauth/register`), and it must equal
  `TWENTY_OAUTH_REDIRECT_URI` byte for byte. The web dev server is pinned to
  port 5173 with `strictPort`, because a Vite server that silently moved to
  5174 would make Twenty reject the consent request with an opaque
  `error=invalid_request` instead of a usable message.
- **Set both basic variables, or neither.** A user without a password is not a
  half-configured guard, it is no guard: the API treats the pair as absent and
  calls Twenty directly, which then fails with a 401 that names the guard
  rather than the credential.

## When sign-in breaks

| Symptom | Meaning | Fix |
| --- | --- | --- |
| "OAuth state mismatch. Start sign-in again." | The PKCE state did not survive the redirect, or an old bundle is running | Restart the dev server, sign in again |
| Native `user:pass` prompt loops, or 401 at `/authorize` | The guard's credentials are wrong or expired | Check `TWENTY_BASIC_USER` / `TWENTY_BASIC_PASSWORD` |
| "Twenty OAuth is not configured" from `/api/auth/*` | OAuth variables are missing from the environment | Fill in the OAuth block above |
| Consent redirects to `/callback?error=...` | The registered redirect URI does not match the dev server port | Keep port 5173, or re-register the client |
| 401 from `/api/auth/config` | Discovery hit the guard without basic credentials | Set both basic variables |
| 401 from `/api/numbers/*` or a record read | The bearer key is wrong or expired | Rotate the key in Twenty and update `TWENTY_API_KEY` |

## The generated client

Sign-in produces a token, and a token needs somewhere to go. The typed GraphQL
client in `packages/core/src/twenty/graphql/` is where it lands:

- `pnpm twenty:client` introspects the configured workspace and emits
  `generated/` from it, so the custom `agency*` objects arrive with exact
  types instead of guessed REST envelopes.
- `createTwentyClient` binds the generated client to a session store, so the
  operator's token rides along on every request and is refreshed once on
  expiry. An expired token is not a 401 from Twenty: it is a 200 whose GraphQL
  payload carries `UNAUTHENTICATED`, and the wrapper reads that before the
  generated client does.

`packages/core/test/twenty-generated-client.test.ts` exercises exactly that
chain against the real generated client, with only the network stubbed.

## What this design deliberately does not do

- Store or hash any Blaster-side password. Members live in Twenty.
- Hold the client secret in the browser, or accept a token that Twenty's own
  introspection has not confirmed live.
- Use the guard's basic credentials for record reads. They are not a record
  credential, and `/rest` and `/graphql` do not need them.
